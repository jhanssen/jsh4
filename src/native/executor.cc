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
    bool captureOutput = false;
    std::string capturedOutput;
    std::vector<int> pipeStatus;  // per-stage exit codes
    bool stopped = false;         // true if job was stopped (SIGTSTP)
    int stoppedSignal = 0;
    pid_t pgid = -1;
    std::vector<pid_t> pids;     // for background/stopped jobs
};

static void OnSpawnDone(Napi::Env env, Napi::Function, SpawnCtx* ctx) {
    Napi::HandleScope scope(env);
    if (ctx->captureOutput) {
        Napi::Object result = Napi::Object::New(env);
        result.Set("exitCode", Napi::Number::New(env, ctx->exitCode));
        result.Set("output",   Napi::String::New(env, ctx->capturedOutput));
        ctx->deferred.Resolve(result);
    } else {
        Napi::Object result = Napi::Object::New(env);
        result.Set("exitCode", Napi::Number::New(env, ctx->exitCode));
        Napi::Array ps = Napi::Array::New(env, ctx->pipeStatus.size());
        for (size_t i = 0; i < ctx->pipeStatus.size(); i++) {
            ps.Set(static_cast<uint32_t>(i), Napi::Number::New(env, ctx->pipeStatus[i]));
        }
        result.Set("pipeStatus", ps);
        result.Set("stopped", Napi::Boolean::New(env, ctx->stopped));
        result.Set("stoppedSignal", Napi::Number::New(env, ctx->stoppedSignal));
        result.Set("pgid", Napi::Number::New(env, ctx->pgid));
        if (!ctx->pids.empty()) {
            Napi::Array pidsArr = Napi::Array::New(env, ctx->pids.size());
            for (size_t i = 0; i < ctx->pids.size(); i++) {
                pidsArr.Set(static_cast<uint32_t>(i), Napi::Number::New(env, static_cast<int>(ctx->pids[i])));
            }
            result.Set("pids", pidsArr);
        }
        ctx->deferred.Resolve(result);
    }
    ctx->tsfn.Release();
    delete ctx;
}

// ---- Redirection and stage specs ----------------------------------------

struct RedirSpec {
    std::string op;
    int fd = -1;        // explicit fd prefix (-1 = use default)
    std::string target; // filename, fd number as string, or here-doc body
    bool isHereDoc = false;
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
    bool captureOutput = false;
    bool background = false;
};

// ---- Helpers used in the child (post-fork, pre-exec) --------------------
// Keep these to async-signal-safe or provably safe-after-fork calls only.

static void writeErr(const char* s) {
    write(STDERR_FILENO, s, strlen(s));
}

