import { createRequire } from "node:module";
import { write as fsWriteRaw } from "node:fs";
import { promisify } from "node:util";
import { parse } from "../parser/index.js";
import type { ASTNode, SimpleCommand, Pipeline } from "../parser/index.js";
import { expandWord, expandWordToStr } from "../expander/index.js";
import { execute as executeNode, withIoContext } from "../executor/index.js";

const fsWrite = promisify(fsWriteRaw);

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    createCloexecPipe: () => [number, number];
    clearCloexec: (fd: number) => void;
    closeFd: (fd: number) => void;
    dupFd: (fd: number) => number;
    dup2Fd: (oldFd: number, newFd: number) => number;
    forkExec: (cmd: string, args: string[], stdinFd?: number, stdoutFd?: number, stderrFd?: number, pgid?: number) => number;
    waitForPids: (pids: number[], pgid?: number) => Promise<{ exitCode: number; pipeStatus: number[] }>;
    captureOutput: (
        stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }>,
        pipeOps: string[]
    ) => Promise<{ exitCode: number; output: string }>;
};

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    ok: boolean;
}

export interface ExecOptions {
    stdin?: string | AsyncIterable<string>;
    stderr?: "inherit" | "pipe" | "merge";
}

type Stage = { cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> };

// ---- Helpers ----------------------------------------------------------------

// Strip a trailing \r so consumers don't have to deal with CRLF vs LF.
function stripCr(s: string): string {
    return s.endsWith("\r") ? s.slice(0, -1) : s;
}

