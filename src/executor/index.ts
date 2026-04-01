import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { createReadStream, createWriteStream, read as fsRead, readFileSync, readSync, accessSync, openSync, closeSync, constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const fsReadAsync = promisify(fsRead);
import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List, BraceGroup, Subshell, Redirection,
    IfClause, WhileClause, ForClause, FunctionDef, JsFunction, CaseClause,
    ConditionalExpr,
} from "../parser/index.js";
import { parse } from "../parser/index.js";
import { expandWord, expandWordToStr, registerCaptureImpl, registerProcessSubstImpl } from "../expander/index.js";
import { $, pushScope, popScope, declareLocal, pushSnapshot, popSnapshot } from "../variables/index.js";
import { pushParams, popParams, shiftParams, snapshotParams, restoreParams } from "../variables/positional.js";
import { lookupJsFunction } from "../jsfunctions/index.js";
import { getAlias } from "../api/index.js";
import { shellOpts, saveShellOpts, restoreShellOpts } from "../shellopts/index.js";
import {
    addJob, removeJob, getJobBySpec, getCurrentJob, getAllJobs,
    markJobStopped, markJobRunning, reapFinishedJobs,
} from "../jobs/index.js";
import { setTrap, getAllTraps, runTrap } from "../trap/index.js";

const require = createRequire(import.meta.url);
interface PipelineResult {
    exitCode: number;
    pipeStatus: number[];
    stopped: boolean;
    stoppedSignal: number;
    pgid: number;
    pids?: number[];
}

const native = require("../../build/Release/jsh_native.node") as {
    spawnPipeline: (
        stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }>,
        pipeOps: string[],
        background?: boolean
    ) => Promise<PipelineResult>;
    captureOutput: (
        stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }>,
        pipeOps: string[]
    ) => Promise<{ exitCode: number; output: string }>;
    createCloexecPipe: () => [number, number];
    clearCloexec: (fd: number) => void;
    closeFd: (fd: number) => void;
    forkExec: (cmd: string, args: string[], stdinFd?: number, stdoutFd?: number, stderrFd?: number, pgid?: number) => number;
    waitForPids: (pids: number[], pgid?: number) => Promise<PipelineResult>;
    execvp: (cmd: string, args: string[]) => number;
    dupFd: (fd: number) => number;
    dup2Fd: (oldFd: number, newFd: number) => number;
    sendSignal: (pid: number, signal: number) => number;
    reapChildren: () => Array<{ pid: number; exitCode: number; stopped: boolean }>;
    tcsetpgrpFg: (pgid: number) => void;
    tcsetpgrpShell: () => void;
    SIGCONT: number;
    SIGTSTP: number;
    SIGTERM: number;
};

export interface ExecResult {
    exitCode: number;
}

// Shell function registry.
const shellFunctions = new Map<string, ASTNode>();

// Execute a string as shell commands (used by trap and eval).
export async function executeString(code: string): Promise<void> {
    const ast = parse(code.trim());
    if (ast) await executeNode(ast);
}

export function hasShellFunction(name: string): boolean {
    return shellFunctions.has(name);
}

// Command text tracking for job display strings.
let currentCommandText = "";
export function setCommandText(text: string): void { currentCommandText = text; }

// Reap finished background jobs — called by REPL before each prompt.
export function reapJobs(): string[] {
    return reapFinishedJobs(() => native.reapChildren());
}

// Register command substitution handler with the expander.
registerCaptureImpl(async (body: string): Promise<string> => {
    const ast = parse(body.trim());
    if (!ast) return "";
    const result = await captureAst(ast);
    // Strip trailing newlines — POSIX behaviour.
    return result.replace(/\n+$/, "");
});

// Track fds opened by process substitution for cleanup after command execution.
const processSubstFds: number[] = [];

// Register process substitution handler with the expander.
registerProcessSubstImpl((body: string, direction: "<" | ">"): string => {
    const [readFd, writeFd] = native.createCloexecPipe();
    if (direction === "<") {
        // <(cmd): command writes to pipe, caller reads from pipe.
        // Fork command with stdout → writeFd.
        const ast = parse(body.trim());
        if (ast && ast.type === "SimpleCommand") {
            // Use forkExec for simple commands.
            const sc = ast as SimpleCommand;
            const words = sc.words.map(w => w.segments.map(s => "value" in s ? (s as { value: string }).value : "").join("")).filter(Boolean);
            if (words.length > 0) {
                native.forkExec(words[0]!, words.slice(1), -1, writeFd, -1, 0);
            }
        }
        native.closeFd(writeFd);
        native.clearCloexec(readFd);
        processSubstFds.push(readFd);
        return `/dev/fd/${readFd}`;
    } else {
        // >(cmd): caller writes to pipe, command reads from pipe.
        const ast = parse(body.trim());
        if (ast && ast.type === "SimpleCommand") {
            const sc = ast as SimpleCommand;
            const words = sc.words.map(w => w.segments.map(s => "value" in s ? (s as { value: string }).value : "").join("")).filter(Boolean);
            if (words.length > 0) {
                native.forkExec(words[0]!, words.slice(1), readFd, -1, -1, 0);
            }
        }
        native.closeFd(readFd);
        native.clearCloexec(writeFd);
        processSubstFds.push(writeFd);
        return `/dev/fd/${writeFd}`;
    }
});

