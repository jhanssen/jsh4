import { createRequire } from "node:module";
import { parse } from "../parser/index.js";
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
    promptLoop();
}

function promptLoop(): void {
    native.linenoiseStart("$ ", async (line, errno) => {
        if (line === null) {
            if (errno === EAGAIN) {
                // Ctrl-C: clear line and restart prompt
                process.stdout.write("\n");
                promptLoop();
            } else {
                // Ctrl-D or real EOF: exit
                process.stdout.write("\n");
                process.exit(0);
            }
            return;
        }

        const trimmed = line.trim();
        if (trimmed) {
            native.linenoiseHistoryAdd(line);
            try {
                const ast = parse(trimmed);
                if (ast) {
                    await execute(ast);
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                process.stderr.write(`jsh: ${msg}\n`);
            }
        }

        promptLoop();
    });
}