async function* fdLineReader(fd: number): AsyncGenerator<string> {
    const { read: fsReadRaw } = await import("node:fs");
    const fsRead = promisify(fsReadRaw);
    const buf = Buffer.alloc(4096);
    let remainder = "";
    while (true) {
        const result = await fsRead(fd, buf, 0, buf.length, null);
        const bytesRead = typeof result === "number" ? result
            : (result as { bytesRead: number }).bytesRead;
        if (bytesRead === 0) {
            if (remainder) yield stripCr(remainder);
            return;
        }
        const text = remainder + buf.slice(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        remainder = lines.pop()!;
        for (const line of lines) yield stripCr(line);
    }
}

async function feedStdinToFd(fd: number, stdin: string | AsyncIterable<string>): Promise<void> {
    try {
        if (typeof stdin === "string") {
            await fsWrite(fd, Buffer.from(stdin));
        } else {
            for await (const chunk of stdin) {
                await fsWrite(fd, Buffer.from(String(chunk)));
            }
        }
    } finally {
        native.closeFd(fd);
    }
}

async function buildStages(ast: ASTNode): Promise<Stage[] | null> {
    const buildOne = async (cmd: SimpleCommand): Promise<Stage> => {
        const wordArrays = await Promise.all(cmd.words.map(expandWord));
        const words = wordArrays.flat();
        const [command = "", ...args] = words;
        const redirs = await Promise.all(cmd.redirections.map(async r => ({
            op: r.op,
            fd: r.fd ?? -1,
            target: await expandWordToStr(r.target),
        })));
        return { cmd: command, args, redirs };
    };

    if (ast.type === "SimpleCommand") {
        return [await buildOne(ast as SimpleCommand)];
    }
    if (ast.type === "Pipeline") {
        const pipe = ast as Pipeline;
        const stages: Stage[] = [];
        for (const node of pipe.commands) {
            if (node.type !== "SimpleCommand") return null;
            stages.push(await buildOne(node as SimpleCommand));
        }
        return stages;
    }
    return null;
}

// ---- ExecHandle -------------------------------------------------------------

// One line of output from the command, tagged with the stream it came from.
// Order is preserved across the merged record array — interleaved as the
// kernel delivered them — so consumers using `iterAll()` see stdout and
// stderr in the order the command actually produced them (modulo per-fd
// line buffering, which is a property of the command, not jsh).
export interface ExecLine {
    stream: "stdout" | "stderr";
    line: string;
}

export class ExecHandle implements PromiseLike<ExecResult> {
    private _records: ExecLine[] = [];
    private _done = false;
    private _waiters: Array<() => void> = [];
    private _resultPromise: Promise<ExecResult>;

    constructor(cmd: string, options: ExecOptions = {}) {
        this._resultPromise = this._run(cmd, options);
    }

    private _pushRecord(stream: "stdout" | "stderr", line: string): void {
        this._records.push({ stream, line });
        const waiters = this._waiters.splice(0);
        for (const w of waiters) w();
    }

    // Backward-compat wrapper — stdout-only enqueue.
    private _pushLine(line: string): void {
        this._pushRecord("stdout", line);
    }

    private _finish(): void {
        this._done = true;
        const waiters = this._waiters.splice(0);
        for (const w of waiters) w();
    }

    private async _run(cmd: string, options: ExecOptions): Promise<ExecResult> {
        const ast = parse(cmd.trim());
        if (!ast) {
            this._finish();
            return { stdout: "", stderr: "", exitCode: 0, ok: true };
        }

        const stages = await buildStages(ast);
        if (stages && stages.length > 0 && !stages[0]!.cmd) {
            // Empty command
            this._finish();
            return { stdout: "", stderr: "", exitCode: 0, ok: true };
        }
        if (!stages) {
            // Compound command (&&, ||, ;, etc.) — execute via the main
            // executor with stdout redirected into a capture pipe.
            return this._runCompound(ast, options);
        }
        // The fast path below doesn't apply parsed redirections (e.g.
        // `2>/dev/null`, `>file`). For those, use native.captureOutput which
        // applies redirs in the forked child and captures stdout into a pipe
        // without touching the shell's own fds — so widgets calling
        // jsh.exec concurrently can't trample each other.
        //
        // Limitation: captureOutput can't feed options.stdin or capture
        // stderr into a string. If those are requested alongside redirs,
        // fall through to the fast path (which will ignore the redirs, like
        // before). Callers mixing both should compose manually.
        if (
            stages.some(s => s.redirs.length > 0) &&
            options.stdin === undefined &&
            options.stderr !== "pipe"
        ) {
            const pipeOps = ast.type === "Pipeline" ? (ast as Pipeline).pipeOps : [];
            const result = await native.captureOutput(stages, pipeOps);
            // Feed the captured output into the line queue so async iterators see it.
            for (const line of result.output.split("\n")) {
                if (line.length > 0) this._pushLine(line);
            }
            this._finish();
            return {
                stdout:   result.output.replace(/\n+$/, ""),
                stderr:   "",
                exitCode: result.exitCode,
                ok:       result.exitCode === 0,
            };
        }

        // stdout capture pipe
        const [stdoutR, stdoutW] = native.createCloexecPipe();

        // stderr setup
        let stderrR = -1, stderrW = -1;
        if (options.stderr === "pipe") {
            [stderrR, stderrW] = native.createCloexecPipe();
        }

        // stdin setup
        let stdinR = 0;
        let stdinFeed: Promise<void> | null = null;
        if (options.stdin !== undefined) {
            const [r, w] = native.createCloexecPipe();
            stdinR = r;
            stdinFeed = feedStdinToFd(w, options.stdin);
        }

        // inter-stage pipes for pipelines
        const interPipes: Array<[number, number]> = [];
        for (let i = 0; i < stages.length - 1; i++) {
            interPipes.push(native.createCloexecPipe());
        }

        // fork stages
        const pids: number[] = [];
        let pgid = 0;

        for (let i = 0; i < stages.length; i++) {
            const { cmd: stagecmd, args } = stages[i]!;
            const isFirst = i === 0;
            const isLast  = i === stages.length - 1;

            const sin  = isFirst ? stdinR : interPipes[i - 1]![0];
            const sout = isLast  ? stdoutW : interPipes[i]![1];
            const serr = options.stderr === "merge" ? sout
                       : options.stderr === "pipe"  ? stderrW
                       : -1; // inherit

            // pipe fds already have CLOEXEC — forkExec dup2s them to STDIN/STDOUT
            // which creates new fds without CLOEXEC; originals are closed on exec.

            const pid = native.forkExec(stagecmd, args, sin, sout, serr, pgid);
            if (pgid === 0) pgid = pid;
            pids.push(pid);
        }

        // Parent closes all write/read ends it doesn't need.
        native.closeFd(stdoutW);
        if (stderrW !== -1) native.closeFd(stderrW);
        if (stdinR  !== 0)  native.closeFd(stdinR);
        for (const [r, w] of interPipes) {
            native.closeFd(r);
            native.closeFd(w);
        }

        // Read stdout — feed lines to queue and accumulate for await path.
        // fdLineReader strips the trailing \n from each yield; reattach during
        // accumulation so the buffered stdout preserves line breaks. The final
        // \n+$/ trim on return handles the over-added one from the last line.
        let stdoutStr = "";
        const readStdout = (async () => {
            for await (const raw of fdLineReader(stdoutR)) {
                stdoutStr += raw + "\n";
                this._pushLine(raw);
            }
            native.closeFd(stdoutR);
            this._finish();
        })();

        // Read stderr if piped — feed lines to the queue (so iterAll()
        // streams them) and accumulate for the awaited result.
        let stderrStr = "";
        const readStderr = stderrR !== -1 ? (async () => {
            for await (const raw of fdLineReader(stderrR)) {
                stderrStr += raw + "\n";
                this._pushRecord("stderr", raw);
            }
            native.closeFd(stderrR);
        })() : Promise.resolve();

        const [waitResult] = await Promise.all([
            native.waitForPids(pids, pgid),
            readStdout,
            readStderr,
            stdinFeed ?? Promise.resolve(),
        ]);

        return {
            stdout:   stdoutStr.replace(/\n+$/, ""),
            stderr:   stderrStr.replace(/\n+$/, ""),
            exitCode: waitResult.exitCode,
            ok:       waitResult.exitCode === 0,
        };
    }

    private async _runCompound(ast: ASTNode, options: ExecOptions): Promise<ExecResult> {
        const [stdoutR, stdoutW] = native.createCloexecPipe();

        // stderr setup
        let stderrR = -1, stderrW = -1;
        if (options.stderr === "pipe") {
            [stderrR, stderrW] = native.createCloexecPipe();
        }

        // Pipe fds will be the IO context's stdout/stderr fds — no dup2 on
        // process fd 1/2. The clearCloexec is so children spawned by the
        // executor (forkExec / posix_spawn) inherit them across exec.
        native.clearCloexec(stdoutW);
        if (stderrW !== -1) native.clearCloexec(stderrW);

        // Read stdout in background. Reattach \n during accumulation (see
        // _run above for rationale).
        let stdoutStr = "";
        const readStdout = (async () => {
            for await (const raw of fdLineReader(stdoutR)) {
                stdoutStr += raw + "\n";
                this._pushLine(raw);
            }
            native.closeFd(stdoutR);
            this._finish();
        })();

        // Read stderr if piped — feed lines to the queue (so iterAll()
        // streams them) and accumulate for the awaited result.
        let stderrStr = "";
        const readStderr = stderrR !== -1 ? (async () => {
            for await (const raw of fdLineReader(stderrR)) {
                stderrStr += raw + "\n";
                this._pushRecord("stderr", raw);
            }
            native.closeFd(stderrR);
        })() : Promise.resolve();

        // Execute the compound command using the main executor inside an IO
        // context that points stdout (and optionally stderr) at the capture
        // pipes. Builtins, JS stages, and externals all route their output
        // through getStdoutFd()/getStderrFd().
        const ctxStderrFd = stderrW !== -1 ? stderrW
                          : options.stderr === "merge" ? stdoutW
                          : 2;
        let result: { exitCode: number };
        try {
            result = await withIoContext(
                { stdinFd: 0, stdoutFd: stdoutW, stderrFd: ctxStderrFd },
                () => executeNode(ast),
            );
        } catch {
            result = { exitCode: 1 };
        } finally {
            // Close the write ends so the readers see EOF and finish.
            native.closeFd(stdoutW);
            if (stderrW !== -1) native.closeFd(stderrW);
        }

        await Promise.all([readStdout, readStderr]);

        return {
            stdout:   stdoutStr.replace(/\n+$/, ""),
            stderr:   stderrStr.replace(/\n+$/, ""),
            exitCode: result.exitCode,
            ok:       result.exitCode === 0,
        };
    }

    // PromiseLike implementation
    then<T, U>(
        onfulfilled?: ((v: ExecResult) => T | PromiseLike<T>) | null,
        onrejected?:  ((r: unknown)   => U | PromiseLike<U>) | null
    ): Promise<T | U> {
        return this._resultPromise.then(onfulfilled, onrejected) as Promise<T | U>;
    }

    // Default AsyncIterable — yields stdout lines as plain strings. Stderr
    // lines (when `options.stderr === "pipe"`) are recorded but not yielded
    // here, preserving the historical "iterate stdout" contract. Use
    // iterStderr() for stderr only, or iterAll() for an interleaved tagged
    // stream of both.
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        let i = 0;
        while (true) {
            while (i < this._records.length) {
                const r = this._records[i++]!;
                if (r.stream === "stdout") yield r.line;
            }
            if (this._done) break;
            await new Promise<void>(resolve => this._waiters.push(resolve));
        }
    }

    // Yield stderr lines as plain strings. Empty unless options.stderr was
    // "pipe" — `inherit` lines go to fd 2 directly and are never seen by
    // this side; `merge` mixes them into stdout under the "stdout" tag.
    async *iterStderr(): AsyncGenerator<string> {
        let i = 0;
        while (true) {
            while (i < this._records.length) {
                const r = this._records[i++]!;
                if (r.stream === "stderr") yield r.line;
            }
            if (this._done) break;
            await new Promise<void>(resolve => this._waiters.push(resolve));
        }
    }

    // Yield every recorded line as `{ stream, line }`, in arrival order.
    // Useful when callers want to react to both streams with one loop.
    async *iterAll(): AsyncGenerator<ExecLine> {
        let i = 0;
        while (true) {
            while (i < this._records.length) {
                yield this._records[i++]!;
            }
            if (this._done) break;
            await new Promise<void>(resolve => this._waiters.push(resolve));
        }
    }
}

export function exec(cmd: string, options: ExecOptions = {}): ExecHandle {
    return new ExecHandle(cmd, options);
}
