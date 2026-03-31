#include "executor.h"
#include <napi.h>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace jsh {

// Resolved on the main thread once the child exits.
struct SpawnCtx {
    Napi::Promise::Deferred deferred;
    Napi::ThreadSafeFunction tsfn;
    int exitCode = -1;
};

struct SpawnRequest {
    std::string cmd;
    std::vector<std::string> args;
    SpawnCtx* ctx;
};

// Runs on the main thread via TSFN — resolves the JS Promise.
static void OnSpawnDone(Napi::Env env, Napi::Function, SpawnCtx* ctx) {
    Napi::HandleScope scope(env);
    ctx->deferred.Resolve(Napi::Number::New(env, ctx->exitCode));
    ctx->tsfn.Release();
    delete ctx;
}

static bool g_interactive = false;

struct ExecutorState {
    std::thread thread;
    std::mutex mutex;
    std::condition_variable cv;
    std::queue<SpawnRequest*> queue;
    bool running = true;

    void start() {
        thread = std::thread(&ExecutorState::run, this);
    }

    void enqueue(SpawnRequest* req) {
        std::lock_guard<std::mutex> lock(mutex);
        queue.push(req);
        cv.notify_one();
    }

    void run() {
        while (true) {
            SpawnRequest* req = nullptr;
            {
                std::unique_lock<std::mutex> lock(mutex);
                cv.wait(lock, [this] { return !queue.empty() || !running; });
                if (!running && queue.empty()) break;
                req = queue.front();
                queue.pop();
            }
            processRequest(req);
        }
    }

    void processRequest(SpawnRequest* req) {
        // Build argv before forking — malloc is not safe in the child of a
        // multithreaded process (allocator mutex may be held by another thread).
        std::vector<const char*> argv;
        argv.push_back(req->cmd.c_str());
        for (const auto& a : req->args) argv.push_back(a.c_str());
        argv.push_back(nullptr);

        pid_t pid = fork();

        if (pid == 0) {
            // Child — put in own process group, reset signal mask, exec.
            // Only async-signal-safe calls from here until exec.
            setpgid(0, 0);

            sigset_t empty;
            sigemptyset(&empty);
            sigprocmask(SIG_SETMASK, &empty, nullptr);

            // Reset signals to default — child inherits SIG_IGN for SIGTTOU/SIGTTIN.
            struct sigaction sa = {};
            sa.sa_handler = SIG_DFL;
            sigemptyset(&sa.sa_mask);
            sigaction(SIGINT,  &sa, nullptr);
            sigaction(SIGTTOU, &sa, nullptr);
            sigaction(SIGTTIN, &sa, nullptr);

            // Node.js sets O_CLOEXEC on stdin/stdout/stderr so they would be
            // closed on exec. Clear it so spawned commands inherit them normally.
            for (int fd : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
                int flags = fcntl(fd, F_GETFD);
                if (flags != -1 && (flags & FD_CLOEXEC)) {
                    fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
                }
            }
            execvp(req->cmd.c_str(), const_cast<char* const*>(argv.data()));

            // exec failed — write error directly, no malloc
            const char* cmd = req->cmd.c_str();
            const char* err = strerror(errno);
            write(STDERR_FILENO, "jsh: exec failed: ", 18);
            write(STDERR_FILENO, cmd, strlen(cmd));
            write(STDERR_FILENO, ": ", 2);
            write(STDERR_FILENO, err, strlen(err));
            write(STDERR_FILENO, "\n", 1);
            _exit(127);

        } else if (pid > 0) {
            // Parent (executor thread) — give terminal to child, wait, reclaim.
            setpgid(pid, pid); // race-free double call with child

            if (g_interactive) {
                tcsetpgrp(STDIN_FILENO, pid);
            }

            int status = 0;
            waitpid(pid, &status, 0);

            if (g_interactive) {
                tcsetpgrp(STDIN_FILENO, getpgrp());
            }

            int exitCode;
            if (WIFEXITED(status)) {
                exitCode = WEXITSTATUS(status);
            } else if (WIFSIGNALED(status)) {
                exitCode = 128 + WTERMSIG(status);
            } else {
                exitCode = 1;
            }

            req->ctx->exitCode = exitCode;
            req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
            delete req;

        } else {
            // fork failed
            std::string msg = "jsh: fork: ";
            msg += strerror(errno);
            msg += "\n";
            write(STDERR_FILENO, msg.c_str(), msg.size());
            req->ctx->exitCode = 1;
            req->ctx->tsfn.NonBlockingCall(req->ctx, OnSpawnDone);
            delete req;
        }
    }
};

static ExecutorState* g_executor = nullptr;

static Napi::Value InitExecutor_(const Napi::CallbackInfo& info) {
    if (g_executor) return info.Env().Undefined();

    // Ignore SIGTTOU and SIGTTIN — standard for interactive shells.
    // Without this, tcsetpgrp() from a non-foreground process sends SIGTTOU
    // to the shell, stopping it.
    struct sigaction sa = {};
    sa.sa_handler = SIG_IGN;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTTOU, &sa, nullptr);
    sigaction(SIGTTIN, &sa, nullptr);

    // Block SIGCHLD and SIGINT on the main thread so Node doesn't handle them.
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    sigaddset(&mask, SIGINT);
    sigprocmask(SIG_BLOCK, &mask, nullptr);

    g_interactive = isatty(STDIN_FILENO);

    if (g_interactive) {
        // Ensure jsh is in its own process group and has terminal control.
        pid_t pid = getpid();
        if (getpgrp() != pid) {
            setpgid(pid, pid);
        }
        tcsetpgrp(STDIN_FILENO, pid);
    }

    g_executor = new ExecutorState();
    g_executor->start();

    return info.Env().Undefined();
}

static Napi::Value Spawn(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_executor) {
        Napi::Error::New(env, "Executor not initialized — call initExecutor() first")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "spawn(cmd: string, args: string[])")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string cmd = info[0].As<Napi::String>().Utf8Value();
    Napi::Array jsArgs = info[1].As<Napi::Array>();
    std::vector<std::string> args;
    for (uint32_t i = 0; i < jsArgs.Length(); i++) {
        args.push_back(jsArgs.Get(i).As<Napi::String>().Utf8Value());
    }

    auto deferred = Napi::Promise::Deferred::New(env);

    auto* ctx = new SpawnCtx { deferred };
    ctx->tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "spawn_complete",
        0, // unlimited queue
        1  // one thread
    );

    g_executor->enqueue(new SpawnRequest { cmd, args, ctx });

    return deferred.Promise();
}

// Expose EAGAIN so JS can distinguish Ctrl-C from EOF.
static Napi::Value GetEAGAIN(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), EAGAIN);
}

Napi::Object InitExecutor(Napi::Env env, Napi::Object exports) {
    exports.Set("initExecutor", Napi::Function::New(env, InitExecutor_));
    exports.Set("spawn",        Napi::Function::New(env, Spawn));
    exports.Set("EAGAIN",       Napi::Function::New(env, GetEAGAIN));
    return exports;
}

} // namespace jsh
