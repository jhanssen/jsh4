import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, IncompleteInputError } from "../parser/index.js";
import { execute } from "../executor/index.js";
import { $ } from "../variables/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    initExecutor: () => void;
    linenoiseStart: (prompt: string, cb: (line: string | null, errno?: number) => void) => void;
    linenoiseHistoryAdd: (line: string) => void;
    linenoiseHistorySetMaxLen: (len: number) => void;
    linenoiseHistorySave: (path: string) => number;
    linenoiseHistoryLoad: (path: string) => number;
    EAGAIN: () => number;
};

const EAGAIN = native.EAGAIN();

export function startRepl(): void {
    native.initExecutor();

    const historyFile = join(String($["HOME"] ?? homedir()), ".jsh_history");
    native.linenoiseHistorySetMaxLen(1000);
    native.linenoiseHistoryLoad(historyFile);

    process.on("exit", () => {
        native.linenoiseHistorySave(historyFile);
    });

    promptLoop("");
}

function promptLoop(buffer: string): void {
    const prompt = buffer ? "> " : "$ ";

    native.linenoiseStart(prompt, async (line, errno) => {
        if (line === null) {
            if (errno === EAGAIN) {
                // Ctrl-C: clear buffer, restart prompt
                if (buffer) process.stdout.write("\n");
                promptLoop("");
            } else {
                process.stdout.write("\n");
                process.exit(0);
            }
            return;
        }

        const input = buffer ? buffer + "\n" + line : line;
        const trimmed = input.trim();

        if (!trimmed) {
            promptLoop("");
            return;
        }

        try {
            const ast = parse(trimmed);
            if (ast) {
                native.linenoiseHistoryAdd(input);
                await execute(ast);
            }
            promptLoop("");
        } catch (e: unknown) {
            if (e instanceof IncompleteInputError) {
                // Need more input — keep accumulating
                promptLoop(input);
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`jsh: ${msg}\n`);
            promptLoop("");
        }
    });
}
