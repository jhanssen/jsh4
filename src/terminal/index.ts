// TerminalUI: main interface between the REPL and the input engine + renderer.

import { Renderer } from "./renderer.js";
import { WidgetManager } from "./widgets.js";
import type { WidgetDef, WidgetHandle, WidgetZone, WidgetOptions } from "./widgets.js";
import type { Frame } from "./renderer.js";
import type { CompletionEntry, CompletionResult } from "../completion/index.js";
import { normalizeEntries } from "../completion/index.js";
import { displayWidth, truncateToWidth } from "./ansi.js";

export type { WidgetDef, WidgetHandle, WidgetZone, WidgetOptions } from "./widgets.js";

interface InputState {
    buf: string;
    pos: number;
    len: number;
    cols: number;
    suggestionId?: number;
    suggestion?: string;      // ghost text (suffix after buffer)
    searchQuery?: string;     // Ctrl-R reverse history search
    searchMatch?: boolean;
    lineSearchQuery?: string; // Ctrl-S inline forward search
    completionDesc?: string;  // description of current completion entry
    menuLines?: string[];     // menu-complete grid rows (when enabled)
}

interface RenderLineResult {
    line: string;
    cursorCol: number;
}

interface NativeInputEngine {
    inputStart: (callbacks: {
        onRender: (state: InputState) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string, cursor: number) => string[] | Promise<string[]> | unknown;
        onEscResponse?: (type: "DCS" | "OSC", payload: string) => void;
    }) => void;
    inputStop: () => void;
    inputGetCols: () => number;
    inputWriteRaw: (data: string) => void;
    inputRenderLine: (prompt: string, colorized: string, rprompt: string, cols: number, rawBuf: string, rawPos: number) => RenderLineResult;
    inputHistoryAdd: (line: string) => void;
    inputHistorySetMaxLen: (len: number) => void;
    inputHistorySave: () => void;
    inputHistoryLoad: (path: string) => number;
    inputSetSuggestion: (id: number, text: string) => void;
    inputSetInput: (text: string) => void;
    inputInsertAtCursor: (text: string) => void;
    inputSetCompletions: (entries: string[], descs: string[], replaceStart?: number, replaceEnd?: number, displays?: string[], ambiguous?: boolean, types?: string[]) => void;
    inputEAGAIN: () => number;
}

export class TerminalUI {
    private native: NativeInputEngine;
    private renderer: Renderer;
    private widgets: WidgetManager;

    private colorizeFn: ((input: string, context?: string) => string) | null = null;
    private completionFn: ((input: string, cursor: number) =>
        CompletionEntry[] | Promise<CompletionEntry[]> | CompletionResult | Promise<CompletionResult>) | null = null;
    private suggestionFn: ((input: string) => string | null | Promise<string | null>) | null = null;
    private lastState: InputState | null = null;
    private lineCallback: ((line: string | null, errno?: number) => void) | null = null;
    private EAGAIN: number;
    private isContinuation = false;
    private frozenLines: string[] = [];
    private pendingFreeze: string[] = []; // rendered lines from last session, frozen on continuation
    private lastRenderedInputLines: string[] = []; // cached from last renderFrame for onLine reuse
    private editing = false; // true while an editing session is active
    private suggestionColor = "\x1b[2m"; // default: dim
    private escResponseFn: ((type: "DCS" | "OSC", payload: string) => void) | null = null;
    private pendingRawWrite: string | null = null;

    constructor(native: NativeInputEngine) {
        this.native = native;
        this.renderer = new Renderer((data: string) => native.inputWriteRaw(data));
        this.widgets = new WidgetManager();
        this.widgets.setRepaintFn(() => this.repaint());
        this.widgets.setEditingFn(() => this.editing);
        this.EAGAIN = native.inputEAGAIN();
    }

    // ---- Core ----

