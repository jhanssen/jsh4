import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { createReadStream, createWriteStream, read as fsRead, readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const fsReadAsync = promisify(fsRead);
import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List, BraceGroup,
    IfClause, WhileClause, ForClause, FunctionDef, JsFunction, CaseClause,
} from "../parser/index.js";
import { parse } from "../parser/index.js";
import { expandWord, expandWordToStr, registerCaptureImpl } from "../expander/index.js";
import { $, pushScope, popScope, declareLocal } from "../variables/index.js";
import { pushParams, popParams } from "../variables/positional.js";
import { lookupJsFunction } from "../jsfunctions/index.js";
import { getAlias } from "../api/index.js";
import { shellOpts } from "../shellopts/index.js";

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
        case "CaseClause":     return executeCase(node as CaseClause);
        case "JsFunction":     return executeJsStage(node as JsFunction, 0, 1);
        default:
            process.stderr.write(`jsh: unimplemented: ${node.type}\n`);
            return { exitCode: 1 };
    }
}

// ---- Helpers ----------------------------------------------------------------

type Stage = { cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string; isHereDoc?: boolean }> };

async function buildStage(cmd: SimpleCommand): Promise<Stage | null> {
    // expandWord returns string[] (glob expansion may produce multiple words)
    const wordArrays = await Promise.all(cmd.words.map(expandWord));
    const words = wordArrays.flat();
    if (words.length === 0) return null;
    const [command, ...args] = words as [string, ...string[]];
    // Redirections — here-docs pass body as target, others expand to filename.
    const redirs = await Promise.all(cmd.redirections.map(async r => {
        const seg = r.target.segments[0];
        const isHereDoc = seg?.type === "HereDoc";
        if (isHereDoc) {
            const hd = seg as { type: "HereDoc"; body: string; quoted: boolean };
            // Expand $VAR in non-quoted here-docs.
            const body = hd.quoted ? hd.body : expandHereDocVars(hd.body);
            return { op: r.op, fd: r.fd ?? -1, target: body, isHereDoc: true };
        }
        return { op: r.op, fd: r.fd ?? -1, target: await expandWordToStr(r.target), isHereDoc: false };
    }));
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

    // xtrace: print command before execution
    if (shellOpts.xtrace) {
        const trace = [command, ...args].join(" ");
        process.stderr.write(`+ ${trace}\n`);
    }

    // Shell functions take priority.
    const func = shellFunctions.get(command);
    if (func) {
        pushParams(args);
        pushScope();
        try { return await executeNode(func); }
        finally { popScope(); popParams(); }
    }

    // read builtin
    if (command === "read") {
        return runRead(args, redirs);
    }

    // source / . — read file, parse, execute in current context
    if (command === "source" || command === ".") {
        if (args.length === 0) {
            process.stderr.write(`${command}: filename argument required\n`);
            return { exitCode: 2 };
        }
        return runSource(args[0]!, args.slice(1));
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

        // pipe fds have CLOEXEC — forkExec dup2s them to STDIN/STDOUT without CLOEXEC.

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
            // end() may never fire on a broken pipe (EPIPE) — resolve on error/close too.
            await new Promise<void>(res => {
                const w = out as NodeJS.WritableStream;
                w.once("error", res);
                w.once("close", res);
                w.end(res);
            });
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
        $["?"] = last.exitCode;
        if (shellOpts.errexit && last.exitCode !== 0) return last;
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

async function executeCase(node: CaseClause): Promise<ExecResult> {
    const word = await expandWordToStr(node.word);
    for (const item of node.items) {
        for (const pattern of item.patterns) {
            const pat = await expandWordToStr(pattern);
            if (matchGlob(word, pat)) {
                if (item.body) return executeNode(item.body);
                return { exitCode: 0 };
            }
        }
    }
    return { exitCode: 0 };
}

// Simple glob pattern match for case patterns (* ? and character classes).
function matchGlob(str: string, pattern: string): boolean {
    // Convert shell glob to regex.
    let re = "^";
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i]!;
        if (ch === "*")      { re += ".*"; i++; }
        else if (ch === "?") { re += ".";  i++; }
        else if (ch === "[") {
            const end = pattern.indexOf("]", i + 1);
            if (end === -1) { re += "\\["; i++; }
            else { re += pattern.slice(i, end + 1); i = end + 1; }
        } else {
            re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
            i++;
        }
    }
    return new RegExp(re + "$").test(str);
}

