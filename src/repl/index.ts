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
import { addHistoryEntry, expandHistory } from "../history/index.js";
import { TerminalUI } from "../terminal/index.js";
import type { JsPipelineFunction } from "../jsfunctions/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    initExecutor: () => void;
    inputStart: (callbacks: {
        onRender: (state: { buf: string; pos: number; len: number; cols: number }) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string) => string[];
    }) => void;
    inputStop: () => void;
    inputGetCols: () => number;
    inputWriteRaw: (data: string) => void;
    inputRenderLine: (prompt: string, colorized: string, rprompt: string, cols: number) => { line: string; cursorCol: number };
    inputHistoryAdd: (line: string) => void;
    inputHistorySetMaxLen: (len: number) => void;
    inputHistorySave: (path: string) => number;
    inputHistoryLoad: (path: string) => number;
    inputEAGAIN: () => number;
};

let ui: TerminalUI | null = null;

export async function startRepl(): Promise<void> {
    native.initExecutor();

    await loadRc();

    if (process.stdin.isTTY) {
        const historyFile = join(String($["HOME"] ?? homedir()), ".jsh_history");

        // Create TerminalUI.
        ui = new TerminalUI(native);
        ui.historySetMaxLen(1000);
        ui.historyLoad(historyFile);

        // Set up syntax highlighting.
        ui.setColorize((input: string): string => {
            const userFn = getColorize();
            if (userFn) return userFn(input);
            return colorize(input, getCurrentTheme());
        });

        // Set up tab completion.
        ui.setCompletion((input: string) => getCompletions(input));

        process.on("beforeExit", async () => {
            await runTrap("EXIT", executeString);
        });
        process.on("exit", () => {
            ui!.historySave(historyFile);
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

    const jshApi = {
        $, setPrompt, setRightPrompt, setColorize, setTheme,
        alias, unalias, registerJsFunction, exec,
        complete: registerCompletion,
        // New TerminalUI APIs
        setHeader: (fn: (() => string[] | Promise<string[]>) | null) => ui?.setHeader(fn),
        setFooter: (fn: (() => string[] | Promise<string[]>) | null) => ui?.setFooter(fn),
        addWidget: (id: string, zone: "header" | "footer", render: () => string | string[] | Promise<string | string[]>, order?: number, interval?: number) =>
            ui?.addWidget(id, zone, render, order, interval),
        removeWidget: (id: string) => ui?.removeWidget(id),
    };
    (globalThis as Record<string, unknown>)["jsh"] = jshApi;

    try {
        const rc = await import(rcPath);
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
    if (!ui) return;

    // Reap finished background jobs and print notifications.
    if (!buffer) {
        const notifications = reapJobs();
        for (const msg of notifications) {
            process.stderr.write(msg + "\n");
        }
    }

    const prompt = buffer ? "> " : await getPromptAsync();
    const rprompt = buffer ? "" : await getRightPromptAsync();

    // Build prompt with OSC 133 marks.
    const markedPrompt = `\x1b]133;A\x07${prompt}\x1b]133;B\x07`;

    ui.start(markedPrompt, rprompt, async (line, errno) => {
        if (line === null) {
            if (errno === ui!.eagain) {
                // Ctrl-C
                if (buffer) process.stdout.write("\n");
                process.stdout.write(`\x1b]133;D;130\x07`);
                promptLoop("");
            } else {
                // Ctrl-D / EOF
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

        // History expansion.
        const expanded = expandHistory(trimmed);
        if (expanded === null) {
            promptLoop("");
            return;
        }
        const finalInput = expanded;
        if (finalInput !== trimmed) {
            process.stdout.write(finalInput + "\n");
        }

        try {
            const ast = parse(finalInput);
            if (ast) {
                ui!.historyAdd(finalInput);
                addHistoryEntry(finalInput);
                setCommandText(finalInput);
                process.stdout.write("\x1b]133;C\x07");
                await execute(ast);
            }
            const exitCode = String($["?"] ?? "0");
            process.stdout.write(`\x1b]133;D;${exitCode}\x07`);
            emitOsc7();
            promptLoop("");
        } catch (e: unknown) {
            if (e instanceof IncompleteInputError) {
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
