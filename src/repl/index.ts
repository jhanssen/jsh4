import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { readFileSync } from "node:fs";
import { parse, IncompleteInputError } from "../parser/index.js";
import { execute, executeString, setCommandText, reapJobs, hasShellFunction } from "../executor/index.js";
import { $ } from "../variables/index.js";
import {
    setColorize, getColorize, setTheme, getAlias,
    alias, unalias, registerJsFunction, exec, registerCompletion,
} from "../api/index.js";
import { getCompletions } from "../completion/index.js";
import { colorize, getCurrentTheme, registerCommandExists, getResolvedColor } from "../colorize/index.js";
import { commandExists } from "../completion/index.js";
import { runTrap } from "../trap/index.js";
import { addHistoryEntry, expandHistory } from "../history/index.js";
import { TerminalUI } from "../terminal/index.js";
import type { WidgetHandle, WidgetZone, WidgetOptions } from "../terminal/index.js";
import { colors, makeFgColor, makeBgColor, makeUlColor, style } from "../terminal/colors.js";
import type { JsPipelineFunction } from "../jsfunctions/index.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    initExecutor: () => void;
    inputStart: (callbacks: {
        onRender: (state: { buf: string; pos: number; len: number; cols: number }) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string) => string[] | Promise<string[]> | unknown;
    }) => void;
    inputStop: () => void;
    inputGetCols: () => number;
    inputWriteRaw: (data: string) => void;
    inputRenderLine: (prompt: string, colorized: string, rprompt: string, cols: number, rawBuf: string, rawPos: number) => { line: string; cursorCol: number };
    inputHistoryAdd: (line: string) => void;
    inputHistorySetMaxLen: (len: number) => void;
    inputHistorySave: (path: string) => number;
    inputHistoryLoad: (path: string) => number;
    inputSetSuggestion: (id: number, text: string) => void;
    inputSetInput: (text: string) => void;
    inputInsertAtCursor: (text: string) => void;
    inputSetCompletions: (entries: string[]) => void;
    inputEAGAIN: () => number;
};

let ui: TerminalUI | null = null;

export interface ReplOptions {
    jshrc?: string;
}

export async function startRepl(opts?: ReplOptions): Promise<void> {
    native.initExecutor();

    // Register command-exists check for the colorizer (breaks circular import).
    registerCommandExists((name: string) => {
        if (commandExists(name)) return true;
        if (getAlias(name) !== undefined) return true;
        if (hasShellFunction(name)) return true;
        return false;
    });

    if (process.stdin.isTTY) {
        // Create TerminalUI before loading rc so jshrc can register widgets.
        ui = new TerminalUI(native);
    }

    await loadRc(opts?.jshrc);

    if (process.stdin.isTTY) {
        const historyFile = join(String($["HOME"] ?? homedir()), ".jsh_history");

        ui!.historySetMaxLen(1000);
        ui!.historyLoad(historyFile);

        // Set up syntax highlighting.
        // Context comes from two sources:
        // 1. continuationBuffer — accumulated lines from previous REPL sessions (real continuation)
        // 2. bufContext — previous lines within a multi-line buffer (e.g. history recall)
        ui!.setColorize((input: string, bufContext?: string): string => {
            const userFn = getColorize();
            if (userFn) return userFn(input);
            // Combine both contexts: continuation buffer + buffer-internal context.
            let fullContext: string | undefined;
            if (continuationBuffer && bufContext) {
                fullContext = continuationBuffer + "\n" + bufContext;
            } else {
                fullContext = continuationBuffer || bufContext;
            }
            return colorize(input, getCurrentTheme(), fullContext || undefined);
        });

        // Set up tab completion.
        ui!.setCompletion((input: string) => getCompletions(input));

        // Set suggestion ghost text color from theme.
        ui!.setSuggestionColor(getResolvedColor("suggestion") ?? "\x1b[2m");

        // Register default prompt if user didn't set one.
        if (!userSetPrompt) {
            ui!.addWidget("__default_prompt", "prompt", () => "$ ");
        }

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

let userSetPrompt = false;
let continuationBuffer = ""; // accumulated buffer from previous lines for colorizer context

async function loadRc(customPath?: string): Promise<void> {
    const rcPath = customPath
        ? resolve(customPath)
        : join(String($["HOME"] ?? homedir()), ".jshrc");

    const jshApi = {
        $, setColorize, setTheme,
        alias, unalias, registerJsFunction, exec,
        complete: registerCompletion,
        setSuggestion: (fn: ((input: string) => Promise<string | null>) | null) => ui?.setSuggestion(fn),
        // Widgets — unified API for all rendered regions
        addWidget: (
            id: string,
            zone: WidgetZone,
            render: () => string | string[] | Promise<string | string[]>,
            opts?: WidgetOptions | number,
        ): WidgetHandle | undefined => {
            if (zone === "prompt") userSetPrompt = true;
            return ui?.addWidget(id, zone, render, opts);
        },
        removeWidget: (id: string) => ui?.removeWidget(id),
        // Terminal info
        get columns() { return native.inputGetCols(); },
        // Input buffer manipulation
        setInput: (text: string) => ui?.setInput(text),
        insertAtCursor: (text: string) => ui?.insertAtCursor(text),
        // Colors
        colors,
        makeFgColor,
        makeBgColor,
        makeUlColor,
        style,
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
    continuationBuffer = buffer;

    // Reap finished background jobs and print notifications.
    if (!buffer) {
        const notifications = reapJobs();
        for (const msg of notifications) {
            process.stderr.write(msg + "\n");
        }
    }

    const continuation = buffer.length > 0;

    await ui.start(continuation, async (line, errno) => {
        if (line === null) {
            ui!.clearFrame();
            if (errno === ui!.eagain) {
                // Ctrl-C
                process.stdout.write(`\x1b]133;D;130\x07`);
                promptLoop("");
            } else {
                // Ctrl-D / EOF
                await runTrap("EXIT", executeString);
                process.exit(0);
            }
            return;
        }

        const input = buffer ? buffer + "\n" + line : line;
        const trimmed = input.trim();

        if (!trimmed) {
            ui!.clearFrame();
            process.stdout.write(`\x1b]133;D;0\x07`);
            promptLoop("");
            return;
        }

        // History expansion.
        const expanded = expandHistory(trimmed);
        if (expanded === null) {
            ui!.clearFrame();
            promptLoop("");
            return;
        }
        const finalInput = expanded;

        try {
            const ast = parse(finalInput);
            if (ast) {
                // Successful parse — clear frame before executing.
                ui!.clearFrame();
                ui!.historyAdd(finalInput);
                addHistoryEntry(finalInput);
                setCommandText(finalInput);
                if (finalInput !== trimmed) {
                    process.stdout.write(finalInput + "\n");
                }
                process.stdout.write("\x1b]133;C\x07");
                await execute(ast);
            } else {
                ui!.clearFrame();
            }
            const exitCode = String($["?"] ?? "0");
            process.stdout.write(`\x1b]133;D;${exitCode}\x07`);
            emitOsc7();
            promptLoop("");
        } catch (e: unknown) {
            if (e instanceof IncompleteInputError) {
                // Don't clear frame — start(true) will overwrite it in place.
                promptLoop(input);
                return;
            }
            ui!.clearFrame();
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`jsh: ${msg}\n`);
            process.stdout.write(`\x1b]133;D;1\x07`);
            promptLoop("");
        }
    });
}