export async function execute(node: ASTNode): Promise<ExecResult> {
    const result = await executeNode(node);
    $["?"] = result.exitCode;
    // Clean up process substitution fds.
    for (const fd of processSubstFds) {
        try { native.closeFd(fd); } catch {}
    }
    processSubstFds.length = 0;
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
        case "BraceGroup":     return executeBraceGroup(node as BraceGroup);
        case "Subshell":       return executeSubshell(node as Subshell);
        case "IfClause":       return executeIf(node as IfClause);
        case "WhileClause":    return executeWhile(node as WhileClause);
        case "ForClause":      return executeFor(node as ForClause);
        case "FunctionDef":    return executeFunctionDef(node as FunctionDef);
        case "CaseClause":     return executeCase(node as CaseClause);
        case "ConditionalExpr": return executeConditionalExpr(node as ConditionalExpr);
        case "JsFunction":     return executeJsStage(node as JsFunction, 0, 1);
        default:
            process.stderr.write(`jsh: unimplemented: ${node.type}\n`);
            return { exitCode: 1 };
    }
}

// ---- In-process fd-level redirections ----------------------------------------
// Applies redirections around a block for compound commands (brace groups,
// subshells) that execute in-process rather than in a forked child.

async function withRedirections(redirs: Redirection[], body: () => Promise<ExecResult>): Promise<ExecResult> {
    if (redirs.length === 0) return body();

    const saved: Array<{ fd: number; savedFd: number }> = [];
    const opened: number[] = [];

    try {
        for (const r of redirs) {
            const target = await expandWordToStr(r.target);
            const seg = r.target.segments[0];
            const isHereDoc = seg?.type === "HereDoc";

            if (isHereDoc) {
                // Here-doc: create a pipe, write body into it, redirect stdin from it.
                const hd = seg as { type: "HereDoc"; body: string; quoted: boolean };
                const bodyText = hd.quoted ? hd.body : await expandHereDocBody(hd.body);
                const [readEnd, writeEnd] = native.createCloexecPipe();
                native.clearCloexec(readEnd);
                native.clearCloexec(writeEnd);
                const buf = Buffer.from(bodyText);
                let written = 0;
                while (written < buf.length) {
                    written += require("node:fs").writeSync(writeEnd, buf, written);
                }
                native.closeFd(writeEnd);
                const srcFd = r.fd ?? 0;
                saved.push({ fd: srcFd, savedFd: native.dupFd(srcFd) });
                native.dup2Fd(readEnd, srcFd);
                native.closeFd(readEnd);
                continue;
            }

            switch (r.op) {
                case ">": case ">>": {
                    const flags = r.op === ">"
                        ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
                        : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
                    const fileFd = openSync(target, flags, 0o666);
                    opened.push(fileFd);
                    const srcFd = r.fd ?? 1;
                    saved.push({ fd: srcFd, savedFd: native.dupFd(srcFd) });
                    native.dup2Fd(fileFd, srcFd);
                    break;
                }
                case "<": {
                    const fileFd = openSync(target, fsConstants.O_RDONLY);
                    opened.push(fileFd);
                    const srcFd = r.fd ?? 0;
                    saved.push({ fd: srcFd, savedFd: native.dupFd(srcFd) });
                    native.dup2Fd(fileFd, srcFd);
                    break;
                }
                case ">&": {
                    // fd duplication: e.g. 2>&1
                    const dstFd = parseInt(target, 10);
                    const srcFd = r.fd ?? 1;
                    saved.push({ fd: srcFd, savedFd: native.dupFd(srcFd) });
                    native.dup2Fd(dstFd, srcFd);
                    break;
                }
                case "<&": {
                    const dstFd = parseInt(target, 10);
                    const srcFd = r.fd ?? 0;
                    saved.push({ fd: srcFd, savedFd: native.dupFd(srcFd) });
                    native.dup2Fd(dstFd, srcFd);
                    break;
                }
                case "&>": case "&>>": {
                    // Redirect both stdout and stderr to file.
                    const flags = r.op === "&>"
                        ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
                        : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
                    const fileFd = openSync(target, flags, 0o666);
                    opened.push(fileFd);
                    saved.push({ fd: 1, savedFd: native.dupFd(1) });
                    saved.push({ fd: 2, savedFd: native.dupFd(2) });
                    native.dup2Fd(fileFd, 1);
                    native.dup2Fd(fileFd, 2);
                    break;
                }
            }
        }

        return await body();
    } finally {
        // Restore all saved fds in reverse order.
        for (let i = saved.length - 1; i >= 0; i--) {
            const { fd, savedFd } = saved[i]!;
            native.dup2Fd(savedFd, fd);
            native.closeFd(savedFd);
        }
        for (const fd of opened) {
            closeSync(fd);
        }
    }
}

// ---- Brace group execution ---------------------------------------------------

