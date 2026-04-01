import { createRequire } from "node:module";
import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List, BraceGroup,
    IfClause, WhileClause, ForClause, FunctionDef,
} from "../parser/index.js";
import { parse } from "../parser/index.js";
import { expandWord, registerCaptureImpl } from "../expander/index.js";
import { $ } from "../variables/index.js";
import { pushParams, popParams } from "../variables/positional.js";

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
        default:
            process.stderr.write(`jsh: unimplemented: ${node.type}\n`);
            return { exitCode: 1 };
    }
}

// ---- Helpers ----------------------------------------------------------------

type Stage = { cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> };

async function buildStage(cmd: SimpleCommand): Promise<Stage | null> {
    const words = await Promise.all(cmd.words.map(expandWord));
    if (words.length === 0) return null;
    const [command, ...args] = words as [string, ...string[]];
    const redirs = await Promise.all(cmd.redirections.map(async r => ({
        op: r.op,
        fd: r.fd ?? -1,
        target: await expandWord(r.target),
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
        $[a.name] = await expandWord(a.value);
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

async function executePipeline(node: Pipeline): Promise<ExecResult> {
    const stages: Stage[] = [];
    for (const stageNode of node.commands) {
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
    const items = node.items ? await Promise.all(node.items.map(expandWord)) : [];
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
