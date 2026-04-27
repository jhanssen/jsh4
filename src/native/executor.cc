#include "executor.h"
#include <cerrno>
#include <csignal>
#include <cstring>
#include <atomic>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <array>
#include <fcntl.h>
#include <sys/stat.h>
#include <spawn.h>
#include <sys/wait.h>
#include <uv.h>
#include <unistd.h>

extern "C" char **environ;

namespace jsh {

// ---- Forward decls --------------------------------------------------------
struct SpawnCtx;
static void maybeFinalize(SpawnCtx* ctx);
static void resolveCtxPromise(SpawnCtx* ctx);

// ---- Global state ---------------------------------------------------------
static napi_env g_env = nullptr;
static bool g_interactive = false;
static uv_signal_t g_sigchld;

struct PendingChild {
    SpawnCtx* ctx;        // nullptr when this pid belongs to a background job
    size_t    stageIdx;   // which ctx->pipeStatus slot to fill
};

// All pids the shell is tracking. Background pids use ctx==nullptr.
static std::unordered_map<pid_t, PendingChild> g_pending;

// Pids returned by forkExec that haven't been handed to waitForPids yet.
// SIGCHLD parks the raw wait status here, so a wait call arriving after the
// process already exited still sees the result.
struct OrphanStatus {
    int  status = 0;
    bool reaped = false;
};
static std::unordered_map<pid_t, OrphanStatus> g_orphans;

struct BgExit {
    pid_t pid;
    int   exitCode;
    bool  stopped;
    int   stoppedSignal;
};
// Completion buffer for background jobs — drained by reapChildren() from JS.
static std::vector<BgExit> g_bg_completions;

struct SpawnCtx {
    Napi::Promise::Deferred deferred;
    int  exitCode = -1;
    bool captureOutput = false;
    std::string capturedOutput;
    std::vector<int> pipeStatus;
    bool stopped = false;
    int  stoppedSignal = 0;
    pid_t pgid = -1;
    std::vector<pid_t> pids;