async function executeBraceGroup(node: BraceGroup): Promise<ExecResult> {
    return withRedirections(node.redirections, () => executeNode(node.body));
}

// ---- Subshell execution (isolated environment) ------------------------------

async function executeSubshell(node: Subshell): Promise<ExecResult> {
    const savedCwd = process.cwd();
    const savedOpts = saveShellOpts();
    const savedParams = snapshotParams();
    pushSnapshot();
    try {
        return await withRedirections(node.redirections, () => executeNode(node.body));
    } finally {
        popSnapshot();
        restoreShellOpts(savedOpts);
        restoreParams(savedParams);
        try { process.chdir(savedCwd); } catch {}
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
            const body = hd.quoted ? hd.body : await expandHereDocBody(hd.body);
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

    // General fallback: redirect fd 1 to a capture pipe, run the AST in-process,
    // then read the captured output.  Works for subshells, control flow, etc.
    const [readFd, writeFd] = native.createCloexecPipe();
    native.clearCloexec(writeFd);

    // Save real stdout fd, then redirect fd 1 → pipe write end.
    const savedStdout = native.dupFd(1);
    native.dup2Fd(writeFd, 1);
    native.closeFd(writeFd);

    // Read captured output concurrently while the node executes.
    const chunks: string[] = [];
    const reader = (async () => {
        for await (const line of fdLineReader(readFd)) {
            chunks.push(line);
        }
    })();

    try {
        await executeNode(node);
    } finally {
        // Restore stdout before reading remaining output.
        native.dup2Fd(savedStdout, 1);
        native.closeFd(savedStdout);
    }

    await reader;
    native.closeFd(readFd);
    return chunks.join("");
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
        try {
            const r = await executeNode(func);
            $["PIPESTATUS"] = [r.exitCode];
            return r;
        }
        finally { popScope(); popParams(); }
    }

    // read builtin
    if (command === "read") {
        const r = runRead(args, redirs);
        $["PIPESTATUS"] = [r.exitCode];
        return r;
    }

    // source / . — read file, parse, execute in current context
    if (command === "source" || command === ".") {
        if (args.length === 0) {
            process.stderr.write(`${command}: filename argument required\n`);
            $["PIPESTATUS"] = [2];
            return { exitCode: 2 };
        }
        const r = await runSource(args[0]!, args.slice(1));
        $["PIPESTATUS"] = [r.exitCode];
        return r;
    }

    // exit — run EXIT trap before exiting
    if (command === "exit") {
        const code = args[0] !== undefined ? parseInt(args[0], 10) : 0;
        await runTrap("EXIT", executeString);
        process.exit(isNaN(code) ? 0 : code);
    }

    // trap — register signal handlers
    if (command === "trap") {
        return runTrapBuiltin(args);
    }

    // eval — parse and execute string in current context
    if (command === "eval") {
        if (args.length === 0) return { exitCode: 0 };
        const code = args.join(" ");
        try {
            const ast = parse(code);
            if (!ast) return { exitCode: 0 };
            const r = await executeNode(ast);
            $["PIPESTATUS"] = [r.exitCode];
            return r;
        } catch (e: unknown) {
            process.stderr.write(`eval: ${e instanceof Error ? e.message : e}\n`);
            return { exitCode: 1 };
        }
    }

    // Job control builtins (async).
    if (command === "fg") return runFg(args);
    if (command === "bg") return runBg(args);
    if (command === "jobs") return runJobs();
    if (command === "wait") return runWait(args);

    // Builtins only run in-process when there are no redirections.
    const builtin = redirs.length === 0 ? runBuiltin(command, args) : null;
    if (builtin !== null) {
        $["PIPESTATUS"] = [builtin.exitCode];
        return builtin;
    }

    const result = await native.spawnPipeline([{ cmd: command, args, redirs }], []);
    if (result.stopped) {
        const pids = result.pids ?? [];
        const cmdText = [command, ...args].join(" ");
        const job = addJob(result.pgid, pids, cmdText, "stopped");
        process.stderr.write(`\n[${job.id}]+  Stopped\t\t${job.command}\n`);
        return { exitCode: 128 + result.stoppedSignal };
    }
    $["PIPESTATUS"] = result.pipeStatus;
    return { exitCode: result.exitCode };
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
    const result = await native.spawnPipeline(stages, node.pipeOps);

    // Handle stopped (Ctrl-Z).
    if (result.stopped) {
        const pids = result.pids ?? [];
        const cmdText = stages.map(s => [s.cmd, ...s.args].join(" ")).join(" | ");
        const job = addJob(result.pgid, pids, cmdText, "stopped");
        process.stderr.write(`\n[${job.id}]+  Stopped\t\t${job.command}\n`);
        return { exitCode: 128 + result.stoppedSignal };
    }

    $["PIPESTATUS"] = result.pipeStatus;
    let exitCode = result.exitCode;
    if (shellOpts.pipefail) {
        for (let i = result.pipeStatus.length - 1; i >= 0; i--) {
            if (result.pipeStatus[i] !== 0) { exitCode = result.pipeStatus[i]!; break; }
        }
    }
    if (node.negated) exitCode = exitCode === 0 ? 1 : 0;
    return { exitCode };
}

