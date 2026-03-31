import { createRequire } from "node:module";
import type { ASTNode, SimpleCommand } from "../parser/index.js";
import { expandWord } from "../expander/index.js";
import { $ } from "../variables/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    spawn: (cmd: string, args: string[]) => Promise<number>;
};

export interface ExecResult {
    exitCode: number;
}

export async function execute(node: ASTNode): Promise<ExecResult> {
    const result = await executeNode(node);
    $["?"] = result.exitCode;
    return result;
}

async function executeNode(node: ASTNode): Promise<ExecResult> {
    switch (node.type) {
        case "SimpleCommand":
            return executeSimple(node as SimpleCommand);
        default:
            process.stderr.write(`jsh: unimplemented node type: ${node.type}\n`);
            return { exitCode: 1 };
    }
}

async function executeSimple(cmd: SimpleCommand): Promise<ExecResult> {
    // Apply prefix assignments (VAR=val command → set for this invocation).
    // For now, apply to the shell environment directly (no scoping).
    for (const a of cmd.assignments) {
        $[a.name] = expandWord(a.value);
    }

    if (cmd.words.length === 0) {
        return { exitCode: 0 };
    }

    const words = cmd.words.map(expandWord);
    const [command, ...args] = words as [string, ...string[]];

    const builtin = runBuiltin(command, args);
    if (builtin !== null) {
        return builtin;
    }

    const exitCode = await native.spawn(command, args);
    return { exitCode };
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
            for (const arg of args) {
                delete $[arg];
            }
            return { exitCode: 0 };
        }

        case "true":
            return { exitCode: 0 };

        case "false":
            return { exitCode: 1 };

        case "echo": {
            process.stdout.write(args.join(" ") + "\n");
            return { exitCode: 0 };
        }

        default:
            return null;
    }
}