    async start(continuation: boolean, callback: (line: string | null, errno?: number) => void): Promise<void> {
        this.isContinuation = continuation;
        this.lineCallback = callback;
        this.editing = true;
        // Only reset renderer for fresh prompts. For continuation, keep the old
        // frame dimensions so the renderer can overwrite the previous frame in place.
        if (!continuation) {
            this.renderer.reset();
        }

        if (!continuation) {
            this.frozenLines = [];
            this.pendingFreeze = [];
            await this.widgets.refreshZone("prompt");
            await this.widgets.refreshZone("rprompt");
        } else {
            // Freeze the previous session's rendered lines.
            if (this.pendingFreeze.length > 0) {
                this.frozenLines.push(...this.pendingFreeze);
                this.pendingFreeze = [];
            }
            await this.widgets.refreshZone("ps2");
        }
        await this.widgets.refreshZone("header");
        await this.widgets.refreshZone("footer");

        this.native.inputStart({
            onRender: (state: InputState) => this.onRender(state),
            onLine: (line: string | null, errno?: number) => this.onLine(line, errno),
            onCompletion: this.completionFn
                ? (input: string, cursor: number) => {
                    const result = this.completionFn!(input, cursor);
                    const normalize = (r: CompletionEntry[] | CompletionResult) => {
                        if (Array.isArray(r)) {
                            const { texts, displays, descs, types } = normalizeEntries(r);
                            return { texts, displays, descs, types, replaceStart: -1, replaceEnd: -1, ambiguous: false };
                        }
                        const { texts, displays, descs, types } = normalizeEntries(r.entries);
                        return { texts, displays, descs, types,
                                 replaceStart: r.replaceStart, replaceEnd: r.replaceEnd,
                                 ambiguous: r.ambiguous === true };
                    };
                    if (result && typeof (result as Promise<unknown>).then === "function") {
                        (result as Promise<CompletionEntry[] | CompletionResult>).then(
                            r => {
                                const n = normalize(r);
                                this.native.inputSetCompletions(n.texts, n.descs, n.replaceStart, n.replaceEnd, n.displays, n.ambiguous, n.types);
                            },
                            () => this.native.inputSetCompletions([], [], -1, -1, [], false, []),
                        );
                        return result;
                    }
                    const n = normalize(result as CompletionEntry[] | CompletionResult);
                    return n.replaceStart >= 0
                        ? { entries: n.texts, displays: n.displays, types: n.types,
                            replaceStart: n.replaceStart, replaceEnd: n.replaceEnd,
                            ambiguous: n.ambiguous }
                        : n.texts;
                }
                : undefined,
            onEscResponse: this.escResponseFn
                ? (type: "DCS" | "OSC", payload: string) => this.escResponseFn!(type, payload)
                : undefined,
        });

        // Flush any pending raw writes (e.g. MB handshake queries) now that
        // raw mode is active and kernel echo is off.
        if (this.pendingRawWrite) {
            this.native.inputWriteRaw(this.pendingRawWrite);
            this.pendingRawWrite = null;
        }
    }

    /**
     * Register a handler for DCS and OSC responses arriving on stdin during
     * raw-mode edit sessions. Takes effect on the next `start()`. Pass null
     * to clear. Used by the MB bridge for XTGETTCAP + handshake responses.
     */
    setEscResponseHandler(fn: ((type: "DCS" | "OSC", payload: string) => void) | null): void {
        this.escResponseFn = fn;
    }

    /**
     * Queue bytes to write to the terminal on the next edit session *after*
     * raw mode is enabled. Used to emit queries whose responses should not be
     * kernel-echoed back to the user (e.g. XTGETTCAP, OSC handshake).
     * Cleared after a single flush.
     */
    queueRawWrite(bytes: string): void {
        this.pendingRawWrite = (this.pendingRawWrite ?? "") + bytes;
    }

    stop(): void {
        this.native.inputStop();
    }

    hide(): void {
        this.renderer.clear();
    }

    show(): void {
        if (this.lastState) this.renderFrame(this.lastState);
    }

    // ---- Configuration ----

    setColorize(fn: ((input: string, context?: string) => string) | null): void {
        this.colorizeFn = fn;
    }

    setCompletion(fn: ((input: string, cursor: number) =>
        CompletionEntry[] | Promise<CompletionEntry[]> | CompletionResult | Promise<CompletionResult>) | null): void {
        this.completionFn = fn;
    }

    setSuggestion(fn: ((input: string) => string | null | Promise<string | null>) | null): void {
        this.suggestionFn = fn;
    }

    setSuggestionColor(color: string): void {
        this.suggestionColor = color;
    }

    /** Replace the entire input buffer and move cursor to end. */
    setInput(text: string): void {
        this.native.inputSetInput(text);
    }

    /** Insert text at the current cursor position. */
    insertAtCursor(text: string): void {
        this.native.inputInsertAtCursor(text);
    }

    // ---- Widgets ----

