#include "executor.h"
#include <cerrno>
#include <csignal>
#include <cstring>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>
#include <array>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace jsh {

struct SpawnCtx {
    Napi::Promise::Deferred deferred;
    Napi::ThreadSafeFunction tsfn;
    int exitCode = -1;
};

static void OnSpawnDone(Napi::Env env, Napi::Function, SpawnCtx* ctx) {
    Napi::HandleScope scope(env);
    ctx->deferred.Resolve(Napi::Number::New(env, ctx->exitCode));
    ctx->tsfn.Release();
    delete ctx;
}

// ---- Redirection and stage specs ----------------------------------------

struct RedirSpec {
    std::string op;
    int fd = -1;        // explicit fd prefix (-1 = use default)
    std::string target; // filename or fd number as string
};

struct StageSpec {
    std::string cmd;
    std::vector<std::string> args;
    std::vector<RedirSpec> redirs;
};

struct PipelineRequest {
    std::vector<StageSpec> stages;
    std::vector<std::string> pipeOps;
    SpawnCtx* ctx;
};

// ---- Helpers used in the child (post-fork, pre-exec) --------------------
// Keep these to async-signal-safe or provably safe-after-fork calls only.

static void writeErr(const char* s) {
    write(STDERR_FILENO, s, strlen(s));
}

// Apply a list of redirections in the child after pipe fds are set up.
// Returns false and writes to stderr if a file cannot be opened.
static bool applyRedirections(const std::vector<RedirSpec>& redirs) {
    for (const auto& r : redirs) {
        const std::string& op = r.op;

        if (op == ">" || op == ">>" || op == "&>" || op == "&>>") {
            int oflags = O_WRONLY | O_CREAT;
            oflags |= (op == ">>" || op == "&>>") ? O_APPEND : O_TRUNC;
            int newfd = open(r.target.c_str(), oflags, 0666);
            if (newfd < 0) {
                writeErr("jsh: ");
                writeErr(r.target.c_str());
                writeErr(": ");
                writeErr(strerror(errno));
                writeErr("\n");
                return false;
            }
            int dst = (r.fd >= 0) ? r.fd : STDOUT_FILENO;
            dup2(newfd, dst);
            if (op == "&>" || op == "&>>") {
                dup2(newfd, STDERR_FILENO);
            }
            close(newfd);

        } else if (op == "<") {
            int newfd = open(r.target.c_str(), O_RDONLY);
            if (newfd < 0) {
                writeErr("jsh: ");
                writeErr(r.target.c_str());
                writeErr(": ");
                writeErr(strerror(errno));
                writeErr("\n");
                return false;
            }
            int dst = (r.fd >= 0) ? r.fd : STDIN_FILENO;
            dup2(newfd, dst);
            close(newfd);

        } else if (op == ">&") {
            // e.g. 2>&1: dup2(target_fd, src_fd)
            int src = (r.fd >= 0) ? r.fd : STDOUT_FILENO;
            int dst = atoi(r.target.c_str());
            dup2(dst, src);

        } else if (op == "<&") {
            int src = (r.fd >= 0) ? r.fd : STDIN_FILENO;
            int dst = atoi(r.target.c_str());
            dup2(dst, src);
        }
    }
    return true;
}

// Clear O_CLOEXEC on stdin/stdout/stderr — Node sets it, which would close
// them in the child on exec.
static void clearCloexecStdio() {
    for (int fd : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
        int flags = fcntl(fd, F_GETFD);
        if (flags != -1 && (flags & FD_CLOEXEC)) {
            fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
        }
    }
}

// ---- Executor state ------------------------------------------------------

static bool g_interactive = false;

struct ExecutorState {
    std::thread thread;
    std::mutex mutex;
    std::condition_variable cv;
    std::queue<PipelineRequest*> queue;
    bool running = true;

    void start() {
        thread = std::thread(&ExecutorState::run, this);
    }

    void enqueue(PipelineRequest* req) {
        std::lock_guard<std::mutex> lock(mutex);
        queue.push(req);
        cv.notify_one();
    }

    void run() {
        while (true) {
            PipelineRequest* req = nullptr;
            {
                std::unique_lock<std::mutex> lock(mutex);
                cv.wait(lock, [this] { return !queue.empty() || !running; });
                if (!running && queue.empty()) break;
                req = queue.front();
                queue.pop();
            }
            processPipeline(req);
        }
    }