// ---- Mixed pipeline (contains JS function stages) --------------------------

async function executeMixedPipeline(node: Pipeline): Promise<number> {
    const n = node.commands.length;
    const stageExitCodes = new Array<number>(n).fill(0);

    // Create cloexec pipes between all adjacent stages.
    // pipes[i] = [readFd, writeFd] connecting stage i → stage i+1.
    const pipes: Array<[number, number]> = [];
    for (let i = 0; i < n - 1; i++) {
        pipes.push(native.createCloexecPipe());
    }

    const stdinFd  = (i: number) => i === 0     ? 0 : pipes[i - 1]![0];
    const stdoutFd = (i: number) => i === n - 1 ? 1 : pipes[i]![1];

    const pids: number[] = [];
    // Map from pids index to pipeline stage index.
    const pidToStage: number[] = [];
    let pgid = 0;

    // Fork all external stages first so they're running while JS stages process.
    for (let i = 0; i < n; i++) {
        const stageNode = node.commands[i]!;
        if (stageNode.type !== "SimpleCommand") continue;

        const stage = await buildStage(stageNode as SimpleCommand);
        if (!stage) { process.stderr.write("jsh: empty stage\n"); continue; }

        const sin  = stdinFd(i);
        const sout = stdoutFd(i);

        const pid = native.forkExec(stage.cmd, stage.args, sin, sout, -1, pgid);
        if (pgid === 0) pgid = pid;
        pids.push(pid);
        pidToStage.push(i);
    }

    // Close write ends that external stages are now writing into, and read ends
    // that external stages are now reading from — the parent doesn't need them.
    for (let i = 0; i < n - 1; i++) {
        const [r, w] = pipes[i]!;
        const prevIsJs = node.commands[i]!.type === "JsFunction";
        const nextIsJs = node.commands[i + 1]!.type === "JsFunction";
        if (!nextIsJs) native.closeFd(r);
        if (!prevIsJs) native.closeFd(w);
    }

    // Run JS function stages in-process.
    for (let i = 0; i < n; i++) {
        const stageNode = node.commands[i]!;
        if (stageNode.type !== "JsFunction") continue;
        const sin  = stdinFd(i);
        const sout = stdoutFd(i);
        stageExitCodes[i] = await executeJsStageRaw(stageNode as JsFunction, sin, sout);
        if (sout !== 1) native.closeFd(sout);
        if (sin  !== 0) native.closeFd(sin);
    }

    // Wait for all external processes.
    if (pids.length > 0) {
        const waitResult = await native.waitForPids(pids, pgid);
        // Map external exit codes back to pipeline stage positions.
        for (let i = 0; i < waitResult.pipeStatus.length; i++) {
            stageExitCodes[pidToStage[i]!] = waitResult.pipeStatus[i]!;
        }
    }

    $["PIPESTATUS"] = stageExitCodes;

    // Determine final exit code.
    let exitCode = stageExitCodes[n - 1]!;
    if (shellOpts.pipefail) {
        for (let i = n - 1; i >= 0; i--) {
            if (stageExitCodes[i] !== 0) { exitCode = stageExitCodes[i]!; break; }
        }
    }
    return exitCode;
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
            last = await executeBackground(entry.node);
            $["?"] = last.exitCode;
            continue;
        }
        last = await executeNode(entry.node);
        $["?"] = last.exitCode;
        if (shellOpts.errexit && last.exitCode !== 0) return last;
    }
    return last;
}

async function executeBackground(node: ASTNode): Promise<ExecResult> {
    // Build stages for pure-external pipeline or simple command.
    let stages: Stage[] | null = null;
    let pipeOps: string[] = [];

    if (node.type === "SimpleCommand") {
        const stage = await buildStage(node as SimpleCommand);
        if (stage) stages = [stage];
    } else if (node.type === "Pipeline") {
        const pipe = node as Pipeline;
        const allSimple = pipe.commands.every(c => c.type === "SimpleCommand");
        if (allSimple) {
            stages = [];
            pipeOps = pipe.pipeOps;
            for (const stageNode of pipe.commands) {
                const s = await buildStage(stageNode as SimpleCommand);
                if (!s) { stages = null; break; }
                stages.push(s);
            }
        }
    }

    if (!stages || stages.length === 0) {
        process.stderr.write("jsh: background not supported for this command type\n");
        return executeNode(node);
    }

    const result = await native.spawnPipeline(stages, pipeOps, true);
    const pids = result.pids ?? [];
    const cmdText = stages.map(s => [s.cmd, ...s.args].join(" ")).join(" | ");
    const job = addJob(result.pgid, pids, cmdText, "running");
    const lastPid = pids.length > 0 ? pids[pids.length - 1]! : result.pgid;
    $["!"] = lastPid;
    process.stderr.write(`[${job.id}] ${lastPid}\n`);
    return { exitCode: 0 };
}

// ---- Job control builtins ---------------------------------------------------