function executeFunctionDef(node: FunctionDef): ExecResult {
    shellFunctions.set(node.name, node.body);
    return { exitCode: 0 };
}

function expandHereDocVars(body: string): string {
    return body.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
        (_, braced, bare) => {
            const name = braced ?? bare;
            const val = $[name];
            return val !== undefined ? String(val) : "";
        }
    );
}

// ---- read builtin -----------------------------------------------------------

function readLineFromFd(fd: number): string | null {
    const buf = Buffer.alloc(1);
    let line = "";
    while (true) {
        let n: number;
        try { n = readSync(fd, buf, 0, 1, null); }
        catch { return line.length > 0 ? line : null; }
        if (n === 0) return line.length > 0 ? line : null;
        const ch = buf.toString("utf8", 0, 1);
        if (ch === "\n") return line;
        line += ch;
    }
}

function runRead(args: string[], redirs: Stage["redirs"]): ExecResult {
    // Parse options
    let raw = false;
    let prompt = "";
    const varNames: string[] = [];
    let i = 0;
    while (i < args.length) {
        const arg = args[i]!;
        if (arg === "-r") {
            raw = true;
            i++;
        } else if (arg === "-p" && i + 1 < args.length) {
            prompt = args[i + 1]!;
            i += 2;
        } else if (arg.startsWith("-")) {
            process.stderr.write(`read: ${arg}: unsupported option\n`);
            return { exitCode: 2 };
        } else {
            varNames.push(arg);
            i++;
        }
    }

    if (prompt) process.stderr.write(prompt);

    // Handle stdin redirections (here-strings, here-docs, file input)
    let line: string | null;
    const stdinRedir = redirs.find(r => r.op === "<<<" || r.op === "<<" || r.op === "<");
    if (stdinRedir && (stdinRedir.op === "<<<" || (stdinRedir.op === "<<" && stdinRedir.isHereDoc))) {
        // Here-string or here-doc: target contains the text
        const text = stdinRedir.target;
        const nl = text.indexOf("\n");
        line = nl >= 0 ? text.slice(0, nl) : text;
        if (line.length === 0 && text.length === 0) line = null;
    } else if (stdinRedir && stdinRedir.op === "<") {
        // File redirect
        const fs = require("node:fs") as typeof import("node:fs");
        let fd: number;
        try { fd = fs.openSync(stdinRedir.target, "r"); }
        catch (e) {
            process.stderr.write(`read: ${e instanceof Error ? e.message : e}\n`);
            return { exitCode: 1 };
        }
        try { line = readLineFromFd(fd); }
        finally { fs.closeSync(fd); }
    } else {
        line = readLineFromFd(0);
    }
    if (line === null) return { exitCode: 1 };

    // Process backslash escapes unless -r
    let processed = line;
    if (!raw) {
        processed = processed.replace(/\\(.)/g, "$1");
    }

    // If no variable names, use REPLY
    if (varNames.length === 0) {
        $["REPLY"] = processed;
        return { exitCode: 0 };
    }

    // Split on IFS (default: space/tab/newline)
    const ifs = String($["IFS"] ?? " \t\n");
    const parts = splitOnIfs(processed, ifs, varNames.length);

    for (let j = 0; j < varNames.length; j++) {
        $[varNames[j]!] = parts[j] ?? "";
    }
    return { exitCode: 0 };
}

function splitOnIfs(str: string, ifs: string, maxParts: number): string[] {
    if (maxParts <= 1) return [str];
    const parts: string[] = [];
    let i = 0;
    while (parts.length < maxParts - 1 && i < str.length) {
        // Skip leading IFS whitespace
        while (i < str.length && ifs.includes(str[i]!)) i++;
        if (i >= str.length) break;
        // Collect non-IFS chars
        let word = "";
        while (i < str.length && !ifs.includes(str[i]!)) word += str[i++];
        parts.push(word);
    }
    // Last var gets the rest (trimmed of leading IFS)
    while (i < str.length && ifs.includes(str[i]!)) i++;
    parts.push(str.slice(i));
    return parts;
}

// ---- source / . builtin -----------------------------------------------------