    void processPipeline(PipelineRequest* req) {
        const auto& stages = req->stages;
        const auto& pipeOps = req->pipeOps;
        int n = static_cast<int>(stages.size());

        // Build all argvs before any fork — malloc is unsafe post-fork in a
        // multithreaded process.
        std::vector<std::vector<const char*>> argvs(n);
        for (int i = 0; i < n; i++) {
            argvs[i].push_back(stages[i].cmd.c_str());
            for (const auto& a : stages[i].args) argvs[i].push_back(a.c_str());
            argvs[i].push_back(nullptr);
        }

        // Create N-1 pipes: pipes[i] connects stage i stdout → stage i+1 stdin.
        std::vector<std::array<int, 2>> pipes(n - 1);
        for (int i = 0; i < n - 1; i++) {
            if (pipe(pipes[i].data()) != 0) {
                for (int j = 0; j < i; j++) {
                    close(pipes[j][0]);
                    close(pipes[j][1]);
                }
                req->ctx->exitCode = 1;
                req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
                delete req;
                return;
            }
        }

        pid_t pgid = -1;
        std::vector<pid_t> pids;

        for (int i = 0; i < n; i++) {
            pid_t pid = fork();

            if (pid == 0) {
                // ---- Child -----------------------------------------------

                // Join / form process group.
                if (pgid == -1) pgid = getpid();
                setpgid(0, pgid);

                // Reset signal mask and handlers.
                sigset_t empty;
                sigemptyset(&empty);
                sigprocmask(SIG_SETMASK, &empty, nullptr);
                struct sigaction sa = {};
                sa.sa_handler = SIG_DFL;
                sigemptyset(&sa.sa_mask);
                sigaction(SIGINT,  &sa, nullptr);
                sigaction(SIGTTOU, &sa, nullptr);
                sigaction(SIGTTIN, &sa, nullptr);
                sigaction(SIGPIPE, &sa, nullptr);

                // Wire up pipe fds.
                if (i > 0) {
                    dup2(pipes[i - 1][0], STDIN_FILENO);
                }
                if (i < n - 1) {
                    dup2(pipes[i][1], STDOUT_FILENO);
                    if (i < static_cast<int>(pipeOps.size()) && pipeOps[i] == "|&") {
                        dup2(pipes[i][1], STDERR_FILENO);
                    }
                }

                // Close all pipe fds — child only needs the two it dup2'd.
                for (int j = 0; j < n - 1; j++) {
                    close(pipes[j][0]);
                    close(pipes[j][1]);
                }

                // Apply redirections (after pipe setup so 2>&1 sees pipe stdout).
                if (!applyRedirections(stages[i].redirs)) {
                    _exit(1);
                }

                // Clear CLOEXEC on stdio so the execd process inherits them.
                clearCloexecStdio();

                execvp(stages[i].cmd.c_str(),
                       const_cast<char* const*>(argvs[i].data()));

                // exec failed
                writeErr("jsh: ");
                writeErr(stages[i].cmd.c_str());
                writeErr(": ");
                writeErr(strerror(errno));
                writeErr("\n");
                _exit(127);

            } else if (pid > 0) {
                // ---- Parent (executor thread) ----------------------------

                if (pgid == -1) pgid = pid;
                setpgid(pid, pgid); // race-free double call with child

                pids.push_back(pid);

            } else {
                // fork failed — close remaining pipes and bail out
                for (int j = i; j < n - 1; j++) {
                    close(pipes[j][0]);
                    close(pipes[j][1]);
                }
                writeErr("jsh: fork: ");
                writeErr(strerror(errno));
                writeErr("\n");
                // Remaining pids will get SIGPIPE / EOF and exit naturally;
                // wait for any we already forked.
                for (pid_t p : pids) {
                    int st = 0;
                    waitpid(p, &st, 0);
                }
                // close already-opened pipe fds
                for (int j = 0; j < i && j < n - 1; j++) {
                    close(pipes[j][0]);
                    close(pipes[j][1]);
                }
                req->ctx->exitCode = 1;
                req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
                delete req;
                return;
            }
        }

        // Parent: close all pipe fds so children see EOF.
        for (auto& p : pipes) {
            close(p[0]);
            close(p[1]);
        }

        if (g_interactive && pgid > 0) {
            tcsetpgrp(STDIN_FILENO, pgid);
        }

        // Wait for all children; use the last stage's exit status.
        int lastExitCode = 0;
        for (size_t i = 0; i < pids.size(); i++) {
            int status = 0;
            waitpid(pids[i], &status, 0);
            int code = WIFEXITED(status)  ? WEXITSTATUS(status) :
                       WIFSIGNALED(status)? 128 + WTERMSIG(status) : 1;
            if (i == pids.size() - 1) {
                lastExitCode = code;
            }
        }

        if (g_interactive && pgid > 0) {
            tcsetpgrp(STDIN_FILENO, getpgrp());
        }

        req->ctx->exitCode = lastExitCode;
        req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
        delete req;
    }
};