async function runFg(args: string[]): Promise<ExecResult> {
    const spec = args[0] ?? "%%";
    const job = getJobBySpec(spec) ?? getCurrentJob();
    if (!job) {
        process.stderr.write("jsh: fg: no current job\n");
        return { exitCode: 1 };
    }
    process.stderr.write(`${job.command}\n`);
    markJobRunning(job.id);
    native.tcsetpgrpFg(job.pgid);
    native.sendSignal(-job.pgid, native.SIGCONT);
    const result = await native.waitForPids(job.pids, job.pgid);
    native.tcsetpgrpShell();
    if (result.stopped) {
        markJobStopped(job.id, result.stoppedSignal);
        process.stderr.write(`\n[${job.id}]+  Stopped\t\t${job.command}\n`);
        return { exitCode: 128 + result.stoppedSignal };
    }
    removeJob(job.id);
    $["PIPESTATUS"] = result.pipeStatus;
    return { exitCode: result.exitCode };
}

async function runBg(args: string[]): Promise<ExecResult> {
    const spec = args[0] ?? "%%";
    const job = getJobBySpec(spec) ?? getCurrentJob();
    if (!job || job.status !== "stopped") {
        process.stderr.write("jsh: bg: no stopped job\n");
        return { exitCode: 1 };
    }
    markJobRunning(job.id);
    native.sendSignal(-job.pgid, native.SIGCONT);
    process.stderr.write(`[${job.id}]+ ${job.command} &\n`);
    return { exitCode: 0 };
}

function runJobs(): ExecResult {
    const currentJob = getCurrentJob();
    for (const job of getAllJobs()) {
        const marker = job === currentJob ? "+" : " ";
        const status = job.status === "running" ? "Running" : "Stopped";
        process.stdout.write(`[${job.id}]${marker}  ${status}\t\t${job.command}\n`);
    }
    return { exitCode: 0 };
}

async function runWait(args: string[]): Promise<ExecResult> {
    const targets = args.length === 0
        ? getAllJobs().filter(j => j.status === "running")
        : args.map(a => getJobBySpec(a)).filter((j): j is NonNullable<typeof j> => j != null && j.status === "running");
    let lastExit = 0;
    for (const job of targets) {
        const result = await native.waitForPids(job.pids, -1);
        if (result.stopped) {
            markJobStopped(job.id, result.stoppedSignal);
        } else {
            lastExit = result.exitCode;
            removeJob(job.id);
        }
    }
    return { exitCode: lastExit };
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

async function expandHereDocBody(body: string): Promise<string> {
    let result = "";
    let i = 0;
    while (i < body.length) {
        if (body[i] === "\\") {
            // Backslash escapes $ in here-docs
            if (i + 1 < body.length && body[i + 1] === "$") {
                result += "$";
                i += 2;
                continue;
            }
            result += body[i];
            i++;
            continue;
        }
        if (body[i] === "$") {
            // $((...)) arithmetic expansion
            if (i + 2 < body.length && body[i + 1] === "(" && body[i + 2] === "(") {
                const start = i + 3;
                let depth = 2;
                let j = start;
                while (j < body.length && depth > 0) {
                    if (body[j] === "(") depth++;
                    else if (body[j] === ")") depth--;
                    if (depth > 0) j++;
                }
                if (depth === 0) {
                    const expr = body.slice(start, j - 1);
                    let evalResult: string;
                    try {
                        let e = expr.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) =>
                            String($[name] ?? 0));
                        e = e.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (_, name: string) =>
                            String($[name] ?? 0));
                        const r = new Function(`"use strict"; return (${e})`)();
                        evalResult = String(Math.trunc(typeof r === "number" ? r : Number(r)));
                    } catch { evalResult = "0"; }
                    result += evalResult;
                    i = j + 1;
                    continue;
                }
            }
            // $(...) command substitution
            if (i + 1 < body.length && body[i + 1] === "(") {
                const start = i + 2;
                let depth = 1;
                let j = start;
                while (j < body.length && depth > 0) {
                    if (body[j] === "(") depth++;
                    else if (body[j] === ")") depth--;
                    j++;
                }
                const cmd = body.slice(start, j - 1);
                const ast = parse(cmd);
                if (ast) {
                    const captured = await captureAst(ast);
                    result += captured.replace(/\n+$/, "");
                }
                i = j;
                continue;
            }
            // ${VAR} or $VAR
            if (body[i + 1] === "{") {
                const end = body.indexOf("}", i + 2);
                if (end !== -1) {
                    const name = body.slice(i + 2, end);
                    const val = $[name];
                    result += val !== undefined ? String(val) : "";
                    i = end + 1;
                    continue;
                }
            }
            // $VAR
            let name = "";
            let j = i + 1;
            while (j < body.length && /[a-zA-Z0-9_]/.test(body[j]!)) {
                name += body[j]; j++;
            }
            if (name) {
                // Handle special vars
                if (name === "?") {
                    result += String($["?"] ?? 0);
                } else {
                    const val = $[name];
                    result += val !== undefined ? String(val) : "";
                }
                i = j;
                continue;
            }
            result += body[i];
            i++;
            continue;
        }
        result += body[i];
        i++;
    }
    return result;
}

