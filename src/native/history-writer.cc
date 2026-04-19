#include "history-writer.h"

#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

namespace jsh::hist_writer {
namespace {

// Hard cap on pending entries. 10k commands queued implies a seriously stuck
// flock (a single local append is microseconds). If we hit it, drop the
// oldest rather than grow without bound. In normal use the queue holds 0-1
// entries at any time.
constexpr size_t kQueueCap = 10000;

// Shutdown cap on the file lock acquisition, so the writer doesn't block
// the shell's exit indefinitely.
constexpr int kFlockTimeoutMs = 1000;

std::mutex g_mu;
std::condition_variable g_cv;      // wakes writer on queue/shutdown.
std::condition_variable g_done_cv; // wakes shutdown() when worker exits.

std::vector<std::string> g_queue;
std::thread g_thread;
bool g_thread_started = false;
bool g_thread_done    = false;
bool g_shutdown       = false;
bool g_load_ok        = false;
std::string g_path;

// Serialize a history entry to its on-disk form.
//  - Single-line entry → entry + "\n"
//  - Multi-line entry  → each internal "\n" becomes "\\\n" (backslash-newline
//    = continuation marker), followed by a final "\n".
//  - Empty entry       → single blank line, so reload preserves shape.
//  - If the final segment ends with '\' (optionally followed by spaces),
//    append an extra space before the terminating "\n". Without this, a line
//    ending "foo\" is ambiguous with the continuation marker "\\\n". zsh
//    uses the same disambiguator; see savehistfile() in zsh's Src/hist.c.
std::string encode(const std::string &entry) {
    std::string out;
    out.reserve(entry.size() + 8);
    if (entry.empty()) { out.push_back('\n'); return out; }
    size_t i = 0;
    while (i < entry.size()) {
        size_t nl = entry.find('\n', i);
        if (nl == std::string::npos) {
            out.append(entry, i, std::string::npos);
            break;
        }
        out.append(entry, i, nl - i);
        out.append("\\\n");
        i = nl + 1;
    }
    // Walk back through any trailing spaces on the final segment; if the
    // run is preceded by a literal backslash, add one more space so the
    // loader can distinguish "entry ends in \" from "\<newline> continuation".
    size_t k = out.size();
    while (k > 0 && out[k-1] == ' ') k--;
    if (k > 0 && out[k-1] == '\\') {
        out.push_back(' ');
    }
    out.push_back('\n');
    return out;
}

// Acquire LOCK_EX with a bounded wait: try non-blocking first, poll-sleep
// with backoff up to `timeout_ms`. Blocking flock() itself can't be
// interrupted cleanly, so we roll our own timeout for the shutdown case.
bool lockWithTimeout(int fd, int timeout_ms) {
    if (timeout_ms <= 0) {
        return flock(fd, LOCK_EX) == 0;
    }
    auto start = std::chrono::steady_clock::now();
    useconds_t delay = 1000; // 1ms initial backoff
    for (;;) {
        if (flock(fd, LOCK_EX | LOCK_NB) == 0) return true;
        if (errno != EWOULDBLOCK && errno != EAGAIN) return false;
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        if (elapsed >= timeout_ms) return false;
        usleep(delay);
        if (delay < 100000) delay *= 2; // cap at 100ms between attempts
    }
}

void writerLoop() {
    for (;;) {
        std::vector<std::string> batch;
        bool shutting_down;
        {
            std::unique_lock<std::mutex> lk(g_mu);
            g_cv.wait(lk, []{ return !g_queue.empty() || g_shutdown; });
            batch.swap(g_queue);
            shutting_down = g_shutdown;
        }
        if (batch.empty() && shutting_down) break;
        if (g_path.empty() || batch.empty()) continue;

        int fd = open(g_path.c_str(), O_CREAT | O_WRONLY | O_APPEND, 0600);
        if (fd < 0) continue; // give up this batch; file could reappear later

        int lock_timeout = shutting_down ? kFlockTimeoutMs : 0;
        if (lockWithTimeout(fd, lock_timeout)) {
            for (const auto &enc : batch) {
                // POSIX guarantees O_APPEND writes are atomic w.r.t. other
                // O_APPEND writers, and flock gives us exclusion against
                // non-O_APPEND writers. Short writes on regular files are
                // theoretically possible but vanishingly rare in practice.
                const char *p = enc.data();
                size_t remaining = enc.size();
                while (remaining > 0) {
                    ssize_t n = write(fd, p, remaining);
                    if (n <= 0) break;
                    p += n;
                    remaining -= static_cast<size_t>(n);
                }
            }
            fsync(fd);
            flock(fd, LOCK_UN);
        }
        // If lock acquisition timed out (shutdown path), we drop the batch.
        // The file itself is untouched — just these tail entries are lost.
        close(fd);
    }
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_thread_done = true;
    }
    g_done_cv.notify_all();
}

void startThreadIfNeeded() {
    if (g_thread_started) return;
    g_thread_done = false;
    g_shutdown = false;
    g_thread = std::thread(writerLoop);
    g_thread_started = true;
}

} // namespace

