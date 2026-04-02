// TerminalUI: main interface between the REPL and the input engine + renderer.

import { Renderer } from "./renderer.js";
import { WidgetManager } from "./widgets.js";
import type { WidgetDef, WidgetHandle, WidgetZone } from "./widgets.js";
import type { Frame } from "./renderer.js";

export type { WidgetDef, WidgetHandle, WidgetZone } from "./widgets.js";

interface InputState {
    buf: string;
    pos: number;
    len: number;
    cols: number;
    searchQuery?: string;
    searchMatch?: boolean;
}

interface RenderLineResult {
    line: string;
    cursorCol: number;
}

interface NativeInputEngine {
    inputStart: (callbacks: {
        onRender: (state: InputState) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string) => string[];
    }) => void;
    inputStop: () => void;
    inputGetCols: () => number;
    inputWriteRaw: (data: string) => void;
    inputRenderLine: (prompt: string, colorized: string, rprompt: string, cols: number) => RenderLineResult;
    inputHistoryAdd: (line: string) => void;
    inputHistorySetMaxLen: (len: number) => void;
    inputHistorySave: (path: string) => number;
    inputHistoryLoad: (path: string) => number;
    inputEAGAIN: () => number;
}

export class TerminalUI {
    private native: NativeInputEngine;
    private renderer: Renderer;
    private widgets: WidgetManager;

    private colorizeFn: ((input: string) => string) | null = null;
    private completionFn: ((input: string) => string[]) | null = null;
    private lastState: InputState | null = null;
    private lineCallback: ((line: string | null, errno?: number) => void) | null = null;
    private EAGAIN: number;
    private isContinuation = false;

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
        this.renderer.reset();

        // Re-evaluate prompt/rprompt/ps2 for this editing session.
        if (continuation) {
            await this.widgets.refreshZone("ps2");
        } else {
            await this.widgets.refreshZone("prompt");
            await this.widgets.refreshZone("rprompt");
        }
        // Refresh header/footer too.
        await this.widgets.refreshZone("header");
        await this.widgets.refreshZone("footer");

        this.native.inputStart({
            onRender: (state: InputState) => this.onRender(state),
            onLine: (line: string | null, errno?: number) => this.onLine(line, errno),
            onCompletion: this.completionFn
                ? (input: string) => this.completionFn!(input)
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

    setColorize(fn: ((input: string) => string) | null): void {
        this.colorizeFn = fn;
    }

    setCompletion(fn: ((input: string) => string[]) | null): void {
        this.completionFn = fn;
    }

    // ---- Widgets ----

    addWidget(id: string, zone: WidgetZone, render: WidgetDef["render"], order = 0): WidgetHandle {
        return this.widgets.add({ id, zone, order, render });
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
        if (this.lastState) this.renderFrame(this.lastState);
    }

    get eagain(): number { return this.EAGAIN; }

    // ---- Internal ----

    private oscMarks = true;

    setOscMarks(enabled: boolean): void {
        this.oscMarks = enabled;
    }

    private getPrompt(): string {
        if (this.isContinuation) {
            return this.widgets.hasZone("ps2") ? this.widgets.getZoneString("ps2") : "> ";
        }
        const raw = this.widgets.getZoneString("prompt") || "$ ";
        if (this.oscMarks) {
            return `\x1b]133;A\x07${raw}\x1b]133;B\x07`;
        }
        return raw;
    }

    private getRightPrompt(): string {
        if (this.isContinuation) return "";
        return this.widgets.getZoneString("rprompt");
    }

    private onRender(state: InputState): void {
        this.lastState = state;
        this.renderFrame(state);
    }

    private onLine(line: string | null, errno?: number): void {
        const headerRows = this.renderer.getLastHeaderRows();
        const footerRows = this.renderer.getLastFooterRows();
        const prompt = this.getPrompt();

        if (headerRows > 0 || footerRows > 0) {
            let buf = "";
            // Move up to top of frame (header start).
            if (headerRows > 0) {
                buf += `\x1b[${headerRows}A`;
            }
            // Clear from here to end of screen (wipes header + input + footer).
            buf += "\r\x1b[J";
            // Rewrite just the input line.
            if (this.lastState) {
                const colorized = this.colorizeFn ? this.colorizeFn(this.lastState.buf) : this.lastState.buf;
                const { line: inputLine } = this.native.inputRenderLine(
                    prompt, colorized, "", this.lastState.cols
                );
                buf += inputLine;
            }
            // Move to new line, reset column for correct tab alignment.
            buf += "\r\n\x1b[G";
            process.stdout.write(buf);
        } else {
            // No header/footer — just move to new line.
            process.stdout.write("\r\n\x1b[G");
        }

        this.renderer.reset();
        if (this.lineCallback) {
            this.lineCallback(line, errno);
        }
    }

    private renderFrame(state: InputState): void {
        const prompt = this.getPrompt();
        const rprompt = this.getRightPrompt();

        // In search mode, show the search prompt instead of the normal prompt.
        let displayPrompt = prompt;
        let displayRightPrompt = rprompt;
        if (state.searchQuery !== undefined) {
            const failMark = state.searchMatch === false && state.searchQuery.length > 0 ? "failing " : "";
            displayPrompt = `(${failMark}reverse-i-search)\`${state.searchQuery}': `;
            displayRightPrompt = "";
        }

        // Colorize buffer.
        const colorized = this.colorizeFn ? this.colorizeFn(state.buf) : state.buf;

        // Get input line from engine (handles scroll + cursor math).
        const { line, cursorCol } = this.native.inputRenderLine(
            displayPrompt, colorized, displayRightPrompt, state.cols
        );

        // Get header/footer from widgets.
        const headerLines = this.widgets.getZoneLines("header");
        const footerLines = this.widgets.getZoneLines("footer");

        const frame: Frame = { headerLines, inputLine: line, cursorCol, footerLines };
        this.renderer.render(frame);
    }
}