    // Lifecycle tracking.
    int  pendingPids = 0;            // siblings still unreaped
    bool foreground  = false;        // true iff tcsetpgrp'd to pgid
    uv_poll_t* captureWatch = nullptr;
    int  captureFd   = -1;
    bool captureEof  = false;
    bool resolved    = false;
};

// ---- Redirection and stage specs -----------------------------------------

struct RedirSpec {
    std::string op;
    int fd = -1;
    std::string target;
    bool isHereDoc = false;
};

struct StageSpec {
    std::string cmd;
    std::vector<std::string> args;
    std::vector<RedirSpec> redirs;
};

// ---- Helpers used in the child (post-fork, pre-exec) ---------------------
// Keep these async-signal-safe or provably safe-after-fork.

static void writeErr(const char* s) {
    [[maybe_unused]] auto _w = write(STDERR_FILENO, s, strlen(s));
}

// Write here-doc body to a pipe and return the read end; caller must close it.
static int makeHereDocPipe(const std::string& body) {
    int fds[2];
    if (pipe(fds) != 0) return -1;
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
            int readFd = makeHereDocPipe(r.target);
            if (readFd < 0) {
                writeErr("jsh: here-doc pipe failed\n");
                return false;
            }
            int dst = (r.fd >= 0) ? r.fd : STDIN_FILENO;
            dup2(readFd, dst);
            close(readFd);

        } else if (op == "<<<") {
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

static void clearCloexecStdio() {
    for (int fd : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
        int flags = fcntl(fd, F_GETFD);
        if (flags != -1 && (flags & FD_CLOEXEC)) {
            fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
        }
    }
}

static bool stagesCanPosixSpawn(const std::vector<StageSpec>& stages) {
    for (const auto& stage : stages) {
        for (const auto& r : stage.redirs) {
            if (r.op == "<<" || r.op == "<<-" || r.op == "<<<")
                return false;
        }
    }
    return true;
}

// ---- Pid tracking ---------------------------------------------------------

// Refcount of pids we still need SIGCHLD for. The signal watcher is
// uv_unref'd by default so the steady "no children" state doesn't keep the
// loop alive — but while we have at least one pending pid that some Promise
// is awaiting, the watcher must be ref'd. Otherwise the loop can drain
// (capture-pipe handle closes on EOF, Promise still pending), Node enters
// cleanup, the SIGCHLD finally fires during cleanup-drain, and
// resolveCtxPromise crashes calling napi on a dying env.
//
// Background pids (ctx == nullptr) deliberately do NOT acquire — script-mode
// `cmd &` should orphan to init when the script exits, matching bash. Their
// SIGCHLD is best-effort recorded by reapChildren when the loop is alive
// for other reasons (interactive input handle, etc.).
static int g_sigchldRefcount = 0;

static void sigchldRefAcquire() {
    if (g_sigchldRefcount++ == 0) {
        uv_ref(reinterpret_cast<uv_handle_t*>(&g_sigchld));
    }
}

static void sigchldRefRelease() {
    if (g_sigchldRefcount > 0 && --g_sigchldRefcount == 0) {
        uv_unref(reinterpret_cast<uv_handle_t*>(&g_sigchld));
    }
}

static void registerPid(pid_t pid, SpawnCtx* ctx, size_t stageIdx) {
    g_pending[pid] = PendingChild { ctx, stageIdx };
    if (ctx) {
        ctx->pendingPids++;
        sigchldRefAcquire();
    }
}

// Erase a g_pending entry; release the SIGCHLD ref iff it was ctx-bound
// (since only ctx-bound registerPid calls acquire). Use this in code paths
// that don't already know whether the entry was foreground or background.
static void erasePending(pid_t pid) {
    auto it = g_pending.find(pid);
    if (it == g_pending.end()) return;
    bool wasCtx = it->second.ctx != nullptr;
    g_pending.erase(it);
    if (wasCtx) sigchldRefRelease();
}

// Called from the SIGCHLD handler when a foreground pid reports stopped.
// Stops apply to the whole process group — collect remaining ctx pids for
// the job table and drop them from g_pending (they'll be re-registered via
// waitForPids when fg/bg resumes the job).
static void handleStopped(SpawnCtx* ctx, int status) {
    if (!ctx) return;  // background job — shouldn't normally stop via WUNTRACED
    ctx->stopped = true;
    ctx->stoppedSignal = WSTOPSIG(status);
    ctx->exitCode = 128 + WSTOPSIG(status);

    // Gather remaining pids for this ctx (so JS can track them in the job
    // table) and remove them from our pending map. Re-park each one as an
    // orphan with reaped=false so a SIGCHLD that arrives before the next
    // waitForPids (e.g. an external SIGCONT racing the user's `fg`) can
    // park the new status. Without this, the second-state-change SIGCHLD
    // finds the pid in neither g_pending nor g_orphans, and the JS side
    // never sees the exit — the eventual `fg` then waits forever for an
    // already-gone pid.
    std::vector<pid_t> remaining;
    for (auto it = g_pending.begin(); it != g_pending.end(); ) {
        if (it->second.ctx == ctx) {
            pid_t p = it->first;
            remaining.push_back(p);
            it = g_pending.erase(it);
            sigchldRefRelease();
            g_orphans[p] = OrphanStatus { 0, false };
        } else {
            ++it;
        }
    }
    // Also include pids that already exited cleanly before the stop fired.
    // ctx->pids may already be populated from earlier siblings — merge.
    for (pid_t p : remaining) ctx->pids.push_back(p);
    ctx->pendingPids = 0;

    if (g_interactive && ctx->foreground && ctx->pgid > 0) {
        tcsetpgrp(STDIN_FILENO, getpgrp());
    }
    maybeFinalize(ctx);
}

// ---- Capture pipe drain (uv_poll_t on the read end) ----------------------

static void onPollClose(uv_handle_t* h) {
    delete reinterpret_cast<uv_poll_t*>(h);
}

static void onCaptureReadable(uv_poll_t* h, int /*status*/, int /*events*/) {
    SpawnCtx* ctx = static_cast<SpawnCtx*>(h->data);
    char buf[4096];
    for (;;) {
        ssize_t n = read(ctx->captureFd, buf, sizeof(buf));
        if (n > 0) {
            ctx->capturedOutput.append(buf, static_cast<size_t>(n));
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            // Pipe drained for now; wait for next readable event.
            return;
        }
        // EOF (n == 0) or a real error — tear down.
        uv_poll_stop(h);
        uv_close(reinterpret_cast<uv_handle_t*>(h), onPollClose);
        close(ctx->captureFd);
        ctx->captureFd = -1;
        ctx->captureWatch = nullptr;
        ctx->captureEof = true;
        maybeFinalize(ctx);
        return;
    }
}

// ---- Resolution -----------------------------------------------------------

static void resolveCtxPromise(SpawnCtx* ctx) {
    if (ctx->resolved) return;
    ctx->resolved = true;

    Napi::Env env(g_env);
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
                pidsArr.Set(static_cast<uint32_t>(i),
                            Napi::Number::New(env, static_cast<int>(ctx->pids[i])));
            }
            result.Set("pids", pidsArr);
        }
        ctx->deferred.Resolve(result);
    }
}