// Apply a list of redirections in the child after pipe fds are set up.
// Returns false and writes to stderr if a file cannot be opened.
// Write here-doc body to a pipe and return the read end; caller must close it.
// Returns -1 on failure.
static int makeHereDocPipe(const std::string& body) {
    int fds[2];
    if (pipe(fds) != 0) return -1;
    // Write body to write end — if body is larger than PIPE_BUF this could
    // block, but here-docs in practice are small.
    const char* p = body.c_str();
    size_t left = body.size();
    while (left > 0) {
        ssize_t n = write(fds[1], p, left);
        if (n <= 0) break;
        p += n; left -= static_cast<size_t>(n);
    }
    close(fds[1]);
    return fds[0];
}

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

        } else if (op == "<<" || op == "<<-") {
            // Here-doc: body is in target, create a pipe.
            int readFd = makeHereDocPipe(r.target);
            if (readFd < 0) {
                writeErr("jsh: here-doc pipe failed\n");
                return false;
            }
            int dst = (r.fd >= 0) ? r.fd : STDIN_FILENO;
            dup2(readFd, dst);
            close(readFd);

        } else if (op == "<<<") {
            // Here-string: body is in target + newline.
            std::string body = r.target + "\n";
            int readFd = makeHereDocPipe(body);
            if (readFd < 0) {
                writeErr("jsh: here-string pipe failed\n");
                return false;
            }
            int dst = (r.fd >= 0) ? r.fd : STDIN_FILENO;
            dup2(readFd, dst);
            close(readFd);

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

static bool g_interactive = false;

// ---- Wait request (used by mixed-pipeline path) ---------------------------

struct WaitRequest {
    std::vector<pid_t> pids;
    int pgid;
    SpawnCtx* ctx;
};

static void processWait(WaitRequest* req) {
    int lastCode = 0;
    bool foreground = req->pgid > 0;
    int waitFlags = foreground ? WUNTRACED : 0;
    req->ctx->pipeStatus.resize(req->pids.size(), 0);
    req->ctx->pgid = req->pgid;
    for (size_t i = 0; i < req->pids.size(); i++) {
        int status = 0;
        waitpid(req->pids[i], &status, waitFlags);
        if (WIFSTOPPED(status)) {
            req->ctx->stopped = true;
            req->ctx->stoppedSignal = WSTOPSIG(status);
            req->ctx->exitCode = 128 + WSTOPSIG(status);
            req->ctx->pids = req->pids;
            if (g_interactive && req->pgid > 0)
                tcsetpgrp(STDIN_FILENO, getpgrp());
            req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
            delete req;
            return;
        }
        int code = WIFEXITED(status)   ? WEXITSTATUS(status) :
                   WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
        req->ctx->pipeStatus[i] = code;
        if (i == req->pids.size() - 1) lastCode = code;
    }
    if (g_interactive && req->pgid > 0)
        tcsetpgrp(STDIN_FILENO, getpgrp());
    req->ctx->exitCode = lastCode;
    req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
    delete req;
}

// ---- Executor state ------------------------------------------------------

struct ExecutorState {
    std::thread thread;
    std::mutex mutex;
    std::condition_variable cv;
    std::queue<PipelineRequest*> queue;
    std::queue<WaitRequest*> waitQueue;
    bool running = true;

    void start() {
        thread = std::thread(&ExecutorState::run, this);
        thread.detach();
    }

    void enqueue(PipelineRequest* req) {
        std::lock_guard<std::mutex> lock(mutex);
        queue.push(req);
        cv.notify_one();
    }

    void enqueueWait(WaitRequest* req) {
        std::lock_guard<std::mutex> lock(mutex);
        waitQueue.push(req);
        cv.notify_one();
    }

    void run() {
        while (true) {
            PipelineRequest* req = nullptr;
            WaitRequest* wreq = nullptr;
            {
                std::unique_lock<std::mutex> lock(mutex);
                cv.wait(lock, [this] {
                    return !queue.empty() || !waitQueue.empty() || !running;
                });
                if (!running && queue.empty() && waitQueue.empty()) break;
                if (!queue.empty()) {
                    req = queue.front(); queue.pop();
                } else if (!waitQueue.empty()) {
                    wreq = waitQueue.front(); waitQueue.pop();
                }
            }
            if (req) processPipeline(req);
            if (wreq) processWait(wreq);
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

        // Capture pipe: capturePipe[0]=read, capturePipe[1]=write.
        // The last stage's stdout is redirected to capturePipe[1].
        int capturePipe[2] = {-1, -1};
        if (req->captureOutput) {
            if (pipe(capturePipe) != 0) {
                for (auto& p : pipes) { close(p[0]); close(p[1]); }
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
                } else if (capturePipe[1] != -1) {
                    // Last stage: redirect stdout to capture pipe.
                    dup2(capturePipe[1], STDOUT_FILENO);
                }

                // Close all pipe fds — child only needs the two it dup2'd.
                for (int j = 0; j < n - 1; j++) {
                    close(pipes[j][0]);
                    close(pipes[j][1]);
                }
                if (capturePipe[0] != -1) close(capturePipe[0]);
                if (capturePipe[1] != -1) close(capturePipe[1]);

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

        // Store pgid for job control.
        req->ctx->pgid = pgid;

        // Background mode: don't give terminal, don't wait.
        if (req->background) {
            req->ctx->exitCode = 0;
            req->ctx->pids = pids;
            req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
            delete req;
            return;
        }

        if (!req->captureOutput && g_interactive && pgid > 0) {
            tcsetpgrp(STDIN_FILENO, pgid);
        }

        // For capture mode: close write end, drain read end before waitpid.
        // Draining first avoids deadlock when the pipe buffer fills.
        if (req->captureOutput && capturePipe[1] != -1) {
            close(capturePipe[1]);
            char buf[4096];
            ssize_t nread;
            while ((nread = read(capturePipe[0], buf, sizeof(buf))) > 0) {
                req->ctx->capturedOutput.append(buf, static_cast<size_t>(nread));
            }
            close(capturePipe[0]);
        }

        // Wait for all children; collect per-stage exit codes.
        // Use WUNTRACED for foreground jobs so we detect Ctrl-Z (SIGTSTP).
        int lastExitCode = 0;
        int waitFlags = req->captureOutput ? 0 : WUNTRACED;
        req->ctx->pipeStatus.resize(pids.size(), 0);
        for (size_t i = 0; i < pids.size(); i++) {
            int status = 0;
            waitpid(pids[i], &status, waitFlags);
            if (WIFSTOPPED(status)) {
                // Job was stopped (Ctrl-Z). All processes in the group
                // received SIGTSTP — break immediately.
                req->ctx->stopped = true;
                req->ctx->stoppedSignal = WSTOPSIG(status);
                req->ctx->exitCode = 128 + WSTOPSIG(status);
                req->ctx->pids = pids;
                // Return terminal to shell.
                if (g_interactive && pgid > 0) {
                    tcsetpgrp(STDIN_FILENO, getpgrp());
                }
                req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
                delete req;
                return;
            }
            int code = WIFEXITED(status)  ? WEXITSTATUS(status) :
                       WIFSIGNALED(status)? 128 + WTERMSIG(status) : 1;
            req->ctx->pipeStatus[i] = code;
            if (i == pids.size() - 1) {
                lastExitCode = code;
            }
        }

        if (!req->captureOutput && g_interactive && pgid > 0) {
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

// Parse JS stages/pipeOps arrays — shared by SpawnPipeline and CaptureOutput.
static bool parseStages(Napi::Env env, Napi::Array jsStages, Napi::Array jsPipeOps,
                        std::vector<StageSpec>& stages, std::vector<std::string>& pipeOps) {
    for (uint32_t i = 0; i < jsStages.Length(); i++) {
        Napi::Object jsStage = jsStages.Get(i).As<Napi::Object>();
        StageSpec stage;
        stage.cmd = jsStage.Get("cmd").As<Napi::String>().Utf8Value();

        Napi::Array jsArgs = jsStage.Get("args").As<Napi::Array>();
        for (uint32_t j = 0; j < jsArgs.Length(); j++)
            stage.args.push_back(jsArgs.Get(j).As<Napi::String>().Utf8Value());

        Napi::Array jsRedirs = jsStage.Get("redirs").As<Napi::Array>();
        for (uint32_t j = 0; j < jsRedirs.Length(); j++) {
            Napi::Object r = jsRedirs.Get(j).As<Napi::Object>();
            RedirSpec redir;
            redir.op       = r.Get("op").As<Napi::String>().Utf8Value();
            Napi::Value fdVal = r.Get("fd");
            redir.fd       = fdVal.IsNumber() ? fdVal.As<Napi::Number>().Int32Value() : -1;
            redir.target   = r.Get("target").As<Napi::String>().Utf8Value();
            Napi::Value hdVal = r.Get("isHereDoc");
            redir.isHereDoc = hdVal.IsBoolean() && hdVal.As<Napi::Boolean>().Value();
            stage.redirs.push_back(std::move(redir));
        }
        stages.push_back(std::move(stage));
    }
    for (uint32_t i = 0; i < jsPipeOps.Length(); i++)
        pipeOps.push_back(jsPipeOps.Get(i).As<Napi::String>().Utf8Value());
    return true;
}

static SpawnCtx* makeCtx(Napi::Env env, bool capture) {
    auto deferred = Napi::Promise::Deferred::New(env);
    auto* ctx = new SpawnCtx { deferred };
    ctx->captureOutput = capture;
    ctx->tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "spawn_complete", 0, 1
    );
    return ctx;
}

static Napi::Value SpawnPipeline(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_executor) {
        Napi::Error::New(env, "Executor not initialized").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "spawnPipeline(stages, pipeOps)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::vector<StageSpec> stages;
    std::vector<std::string> pipeOps;
    parseStages(env, info[0].As<Napi::Array>(), info[1].As<Napi::Array>(), stages, pipeOps);
    bool background = info.Length() > 2 && info[2].IsBoolean() && info[2].As<Napi::Boolean>().Value();
    auto* ctx = makeCtx(env, false);
    g_executor->enqueue(new PipelineRequest { std::move(stages), std::move(pipeOps), ctx, false, background });
    return ctx->deferred.Promise();
}

static Napi::Value CaptureOutput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_executor) {
        Napi::Error::New(env, "Executor not initialized").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "captureOutput(stages, pipeOps)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::vector<StageSpec> stages;
    std::vector<std::string> pipeOps;
    parseStages(env, info[0].As<Napi::Array>(), info[1].As<Napi::Array>(), stages, pipeOps);
    auto* ctx = makeCtx(env, true);
    g_executor->enqueue(new PipelineRequest { std::move(stages), std::move(pipeOps), ctx, true });
    return ctx->deferred.Promise();
}

static Napi::Value GetEAGAIN(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), EAGAIN);
}

// ---- Mixed-pipeline helpers (JS function stages) ----------------------------

// Create a pipe with FD_CLOEXEC on both ends so it doesn't leak to unintended
// child processes.  The TS side selectively clears CLOEXEC before forking.
static Napi::Value CreateCloexecPipe(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int fds[2];
    if (pipe(fds) != 0) {
        Napi::Error::New(env, "pipe() failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    fcntl(fds[1], F_SETFD, FD_CLOEXEC);
    Napi::Array arr = Napi::Array::New(env, 2);
    arr.Set(0u, Napi::Number::New(env, fds[0]));
    arr.Set(1u, Napi::Number::New(env, fds[1]));
    return arr;
}

// Clear FD_CLOEXEC on a specific fd so it survives exec in the next fork.
static Napi::Value ClearCloexec(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected fd").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int fd = info[0].As<Napi::Number>().Int32Value();
    int flags = fcntl(fd, F_GETFD);
    if (flags != -1) fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
    return env.Undefined();
}

// Fork+exec a single command with the given stdio fds, returning the pid
// immediately without waiting.  Runs on the calling thread (safe since exec
// replaces the image before any V8 locking issues can arise in the child).
static Napi::Value ForkExec(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "forkExec(cmd, args, stdinFd?, stdoutFd?, stderrFd?, pgid?)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string cmd = info[0].As<Napi::String>().Utf8Value();
    Napi::Array jsArgs = info[1].As<Napi::Array>();
    std::vector<std::string> args;
    for (uint32_t i = 0; i < jsArgs.Length(); i++)
        args.push_back(jsArgs.Get(i).As<Napi::String>().Utf8Value());

    int stdinFd  = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().Int32Value() : -1;
    int stdoutFd = info.Length() > 3 && info[3].IsNumber() ? info[3].As<Napi::Number>().Int32Value() : -1;
    int stderrFd = info.Length() > 4 && info[4].IsNumber() ? info[4].As<Napi::Number>().Int32Value() : -1;
    int pgid     = info.Length() > 5 && info[5].IsNumber() ? info[5].As<Napi::Number>().Int32Value() : 0;

    // Build argv before fork.
    std::vector<const char*> argv;
    argv.push_back(cmd.c_str());
    for (const auto& a : args) argv.push_back(a.c_str());
    argv.push_back(nullptr);

    pid_t pid = fork();
    if (pid == 0) {
        setpgid(0, pgid);

        sigset_t empty; sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, nullptr);
        struct sigaction sa = {};
        sa.sa_handler = SIG_DFL; sigemptyset(&sa.sa_mask);
        sigaction(SIGINT,  &sa, nullptr);
        sigaction(SIGTTOU, &sa, nullptr);
        sigaction(SIGTTIN, &sa, nullptr);
        sigaction(SIGPIPE, &sa, nullptr);

        if (stdinFd  != -1 && stdinFd  != STDIN_FILENO)  dup2(stdinFd,  STDIN_FILENO);
        if (stdoutFd != -1 && stdoutFd != STDOUT_FILENO) dup2(stdoutFd, STDOUT_FILENO);
        if (stderrFd != -1 && stderrFd != STDERR_FILENO) dup2(stderrFd, STDERR_FILENO);

        // Clear CLOEXEC on stdio so exec'd command inherits them.
        for (int fd : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
            int flags = fcntl(fd, F_GETFD);
            if (flags != -1 && (flags & FD_CLOEXEC))
                fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
        }

        execvp(cmd.c_str(), const_cast<char* const*>(argv.data()));
        writeErr("jsh: "); writeErr(cmd.c_str());
        writeErr(": "); writeErr(strerror(errno)); writeErr("\n");
        _exit(127);
    } else if (pid < 0) {
        Napi::Error::New(env, std::string("fork: ") + strerror(errno))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Parent: race-free pgid setup.
    setpgid(pid, pgid == 0 ? pid : pgid);
    return Napi::Number::New(env, pid);
}

static Napi::Value WaitForPids(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_executor) {
        Napi::Error::New(env, "Executor not initialized").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "waitForPids(pids: number[], pgid?: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array jsPids = info[0].As<Napi::Array>();
    std::vector<pid_t> pids;
    for (uint32_t i = 0; i < jsPids.Length(); i++)
        pids.push_back(static_cast<pid_t>(jsPids.Get(i).As<Napi::Number>().Int32Value()));

    int pgid = info.Length() > 1 && info[1].IsNumber()
                   ? info[1].As<Napi::Number>().Int32Value() : -1;

    auto* ctx = makeCtx(env, false);
    g_executor->enqueueWait(new WaitRequest { pids, pgid, ctx });
    return ctx->deferred.Promise();
}

// dup / dup2 wrappers for fd-level stdout redirection in captureAst.
static Napi::Value DupFd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "dupFd(fd)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int fd = dup(info[0].As<Napi::Number>().Int32Value());
    if (fd == -1) {
        Napi::Error::New(env, std::string("dup: ") + strerror(errno))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Number::New(env, fd);
}

static Napi::Value Dup2Fd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "dup2Fd(oldFd, newFd)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int result = dup2(info[0].As<Napi::Number>().Int32Value(),
                      info[1].As<Napi::Number>().Int32Value());
    if (result == -1) {
        Napi::Error::New(env, std::string("dup2: ") + strerror(errno))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Number::New(env, result);
}

// exec builtin: replace the current process with the given command.
// Resets signals, then calls execvp.  Only returns on error.
static Napi::Value Execvp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "execvp(cmd, args)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string cmd = info[0].As<Napi::String>().Utf8Value();
    Napi::Array jsArgs = info[1].As<Napi::Array>();
    std::vector<std::string> args;
    for (uint32_t i = 0; i < jsArgs.Length(); i++)
        args.push_back(jsArgs.Get(i).As<Napi::String>().Utf8Value());

    std::vector<const char*> argv;
    argv.push_back(cmd.c_str());
    for (const auto& a : args) argv.push_back(a.c_str());
    argv.push_back(nullptr);

    // Reset all signals to default before exec.
    sigset_t empty; sigemptyset(&empty);
    sigprocmask(SIG_SETMASK, &empty, nullptr);
    struct sigaction sa = {};
    sa.sa_handler = SIG_DFL; sigemptyset(&sa.sa_mask);
    sigaction(SIGINT,  &sa, nullptr);
    sigaction(SIGTTOU, &sa, nullptr);
    sigaction(SIGTTIN, &sa, nullptr);
    sigaction(SIGPIPE, &sa, nullptr);

    // Ensure stdio fds survive exec (clear CLOEXEC).
    for (int fd : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
        int flags = fcntl(fd, F_GETFD);
        if (flags != -1 && (flags & FD_CLOEXEC))
            fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
    }

    execvp(cmd.c_str(), const_cast<char* const*>(argv.data()));
    // Only reached on error
    int err = errno;
    Napi::Error::New(env, std::string("exec: ") + cmd + ": " + strerror(err))
        .ThrowAsJavaScriptException();
    return Napi::Number::New(env, err == ENOENT ? 127 : 126);
}

// ---- Job control helpers --------------------------------------------------

static Napi::Value SendSignal(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "sendSignal(pid, signal)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int pid = info[0].As<Napi::Number>().Int32Value();
    int sig = info[1].As<Napi::Number>().Int32Value();
    int rc = kill(pid, sig);
    return Napi::Number::New(env, rc);
}

static Napi::Value ReapChildren(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array results = Napi::Array::New(env);
    uint32_t idx = 0;
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG | WUNTRACED)) > 0) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("pid", Napi::Number::New(env, static_cast<int>(pid)));
        if (WIFEXITED(status)) {
            obj.Set("exitCode", Napi::Number::New(env, WEXITSTATUS(status)));
            obj.Set("stopped", Napi::Boolean::New(env, false));
        } else if (WIFSIGNALED(status)) {
            obj.Set("exitCode", Napi::Number::New(env, 128 + WTERMSIG(status)));
            obj.Set("stopped", Napi::Boolean::New(env, false));
        } else if (WIFSTOPPED(status)) {
            obj.Set("exitCode", Napi::Number::New(env, 128 + WSTOPSIG(status)));
            obj.Set("stopped", Napi::Boolean::New(env, true));
        }
        results.Set(idx++, obj);
    }
    return results;
}

