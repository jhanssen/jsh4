import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { createReadStream, createWriteStream, read as fsRead } from "node:fs";
import { promisify } from "node:util";

const fsReadAsync = promisify(fsRead);
import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List, BraceGroup,
    IfClause, WhileClause, ForClause, FunctionDef, JsFunction,
} from "../parser/index.js";
import { parse } from "../parser/index.js";
import { expandWord, expandWordToStr, registerCaptureImpl } from "../expander/index.js";
import { $ } from "../variables/index.js";
import { pushParams, popParams } from "../variables/positional.js";
import { lookupJsFunction } from "../jsfunctions/index.js";
import { getAlias } from "../api/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    spawnPipeline: (
        stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }>,
        pipeOps: string[]
    ) => Promise<number>;
    captureOutput: (
        stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }>,
        pipeOps: string[]
    ) => Promise<{ exitCode: number; output: string }>;
    createCloexecPipe: () => [number, number];
    clearCloexec: (fd: number) => void;
    closeFd: (fd: number) => void;
    forkExec: (cmd: string, args: string[], stdinFd?: number, stdoutFd?: number, stderrFd?: number, pgid?: number) => number;
    waitForPids: (pids: number[], pgid?: number) => Promise<number>;
};

export interface ExecResult {
    exitCode: number;
}

// Shell function registry.
const shellFunctions = new Map<string, ASTNode>();

// Register command substitution handler with the expander.
registerCaptureImpl(async (body: string): Promise<string> => {
    const ast = parse(body.trim());
    if (!ast) return "";
    const result = await captureAst(ast);
    // Strip trailing newlines — POSIX behaviour.
    return result.replace(/\n+$/, "");
});

export async function execute(node: ASTNode): Promise<ExecResult> {
    const result = await executeNode(node);
    $["?"] = result.exitCode;
    return result;
}

async function executeNode(node: ASTNode): Promise<ExecResult> {
    // Alias expansion: if this is a simple command whose first word is an alias,
    // re-parse and execute the expansion.  Done here so it applies in pipelines too.
    if (node.type === "SimpleCommand") {
        const cmd = node as SimpleCommand;
        if (cmd.words.length > 0) {
            const firstWords = await expandWord(cmd.words[0]!);
            const name = firstWords[0];
            if (name) {
                const expansion = getAlias(name);
                if (expansion) {
                    const restWords = (await Promise.all(cmd.words.slice(1).map(expandWord))).flat();
                    const expanded = [expansion, ...restWords].join(" ").trim();
                    const ast = parse(expanded);
                    if (ast) return executeNode(ast);
                    return { exitCode: 0 };
                }
            }
        }
    }

    switch (node.type) {
        case "SimpleCommand":  return executeSimple(node as SimpleCommand);
        case "Pipeline":       return executePipeline(node as Pipeline);
        case "AndOr":          return executeAndOr(node as AndOr);
        case "List":           return executeList(node as List);
        case "BraceGroup":     return executeNode((node as BraceGroup).body);
        case "IfClause":       return executeIf(node as IfClause);
        case "WhileClause":    return executeWhile(node as WhileClause);
        case "ForClause":      return executeFor(node as ForClause);
        case "FunctionDef":    return executeFunctionDef(node as FunctionDef);
        case "JsFunction":     return executeJsStage(node as JsFunction, 0, 1);
        default:
            process.stderr.write(`jsh: unimplemented: ${node.type}\n`);
            return { exitCode: 1 };
    }
}

// ---- Helpers ----------------------------------------------------------------

type Stage = { cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> };

async function buildStage(cmd: SimpleCommand): Promise<Stage | null> {
    // expandWord returns string[] (glob expansion may produce multiple words)
    const wordArrays = await Promise.all(cmd.words.map(expandWord));
    const words = wordArrays.flat();
    if (words.length === 0) return null;
    const [command, ...args] = words as [string, ...string[]];
    // Redirections use expandWordToStr — no glob expansion on redirect targets
    const redirs = await Promise.all(cmd.redirections.map(async r => ({
        op: r.op,
        fd: r.fd ?? -1,
        target: await expandWordToStr(r.target),
    })));
    return { cmd: command, args, redirs };
}

// ---- captureAst: run an AST with stdout captured ----------------------------