static void maybeFinalize(SpawnCtx* ctx) {
    if (ctx->pendingPids > 0) return;                   // children still running
    if (ctx->captureWatch && !ctx->captureEof) return;  // capture still draining
    resolveCtxPromise(ctx);
    delete ctx;
}

// ---- SIGCHLD handler ------------------------------------------------------

static void onSigChld(uv_signal_t*, int /*signum*/) {
    pid_t pid;
    int status;
    while ((pid = waitpid(-1, &status, WNOHANG | WUNTRACED)) > 0) {
        auto it = g_pending.find(pid);
        if (it == g_pending.end()) {
            // Not in pending — might be a forkExec'd orphan waiting for its
            // waitForPids call. Park the status so waitForPids can retrieve
            // it; otherwise the exit goes unnoticed and the Promise hangs.
            auto oit = g_orphans.find(pid);
            if (oit != g_orphans.end()) {
                oit->second.status = status;
                oit->second.reaped = true;
            }
            continue;
        }

        SpawnCtx* ctx = it->second.ctx;
        size_t idx = it->second.stageIdx;
        g_pending.erase(it);
        if (ctx) sigchldRefRelease();

        if (!ctx) {
            // Background job — record for reapChildren drain.
            BgExit ex { pid, 0, false, 0 };
            if (WIFEXITED(status))       ex.exitCode = WEXITSTATUS(status);
            else if (WIFSIGNALED(status)) ex.exitCode = 128 + WTERMSIG(status);
            else if (WIFSTOPPED(status)) {
                ex.stopped = true;
                ex.stoppedSignal = WSTOPSIG(status);
                ex.exitCode = 128 + WSTOPSIG(status);
            }
            g_bg_completions.push_back(ex);
            continue;
        }

        if (WIFSTOPPED(status)) {
            // Save already-completed sibling pids before handleStopped clears.
            // pipeStatus slots already filled stay; other slots remain 0.
            handleStopped(ctx, status);
            continue;
        }

        int code = WIFEXITED(status)   ? WEXITSTATUS(status)
                 : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;

        if (idx < ctx->pipeStatus.size()) ctx->pipeStatus[idx] = code;
        if (idx + 1 == ctx->pipeStatus.size()) ctx->exitCode = code;
        ctx->pendingPids--;

        if (ctx->pendingPids == 0) {
            // Last sibling of a foreground pipeline — return the terminal.
            // Capture and background pipelines never took it.
            if (g_interactive && ctx->foreground && ctx->pgid > 0) {
                tcsetpgrp(STDIN_FILENO, getpgrp());
            }
            maybeFinalize(ctx);
        }
    }
}

// ---- Pipeline spawn (runs inline on the main/V8 thread) -------------------

struct PipelineReq {
    std::vector<StageSpec>   stages;
    std::vector<std::string> pipeOps;
    bool captureOutput = false;
    bool background    = false;
    // -1 = inherit from parent. When set, applies as the default fd for
    // stage 0 stdin / stage n-1 stdout (capture mode ignores stdoutFd) /
    // every stage's stderr — only when no explicit redirection overrides.
    int  stdinFd  = -1;
    int  stdoutFd = -1;
    int  stderrFd = -1;
};

