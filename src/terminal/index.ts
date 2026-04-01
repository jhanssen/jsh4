// TerminalUI: main interface between the REPL and the input engine + renderer.

import { Renderer } from "./renderer.js";
import { WidgetManager } from "./widgets.js";
import type { WidgetDef } from "./widgets.js";
import type { Frame } from "./renderer.js";

export type { WidgetDef } from "./widgets.js";

interface InputState {
    buf: string;
    pos: number;
    len: number;
    cols: number;
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

    private prompt = "$ ";
    private rightPrompt = "";
    private colorizeFn: ((input: string) => string) | null = null;
    private completionFn: ((input: string) => string[]) | null = null;
    private headerFn: (() => string[] | Promise<string[]>) | null = null;
    private footerFn: (() => string[] | Promise<string[]>) | null = null;
    private lastState: InputState | null = null;
    private lineCallback: ((line: string | null, errno?: number) => void) | null = null;
    private EAGAIN: number;

    constructor(native: NativeInputEngine) {
        this.native = native;
        this.renderer = new Renderer((data: string) => native.inputWriteRaw(data));
        this.widgets = new WidgetManager();
        this.widgets.setRepaintFn(() => this.repaint());
        this.EAGAIN = native.inputEAGAIN();
    }

    // ---- Core ----

    start(prompt: string, rprompt: string, callback: (line: string | null, errno?: number) => void): void {
        this.prompt = prompt;
        this.rightPrompt = rprompt;
        this.lineCallback = callback;
        this.renderer.reset();
        this.widgets.startTimers();

        this.native.inputStart({
            onRender: (state: InputState) => this.onRender(state),
            onLine: (line: string | null, errno?: number) => this.onLine(line, errno),
            onCompletion: this.completionFn
                ? (input: string) => this.completionFn!(input)
                : undefined,
        });
    }

    stop(): void {
        this.widgets.stopTimers();
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

    setHeader(fn: (() => string[] | Promise<string[]>) | null): void {
        this.headerFn = fn;
    }

    setFooter(fn: (() => string[] | Promise<string[]>) | null): void {
        this.footerFn = fn;
    }

    // ---- Widgets ----

    addWidget(id: string, zone: "header" | "footer", render: WidgetDef["render"], order = 0, interval?: number): void {
        this.widgets.add({ id, zone, order, render, interval });
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

    private onRender(state: InputState): void {
        this.lastState = state;
        this.renderFrame(state);
    }

    private onLine(line: string | null, errno?: number): void {
        this.widgets.stopTimers();
        // Move past the frame before returning to caller.
        this.native.inputWriteRaw("\n");
        this.renderer.reset();
        if (this.lineCallback) {
            this.lineCallback(line, errno);
        }
    }

    private renderFrame(state: InputState): void {
        // Colorize buffer.
        const colorized = this.colorizeFn ? this.colorizeFn(state.buf) : state.buf;

        // Get input line from engine (handles scroll + cursor math).
        const { line, cursorCol } = this.native.inputRenderLine(
            this.prompt, colorized, this.rightPrompt, state.cols
        );

        // Get header/footer from widgets and/or direct functions.
        const headerLines = this.getHeaderLines();
        const footerLines = this.getFooterLines();

        const frame: Frame = { headerLines, inputLine: line, cursorCol, footerLines };
        this.renderer.render(frame);
    }

    private getHeaderLines(): string[] {
        // Combine widget header lines with direct header function.
        const widgetLines = this.widgets.getZoneLines("header");
        // headerFn is async-capable but during render we use cached/sync result.
        // If headerFn is set, it should be called async before start() and cached.
        return widgetLines;
    }

    private getFooterLines(): string[] {
        return this.widgets.getZoneLines("footer");
    }
}