async function runSource(file: string, extraArgs: string[]): Promise<ExecResult> {
    const path = resolve(file);
    let content: string;
    try {
        content = readFileSync(path, "utf8");
    } catch (e) {
        process.stderr.write(`source: ${e instanceof Error ? e.message : e}\n`);
        return { exitCode: 1 };
    }
    let ast;
    try {
        ast = parse(content);
    } catch (e) {
        process.stderr.write(`source: ${path}: ${e instanceof Error ? e.message : e}\n`);
        return { exitCode: 1 };
    }
    if (!ast) return { exitCode: 0 };
    if (extraArgs.length > 0) pushParams(extraArgs);
    try {
        return await executeNode(ast);
    } finally {
        if (extraArgs.length > 0) popParams();
    }
}

// ---- test / [ builtin -------------------------------------------------------

function runTest(args: string[]): ExecResult {
    try {
        return { exitCode: evalTestExpr(args, 0, args.length)[0] ? 0 : 1 };
    } catch (e) {
        process.stderr.write(`test: ${e instanceof Error ? e.message : e}\n`);
        return { exitCode: 2 };
    }
}

type TestResult = [boolean, number]; // [value, nextIndex]

function evalTestExpr(args: string[], pos: number, end: number): TestResult {
    if (pos >= end) return [false, pos];
    // Handle OR: expr1 -o expr2
    let [val, next] = evalTestAnd(args, pos, end);
    while (next < end && args[next] === "-o") {
        const [rhs, rn] = evalTestAnd(args, next + 1, end);
        val = val || rhs;
        next = rn;
    }
    return [val, next];
}

function evalTestAnd(args: string[], pos: number, end: number): TestResult {
    let [val, next] = evalTestNot(args, pos, end);
    while (next < end && args[next] === "-a") {
        const [rhs, rn] = evalTestNot(args, next + 1, end);
        val = val && rhs;
        next = rn;
    }
    return [val, next];
}

function evalTestNot(args: string[], pos: number, end: number): TestResult {
    if (pos < end && args[pos] === "!") {
        const [val, next] = evalTestNot(args, pos + 1, end);
        return [!val, next];
    }
    return evalTestPrimary(args, pos, end);
}

function evalTestPrimary(args: string[], pos: number, end: number): TestResult {
    if (pos >= end) return [false, pos];

    const tok = args[pos]!;

    // Parenthesized expression
    if (tok === "(") {
        const [val, next] = evalTestExpr(args, pos + 1, end);
        if (next >= end || args[next] !== ")") throw new Error("missing ')'");
        return [val, next + 1];
    }

    // Unary operators (must check before binary to handle -z, -n, -f, etc.)
    if (pos + 1 < end) {
        const unaryResult = evalUnaryTest(tok, args[pos + 1]!);
        if (unaryResult !== null) return [unaryResult, pos + 2];
    }

    // Binary operators — check if next token is a binary op
    if (pos + 2 < end) {
        const binResult = evalBinaryOp(tok, args[pos + 1]!, args[pos + 2]!, pos);
        if (binResult !== null) return [binResult, pos + 3];
    }

    // Single argument: true if non-empty string
    return [tok.length > 0, pos + 1];
}

function evalUnaryTest(op: string, arg: string): boolean | null {
    const fs = require("node:fs") as typeof import("node:fs");
    switch (op) {
        case "-z": return arg.length === 0;
        case "-n": return arg.length > 0;
        case "-e": case "-a": // -a as unary = file exists (POSIX)
            try { fs.statSync(arg); return true; } catch { return false; }
        case "-f":
            try { return fs.statSync(arg).isFile(); } catch { return false; }
        case "-d":
            try { return fs.statSync(arg).isDirectory(); } catch { return false; }
        case "-s":
            try { return fs.statSync(arg).size > 0; } catch { return false; }
        case "-r": case "-w": case "-x": {
            const mode = op === "-r" ? fs.constants.R_OK : op === "-w" ? fs.constants.W_OK : fs.constants.X_OK;
            try { fs.accessSync(arg, mode); return true; } catch { return false; }
        }
        case "-L": case "-h":
            try { return fs.lstatSync(arg).isSymbolicLink(); } catch { return false; }
        case "-p":
            try { return fs.statSync(arg).isFIFO(); } catch { return false; }
        case "-S":
            try { return fs.statSync(arg).isSocket(); } catch { return false; }
        case "-b":
            try { return fs.statSync(arg).isBlockDevice(); } catch { return false; }
        case "-c":
            try { return fs.statSync(arg).isCharacterDevice(); } catch { return false; }
        case "-t": {
            const fd = parseInt(arg, 10);
            if (isNaN(fd)) return false;
            try { return require("node:tty").isatty(fd); } catch { return false; }
        }
        default: return null;
    }
}