// Spawn all stages and register their pids. Returns false on unrecoverable
// failure, having already resolved ctx with an error exitCode.
static bool spawnPipelineInline(PipelineReq& req, SpawnCtx* ctx) {
    const auto& stages = req.stages;
    const auto& pipeOps = req.pipeOps;
    int n = static_cast<int>(stages.size());

    std::vector<std::vector<const char*>> argvs(n);
    for (int i = 0; i < n; i++) {
        argvs[i].push_back(stages[i].cmd.c_str());
        for (const auto& a : stages[i].args) argvs[i].push_back(a.c_str());
        argvs[i].push_back(nullptr);
    }

    std::vector<std::array<int, 2>> pipes(n - 1);
    for (int i = 0; i < n - 1; i++) {
        if (pipe(pipes[i].data()) != 0) {
            for (int j = 0; j < i; j++) { close(pipes[j][0]); close(pipes[j][1]); }
            ctx->exitCode = 1;
            resolveCtxPromise(ctx);
            delete ctx;
            return false;
        }
    }

    int capturePipe[2] = {-1, -1};
    if (req.captureOutput) {
        if (pipe(capturePipe) != 0) {
            for (auto& p : pipes) { close(p[0]); close(p[1]); }
            ctx->exitCode = 1;
            resolveCtxPromise(ctx);
            delete ctx;
            return false;
        }
    }

    pid_t pgid = -1;
    std::vector<pid_t> pids;
    ctx->pipeStatus.resize(n, 0);

    if (stagesCanPosixSpawn(stages)) {
        for (int i = 0; i < n; i++) {
            posix_spawnattr_t attr;
            posix_spawn_file_actions_t actions;
            posix_spawnattr_init(&attr);
            posix_spawn_file_actions_init(&actions);

            short flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
            posix_spawnattr_setflags(&attr, flags);
            posix_spawnattr_setpgroup(&attr, pgid == -1 ? 0 : pgid);

            sigset_t emptyMask; sigemptyset(&emptyMask);
            posix_spawnattr_setsigmask(&attr, &emptyMask);

            sigset_t defSigs; sigemptyset(&defSigs);
            sigaddset(&defSigs, SIGINT);
            sigaddset(&defSigs, SIGTTOU);
            sigaddset(&defSigs, SIGTTIN);
            sigaddset(&defSigs, SIGPIPE);
            posix_spawnattr_setsigdefault(&attr, &defSigs);

            bool stdinSet = false, stdoutSet = false, stderrSet = false;

            if (i > 0) {
                posix_spawn_file_actions_adddup2(&actions, pipes[i - 1][0], STDIN_FILENO);
                stdinSet = true;
            } else if (req.stdinFd >= 0 && req.stdinFd != STDIN_FILENO) {
                posix_spawn_file_actions_adddup2(&actions, req.stdinFd, STDIN_FILENO);
                stdinSet = true;
            }
            if (i < n - 1) {
                posix_spawn_file_actions_adddup2(&actions, pipes[i][1], STDOUT_FILENO);
                stdoutSet = true;
                if (i < static_cast<int>(pipeOps.size()) && pipeOps[i] == "|&") {
                    posix_spawn_file_actions_adddup2(&actions, pipes[i][1], STDERR_FILENO);
                    stderrSet = true;
                }
            } else if (capturePipe[1] != -1) {
                posix_spawn_file_actions_adddup2(&actions, capturePipe[1], STDOUT_FILENO);
                stdoutSet = true;
            } else if (req.stdoutFd >= 0 && req.stdoutFd != STDOUT_FILENO) {
                posix_spawn_file_actions_adddup2(&actions, req.stdoutFd, STDOUT_FILENO);
                stdoutSet = true;
            }
            if (!stderrSet && req.stderrFd >= 0 && req.stderrFd != STDERR_FILENO) {
                posix_spawn_file_actions_adddup2(&actions, req.stderrFd, STDERR_FILENO);
                stderrSet = true;
            }

            for (int j = 0; j < n - 1; j++) {
                posix_spawn_file_actions_addclose(&actions, pipes[j][0]);
                posix_spawn_file_actions_addclose(&actions, pipes[j][1]);
            }
            if (capturePipe[0] != -1) posix_spawn_file_actions_addclose(&actions, capturePipe[0]);
            if (capturePipe[1] != -1) posix_spawn_file_actions_addclose(&actions, capturePipe[1]);

            for (const auto& r : stages[i].redirs) {
                if (r.op == ">" || r.op == ">>" || r.op == "&>" || r.op == "&>>") {
                    int oflags = O_WRONLY | O_CREAT;
                    oflags |= (r.op == ">>" || r.op == "&>>") ? O_APPEND : O_TRUNC;
                    int dst = (r.fd >= 0) ? r.fd : STDOUT_FILENO;
                    posix_spawn_file_actions_addopen(&actions, dst, r.target.c_str(), oflags, 0666);
                    if (dst == STDIN_FILENO) stdinSet = true;
                    if (dst == STDOUT_FILENO) stdoutSet = true;
                    if (dst == STDERR_FILENO) stderrSet = true;
                    if (r.op == "&>" || r.op == "&>>") {
                        posix_spawn_file_actions_adddup2(&actions, dst, STDERR_FILENO);
                        stderrSet = true;
                    }
                } else if (r.op == "<") {
                    int dst = (r.fd >= 0) ? r.fd : STDIN_FILENO;
                    posix_spawn_file_actions_addopen(&actions, dst, r.target.c_str(), O_RDONLY, 0);
                    if (dst == STDIN_FILENO) stdinSet = true;
                    if (dst == STDOUT_FILENO) stdoutSet = true;
                    if (dst == STDERR_FILENO) stderrSet = true;
                } else if (r.op == ">&") {
                    int src = (r.fd >= 0) ? r.fd : STDOUT_FILENO;
                    int dst = atoi(r.target.c_str());
                    posix_spawn_file_actions_adddup2(&actions, dst, src);
                    if (src == STDIN_FILENO) stdinSet = true;
                    if (src == STDOUT_FILENO) stdoutSet = true;
                    if (src == STDERR_FILENO) stderrSet = true;
                } else if (r.op == "<&") {
                    int src = (r.fd >= 0) ? r.fd : STDIN_FILENO;
                    int dst = atoi(r.target.c_str());
                    posix_spawn_file_actions_adddup2(&actions, dst, src);
                    if (src == STDIN_FILENO) stdinSet = true;
                    if (src == STDOUT_FILENO) stdoutSet = true;
                    if (src == STDERR_FILENO) stderrSet = true;
                }
            }

#ifdef __APPLE__
            if (!stdinSet)  posix_spawn_file_actions_addinherit_np(&actions, STDIN_FILENO);
            if (!stdoutSet) posix_spawn_file_actions_addinherit_np(&actions, STDOUT_FILENO);
            if (!stderrSet) posix_spawn_file_actions_addinherit_np(&actions, STDERR_FILENO);
#else
            if (!stdinSet)  posix_spawn_file_actions_adddup2(&actions, STDIN_FILENO,  STDIN_FILENO);
            if (!stdoutSet) posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDOUT_FILENO);
            if (!stderrSet) posix_spawn_file_actions_adddup2(&actions, STDERR_FILENO, STDERR_FILENO);
#endif

            pid_t pid;
            int err = posix_spawnp(&pid, stages[i].cmd.c_str(), &actions, &attr,
                                   const_cast<char* const*>(argvs[i].data()), environ);

            posix_spawnattr_destroy(&attr);
            posix_spawn_file_actions_destroy(&actions);

            if (err != 0) {
                writeErr("jsh: ");
                writeErr(stages[i].cmd.c_str());
                writeErr(": ");
                writeErr(strerror(err));
                writeErr("\n");
                // Close all remaining pipe fds.
                for (auto& p : pipes) { close(p[0]); close(p[1]); }
                if (capturePipe[0] != -1) close(capturePipe[0]);
                if (capturePipe[1] != -1) close(capturePipe[1]);
                // Reap any already-spawned children synchronously.
                for (pid_t p : pids) {
                    int st = 0; pid_t w;
                    do { w = waitpid(p, &st, 0); } while (w == -1 && errno == EINTR);
                    // Use erasePending (not raw erase) so the per-pid sigchld
                    // refcount is released. Bare g_pending.erase leaks a ref,
                    // keeping the SIGCHLD watcher alive after the loop should
                    // have drained — visible as the shell's event loop refusing
                    // to exit cleanly after a pipeline-spawn failure.
                    erasePending(p);
                }
                ctx->exitCode = 127;
                resolveCtxPromise(ctx);
                delete ctx;
                return false;
            }

            if (pgid == -1) pgid = pid;
            setpgid(pid, pgid);
            pids.push_back(pid);
        }
    } else {
        // Fork fallback for here-docs / here-strings.
        for (int i = 0; i < n; i++) {
            pid_t pid = fork();
            if (pid == 0) {
                if (pgid == -1) pgid = getpid();
                setpgid(0, pgid);

                sigset_t empty; sigemptyset(&empty);
                sigprocmask(SIG_SETMASK, &empty, nullptr);
                struct sigaction sa = {};
                sa.sa_handler = SIG_DFL; sigemptyset(&sa.sa_mask);
                sigaction(SIGINT,  &sa, nullptr);
                sigaction(SIGTTOU, &sa, nullptr);
                sigaction(SIGTTIN, &sa, nullptr);
                sigaction(SIGPIPE, &sa, nullptr);

                if (i > 0) dup2(pipes[i - 1][0], STDIN_FILENO);
                else if (req.stdinFd >= 0 && req.stdinFd != STDIN_FILENO) dup2(req.stdinFd, STDIN_FILENO);
                if (i < n - 1) {
                    dup2(pipes[i][1], STDOUT_FILENO);
                    if (i < static_cast<int>(pipeOps.size()) && pipeOps[i] == "|&") {
                        dup2(pipes[i][1], STDERR_FILENO);
                    }
                } else if (capturePipe[1] != -1) {
                    dup2(capturePipe[1], STDOUT_FILENO);
                } else if (req.stdoutFd >= 0 && req.stdoutFd != STDOUT_FILENO) {
                    dup2(req.stdoutFd, STDOUT_FILENO);
                }
                if (req.stderrFd >= 0 && req.stderrFd != STDERR_FILENO) {
                    bool mergeFromPipe = (i < n - 1)
                        && (i < static_cast<int>(pipeOps.size()))
                        && (pipeOps[i] == "|&");
                    if (!mergeFromPipe) dup2(req.stderrFd, STDERR_FILENO);
                }

                for (int j = 0; j < n - 1; j++) {
                    close(pipes[j][0]); close(pipes[j][1]);
                }
                if (capturePipe[0] != -1) close(capturePipe[0]);
                if (capturePipe[1] != -1) close(capturePipe[1]);

                if (!applyRedirections(stages[i].redirs)) _exit(1);
                clearCloexecStdio();
                execvp(stages[i].cmd.c_str(),
                       const_cast<char* const*>(argvs[i].data()));

                writeErr("jsh: ");
                writeErr(stages[i].cmd.c_str());
                writeErr(": ");
                writeErr(strerror(errno));
                writeErr("\n");
                _exit(127);

            } else if (pid > 0) {
                if (pgid == -1) pgid = pid;
                setpgid(pid, pgid);
                pids.push_back(pid);
            } else {
                writeErr("jsh: fork: ");
                writeErr(strerror(errno));
                writeErr("\n");
                for (auto& p : pipes) { close(p[0]); close(p[1]); }
                if (capturePipe[0] != -1) close(capturePipe[0]);
                if (capturePipe[1] != -1) close(capturePipe[1]);
                for (pid_t p : pids) {
                    int st = 0; pid_t w;
                    do { w = waitpid(p, &st, 0); } while (w == -1 && errno == EINTR);
                    erasePending(p);
                }
                ctx->exitCode = 1;
                resolveCtxPromise(ctx);
                delete ctx;
                return false;
            }
        }
    }

    // Parent closes all inter-stage pipe fds.
    for (auto& p : pipes) { close(p[0]); close(p[1]); }
    // Parent also closes the capture write end; the read end stays for drain.
    if (capturePipe[1] != -1) close(capturePipe[1]);

    ctx->pgid = pgid;
    ctx->pids = pids;

    // Register pids with the pending map.
    for (size_t i = 0; i < pids.size(); i++) {
        if (req.background) {
            g_pending[pids[i]] = PendingChild { nullptr, 0 };
        } else {
            registerPid(pids[i], ctx, i);
        }
    }

    // Background pipeline: resolve immediately with {exitCode:0, pids, pgid}.
    if (req.background) {
        ctx->exitCode = 0;
        resolveCtxPromise(ctx);
        delete ctx;
        return true;
    }

    // Foreground external pipeline takes the terminal; capture mode does not.
    if (!req.captureOutput && g_interactive && pgid > 0) {
        ctx->foreground = true;
        tcsetpgrp(STDIN_FILENO, pgid);
    }

    // Set up capture drain if needed. The read fd must be non-blocking so
    // the uv_poll callback can loop read() until EAGAIN.
    if (req.captureOutput) {
        int fl = fcntl(capturePipe[0], F_GETFL);
        if (fl != -1) fcntl(capturePipe[0], F_SETFL, fl | O_NONBLOCK);
        ctx->captureFd = capturePipe[0];
        ctx->captureWatch = new uv_poll_t;
        ctx->captureWatch->data = ctx;
        uv_loop_t* loop;
        napi_get_uv_event_loop(g_env, &loop);
        uv_poll_init(loop, ctx->captureWatch, capturePipe[0]);
        uv_poll_start(ctx->captureWatch, UV_READABLE, onCaptureReadable);
    }

    return true;
}