    addWidget(id: string, zone: WidgetZone, render: WidgetDef["render"], opts?: WidgetOptions | number): WidgetHandle {
        const options = typeof opts === "number" ? { line: opts } : (opts ?? {});
        return this.widgets.add({
            id, zone,
            line: options.line ?? 0,
            align: options.align ?? "left",
            render,
        });
    }

    removeWidget(id: string): void {
        this.widgets.remove(id);
    }

    // ---- History ----

    historyAdd(line: string): void { this.native.inputHistoryAdd(line); }
    historySetMaxLen(len: number): void { this.native.inputHistorySetMaxLen(len); }
    historySave(): void { this.native.inputHistorySave(); }
    historyLoad(path: string): number { return this.native.inputHistoryLoad(path); }

    // ---- Repaint ----

    repaint(): void {
        if (this.editing && this.lastState) this.renderFrame(this.lastState);
    }

    /** Called on SIGWINCH. Refreshes cols, resets renderer state (so we don't
     *  rely on stale row counts after the terminal changed size), and forces a
     *  full redraw of the current frame. */
    onWindowResize(): void {
        if (!this.editing || !this.lastState) return;
        this.lastState.cols = this.native.inputGetCols();
        this.renderer.reset();
        this.renderFrame(this.lastState);
    }

    get eagain(): number { return this.EAGAIN; }

    // ---- Internal ----

    private oscMarks = true;

    setOscMarks(enabled: boolean): void {
        this.oscMarks = enabled;
    }

    private getPrompt(): string {
        if (this.isContinuation) {
            const ps2 = this.widgets.getZoneContent("ps2");
            return ps2.length > 0 ? ps2.join("") : "> ";
        }
        const raw = this.widgets.getZoneContent("prompt").join("") || "$ ";
        if (this.oscMarks) {
            return `\x1b]133;A\x07${raw}\x1b]133;B\x07`;
        }
        return raw;
    }

    private getRightPrompt(): string {
        if (this.isContinuation) return "";
        return this.widgets.getZoneContent("rprompt").join("");
    }

    private lastSuggestionId: number | undefined;

    private onRender(state: InputState): void {
        this.lastState = state;
        this.renderFrame(state);

        // Trigger async suggestion if the buffer changed and we have a suggestion function.
        if (this.suggestionFn && state.suggestionId !== undefined &&
            state.suggestionId !== this.lastSuggestionId && state.buf.length > 0) {
            this.lastSuggestionId = state.suggestionId;
            const id = state.suggestionId;
            try {
                const result = this.suggestionFn(state.buf);
                // Always defer the inputSetSuggestion call. The native side's
                // SetSuggestion calls notifyRender synchronously, which would
                // re-enter onRender mid-execution. Run on a microtask so the
                // current onRender finishes first.
                if (result && typeof (result as Promise<string | null>).then === "function") {
                    (result as Promise<string | null>).then(r => {
                        if (r) this.native.inputSetSuggestion(id, r);
                    }).catch(() => {});
                } else if (typeof result === "string" && result) {
                    const text = result;
                    queueMicrotask(() => this.native.inputSetSuggestion(id, text));
                }
            } catch {}
        }
    }

    private onLine(line: string | null, errno?: number): void {
        // Reuse the cached rendered lines from the last renderFrame call.
        this.pendingFreeze = [...this.lastRenderedInputLines];

        // Pause repaints until next start() — prevents widget timers from
        // rendering stale content between onLine and the next editing session.
        this.editing = false;

        // Don't clear anything yet — the REPL will call either:
        // - start(continuation=true): renderFrame overwrites the old frame in place (no flicker)
        // - clearFrame() then execute: explicit cleanup before command output
        if (this.lineCallback) {
            this.lineCallback(line, errno);
        }
    }

    /** Clear the current frame (header/footer) and position cursor for command output. */
    clearFrame(): void {
        const cursorRow = this.renderer.getLastHeaderRows(); // rows above cursor in last frame
        const totalRows = this.renderer.getLastTotalRows();
        const allContent = [...this.frozenLines, ...this.pendingFreeze];

        if (totalRows > 1 || allContent.length > 1) {
            let buf = "";
            // Move to top of entire frame.
            if (cursorRow > 0) buf += `\x1b[${cursorRow}A`;
            // Clear everything from here down.
            buf += "\r\x1b[J";
            // Rewrite only the content lines (no header/footer).
            for (const line of allContent) {
                buf += line + "\r\n";
            }
            buf += "\x1b[G";
            process.stdout.write(buf);
        } else {
            process.stdout.write("\r\n\x1b[G");
        }

        this.renderer.reset();
    }

