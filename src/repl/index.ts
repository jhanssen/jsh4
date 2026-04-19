import { createRequire, register } from "node:module";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { parse, IncompleteInputError } from "../parser/index.js";
import { execute, executeString, setCommandText, reapJobs, hasShellFunction } from "../executor/index.js";
import { $ } from "../variables/index.js";
import {
    setColorize, getColorize, setTheme, getAlias,
    alias, unalias, registerJsFunction, exec, registerCompletion,
} from "../api/index.js";
import { getCompletions } from "../completion/index.js";
import { colorize, getCurrentTheme, registerCommandExists, getResolvedColor, onThemeChange } from "../colorize/index.js";
import { commandExists } from "../completion/index.js";
import { lookupJsFunction, lookupBareJsFunction } from "../jsfunctions/index.js";
import { runTrap } from "../trap/index.js";
import { expandHistory, getAllEntries } from "../history/index.js";
import { TerminalUI } from "../terminal/index.js";
import type { WidgetHandle, WidgetZone, WidgetOptions } from "../terminal/index.js";
import { colors, makeFgColor, makeBgColor, makeUlColor, style } from "../terminal/colors.js";
import type { JsPipelineFunction } from "../jsfunctions/index.js";
import { startHandshake } from "../mb/handshake.js";
import type { HandshakeResult } from "../mb/handshake.js";
import { connectMb } from "../mb/client.js";
import type { MbApi } from "../mb/client.js";
import { APPLET_PERMISSIONS, ensureAppletOnDisk, appletLoadDisabled } from "../mb/applet.js";

const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    initExecutor: () => void;
    inputStart: (callbacks: {
        onRender: (state: { buf: string; pos: number; len: number; cols: number }) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string, cursor: number) => string[] | Promise<string[]> | unknown;
        onEscResponse?: (type: "DCS" | "OSC", payload: string) => void;
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
    inputSetCompletions: (entries: string[], descs?: string[], replaceStart?: number, replaceEnd?: number, displays?: string[], ambiguous?: boolean) => void;
    inputSetWordChars: (chars: string) => void;
    inputSetCompletionStyle: (style: string) => void;
    inputEAGAIN: () => number;
};

let ui: TerminalUI | null = null;
let mbApi: MbApi | null = null;

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
        // Bare-name JS function calls — atOnly functions don't participate.
        if (lookupBareJsFunction(name) !== undefined) return true;
        // @name / @!name pipeline functions — strip the sigil(s) before lookup.
        if (name.startsWith("@")) {
            const bare = name.startsWith("@!") ? name.slice(2) : name.slice(1);
            if (bare && lookupJsFunction(bare) !== undefined) return true;
        }
        return false;
    });

    if (process.stdin.isTTY) {
        // Create TerminalUI before loading rc so jshrc can register widgets.
        ui = new TerminalUI(native);

        // SIGWINCH: when the terminal is resized, force a full redraw so the
        // footer/header widgets reflow to the new width and the renderer
        // forgets stale row counts (which would otherwise leave the prompt
        // stranded at the bottom of a shrunken window).
        process.on("SIGWINCH", () => ui?.onWindowResize());
    }

    // MasterBandit async handshake. Fires XTGETTCAP + OSC 58300 queries now;
    // the native input-engine's OSC/DCS parser catches responses during the
    // first (or later) edit session and hands them to the listener. When both
    // land, `mbApi` flips from null to a live MbApi. Startup does not block.
    if (process.stdin.isTTY && process.stdout.isTTY && ui) {
        const theUi = ui;
        // Ship our own applet so jsh works out of the box under MB. Users who
        // maintain their own applet can opt out via JSH_MB_NO_APPLET_LOAD=1.
        const appletPath = appletLoadDisabled() ? null : ensureAppletOnDisk();

        // A credential provider: either loads our bundled applet (first call
        // after boot, or after WS reconnect when the applet may have unloaded)
        // or just re-queries an existing applet. Fires a fresh OSC 58300
        // handshake either way because the applet consumes the nonce on first
        // hello — cached creds can't be replayed.
        let handshakeInFlight: Promise<HandshakeResult | null> | null = null;
        let firstHandshake = true;
        const getCreds = (): Promise<HandshakeResult | null> => {
            if (handshakeInFlight) return handshakeInFlight;
            const loadApplet = firstHandshake && appletPath
                ? { path: appletPath, permissions: APPLET_PERMISSIONS }
                : undefined;
            firstHandshake = false;
            handshakeInFlight = new Promise<HandshakeResult | null>((resolve) => {
                const listener = startHandshake(
                    (result) => {
                        handshakeInFlight = null;
                        resolve(result);
                    },
                    {
                        loadApplet,
                        emit: (bytes) => native.inputWriteRaw(bytes),
                    },
                );
                theUi.setEscResponseHandler((type, payload) => listener.handle(type, payload));
                theUi.queueRawWrite(listener.queries);
            });
            return handshakeInFlight;
        };
        // Kick off initial detection in the background.
        getCreds().then((initial) => {
            if (!initial) return;
            connectMb(initial, getCreds).then((client) => {
                if (client) mbApi = client;
            });
        });
    }

    // Register ESM loader hook so jshrc files can `import ... from 'jsh/...'`.
    register('../loader-hooks.js', import.meta.url);

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
        ui!.setCompletion((input: string, cursor: number) => getCompletions(input, cursor));

        // Set suggestion ghost text color from theme — and refresh whenever
        // setTheme() runs (which may happen after the rc loads).
        const applySuggestionColor = () => {
            ui!.setSuggestionColor(getResolvedColor("suggestion") ?? "\x1b[2m");
        };
        applySuggestionColor();
        onThemeChange(applySuggestionColor);

        // Register default prompt if user didn't set one.
        if (!userSetPrompt) {
            ui!.addWidget("__default_prompt", "prompt", () => "$ ");
        }

        process.on("beforeExit", async () => {
            await runTrap("EXIT", executeString);
        });
        process.on("exit", () => {
            ui!.historySave(historyFile);
            popTitle();
        });

        // Emit OSC 7 (cwd) at startup.
        emitOsc7();
        // Push the current icon title and set it to "jsh". Paired with a pop
        // in the 'exit' handler below, and with pop/push-set around each
        // command so child processes see their pre-existing title.
        pushSetTitle();

        promptLoop("");
    } else {
        const input = readFileSync(0, "utf8");
        await executeScript(input);
    }
}

