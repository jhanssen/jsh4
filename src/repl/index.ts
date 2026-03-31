import { createRequire } from "node:module";
import { parse, IncompleteInputError } from "../parser/index.js";
import { execute } from "../executor/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    initExecutor: () => void;
    linenoiseStart: (prompt: string, cb: (line: string | null, errno?: number) => void) => void;
    linenoiseHistoryAdd: (line: string) => void;
    EAGAIN: () => number;
};

const EAGAIN = native.EAGAIN();

export function startRepl(): void {
    native.initExecutor();
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
