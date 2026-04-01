import { createRequire } from "node:module";
import { write as fsWriteRaw } from "node:fs";
import { promisify } from "node:util";
import { parse } from "../parser/index.js";
import type { ASTNode, SimpleCommand, Pipeline } from "../parser/index.js";
import { expandWord, expandWordToStr } from "../expander/index.js";

const fsWrite = promisify(fsWriteRaw);

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    createCloexecPipe: () => [number, number];
    clearCloexec: (fd: number) => void;
    closeFd: (fd: number) => void;
    forkExec: (cmd: string, args: string[], stdinFd?: number, stdoutFd?: number, stderrFd?: number, pgid?: number) => number;
    waitForPids: (pids: number[], pgid?: number) => Promise<number>;
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
            if (remainder) yield remainder;
            return;
        }
        const text = remainder + buf.slice(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        remainder = lines.pop()!;
        for (const line of lines) yield line + "\n";
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

export class ExecHandle implements PromiseLike<ExecResult> {
    private _lines: string[] = [];
    private _done = false;
    private _waiters: Array<() => void> = [];
    private _resultPromise: Promise<ExecResult>;

    constructor(cmd: string, options: ExecOptions = {}) {
        this._resultPromise = this._run(cmd, options);
    }

    private _pushLine(line: string): void {
        this._lines.push(line);
        const waiters = this._waiters.splice(0);
        for (const w of waiters) w();
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
        if (!stages || stages.length === 0 || !stages[0]!.cmd) {
            this._finish();
            return { stdout: "", stderr: "", exitCode: 0, ok: true };
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

            if (sin  !== 0)  native.clearCloexec(sin);
            native.clearCloexec(sout);
            if (serr !== -1 && serr !== sout) native.clearCloexec(serr);

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
        let stdoutStr = "";
        const readStdout = (async () => {
            for await (const raw of fdLineReader(stdoutR)) {
                stdoutStr += raw;
                this._pushLine(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
            }
            native.closeFd(stdoutR);
            this._finish();
        })();

        // Read stderr if piped.
        let stderrStr = "";
        const readStderr = stderrR !== -1 ? (async () => {
            for await (const raw of fdLineReader(stderrR)) stderrStr += raw;
            native.closeFd(stderrR);
        })() : Promise.resolve();

        const [exitCode] = await Promise.all([
            native.waitForPids(pids, pgid),
            readStdout,
            readStderr,
            stdinFeed ?? Promise.resolve(),
        ]);

        return {
            stdout:   stdoutStr.replace(/\n+$/, ""),
            stderr:   stderrStr.replace(/\n+$/, ""),
            exitCode: exitCode as number,
            ok:       (exitCode as number) === 0,
        };
    }

    // PromiseLike implementation
    then<T, U>(
        onfulfilled?: ((v: ExecResult) => T | PromiseLike<T>) | null,
        onrejected?:  ((r: unknown)   => U | PromiseLike<U>) | null
    ): Promise<T | U> {
        return this._resultPromise.then(onfulfilled, onrejected) as Promise<T | U>;
    }

    // AsyncIterable — yields stdout lines as they arrive.
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        let i = 0;
        while (true) {
            if (i < this._lines.length) {
                yield this._lines[i++]!;
            } else if (this._done) {
                break;
            } else {
                await new Promise<void>(resolve => this._waiters.push(resolve));
            }
        }
    }
}

export function exec(cmd: string, options: ExecOptions = {}): ExecHandle {
    return new ExecHandle(cmd, options);
}