// Legacy sync version for simple cases (kept for backward compat in withRedirections)
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

// ---- echo escape processing -------------------------------------------------

function echoEscape(s: string): string {
    let result = "";
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "\\" && i + 1 < s.length) {
            switch (s[i + 1]) {
                case "n": result += "\n"; i++; break;
                case "t": result += "\t"; i++; break;
                case "r": result += "\r"; i++; break;
                case "\\": result += "\\"; i++; break;
                case "a": result += "\x07"; i++; break;
                case "b": result += "\b"; i++; break;
                case "f": result += "\f"; i++; break;
                case "v": result += "\v"; i++; break;
                case "0": {
                    let oct = "";
                    let j = i + 2;
                    while (j < s.length && j < i + 5 && s[j]! >= "0" && s[j]! <= "7") { oct += s[j]; j++; }
                    result += String.fromCharCode(parseInt(oct || "0", 8));
                    i = j - 1;
                    break;
                }
                case "x": {
                    let hex = "";
                    let j = i + 2;
                    while (j < s.length && j < i + 4 && /[0-9a-fA-F]/.test(s[j]!)) { hex += s[j]; j++; }
                    if (hex) { result += String.fromCharCode(parseInt(hex, 16)); i = j - 1; }
                    else { result += "\\x"; i++; }
                    break;
                }
                default: result += "\\" + s[i + 1]; i++; break;
            }
        } else {
            result += s[i];
        }
    }
    return result;
}

// ---- trap builtin -----------------------------------------------------------

function runTrapBuiltin(args: string[]): ExecResult {
    // No args: list current traps
    if (args.length === 0) {
        for (const [sig, action] of getAllTraps()) {
            process.stdout.write(`trap -- ${shellQuote(action)} ${sig}\n`);
        }
        return { exitCode: 0 };
    }

    // trap -l: list signal names (not standard, but useful)
    if (args[0] === "-l") {
        process.stdout.write("EXIT INT TERM HUP QUIT ERR DEBUG RETURN\n");
        return { exitCode: 0 };
    }

    // Single arg: treated as signal name with action inherited (print)
    // trap action sig1 [sig2 ...]
    if (args.length === 1) {
        // Single arg could be a signal to display
        const action = getAllTraps().get(args[0]!.toUpperCase().replace(/^SIG/, ""));
        if (action !== undefined) {
            process.stdout.write(`trap -- ${shellQuote(action)} ${args[0]}\n`);
        }
        return { exitCode: 0 };
    }

    const action = args[0]!;
    let ok = true;
    for (let i = 1; i < args.length; i++) {
        if (!setTrap(args[i]!, action)) ok = false;
    }
    return { exitCode: ok ? 0 : 1 };
}

function shellQuote(s: string): string {
    if (s === "") return "''";
    if (/^[a-zA-Z0-9_.\/:@=+-]+$/.test(s)) return `'${s}'`;
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---- printf builtin ---------------------------------------------------------

function printfEscape(s: string): string {
    let result = "";
    let i = 0;
    while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
            const next = s[i + 1]!;
            switch (next) {
                case "n": result += "\n"; i += 2; break;
                case "t": result += "\t"; i += 2; break;
                case "r": result += "\r"; i += 2; break;
                case "\\": result += "\\"; i += 2; break;
                case "a": result += "\x07"; i += 2; break;
                case "b": result += "\b"; i += 2; break;
                case "f": result += "\f"; i += 2; break;
                case "v": result += "\v"; i += 2; break;
                case "0": {
                    // Octal: \0NNN (up to 3 digits after 0)
                    let oct = "";
                    let j = i + 2;
                    while (j < s.length && j < i + 5 && s[j]! >= "0" && s[j]! <= "7") {
                        oct += s[j]; j++;
                    }
                    result += String.fromCharCode(parseInt(oct || "0", 8));
                    i = j;
                    break;
                }
                case "x": {
                    // Hex: \xNN
                    let hex = "";
                    let j = i + 2;
                    while (j < s.length && j < i + 4 && /[0-9a-fA-F]/.test(s[j]!)) {
                        hex += s[j]; j++;
                    }
                    if (hex) result += String.fromCharCode(parseInt(hex, 16));
                    i = j;
                    break;
                }
                default: result += "\\" + next; i += 2; break;
            }
        } else {
            result += s[i]; i++;
        }
    }
    return result;
}

