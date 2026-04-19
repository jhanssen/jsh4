#pragma once

#include <functional>
#include <string>

// Asynchronous history-file persister.
//
// Invariants (the reason this exists as a separate subsystem):
//
//  1. The user's history file is never truncated in-place. We only ever
//     open it O_APPEND, so a process crash mid-write yields at worst a
//     partial trailing line — the bulk of the file is untouched.
//
//  2. If `load()` fails for any reason other than ENOENT (permission, I/O,
//     corrupt encoding trapped by an exception, …) we MUST NOT write back.
//     A successful load is the precondition for knowing we own the file
//     contents; without it, new writes could clobber entries we never read.
//
//  3. Writes happen on a dedicated worker thread so the Node event loop
//     never blocks on `flock()`, `fsync()`, NFS latency, or contention with
//     another jsh instance appending concurrently.
//
//  4. Cross-process safety: every write batch takes `flock(LOCK_EX)` on the
//     fd, so two jsh instances can't interleave partial lines.
//
//  5. Shutdown is bounded: `shutdown(timeout_ms)` drains the queue and joins
//     the worker, but if the worker is stuck on a foreign-held `flock` it
//     detaches rather than hanging the shell exit. Tail entries may be lost
//     in that case — explicitly acceptable per the spec.
namespace jsh::hist_writer {

enum class LoadStatus {
    Ok,      // Loaded (or file didn't exist). Append path is enabled.
    Failed,  // File exists but couldn't be read; append path is DISABLED.
};

// Read `path` line-by-line and invoke `onEntry` for every complete history
// entry. Multi-line entries (written with `\<newline>` continuation markers)
// are reassembled before the callback fires. Registers `path` as the target
// for future `enqueue()` calls and starts the writer thread on success.
LoadStatus load(const std::string &path,
                std::function<void(const std::string &)> onEntry);

// Queue `entry` for asynchronous append. Multi-line entries are encoded with
// `\<newline>` continuation on write. Silently no-ops if load() hasn't
// succeeded (invariant #2).
void enqueue(const std::string &entry);

// Block up to `timeout_ms` while the worker drains its queue and exits.
// If the timeout elapses with the worker still running (e.g. long-held
// foreign flock), the thread is detached — outstanding entries are lost
// but the shell exits promptly. `timeout_ms <= 0` waits indefinitely.
void shutdown(int timeout_ms);

} // namespace jsh::history