function evalBinaryOp(left: string, op: string, right: string | undefined, _pos: number): boolean | null {
    if (right === undefined) return null;
    switch (op) {
        // String comparison
        case "=": case "==": return left === right;
        case "!=": return left !== right;
        // Integer comparison
        case "-eq": return toInt(left) === toInt(right);
        case "-ne": return toInt(left) !== toInt(right);
        case "-lt": return toInt(left) < toInt(right);
        case "-le": return toInt(left) <= toInt(right);
        case "-gt": return toInt(left) > toInt(right);
        case "-ge": return toInt(left) >= toInt(right);
        // File comparison
        case "-nt": case "-ot": case "-ef": return evalFileCompare(left, op, right);
        default: return null;
    }
}

function evalFileCompare(left: string, op: string, right: string): boolean {
    const fs = require("node:fs") as typeof import("node:fs");
    try {
        const ls = fs.statSync(left);
        const rs = fs.statSync(right);
        if (op === "-nt") return ls.mtimeMs > rs.mtimeMs;
        if (op === "-ot") return ls.mtimeMs < rs.mtimeMs;
        // -ef: same device and inode
        return ls.dev === rs.dev && ls.ino === rs.ino;
    } catch { return false; }
}

function toInt(s: string): number {
    const n = parseInt(s, 10);
    if (isNaN(n)) throw new Error(`integer expression expected: ${s}`);
    return n;
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
        case "test":
            return runTest(args);
        case "[": {
            if (args.length === 0 || args[args.length - 1] !== "]") {
                process.stderr.write("[: missing ']'\n");
                return { exitCode: 2 };
            }
            return runTest(args.slice(0, -1));
        }
        case "set":
            return runSet(args);
        case "local": {
            for (const arg of args) {
                const eq = arg.indexOf("=");
                if (eq > 0) {
                    const key = arg.slice(0, eq);
                    const val = arg.slice(eq + 1);
                    declareLocal(key);
                    $[key] = val;
                } else if (arg) {
                    declareLocal(arg);
                }
            }
            return { exitCode: 0 };
        }
        default:
            return null;
    }
}

// ---- set builtin ------------------------------------------------------------

const shortOptMap: Record<string, keyof typeof shellOpts> = {
    e: "errexit",
    u: "nounset",
    x: "xtrace",
};

const longOptMap: Record<string, keyof typeof shellOpts> = {
    errexit: "errexit",
    nounset: "nounset",
    xtrace: "xtrace",
    pipefail: "pipefail",
};

function runSet(args: string[]): ExecResult {
    if (args.length === 0) {
        // Print all shell options
        for (const [name, val] of Object.entries(shellOpts)) {
            process.stdout.write(`${name}\t${val ? "on" : "off"}\n`);
        }
        return { exitCode: 0 };
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "-o" || arg === "+o") {
            const enable = arg[0] === "-";
            const name = args[++i];
            if (!name || !(name in longOptMap)) {
                process.stderr.write(`set: ${name ?? ""}: invalid option\n`);
                return { exitCode: 1 };
            }
            shellOpts[longOptMap[name]!] = enable;
        } else if (arg.startsWith("-") && arg.length > 1 && arg[1] !== "-") {
            for (let j = 1; j < arg.length; j++) {
                const ch = arg[j]!;
                const opt = shortOptMap[ch];
                if (!opt) {
                    process.stderr.write(`set: -${ch}: invalid option\n`);
                    return { exitCode: 1 };
                }
                shellOpts[opt] = true;
            }
        } else if (arg.startsWith("+") && arg.length > 1) {
            for (let j = 1; j < arg.length; j++) {
                const ch = arg[j]!;
                const opt = shortOptMap[ch];
                if (!opt) {
                    process.stderr.write(`set: +${ch}: invalid option\n`);
                    return { exitCode: 1 };
                }
                shellOpts[opt] = false;
            }
        } else {
            process.stderr.write(`set: ${arg}: invalid argument\n`);
            return { exitCode: 1 };
        }
    }
    return { exitCode: 0 };
}