async function captureAst(node: ASTNode): Promise<string> {
    // For SimpleCommand and Pipeline we can go directly through the native
    // capture path.  Complex constructs (if/for/while) are not yet supported.
    if (node.type === "SimpleCommand") {
        const stage = await buildStage(node as SimpleCommand);
        if (!stage) return "";
        const result = await native.captureOutput([stage], []);
        return result.output;
    }

    if (node.type === "Pipeline") {
        const pipe = node as Pipeline;
        const stages: Stage[] = [];
        for (const stageNode of pipe.commands) {
            if (stageNode.type !== "SimpleCommand") {
                process.stderr.write("jsh: $(): complex pipeline stage not supported\n");
                return "";
            }
            const stage = await buildStage(stageNode as SimpleCommand);
            if (!stage) { process.stderr.write("jsh: $(): empty stage\n"); return ""; }
            stages.push(stage);
        }
        const result = await native.captureOutput(stages, pipe.pipeOps);
        return result.output;
    }

    process.stderr.write(`jsh: $(): ${node.type} not supported in command substitution\n`);
    return "";
}

// ---- Command execution -------------------------------------------------------

async function executeSimple(cmd: SimpleCommand): Promise<ExecResult> {
    for (const a of cmd.assignments) {
        $[a.name] = await expandWordToStr(a.value);
    }
    if (cmd.words.length === 0) return { exitCode: 0 };

    const stage = await buildStage(cmd);
    if (!stage) return { exitCode: 0 };
    const { cmd: command, args, redirs } = stage;

    // Shell functions take priority.
    const func = shellFunctions.get(command);
    if (func) {
        pushParams(args);
        try { return await executeNode(func); }
        finally { popParams(); }
    }

    // Builtins only run in-process when there are no redirections.
    const builtin = redirs.length === 0 ? runBuiltin(command, args) : null;
    if (builtin !== null) return builtin;

    const exitCode = await native.spawnPipeline([{ cmd: command, args, redirs }], []);
    return { exitCode };
}

// Resolve aliases in pipeline stage list — returns expanded command list.
async function expandAliasesInPipeline(commands: ASTNode[]): Promise<ASTNode[] | null> {
    const result: ASTNode[] = [];
    for (const cmd of commands) {
        if (cmd.type !== "SimpleCommand") { result.push(cmd); continue; }
        const sc = cmd as SimpleCommand;
        if (sc.words.length === 0) { result.push(cmd); continue; }
        const firstWords = await expandWord(sc.words[0]!);
        const name = firstWords[0];
        if (!name) { result.push(cmd); continue; }
        const expansion = getAlias(name);
        if (!expansion) { result.push(cmd); continue; }
        const restWords = (await Promise.all(sc.words.slice(1).map(expandWord))).flat();
        const expanded = [expansion, ...restWords].join(" ").trim();
        const ast = parse(expanded);
        if (!ast) { process.stderr.write(`jsh: bad alias expansion: ${expanded}\n`); return null; }
        // Inline the expanded command (may itself be a pipeline segment).
        result.push(ast);
    }
    return result;
}

async function executePipeline(node: Pipeline): Promise<ExecResult> {
    const hasJs = node.commands.some(c => c.type === "JsFunction");
    if (hasJs) {
        let exitCode = await executeMixedPipeline(node);
        if (node.negated) exitCode = exitCode === 0 ? 1 : 0;
        return { exitCode };
    }

    // Pure external pipeline — fast path via native spawnPipeline.
    // Expand aliases in the command list first.
    const resolvedCommands = await expandAliasesInPipeline(node.commands);
    if (resolvedCommands === null) return { exitCode: 1 };

    const stages: Stage[] = [];
    for (const stageNode of resolvedCommands) {
        if (stageNode.type !== "SimpleCommand") {
            process.stderr.write(`jsh: unsupported pipeline stage: ${stageNode.type}\n`);
            return { exitCode: 1 };
        }
        const stage = await buildStage(stageNode as SimpleCommand);
        if (!stage) { process.stderr.write("jsh: empty pipeline stage\n"); return { exitCode: 1 }; }
        stages.push(stage);
    }
    let exitCode = await native.spawnPipeline(stages, node.pipeOps);
    if (node.negated) exitCode = exitCode === 0 ? 1 : 0;
    return { exitCode };
}

// ---- Mixed pipeline (contains JS function stages) --------------------------