LoadStatus load(const std::string &path,
                std::function<void(const std::string &)> onEntry) {
    g_path = path;
    FILE *fp = fopen(path.c_str(), "r");
    if (!fp) {
        if (errno == ENOENT) {
            // Fresh install / first run — file doesn't exist yet. Safe to
            // start appending: we're not overwriting anything.
            g_load_ok = true;
            startThreadIfNeeded();
            return LoadStatus::Ok;
        }
        // Any other error (EACCES, EIO, etc.) — we don't know what's in the
        // file, so we must not write. Append path stays disabled.
        g_load_ok = false;
        return LoadStatus::Failed;
    }

    char buf[4096];
    std::string entry;
    bool cont = false;
    while (fgets(buf, sizeof(buf), fp)) {
        size_t n = strlen(buf);
        while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) n--;
        buf[n] = '\0';
        if (n > 0 && buf[n-1] == '\\') {
            buf[n-1] = '\0';
            if (cont) entry += '\n';
            entry += buf;
            cont = true;
        } else {
            // Reverse the encoder's trailing-space disambiguator: if the
            // line's tail is '\' followed by 1+ spaces, strip one space to
            // recover the literal trailing-backslash entry.
            if (n >= 2 && buf[n-1] == ' ') {
                size_t k = n - 1;
                while (k > 0 && buf[k-1] == ' ') k--;
                if (k > 0 && buf[k-1] == '\\') {
                    n--;
                    buf[n] = '\0';
                }
            }
            if (cont) {
                entry += '\n';
                entry += buf;
                onEntry(entry);
                entry.clear();
                cont = false;
            } else {
                onEntry(std::string(buf));
            }
        }
    }
    // Trailing continuation (file truncated mid-entry) — preserve what we got.
    if (cont && !entry.empty()) onEntry(entry);
    fclose(fp);

    g_load_ok = true;
    startThreadIfNeeded();
    return LoadStatus::Ok;
}

void enqueue(const std::string &entry) {
    if (!g_load_ok || g_path.empty()) return;
    std::string enc = encode(entry);
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_queue.size() >= kQueueCap) {
            // Pathological — drop the oldest pending entry. Can't happen in
            // normal interactive use; this is a belt-and-suspenders bound.
            g_queue.erase(g_queue.begin());
        }
        g_queue.push_back(std::move(enc));
    }
    g_cv.notify_one();
}

void shutdown(int timeout_ms) {
    if (!g_thread_started) return;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_shutdown = true;
    }
    g_cv.notify_one();

    if (timeout_ms <= 0) {
        if (g_thread.joinable()) g_thread.join();
        g_thread_started = false;
        return;
    }

    std::unique_lock<std::mutex> lk(g_mu);
    bool finished = g_done_cv.wait_for(lk,
        std::chrono::milliseconds(timeout_ms),
        []{ return g_thread_done; });
    lk.unlock();

    if (finished && g_thread.joinable()) {
        g_thread.join();
    } else if (g_thread.joinable()) {
        // Worker is still stuck (probably on a long-held foreign flock).
        // Detach so the process can exit; the tail batch is lost but the
        // file on disk is intact.
        g_thread.detach();
    }
    g_thread_started = false;
}

} // namespace jsh::history
