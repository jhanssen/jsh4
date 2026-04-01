import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { readFileSync } from "node:fs";
import { parse, IncompleteInputError } from "../parser/index.js";
import { execute, executeString, setCommandText, reapJobs } from "../executor/index.js";
import { $ } from "../variables/index.js";
import {
    getPromptAsync, setPrompt, setRightPrompt, getRightPromptAsync,
    setColorize, getColorize, setTheme,
    alias, unalias, registerJsFunction, exec, registerCompletion,
} from "../api/index.js";
import { getCompletions } from "../completion/index.js";
import { colorize, getCurrentTheme } from "../colorize/index.js";
import { runTrap } from "../trap/index.js";
import type { JsPipelineFunction } from "../jsfunctions/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    initExecutor: () => void;
    linenoiseStart: (prompt: string, cb: (line: string | null, errno?: number) => void) => void;
    linenoiseHistoryAdd: (line: string) => void;
    linenoiseHistorySetMaxLen: (len: number) => void;
    linenoiseHistorySave: (path: string) => number;
    linenoiseHistoryLoad: (path: string) => number;
    linenoiseSetCompletion: (cb: (input: string) => string[]) => void;
    linenoiseSetColorize: (cb: ((input: string) => string) | null) => void;
    linenoiseSetRightPrompt: (rprompt: string | null) => void;
    EAGAIN: () => number;
};

const EAGAIN = native.EAGAIN();

export async function startRepl(): Promise<void> {
    native.initExecutor();

    await loadRc();

    if (process.stdin.isTTY) {
        const historyFile = join(String($["HOME"] ?? homedir()), ".jsh_history");
        native.linenoiseHistorySetMaxLen(1000);
        native.linenoiseHistoryLoad(historyFile);

        process.on("beforeExit", async () => {
            await runTrap("EXIT", executeString);
        });
        process.on("exit", () => {
            native.linenoiseHistorySave(historyFile);
        });

        native.linenoiseSetCompletion((input: string) => getCompletions(input));

        // Set up syntax highlighting.
        native.linenoiseSetColorize((input: string): string => {
            const userFn = getColorize();
            if (userFn) return userFn(input);
            return colorize(input, getCurrentTheme());
        });

        // Emit OSC 7 (cwd) at startup.
        emitOsc7();

        promptLoop("");
    } else {
        const input = readFileSync(0, "utf8");
        await executeScript(input);
    }
}

async function loadRc(): Promise<void> {
    const rcPath = join(String($["HOME"] ?? homedir()), ".jshrc");

    // Expose the jsh API as a single global object.
    const jshApi = {
        $, setPrompt, setRightPrompt, setColorize, setTheme,
        alias, unalias, registerJsFunction, exec,
        complete: registerCompletion,
    };
    (globalThis as Record<string, unknown>)["jsh"] = jshApi;

    try {
        const rc = await import(rcPath);
        // Auto-register any exported functions as @ pipeline functions.
        for (const [name, value] of Object.entries(rc)) {
            if (name === "default") continue;
            if (typeof value === "function") {
                registerJsFunction(name, value as JsPipelineFunction);
            }
        }
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") {
            process.stderr.write(`jsh: .jshrc: ${e instanceof Error ? e.message : e}\n`);
        }
    }
}

async function executeScript(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    try {
        const ast = parse(trimmed);
        if (ast) {
            setCommandText(trimmed);
            await execute(ast);
        }
    } catch (e: unknown) {
        process.stderr.write(`jsh: ${e instanceof Error ? e.message : String(e)}\n`);
    }
}

function emitOsc7(): void {
    const cwd = process.cwd();
    const host = hostname();
    process.stdout.write(`\x1b]7;file://${host}${cwd}\x07`);
}

async function promptLoop(buffer: string): Promise<void> {
    // Reap finished background jobs and print notifications.
    if (!buffer) {
        const notifications = reapJobs();
        for (const msg of notifications) {
            process.stderr.write(msg + "\n");
        }
    }

    const prompt = buffer ? "> " : await getPromptAsync();
    const rprompt = buffer ? "" : await getRightPromptAsync();

    // Set right prompt for linenoise.
    native.linenoiseSetRightPrompt(rprompt || null);

    // Build prompt with OSC 133 marks:
    // A = prompt start, B = prompt end / command input begins
    const markedPrompt = `\x1b]133;A\x07${prompt}\x1b]133;B\x07`;

    native.linenoiseStart(markedPrompt, async (line, errno) => {
        if (line === null) {
            if (errno === EAGAIN) {
                // Ctrl-C: clear buffer, restart prompt
                if (buffer) process.stdout.write("\n");
                process.stdout.write(`\x1b]133;D;130\x07`);
                promptLoop("");
            } else {
                process.stdout.write("\n");
                await runTrap("EXIT", executeString);
                process.exit(0);
            }
            return;
        }

        const input = buffer ? buffer + "\n" + line : line;
        const trimmed = input.trim();

        if (!trimmed) {
            process.stdout.write(`\x1b]133;D;0\x07`);
            promptLoop("");
            return;
        }

        try {
            const ast = parse(trimmed);
            if (ast) {
                native.linenoiseHistoryAdd(input);
                setCommandText(trimmed);
                // OSC 133;C — command execution begins
                process.stdout.write("\x1b]133;C\x07");
                await execute(ast);
            }
            const exitCode = String($["?"] ?? "0");
            process.stdout.write(`\x1b]133;D;${exitCode}\x07`);
            emitOsc7();
            promptLoop("");
        } catch (e: unknown) {
            if (e instanceof IncompleteInputError) {
                // Need more input — keep accumulating
                promptLoop(input);
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`jsh: ${msg}\n`);
            process.stdout.write(`\x1b]133;D;1\x07`);
            promptLoop("");
        }
    });
}