// ---- N-API bindings -------------------------------------------------------

static Napi::Value InitExecutor_(const Napi::CallbackInfo& info) {
    static bool initialized = false;
    if (initialized) return info.Env().Undefined();
    initialized = true;

    // Ignore SIGTTOU/SIGTTIN — standard for interactive shells.
    struct sigaction sa = {};
    sa.sa_handler = SIG_IGN;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTTOU, &sa, nullptr);
    sigaction(SIGTTIN, &sa, nullptr);

    // Block SIGINT on the main thread — the foreground pgrp (the child)
    // receives it via tcsetpgrp, not the shell itself. SIGCHLD is NOT
    // blocked; libuv's uv_signal_t manages delivery to onSigChld.
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGINT);
    sigprocmask(SIG_BLOCK, &mask, nullptr);

    g_interactive = isatty(STDIN_FILENO);

    if (g_interactive) {
        pid_t pid = getpid();
        if (getpgrp() != pid) setpgid(pid, pid);
        tcsetpgrp(STDIN_FILENO, pid);
    }

    g_env = info.Env();
    uv_loop_t* loop;
    napi_get_uv_event_loop(g_env, &loop);

    uv_signal_init(loop, &g_sigchld);
    uv_signal_start(&g_sigchld, onSigChld, SIGCHLD);
    // Don't keep the loop alive just for the SIGCHLD watcher.
    uv_unref(reinterpret_cast<uv_handle_t*>(&g_sigchld));

    return info.Env().Undefined();
}