function runPrintf(args: string[]): ExecResult {
    if (args.length === 0) {
        process.stderr.write("printf: usage: printf format [arguments]\n");
        return { exitCode: 1 };
    }

    const fmt = args[0]!;
    let argIdx = 1;

    // Process format string, reusing it if args remain (POSIX behavior).
    do {
        const startArgIdx = argIdx;
        let output = "";
        let i = 0;

        while (i < fmt.length) {
            if (fmt[i] === "\\" && i + 1 < fmt.length) {
                // Format string escape sequences
                const consumed = consumeEscape(fmt, i);
                output += consumed.char;
                i = consumed.next;
                continue;
            }

            if (fmt[i] === "%" && i + 1 < fmt.length) {
                i++;
                if (fmt[i] === "%") { output += "%"; i++; continue; }

                // Parse flags, width, precision
                while (i < fmt.length && "-+ #0".includes(fmt[i]!)) i++;
                while (i < fmt.length && fmt[i]! >= "0" && fmt[i]! <= "9") i++;
                if (i < fmt.length && fmt[i] === ".") {
                    i++;
                    while (i < fmt.length && fmt[i]! >= "0" && fmt[i]! <= "9") i++;
                }

                const conversion = i < fmt.length ? fmt[i]! : "";
                i++;
                const arg = argIdx < args.length ? args[argIdx]! : "";
                if (argIdx < args.length) argIdx++;

                switch (conversion) {
                    case "s": output += arg; break;
                    case "d": case "i": output += String(parseInt(arg, 10) || 0); break;
                    case "o": output += ((parseInt(arg, 10) || 0) >>> 0).toString(8); break;
                    case "x": output += ((parseInt(arg, 10) || 0) >>> 0).toString(16); break;
                    case "X": output += ((parseInt(arg, 10) || 0) >>> 0).toString(16).toUpperCase(); break;
                    case "f": output += (parseFloat(arg) || 0).toFixed(6); break;
                    case "c": output += arg ? arg[0]! : ""; break;
                    case "b": output += printfEscape(arg); break;
                    case "q":
                        if (arg === "") output += "''";
                        else if (/^[a-zA-Z0-9_.\/:@=-]+$/.test(arg)) output += arg;
                        else output += "'" + arg.replace(/'/g, "'\\''") + "'";
                        break;
                    default: output += "%" + conversion; break;
                }
                continue;
            }

            output += fmt[i]; i++;
        }

        process.stdout.write(output);

        // If no args were consumed this pass, stop (avoid infinite loop on format with no specifiers).
        if (argIdx === startArgIdx) break;
    } while (argIdx < args.length);

    return { exitCode: 0 };
}

function consumeEscape(s: string, i: number): { char: string; next: number } {
    const next = s[i + 1]!;
    switch (next) {
        case "n": return { char: "\n", next: i + 2 };
        case "t": return { char: "\t", next: i + 2 };
        case "r": return { char: "\r", next: i + 2 };
        case "\\": return { char: "\\", next: i + 2 };
        case "a": return { char: "\x07", next: i + 2 };
        case "b": return { char: "\b", next: i + 2 };
        case "f": return { char: "\f", next: i + 2 };
        case "v": return { char: "\v", next: i + 2 };
        case "0": {
            let oct = "";
            let j = i + 2;
            while (j < s.length && j < i + 5 && s[j]! >= "0" && s[j]! <= "7") { oct += s[j]; j++; }
            return { char: String.fromCharCode(parseInt(oct || "0", 8)), next: j };
        }
        case "x": {
            let hex = "";
            let j = i + 2;
            while (j < s.length && j < i + 4 && /[0-9a-fA-F]/.test(s[j]!)) { hex += s[j]; j++; }
            return { char: hex ? String.fromCharCode(parseInt(hex, 16)) : "\\x", next: j };
        }
        default: return { char: "\\" + next, next: i + 2 };
    }
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
        case "echo": {
            let newline = true;
            let escapes = false;
            let startIdx = 0;
            // Parse flags: -n (no newline), -e (enable escapes), -E (disable escapes)
            while (startIdx < args.length) {
                const a = args[startIdx]!;
                if (a === "-n") { newline = false; startIdx++; }
                else if (a === "-e") { escapes = true; startIdx++; }
                else if (a === "-E") { escapes = false; startIdx++; }
                else if (a === "-ne" || a === "-en") { newline = false; escapes = true; startIdx++; }
                else if (a === "-nE" || a === "-En") { newline = false; escapes = false; startIdx++; }
                else break;
            }
            let out = args.slice(startIdx).join(" ");
            if (escapes) out = echoEscape(out);
            process.stdout.write(out + (newline ? "\n" : ""));
            return { exitCode: 0 };
        }
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
        case "shift": {
            const n = args[0] !== undefined ? parseInt(args[0], 10) : 1;
            if (isNaN(n) || n < 0) {
                process.stderr.write(`shift: ${args[0]}: numeric argument required\n`);
                return { exitCode: 1 };
            }
            return { exitCode: shiftParams(n) ? 0 : 1 };
        }
        case "exec":
            // No args: exec with no command is a no-op (POSIX: redirections-only form not yet supported)
            if (args.length === 0) return { exitCode: 0 };
            return runExec(name, args);
        case "type":
            return runType(args);
        case "which":
            return runWhich(args);
        case "printf":
            return runPrintf(args);
        default:
            return null;
    }
}

// ---- [[ conditional expression ]] -------------------------------------------

async function executeConditionalExpr(node: ConditionalExpr): Promise<ExecResult> {
    // Expand each word to a string (no glob expansion inside [[ ]])
    const args: string[] = [];
    for (const w of node.words) {
        args.push(await expandWordToStr(w));
    }
    try {
        return { exitCode: evalCondExpr(args, 0, args.length)[0] ? 0 : 1 };
    } catch (e) {
        process.stderr.write(`[[: ${e instanceof Error ? e.message : e}\n`);
        return { exitCode: 2 };
    }
}