async function executeMixedPipeline(node: Pipeline): Promise<number> {
    const n = node.commands.length;

    // Create cloexec pipes between all adjacent stages.
    // pipes[i] = [readFd, writeFd] connecting stage i → stage i+1.
    const pipes: Array<[number, number]> = [];
    for (let i = 0; i < n - 1; i++) {
        pipes.push(native.createCloexecPipe());
    }

    const stdinFd  = (i: number) => i === 0     ? 0 : pipes[i - 1]![0];
    const stdoutFd = (i: number) => i === n - 1 ? 1 : pipes[i]![1];

    const pids: number[] = [];
    let pgid = 0;

    // Fork all external stages first so they're running while JS stages process.
    for (let i = 0; i < n; i++) {
        const stageNode = node.commands[i]!;
        if (stageNode.type !== "SimpleCommand") continue;

        const stage = await buildStage(stageNode as SimpleCommand);
        if (!stage) { process.stderr.write("jsh: empty stage\n"); continue; }

        const sin  = stdinFd(i);
        const sout = stdoutFd(i);

        // Temporarily clear CLOEXEC on the fds this child will use.
        if (sin  !== 0) native.clearCloexec(sin);
        if (sout !== 1) native.clearCloexec(sout);

        const pid = native.forkExec(stage.cmd, stage.args, sin, sout, -1, pgid);
        if (pgid === 0) pgid = pid;
        pids.push(pid);

        // Re-seal after fork (parent won't exec, so CLOEXEC doesn't matter
        // here, but it's tidy).
        // (No need to re-set CLOEXEC — the parent won't exec these fds.)
    }

    // Close write ends that external stages are now writing into, and read ends
    // that external stages are now reading from — the parent doesn't need them.
    for (let i = 0; i < n - 1; i++) {
        const [r, w] = pipes[i]!;
        const prevIsJs = node.commands[i]!.type === "JsFunction";
        const nextIsJs = node.commands[i + 1]!.type === "JsFunction";
        // Close the read end if the next stage is external (it dup2'd it).
        if (!nextIsJs) native.closeFd(r);
        // Close the write end if the previous stage is external (it dup2'd it).
        if (!prevIsJs) native.closeFd(w);
    }

    // Run JS function stages in-process.
    let lastJsExit = 0;
    for (let i = 0; i < n; i++) {
        const stageNode = node.commands[i]!;
        if (stageNode.type !== "JsFunction") continue;
        const sin  = stdinFd(i);
        const sout = stdoutFd(i);
        lastJsExit = await executeJsStageRaw(stageNode as JsFunction, sin, sout);
        // Close the write end after the JS function finishes so downstream sees EOF.
        if (sout !== 1) native.closeFd(sout);
        if (sin  !== 0) native.closeFd(sin);
    }

    // Wait for all external processes.
    const lastExternalExit = pids.length > 0
        ? await native.waitForPids(pids, pgid)
        : 0;

    // Use last stage's exit code.
    const lastStage = node.commands[n - 1]!;
    return lastStage.type === "JsFunction" ? lastJsExit : lastExternalExit;
}

// ---- JS stage execution -----------------------------------------------------

async function executeJsStage(node: JsFunction, stdinFd: number, stdoutFd: number): Promise<ExecResult> {
    const exitCode = await executeJsStageRaw(node, stdinFd, stdoutFd);
    return { exitCode };
}

async function executeJsStageRaw(node: JsFunction, stdinFd: number, stdoutFd: number): Promise<number> {
    // Resolve the function.
    let fn: Function;
    if (node.inlineBody !== undefined) {
        try {
            // eslint-disable-next-line no-new-func
            fn = new Function(`"use strict"; return (${node.inlineBody})`)() as Function;
        } catch (e) {
            process.stderr.write(`jsh: @{}: ${e instanceof Error ? e.message : e}\n`);
            return 1;
        }
    } else {
        const found = lookupJsFunction(node.name);
        if (!found) {
            process.stderr.write(`jsh: @${node.name}: function not found\n`);
            return 1;
        }
        fn = found;
    }

    const args = (await Promise.all(node.args.map(expandWord))).flat();

    // Build stdin iterable — line-by-line reader from a raw fd.
    const stdinIterable: AsyncIterable<string> | null = stdinFd === 0
        ? null
        : fdLineReader(stdinFd);

    // Output writer.
    const out = stdoutFd === 1
        ? process.stdout
        : createWriteStream("", { fd: stdoutFd, autoClose: false });

    const writeOut = (chunk: unknown): void => {
        if (chunk === null || chunk === undefined) return;
        if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            out.write(chunk);
        } else {
            out.write(String(chunk));
        }
    };

    try {
        let result: unknown;
        if (node.buffered && stdinIterable) {
            let input = "";
            for await (const line of stdinIterable) input += line + "\n";
            result = await Promise.resolve(fn(args, input));
        } else {
            result = await Promise.resolve(fn(args, stdinIterable));
        }

        // Handle return types.
        if (result === undefined || result === null) {
            // void — nothing to write
        } else if (typeof result === "object" && "exitCode" in (result as object)) {
            return (result as { exitCode: number }).exitCode;
        } else if (isAsyncGenerator(result) || isGenerator(result)) {
            for await (const chunk of result as AsyncIterable<unknown>) writeOut(chunk);
        } else if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
            out.write(result);
        } else {
            writeOut(result);
        }
        return 0;
    } catch (e: unknown) {
        if (e !== null && e !== undefined) {
            process.stderr.write(`jsh: @${node.name || "{"}: ${e instanceof Error ? e.message : e}\n`);
        }
        return 1;
    } finally {
        if (out !== process.stdout) {
            await new Promise<void>(res => (out as NodeJS.WritableStream).end(res));
        }
    }
}