static ExecutorState* g_executor = nullptr;

// ---- N-API bindings -------------------------------------------------------

static Napi::Value InitExecutor_(const Napi::CallbackInfo& info) {
    if (g_executor) return info.Env().Undefined();

    // Ignore SIGTTOU/SIGTTIN — standard for interactive shells.
    struct sigaction sa = {};
    sa.sa_handler = SIG_IGN;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTTOU, &sa, nullptr);
    sigaction(SIGTTIN, &sa, nullptr);

    // Block SIGCHLD and SIGINT on the main thread.
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    sigaddset(&mask, SIGINT);
    sigprocmask(SIG_BLOCK, &mask, nullptr);

    g_interactive = isatty(STDIN_FILENO);

    if (g_interactive) {
        pid_t pid = getpid();
        if (getpgrp() != pid) setpgid(pid, pid);
        tcsetpgrp(STDIN_FILENO, pid);
    }

    g_executor = new ExecutorState();
    g_executor->start();

    return info.Env().Undefined();
}

static Napi::Value SpawnPipeline(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_executor) {
        Napi::Error::New(env, "Executor not initialized").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "spawnPipeline(stages: object[], pipeOps: string[])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array jsStages  = info[0].As<Napi::Array>();
    Napi::Array jsPipeOps = info[1].As<Napi::Array>();

    std::vector<StageSpec> stages;
    for (uint32_t i = 0; i < jsStages.Length(); i++) {
        Napi::Object jsStage = jsStages.Get(i).As<Napi::Object>();
        StageSpec stage;
        stage.cmd = jsStage.Get("cmd").As<Napi::String>().Utf8Value();

        Napi::Array jsArgs = jsStage.Get("args").As<Napi::Array>();
        for (uint32_t j = 0; j < jsArgs.Length(); j++) {
            stage.args.push_back(jsArgs.Get(j).As<Napi::String>().Utf8Value());
        }

        Napi::Array jsRedirs = jsStage.Get("redirs").As<Napi::Array>();
        for (uint32_t j = 0; j < jsRedirs.Length(); j++) {
            Napi::Object jsRedir = jsRedirs.Get(j).As<Napi::Object>();
            RedirSpec redir;
            redir.op     = jsRedir.Get("op").As<Napi::String>().Utf8Value();
            Napi::Value fdVal = jsRedir.Get("fd");
            redir.fd     = fdVal.IsNumber() ? fdVal.As<Napi::Number>().Int32Value() : -1;
            redir.target = jsRedir.Get("target").As<Napi::String>().Utf8Value();
            stage.redirs.push_back(std::move(redir));
        }

        stages.push_back(std::move(stage));
    }

    std::vector<std::string> pipeOps;
    for (uint32_t i = 0; i < jsPipeOps.Length(); i++) {
        pipeOps.push_back(jsPipeOps.Get(i).As<Napi::String>().Utf8Value());
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto* ctx = new SpawnCtx { deferred };
    ctx->tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "spawn_complete",
        0, 1
    );

    g_executor->enqueue(new PipelineRequest { std::move(stages), std::move(pipeOps), ctx });

    return deferred.Promise();
}

static Napi::Value GetEAGAIN(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), EAGAIN);
}

Napi::Object InitExecutor(Napi::Env env, Napi::Object exports) {
    exports.Set("initExecutor",   Napi::Function::New(env, InitExecutor_));
    exports.Set("spawnPipeline",  Napi::Function::New(env, SpawnPipeline));
    exports.Set("EAGAIN",         Napi::Function::New(env, GetEAGAIN));
    return exports;
}

} // namespace jsh