type CondResult = [boolean, number];

function evalCondExpr(args: string[], pos: number, end: number): CondResult {
    if (pos >= end) return [false, pos];
    let [val, next] = evalCondAnd(args, pos, end);
    while (next < end && args[next] === "||") {
        const [rhs, rn] = evalCondAnd(args, next + 1, end);
        val = val || rhs;
        next = rn;
    }
    return [val, next];
}

function evalCondAnd(args: string[], pos: number, end: number): CondResult {
    let [val, next] = evalCondNot(args, pos, end);
    while (next < end && args[next] === "&&") {
        const [rhs, rn] = evalCondNot(args, next + 1, end);
        val = val && rhs;
        next = rn;
    }
    return [val, next];
}

function evalCondNot(args: string[], pos: number, end: number): CondResult {
    if (pos < end && args[pos] === "!") {
        const [val, next] = evalCondNot(args, pos + 1, end);
        return [!val, next];
    }
    return evalCondPrimary(args, pos, end);
}

function evalCondPrimary(args: string[], pos: number, end: number): CondResult {
    if (pos >= end) return [false, pos];
    const tok = args[pos]!;

    // Parenthesized
    if (tok === "(") {
        const [val, next] = evalCondExpr(args, pos + 1, end);
        if (next >= end || args[next] !== ")") throw new Error("missing ')'");
        return [val, next + 1];
    }

    // Unary operators (reuse test's unary ops)
    if (pos + 1 < end) {
        const unary = evalUnaryTest(tok, args[pos + 1]!);
        if (unary !== null) return [unary, pos + 2];
    }

    // Binary operators
    if (pos + 2 < end) {
        const op = args[pos + 1]!;
        const right = args[pos + 2]!;
        // [[ extensions
        if (op === "=~") {
            try {
                return [new RegExp(right).test(tok), pos + 3];
            } catch {
                throw new Error(`invalid regex: ${right}`);
            }
        }
        if (op === "<") return [tok < right, pos + 3];
        if (op === ">") return [tok > right, pos + 3];
        // Standard binary ops from test
        const bin = evalBinaryOp(tok, op, right, pos);
        if (bin !== null) return [bin, pos + 3];
    }

    // Single argument: true if non-empty
    return [tok.length > 0, pos + 1];
}

// ---- type / which builtins --------------------------------------------------

const BUILTIN_NAMES = new Set([
    "cd", "exit", "export", "unset", "echo", "true", "false",
    "test", "[", "set", "local", "shift", "exec", "read",
    "source", ".", "alias", "unalias", "type", "which",
]);

function findInPath(cmd: string): string | null {
    if (cmd.includes("/")) {
        try { accessSync(cmd, fsConstants.X_OK); return cmd; } catch { return null; }
    }
    const path = String($["PATH"] ?? process.env["PATH"] ?? "");
    for (const dir of path.split(":")) {
        const full = dir + "/" + cmd;
        try { accessSync(full, fsConstants.X_OK); return full; } catch { /* skip */ }
    }
    return null;
}

function classifyCommand(name: string): { kind: string; detail: string } | null {
    const alias = getAlias(name);
    if (alias) return { kind: "alias", detail: `${name} is aliased to '${alias}'` };
    if (BUILTIN_NAMES.has(name)) return { kind: "builtin", detail: `${name} is a shell builtin` };
    if (shellFunctions.has(name)) return { kind: "function", detail: `${name} is a shell function` };
    if (name.startsWith("@") && lookupJsFunction(name.slice(1))) return { kind: "function", detail: `${name} is a JS pipeline function` };
    const path = findInPath(name);
    if (path) return { kind: "file", detail: `${name} is ${path}` };
    return null;
}

function runType(args: string[]): ExecResult {
    let exitCode = 0;
    for (const name of args) {
        const info = classifyCommand(name);
        if (info) {
            process.stdout.write(info.detail + "\n");
        } else {
            process.stderr.write(`type: ${name}: not found\n`);
            exitCode = 1;
        }
    }
    return { exitCode };
}

function runWhich(args: string[]): ExecResult {
    let exitCode = 0;
    for (const name of args) {
        const path = findInPath(name);
        if (path) {
            process.stdout.write(path + "\n");
        } else if (BUILTIN_NAMES.has(name)) {
            process.stdout.write(`${name}: shell built-in command\n`);
        } else {
            process.stderr.write(`which: ${name}: not found\n`);
            exitCode = 1;
        }
    }
    return { exitCode };
}

// ---- exec builtin -----------------------------------------------------------

function runExec(_name: string, args: string[]): ExecResult {
    const [cmd, ...rest] = args as [string, ...string[]];
    try {
        native.execvp(cmd, rest);
    } catch (e) {
        // execvp failed — print error and exit
        process.stderr.write(`exec: ${cmd}: ${e instanceof Error ? e.message : e}\n`);
        process.exit(127);
    }
    // Unreachable on success (process replaced), but TypeScript needs a return.
    process.exit(126);
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