let userSetPrompt = false;
let continuationBuffer = ""; // accumulated buffer from previous lines for colorizer context

async function loadRc(customPath: string | undefined): Promise<void> {
    let rcPath: string | undefined;
    if (customPath) {
        rcPath = resolve(customPath);
    } else {
        const home = String($["HOME"] ?? homedir());
        const xdgConfig = String($["XDG_CONFIG_HOME"] ?? join(home, ".config"));
        const configDir = join(xdgConfig, "jsh");
        for (const ext of ["ts", "mts", "mjs", "js"]) {
            const candidate = join(configDir, `jshrc.${ext}`);
            if (existsSync(candidate)) { rcPath = candidate; break; }
        }
    }

    const jshApi = {
        $, setColorize, setTheme,
        alias, unalias, registerJsFunction, exec,
        // Mark an exported JS function as callable only via the @-prefixed
        // form (@name). Bare-name resolution skips it, so a same-named
        // command on PATH (e.g. the real `claude` CLI) remains accessible.
        // Usage:
        //   export const claude = jsh.atOnly(async function* (args, stdin) { ... });
        atOnly: <T extends JsPipelineFunction>(fn: T): T => {
            (fn as T & { atOnly?: boolean }).atOnly = true;
            return fn;
        },
        complete: registerCompletion,
        // `mb` is a getter so jsh.mb reflects the current handshake state —
        // null until the async handshake completes (or never, if not under MB).
        get mb() { return mbApi; },
        setSuggestion: (fn: ((input: string) => string | null | Promise<string | null>) | null) => ui?.setSuggestion(fn),
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
        // History
        history: () => getAllEntries(),
        // Terminal info
        get columns() { return native.inputGetCols(); },
        // Input buffer manipulation
        setInput: (text: string) => ui?.setInput(text),
        insertAtCursor: (text: string) => ui?.insertAtCursor(text),
        // Word-boundary characters for Alt-B/F/D/Backspace and Ctrl-W (zsh's
        // WORDCHARS). Defaults to zsh's default; override from jshrc to taste.
        setWordChars: (chars: string) => native.inputSetWordChars(chars),
        // Completion style: "cycle" (default) inserts each match in turn on
        // repeated Tab; "menu" shows a zsh-style grid and navigates it with
        // Tab / arrow keys.
        setCompletionStyle: (style: "cycle" | "menu") => native.inputSetCompletionStyle(style),
        // Colors
        colors,
        makeFgColor,
        makeBgColor,
        makeUlColor,
        style,
    };
    (globalThis as Record<string, unknown>)["jsh"] = jshApi;

    if (!rcPath) return;

    try {
        const rc = await import(rcPath);
        for (const [name, value] of Object.entries(rc)) {
            if (name === "default") continue;
            if (typeof value === "function") {
                const fn = value as JsPipelineFunction & { atOnly?: boolean };
                registerJsFunction(name, fn, { atOnly: fn.atOnly === true });
            }
        }
    } catch (e: unknown) {
        // rcPath was confirmed to exist (or provided explicitly by --jshrc), so
        // any ERR_MODULE_NOT_FOUND here is a *dependency* the rc file imports.
        // Always surface.
        process.stderr.write(`jsh: .jshrc: ${e instanceof Error ? e.message : e}\n`);
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

// Window-title (OSC 2) stack management via xterm XTWINOPS.
// `22;2t` pushes the current window title onto the terminal's stack;
// `23;2t` pops it. We snapshot before setting "jsh" so that whatever was
// there before — the parent shell's title, the terminal default — can be
// restored when a child process takes the foreground.
function pushSetTitle(): void {
    process.stdout.write(`\x1b[22;2t\x1b]2;jsh\x07`);
}
function popTitle(): void {
    process.stdout.write(`\x1b[23;2t`);
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
                setCommandText(finalInput);
                if (finalInput !== trimmed) {
                    process.stdout.write(finalInput + "\n");
                }
                process.stdout.write("\x1b]133;C\x07");
                popTitle();
                try {
                    await execute(ast);
                } finally {
                    pushSetTitle();
                }
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