    private renderFrame(state: InputState): void {
        const prompt = this.getPrompt();
        const rprompt = this.getRightPrompt();
        // Only fall back to "> " when no ps2 widget is registered at all. A
        // registered widget returning "" is treated as an intentional blank
        // continuation prompt (zsh-style).
        const ps2 = this.widgets.hasZone("ps2")
            ? this.widgets.getZoneContent("ps2").join("")
            : "> ";

        // Reverse-search (Ctrl-R) and inline forward-search (Ctrl-S) indicators
        // both render on their own line below the input (see after the bufLines
        // loop). Split into prefix (text before the insertion point) and suffix
        // ("'") so the indicator can show a subcursor marking where the next
        // keystroke lands in the query. bash readline appends ": <matched line>"
        // here, but jsh shows the match in the editable buffer above, so the
        // ": " separator would point at nothing.
        const searchIndicatorPrefix = state.searchQuery !== undefined
            ? `(${state.searchMatch === false && state.searchQuery.length > 0 ? "failing " : ""}reverse-i-search)\`${state.searchQuery}`
            : state.lineSearchQuery !== undefined
                ? `(i-search)\`${state.lineSearchQuery}`
                : null;
        const searchIndicatorSuffix = "'";
        const displayPrompt = prompt;
        const displayRightPrompt = rprompt;

        // Multi-line prompt support: the native renderer treats its prompt arg
        // as a single visual line, so we split on \n and render the leading
        // lines as plain inputLines rows above the input. Only the last
        // prompt line is passed to inputRenderLine (where it participates in
        // width/cursor math). Same treatment for ps2.
        const promptPieces = displayPrompt.split("\n");
        const lastPromptLine = promptPieces.pop()!;
        const promptHeaderLines = promptPieces;

        const ps2Pieces = ps2.split("\n");
        const lastPs2Line = ps2Pieces.pop()!;
        const ps2HeaderLines = ps2Pieces;

        // Split buffer on newlines for multi-line input (e.g. from history recall).
        const bufLines = state.buf.split("\n");

        // Per-line UTF-8 byte lengths. `state.pos` from C++ is a byte offset;
        // TS `.length` is UTF-16 code units — they only match for ASCII. The
        // scroll/cursor math in inputRenderLine expects byte offsets, so we
        // track byte positions explicitly.
        const bufLineByteLens = bufLines.map(l => Buffer.byteLength(l, "utf8"));

        // Compute which line the cursor is on and the byte position within.
        let cursorLineIdx = 0;
        let posInLineBytes = state.pos;
        {
            let offsetBytes = 0;
            for (let i = 0; i < bufLines.length; i++) {
                const lineBytes = bufLineByteLens[i]!;
                if (state.pos <= offsetBytes + lineBytes) {
                    cursorLineIdx = i;
                    posInLineBytes = state.pos - offsetBytes;
                    break;
                }
                offsetBytes += lineBytes + 1; // +1 for \n
            }
        }

        // Colorize the entire buffer at once (avoids O(n²) re-lexing per line).
        let colorizedLines: string[];
        if (this.colorizeFn && bufLines.length > 1) {
            // Colorize full buffer, then split by newlines.
            // ANSI escapes don't contain \n so splitting is safe.
            const fullColorized = this.colorizeFn(state.buf);
            colorizedLines = fullColorized.split("\n");
            // Ensure we have the right number of lines (in case colorizer output differs).
            while (colorizedLines.length < bufLines.length) colorizedLines.push("");
        } else if (this.colorizeFn) {
            colorizedLines = [this.colorizeFn(state.buf)];
        } else {
            colorizedLines = [...bufLines];
        }

        const inputLines: string[] = [];
        let cursorCol = 0;
        let cursorRowInInput = 0;

        // Prompt header lines (everything above the last prompt line).
        for (const line of promptHeaderLines) inputLines.push(line);

        for (let i = 0; i < bufLines.length; i++) {
            const bufLine = bufLines[i]!;
            const isFirst = i === 0;
            const isLast = i === bufLines.length - 1;
            const isCursorLine = i === cursorLineIdx;
            const colorized = colorizedLines[i] ?? bufLine;
            const lineRprompt = isLast ? displayRightPrompt : "";

            // For continuation lines, also support multi-line ps2.
            if (!isFirst) {
                for (const line of ps2HeaderLines) inputLines.push(line);
            }

            const linePrompt = isFirst ? lastPromptLine : lastPs2Line;

            // Pass per-line raw buffer and cursor position to C++. linePos is
            // a UTF-8 byte offset matching what inputRenderLine expects.
            const linePos = isCursorLine ? posInLineBytes : bufLineByteLens[i]!;
            const { line, cursorCol: col } = this.native.inputRenderLine(
                linePrompt, colorized, lineRprompt, state.cols, bufLine, linePos
            );
            if (isCursorLine) {
                cursorRowInInput = inputLines.length;
                cursorCol = col;
            }
            inputLines.push(line);
        }

        // Cache clean lines (without ghost text or search indicator) for
        // onLine/clearFrame reuse. The indicator is transient to the search
        // session and must not be frozen above subsequent output.
        this.lastRenderedInputLines = [...inputLines];

        // Reverse-search indicator on its own line below the input. A faux
        // cursor (inverse-video `_`) marks where typing lands in the query
        // field; the real terminal cursor stays on the matched substring in
        // the buffer so arrow keys visibly step through the match (zsh-style).
        // Ghost text and completion descriptions don't apply while searching.
        if (searchIndicatorPrefix !== null) {
            inputLines.push(searchIndicatorPrefix + "_" + searchIndicatorSuffix);
        }

        // Menu-complete grid (opt-in via jsh.setCompletionStyle("menu")). Each
        // line is pre-composed by the native engine — columns padded, selected
        // cell wrapped in inverse video — so we just append them below the
        // input. Cursor stays on the input line (no override).
        if (state.menuLines && state.menuLines.length > 0) {
            for (const ln of state.menuLines) inputLines.push(ln);
        }

        // Append ghost text to display (not cached — so it doesn't appear in frozen lines).
        // Truncate so the rendered line + suggestion fits in (cols - 1) cells —
        // reserving the last column avoids the xenl pending-wrap glitch that
        // would otherwise wrap the prompt.
        if (searchIndicatorPrefix === null && !(state.menuLines && state.menuLines.length > 0) && state.suggestion && state.pos === state.len && inputLines.length > 0) {
            const lastIdx = inputLines.length - 1;
            const used = displayWidth(inputLines[lastIdx]!);
            const budget = Math.max(0, state.cols - 1 - used);
            if (budget > 0) {
                // Ghost text must be single-line — OPOST is off in raw mode,
                // so a raw \n in the appended ghost moves the cursor down
                // without CR and corrupts subsequent renders. Show only the
                // first line of the suggestion; accepting still inserts the
                // full multi-line command.
                const firstLine = state.suggestion.split(/\r?\n/, 1)[0]!;
                const ghost = truncateToWidth(firstLine, budget);
                if (ghost.length > 0) {
                    // Reset before the suggestion color — many terminals ignore
                    // \x1b[2m (faint) when a truecolor fg is already set by the
                    // colorizer, so the ghost would render at full intensity.
                    inputLines[lastIdx] = inputLines[lastIdx]! + "\x1b[0m" + this.suggestionColor + ghost + "\x1b[0m";
                }
            }
        }

        // Append completion description (dimmed, after cursor on the input line).
        // Same width budget as the ghost-text path above.
        if (searchIndicatorPrefix === null && !(state.menuLines && state.menuLines.length > 0) && state.completionDesc && inputLines.length > 0) {
            const lastIdx = inputLines.length - 1;
            const used = displayWidth(inputLines[lastIdx]!);
            const budget = Math.max(0, state.cols - 1 - used - 1); // -1 for leading space
            if (budget > 0) {
                const desc = truncateToWidth(state.completionDesc, budget);
                if (desc.length > 0) {
                    inputLines[lastIdx] += "\x1b[0m\x1b[2m " + desc + "\x1b[0m";
                }
            }
        }

        // Get header/footer from widgets.
        const headerLines = this.widgets.getZoneContent("header", state.cols);
        const footerLines = this.widgets.getZoneContent("footer", state.cols);

        // Cursor row is on the cursor's line within inputLines.
        const frame: Frame = { headerLines, frozenLines: this.frozenLines, inputLines, cursorCol, footerLines };

        // Override cursor row in the renderer: it's not always the last input line.
        // cursorRowInInput accounts for any prompt/ps2 header lines that were
        // prepended to inputLines.
        this.renderer.render(frame, cursorRowInInput);
    }
}