static bool parseStages(Napi::Env /*env*/, Napi::Array jsStages, Napi::Array jsPipeOps,
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
    return ctx;
}

static Napi::Value SpawnPipeline(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "spawnPipeline(stages, pipeOps, [bg], [stdinFd], [stdoutFd], [stderrFd])").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    PipelineReq req;
    parseStages(env, info[0].As<Napi::Array>(), info[1].As<Napi::Array>(), req.stages, req.pipeOps);
    req.background = info.Length() > 2 && info[2].IsBoolean() && info[2].As<Napi::Boolean>().Value();
    req.captureOutput = false;
    if (info.Length() > 3 && info[3].IsNumber()) req.stdinFd  = info[3].As<Napi::Number>().Int32Value();
    if (info.Length() > 4 && info[4].IsNumber()) req.stdoutFd = info[4].As<Napi::Number>().Int32Value();
    if (info.Length() > 5 && info[5].IsNumber()) req.stderrFd = info[5].As<Napi::Number>().Int32Value();

    auto* ctx = makeCtx(env, false);
    auto promise = ctx->deferred.Promise();
    spawnPipelineInline(req, ctx);
    return promise;
}

static Napi::Value CaptureOutput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
        Napi::TypeError::New(env, "captureOutput(stages, pipeOps, [stdinFd], [stderrFd])").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    PipelineReq req;
    parseStages(env, info[0].As<Napi::Array>(), info[1].As<Napi::Array>(), req.stages, req.pipeOps);
    req.captureOutput = true;
    // capture mode owns stdout — only stdin / stderr are user-overridable.
    if (info.Length() > 2 && info[2].IsNumber()) req.stdinFd  = info[2].As<Napi::Number>().Int32Value();
    if (info.Length() > 3 && info[3].IsNumber()) req.stderrFd = info[3].As<Napi::Number>().Int32Value();

    auto* ctx = makeCtx(env, true);
    auto promise = ctx->deferred.Promise();
    spawnPipelineInline(req, ctx);
    return promise;
}

