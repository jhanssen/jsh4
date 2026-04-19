// Public jsh API — available as globals in .jshrc and importable directly.

import {
    writeStdout as _writeStdout,
    writeStderr as _writeStderr,
    readLineFromFdAsync,
    readBytesFromFdAsync,
    getStdinFd,
    getStdoutFd,
    getStderrFd,
} from "../executor/index.js";

export { $ } from "../variables/index.js";
export { registerJsFunction } from "../jsfunctions/index.js";
export { exec } from "../exec/index.js";
export type { ExecResult, ExecOptions } from "../exec/index.js";
export { registerCompletion } from "../completion/index.js";

// ---- Stream-shaped IO ------------------------------------------------------
//
// Three lazy handles that always read the *current* IO context fd. In a
// pipeline `@`-stage, the fds point at the stage's pipes; outside any
// pipeline (jshrc top-level, widget callbacks, timers) they point at the
// process's terminal. Code can use them uniformly without caring which
// context it runs in.

export interface JshWritable {
    /** fd this handle currently writes to (read fresh on each access). */
    readonly fd: number;
    /** Writes data, returning a Promise that settles when the kernel
     *  accepted all bytes. Concurrent writes to the same fd are serialized
     *  by a per-fd queue, so order is preserved across callers. */
    write(data: string | Buffer | Uint8Array): Promise<void>;
}

export interface JshReadable extends AsyncIterable<string> {
    /** fd this handle currently reads from (read fresh on each access). */
    readonly fd: number;
    /** Reads exactly `n` bytes (or fewer at EOF) and returns them as utf8. */
    read(n: number): Promise<string>;
}

const toBuffer = (data: string | Buffer | Uint8Array): Buffer =>
    typeof data === "string" ? Buffer.from(data)
        : Buffer.isBuffer(data) ? data
            : Buffer.from(data);

export const stdout: JshWritable = {
    get fd() { return getStdoutFd(); },
    write(data) { return _writeStdout(toBuffer(data).toString("utf8")); },
};

export const stderr: JshWritable = {
    get fd() { return getStderrFd(); },
    write(data) { return _writeStderr(toBuffer(data).toString("utf8")); },
};

export const stdin: JshReadable = {
    get fd() { return getStdinFd(); },
    async read(n: number) { return readBytesFromFdAsync(getStdinFd(), n); },
    async *[Symbol.asyncIterator]() {
        // Re-read fd each iteration start — supports nested IO contexts
        // (uncommon, but cheap). Yields lines without trailing \n.
        const fd = getStdinFd();
        while (true) {
            const line = await readLineFromFdAsync(fd);
            if (line === null) return;
            yield line;
        }
    },
};

// ---- Colorize ---------------------------------------------------------------

let colorizeFn: ((input: string) => string) | null = null;

export function setColorize(fn: ((input: string) => string) | null): void {
    colorizeFn = fn;
}

export function getColorize(): ((input: string) => string) | null {
    return colorizeFn;
}

export { setTheme, getCurrentTheme } from "../colorize/index.js";

// ---- Aliases ----------------------------------------------------------------

const aliasMap = new Map<string, string>();

export function alias(name: string, expansion: string): void {
    aliasMap.set(name, expansion);
}

export function unalias(name: string): void {
    aliasMap.delete(name);
}

export function getAlias(name: string): string | undefined {
    return aliasMap.get(name);
}

export function getAllAliases(): Iterable<[string, string]> {
    return aliasMap.entries();
}