function isAsyncGenerator(v: unknown): v is AsyncGenerator {
    return v != null && typeof (v as AsyncGenerator)[Symbol.asyncIterator] === "function";
}
function isGenerator(v: unknown): v is Generator {
    return v != null && typeof (v as Generator)[Symbol.iterator] === "function"
        && typeof (v as Generator).next === "function";
}

// Async line reader from a raw file descriptor — avoids stream lifecycle issues.
async function* fdLineReader(fd: number): AsyncGenerator<string> {
    const buf = Buffer.alloc(4096);
    let remainder = "";
    while (true) {
        const result = await fsReadAsync(fd, buf, 0, buf.length, null);
        const bytesRead = typeof result === "number" ? result : (result as { bytesRead: number }).bytesRead;
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

async function executeAndOr(node: AndOr): Promise<ExecResult> {
    const left = await executeNode(node.left);
    if (node.op === "&&" && left.exitCode !== 0) return left;
    if (node.op === "||" && left.exitCode === 0) return left;
    return executeNode(node.right);
}

async function executeList(node: List): Promise<ExecResult> {
    let last: ExecResult = { exitCode: 0 };
    for (const entry of node.entries) {
        if (entry.separator === "&") {
            process.stderr.write("jsh: background jobs not yet implemented\n");
        }
        last = await executeNode(entry.node);
    }
    return last;
}

async function executeIf(node: IfClause): Promise<ExecResult> {
    const cond = await executeNode(node.condition);
    if (cond.exitCode === 0) return executeNode(node.consequent);
    if (node.elseClause) return executeNode(node.elseClause);
    return { exitCode: 0 };
}

async function executeWhile(node: WhileClause): Promise<ExecResult> {
    let last: ExecResult = { exitCode: 0 };
    while (true) {
        const cond = await executeNode(node.condition);
        const met = node.until ? cond.exitCode !== 0 : cond.exitCode === 0;
        if (!met) break;
        last = await executeNode(node.body);
    }
    return last;
}

async function executeFor(node: ForClause): Promise<ExecResult> {
    const itemArrays = node.items ? await Promise.all(node.items.map(expandWord)) : [];
    const items = itemArrays.flat();
    let last: ExecResult = { exitCode: 0 };
    for (const item of items) {
        $[node.name] = item;
        last = await executeNode(node.body);
    }
    return last;
}

function executeFunctionDef(node: FunctionDef): ExecResult {
    shellFunctions.set(node.name, node.body);
    return { exitCode: 0 };
}

function runBuiltin(name: string, args: string[]): ExecResult | null {
    switch (name) {
        case "cd": {
            const target = args[0] ?? String($["HOME"] ?? process.env["HOME"] ?? "/");
            try {
                process.chdir(target);
                $["PWD"] = process.cwd();
            } catch (e: unknown) {
                process.stderr.write(`cd: ${e instanceof Error ? e.message : e}\n`);
                return { exitCode: 1 };
            }
            return { exitCode: 0 };
        }
        case "exit": {
            const code = args[0] !== undefined ? parseInt(args[0], 10) : 0;
            process.exit(isNaN(code) ? 0 : code);
        }
        // eslint-disable-next-line no-fallthrough
        case "export": {
            for (const arg of args) {
                const eq = arg.indexOf("=");
                if (eq > 0) {
                    const key = arg.slice(0, eq);
                    const val = arg.slice(eq + 1);
                    $[key] = val; process.env[key] = val;
                } else if (arg) {
                    const val = $[arg];
                    if (val !== undefined) process.env[arg] = String(val);
                }
            }
            return { exitCode: 0 };
        }
        case "unset":
            for (const arg of args) delete $[arg];
            return { exitCode: 0 };
        case "true":  return { exitCode: 0 };
        case "false": return { exitCode: 1 };
        case "echo":
            process.stdout.write(args.join(" ") + "\n");
            return { exitCode: 0 };
        default:
            return null;
    }
}