static Napi::Value GetEAGAIN(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), EAGAIN);
}

// ---- Mixed-pipeline helpers ----------------------------------------------

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

// Fork+exec a single command, return pid immediately. Caller tracks the pid
// and uses waitForPids to wait asynchronously.
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

    setpgid(pid, pgid == 0 ? pid : pgid);
    // Track this pid so SIGCHLD doesn't discard its exit status if it dies
    // before waitForPids is called. waitForPids consumes the entry.
    g_orphans[pid] = OrphanStatus { 0, false };
    return Napi::Number::New(env, pid);
}

// waitForPids registers the pids under a fresh ctx and returns a Promise
// that resolves when all of them have reported (via SIGCHLD). Used by
// mixed-pipeline orchestration in TS and by the fg builtin (which first
// sends SIGCONT to resume a stopped pgrp).
static Napi::Value WaitForPids(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
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
    ctx->pgid = pgid;
    ctx->pipeStatus.resize(pids.size(), 0);
    // Callers (TS fg builtin, executeMixedPipeline) own tcsetpgrp themselves.
    // Leave ctx->foreground false so SIGCHLD doesn't try to restore it here.
    ctx->foreground = false;

    auto promise = ctx->deferred.Promise();

    for (size_t i = 0; i < pids.size(); i++) {
        pid_t p = pids[i];
        auto oit = g_orphans.find(p);
        if (oit != g_orphans.end() && oit->second.reaped) {
            // SIGCHLD parked a status before this waitForPids call. Pull it.
            int s = oit->second.status;
            if (WIFSTOPPED(s)) {
                // Process is stopped, not gone. Keep the orphan entry alive
                // and reset reaped=false so the eventual resume+exit SIGCHLD
                // (after `fg` or `bg`) can park its status here for the next
                // waitForPids. Without this, the second-state-change SIGCHLD
                // finds the pid in neither g_pending nor g_orphans and the
                // zombie leaks. Window is small but the leak is permanent.
                oit->second.reaped = false;
                oit->second.status = 0;
                ctx->stopped = true;
                ctx->stoppedSignal = WSTOPSIG(s);
                int code = 128 + WSTOPSIG(s);
                ctx->pipeStatus[i] = code;
                if (i + 1 == pids.size()) ctx->exitCode = code;
            } else {
                // True termination (exit or fatal signal) — entry can go.
                g_orphans.erase(oit);
                int code = WIFEXITED(s)   ? WEXITSTATUS(s)
                         : WIFSIGNALED(s) ? 128 + WTERMSIG(s) : 1;
                ctx->pipeStatus[i] = code;
                if (i + 1 == pids.size()) ctx->exitCode = code;
            }
        } else {
            // Still alive (or never forkExec'd). Drop stale orphan entry
            // and any stale pending entry (releasing its sigchld ref if it
            // had one), then register under this ctx.
            g_orphans.erase(p);
            erasePending(p);
            registerPid(p, ctx, i);
        }
    }

    // If every pid was already reaped, pendingPids stayed 0 — resolve now.
    if (ctx->pendingPids == 0) {
        maybeFinalize(ctx);
    }
    return promise;
}

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

    sigset_t empty; sigemptyset(&empty);
    sigprocmask(SIG_SETMASK, &empty, nullptr);
    struct sigaction sa = {};
    sa.sa_handler = SIG_DFL; sigemptyset(&sa.sa_mask);
    sigaction(SIGINT,  &sa, nullptr);
    sigaction(SIGTTOU, &sa, nullptr);
    sigaction(SIGTTIN, &sa, nullptr);
    sigaction(SIGPIPE, &sa, nullptr);

    for (int fd : {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO}) {
        int flags = fcntl(fd, F_GETFD);
        if (flags != -1 && (flags & FD_CLOEXEC))
            fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
    }

    execvp(cmd.c_str(), const_cast<char* const*>(argv.data()));
    int err = errno;
    Napi::Error::New(env, std::string("exec: ") + cmd + ": " + strerror(err))
        .ThrowAsJavaScriptException();
    return Napi::Number::New(env, err == ENOENT ? 127 : 126);
}

