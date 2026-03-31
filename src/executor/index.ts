import { createRequire } from "node:module";
import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List, BraceGroup,
    IfClause, WhileClause, ForClause, FunctionDef,
} from "../parser/index.js";
import { expandWord } from "../expander/index.js";
import { $ } from "../variables/index.js";
import { pushParams, popParams } from "../variables/positional.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    spawnPipeline: (
        stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }>,
        pipeOps: string[]
    ) => Promise<number>;
};

export interface ExecResult {
    exitCode: number;
}

// Shell function registry — populated by FunctionDef nodes at runtime.
const shellFunctions = new Map<string, ASTNode>();

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

// Build the redirection array for a stage.
function buildRedirs(cmd: SimpleCommand) {
    return cmd.redirections.map(r => ({
        op: r.op,
        fd: r.fd ?? -1,
        target: expandWord(r.target),
    }));
}

async function executeSimple(cmd: SimpleCommand): Promise<ExecResult> {
    // Prefix assignments with no command → set variables.
    for (const a of cmd.assignments) {
        $[a.name] = expandWord(a.value);
    }

    if (cmd.words.length === 0) {
        return { exitCode: 0 };
    }

    const words = cmd.words.map(expandWord);
    const [command, ...args] = words as [string, ...string[]];
    const redirs = buildRedirs(cmd);

    // Shell functions take priority over builtins and external commands.
    const func = shellFunctions.get(command);
    if (func) {
        pushParams(args);
        try {
            return await executeNode(func);
        } finally {
            popParams();
        }
    }

    // Only run builtins in-process when there are no redirections.
    // With redirections, fall through to the external binary so the OS
    // applies the redirects correctly.
    const builtin = redirs.length === 0 ? runBuiltin(command, args) : null;
    if (builtin !== null) {
        return builtin;
    }
    const exitCode = await native.spawnPipeline(
        [{ cmd: command, args, redirs }],
        []
    );
    return { exitCode };
}

async function executePipeline(node: Pipeline): Promise<ExecResult> {
    // Build stages — for now only SimpleCommand stages are supported.
    const stages: Array<{ cmd: string; args: string[]; redirs: Array<{ op: string; fd: number; target: string }> }> = [];

    for (const stageNode of node.commands) {
        if (stageNode.type !== "SimpleCommand") {
            process.stderr.write(`jsh: unsupported pipeline stage: ${stageNode.type}\n`);
            return { exitCode: 1 };
        }
        const cmd = stageNode as SimpleCommand;
        const words = cmd.words.map(expandWord);
        if (words.length === 0) {
            process.stderr.write("jsh: empty command in pipeline\n");
            return { exitCode: 1 };
        }
        const [command, ...args] = words as [string, ...string[]];
        stages.push({ cmd: command, args, redirs: buildRedirs(cmd) });
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
            // Background — not yet implemented, run synchronously for now.
            process.stderr.write("jsh: background jobs not yet implemented\n");
            last = await executeNode(entry.node);
        } else {
            last = await executeNode(entry.node);
        }
    }
    return last;
}

async function executeIf(node: IfClause): Promise<ExecResult> {
    const cond = await executeNode(node.condition);
    if (cond.exitCode === 0) {
        return executeNode(node.consequent);
    } else if (node.elseClause) {
        return executeNode(node.elseClause);
    }
    return { exitCode: 0 };
}

async function executeWhile(node: WhileClause): Promise<ExecResult> {
    let last: ExecResult = { exitCode: 0 };
    while (true) {
        const cond = await executeNode(node.condition);
        const condMet = node.until ? cond.exitCode !== 0 : cond.exitCode === 0;
        if (!condMet) break;
        last = await executeNode(node.body);
    }
    return last;
}

async function executeFor(node: ForClause): Promise<ExecResult> {
    const items = node.items?.map(w => expandWord(w)) ?? [];
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
                const msg = e instanceof Error ? e.message : String(e);
                process.stderr.write(`cd: ${msg}\n`);
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
                    $[key] = val;
                    process.env[key] = val;
                } else if (arg) {
                    const val = $[arg];
                    if (val !== undefined) process.env[arg] = String(val);
                }
            }
            return { exitCode: 0 };
        }

        case "unset": {
            for (const arg of args) delete $[arg];
            return { exitCode: 0 };
        }

        case "true":  return { exitCode: 0 };
        case "false": return { exitCode: 1 };

        case "echo": {
            process.stdout.write(args.join(" ") + "\n");
            return { exitCode: 0 };
        }

        default:
            return null;
    }
}
