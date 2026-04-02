// TerminalUI: main interface between the REPL and the input engine + renderer.

import { Renderer } from "./renderer.js";
import { WidgetManager } from "./widgets.js";
import type { WidgetDef, WidgetHandle, WidgetZone, WidgetOptions } from "./widgets.js";
import type { Frame } from "./renderer.js";
import type { CompletionEntry } from "../completion/index.js";
import { normalizeEntries } from "../completion/index.js";

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
}

interface RenderLineResult {
    line: string;
    cursorCol: number;
}

interface NativeInputEngine {
    inputStart: (callbacks: {
        onRender: (state: InputState) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string) => string[] | Promise<string[]> | unknown;
    }) => void;
    inputStop: () => void;
    inputGetCols: () => number;
    inputWriteRaw: (data: string) => void;
    inputRenderLine: (prompt: string, colorized: string, rprompt: string, cols: number, rawBuf: string, rawPos: number) => RenderLineResult;
    inputHistoryAdd: (line: string) => void;
    inputHistorySetMaxLen: (len: number) => void;
    inputHistorySave: (path: string) => number;
    inputHistoryLoad: (path: string) => number;
    inputSetSuggestion: (id: number, text: string) => void;
    inputSetInput: (text: string) => void;
    inputInsertAtCursor: (text: string) => void;
    inputSetCompletions: (entries: string[], descs: string[]) => void;
    inputEAGAIN: () => number;
}

export class TerminalUI {
    private native: NativeInputEngine;
    private renderer: Renderer;
    private widgets: WidgetManager;

    private colorizeFn: ((input: string, context?: string) => string) | null = null;
    private completionFn: ((input: string) => CompletionEntry[] | Promise<CompletionEntry[]>) | null = null;
    private suggestionFn: ((input: string) => Promise<string | null>) | null = null;
    private lastState: InputState | null = null;
    private lineCallback: ((line: string | null, errno?: number) => void) | null = null;
    private EAGAIN: number;
    private isContinuation = false;
    private frozenLines: string[] = [];
    private pendingFreeze: string[] = []; // rendered lines from last session, frozen on continuation
    private lastRenderedInputLines: string[] = []; // cached from last renderFrame for onLine reuse
    private editing = false; // true while an editing session is active
    private suggestionColor = "\x1b[2m"; // default: dim

    constructor(native: NativeInputEngine) {
        this.native = native;
        this.renderer = new Renderer((data: string) => native.inputWriteRaw(data));
        this.widgets = new WidgetManager();
        this.widgets.setRepaintFn(() => this.repaint());
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
                ? (input: string) => {
                    const result = this.completionFn!(input);
                    if (result && typeof (result as Promise<CompletionEntry[]>).then === "function") {
                        // Async: C++ will detect the promise and stop polling.
                        // Chain .then to deliver results when ready.
                        (result as Promise<CompletionEntry[]>).then(
                            entries => {
                                const { texts, descs } = normalizeEntries(entries);
                                this.native.inputSetCompletions(texts, descs);
                            },
                            () => this.native.inputSetCompletions([], []),
                        );
                        return result; // Return the promise so C++ sees IsPromise()
                    }
                    // Sync: normalize and return texts only (C++ reads directly).
                    // Sync completions (file/command) are plain strings without descriptions.
                    const { texts } = normalizeEntries(result as CompletionEntry[]);
                    return texts;
                }
                : undefined,
        });
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

    setCompletion(fn: ((input: string) => CompletionEntry[] | Promise<CompletionEntry[]>) | null): void {
        this.completionFn = fn;
    }

    setSuggestion(fn: ((input: string) => Promise<string | null>) | null): void {
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
    historySave(path: string): number { return this.native.inputHistorySave(path); }
    historyLoad(path: string): number { return this.native.inputHistoryLoad(path); }

    // ---- Repaint ----

    repaint(): void {
        if (this.editing && this.lastState) this.renderFrame(this.lastState);
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
            this.suggestionFn(state.buf).then(result => {
                if (result) {
                    this.native.inputSetSuggestion(id, result);
                }
            }).catch(() => {});
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
        const ps2 = this.widgets.getZoneContent("ps2").join("") || "> ";

        // In search mode, show the search prompt instead of the normal prompt.
        let displayPrompt = prompt;
        let displayRightPrompt = rprompt;
        if (state.searchQuery !== undefined) {
            const failMark = state.searchMatch === false && state.searchQuery.length > 0 ? "failing " : "";
            displayPrompt = `(${failMark}reverse-i-search)\`${state.searchQuery}': `;
            displayRightPrompt = "";
        }
        // Inline forward search — show in prompt area (consistent with Ctrl-R).
        if (state.lineSearchQuery !== undefined) {
            displayPrompt = `(i-search)\`${state.lineSearchQuery}': `;
            displayRightPrompt = "";
        }

        // Split buffer on newlines for multi-line input (e.g. from history recall).
        const bufLines = state.buf.split("\n");

        // Compute which line the cursor is on and the position within that line.
        let cursorLineIdx = 0;
        let posInLine = state.pos;
        {
            let offset = 0;
            for (let i = 0; i < bufLines.length; i++) {
                const lineLen = bufLines[i]!.length;
                if (state.pos <= offset + lineLen) {
                    cursorLineIdx = i;
                    posInLine = state.pos - offset;
                    break;
                }
                offset += lineLen + 1; // +1 for \n
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

        for (let i = 0; i < bufLines.length; i++) {
            const bufLine = bufLines[i]!;
            const isFirst = i === 0;
            const isLast = i === bufLines.length - 1;
            const isCursorLine = i === cursorLineIdx;
            const linePrompt = isFirst ? displayPrompt : ps2;
            const lineRprompt = isLast ? displayRightPrompt : "";
            const colorized = colorizedLines[i] ?? bufLine;

            // Pass per-line raw buffer and cursor position to C++.
            const linePos = isCursorLine ? posInLine : bufLine.length;
            const { line, cursorCol: col } = this.native.inputRenderLine(
                linePrompt, colorized, lineRprompt, state.cols, bufLine, linePos
            );
            inputLines.push(line);
            if (isCursorLine) cursorCol = col;
        }

        // Cache clean lines (without ghost text) for onLine/clearFrame reuse.
        this.lastRenderedInputLines = [...inputLines];

        // Append ghost text to display (not cached — so it doesn't appear in frozen lines).
        if (state.suggestion && state.pos === state.len && inputLines.length > 0) {
            const lastIdx = inputLines.length - 1;
            inputLines[lastIdx] = inputLines[lastIdx]! + this.suggestionColor + state.suggestion + "\x1b[0m";
        }

        // Append completion description (dimmed, after cursor on the input line).
        if (state.completionDesc && inputLines.length > 0) {
            const lastIdx = inputLines.length - 1;
            inputLines[lastIdx] += "\x1b[2m " + state.completionDesc + "\x1b[0m";
        }

        // Get header/footer from widgets.
        const headerLines = this.widgets.getZoneContent("header", state.cols);
        const footerLines = this.widgets.getZoneContent("footer", state.cols);

        // Cursor row is on the cursor's line within inputLines.
        const frame: Frame = { headerLines, frozenLines: this.frozenLines, inputLines, cursorCol, footerLines };

        // Override cursor row in the renderer: it's not always the last input line.
        this.renderer.render(frame, cursorLineIdx);
    }
}