// ---- Job control ----------------------------------------------------------

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

// reapChildren drains the background-completion buffer accumulated by the
// SIGCHLD handler. No longer calls waitpid — all reaping has already
// happened on the main thread via onSigChld.
static Napi::Value ReapChildren(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array results = Napi::Array::New(env, g_bg_completions.size());
    for (size_t i = 0; i < g_bg_completions.size(); i++) {
        const BgExit& ex = g_bg_completions[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("pid", Napi::Number::New(env, static_cast<int>(ex.pid)));
        obj.Set("exitCode", Napi::Number::New(env, ex.exitCode));
        obj.Set("stopped", Napi::Boolean::New(env, ex.stopped));
        results.Set(static_cast<uint32_t>(i), obj);
    }
    g_bg_completions.clear();
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

// Returns the controlling-terminal foreground pgid, or -1 if there is no
// controlling terminal (e.g., script mode). Used by the shell-exit signal
// handler to forward SIGTERM/SIGHUP to whatever currently owns the TTY.
static Napi::Value TcgetpgrpFg(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    pid_t pgid = tcgetpgrp(STDIN_FILENO);
    return Napi::Number::New(env, pgid);
}

// Returns this process's pgid. Compared against tcgetpgrpFg to decide
// whether the FG group is the shell or a child.
static Napi::Value Getpgrp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Number::New(env, getpgrp());
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
    exports.Set("tcgetpgrpFg",      Napi::Function::New(env, TcgetpgrpFg));
    exports.Set("getpgrp",          Napi::Function::New(env, Getpgrp));
    exports.Set("SIGHUP",           Napi::Number::New(env, SIGHUP));
    exports.Set("SIGINT",           Napi::Number::New(env, SIGINT));
    exports.Set("SIGCONT",          Napi::Number::New(env, SIGCONT));
    exports.Set("SIGTSTP",          Napi::Number::New(env, SIGTSTP));
    exports.Set("SIGTERM",          Napi::Number::New(env, SIGTERM));
    return exports;
}

} // namespace jsh