static Napi::Value TcsetpgrpFg(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "tcsetpgrpFg(pgid)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    tcsetpgrp(STDIN_FILENO, info[0].As<Napi::Number>().Int32Value());
    return env.Undefined();
}

static Napi::Value TcsetpgrpShell(const Napi::CallbackInfo& info) {
    tcsetpgrp(STDIN_FILENO, getpgrp());
    return info.Env().Undefined();
}

Napi::Object InitExecutor(Napi::Env env, Napi::Object exports) {
    exports.Set("initExecutor",     Napi::Function::New(env, InitExecutor_));
    exports.Set("spawnPipeline",    Napi::Function::New(env, SpawnPipeline));
    exports.Set("captureOutput",    Napi::Function::New(env, CaptureOutput));
    exports.Set("createCloexecPipe",Napi::Function::New(env, CreateCloexecPipe));
    exports.Set("clearCloexec",     Napi::Function::New(env, ClearCloexec));
    exports.Set("forkExec",         Napi::Function::New(env, ForkExec));
    exports.Set("waitForPids",      Napi::Function::New(env, WaitForPids));
    exports.Set("EAGAIN",           Napi::Function::New(env, GetEAGAIN));
    exports.Set("execvp",           Napi::Function::New(env, Execvp));
    exports.Set("dupFd",            Napi::Function::New(env, DupFd));
    exports.Set("dup2Fd",           Napi::Function::New(env, Dup2Fd));
    exports.Set("sendSignal",       Napi::Function::New(env, SendSignal));
    exports.Set("reapChildren",     Napi::Function::New(env, ReapChildren));
    exports.Set("tcsetpgrpFg",      Napi::Function::New(env, TcsetpgrpFg));
    exports.Set("tcsetpgrpShell",   Napi::Function::New(env, TcsetpgrpShell));
    exports.Set("SIGCONT",          Napi::Number::New(env, SIGCONT));
    exports.Set("SIGTSTP",          Napi::Number::New(env, SIGTSTP));
    exports.Set("SIGTERM",          Napi::Number::New(env, SIGTERM));
    return exports;
}

} // namespace jsh
