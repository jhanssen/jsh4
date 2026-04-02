import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../build/Release/jsh_native.node") as {
    inputStart: (callbacks: {
        onRender: (state: { buf: string; pos: number; len: number; cols: number }) => void;
        onLine: (line: string | null, errno?: number) => void;
        onCompletion?: (input: string) => string[];
    }) => void;
    inputStop: () => void;
    inputGetCols: () => number;
    inputWriteRaw: (data: string) => void;
    inputRenderLine: (prompt: string, colorized: string, rprompt: string, cols: number, rawBuf: string, rawPos: number) => { line: string; cursorCol: number };
    inputHistoryAdd: (line: string) => void;
    inputHistorySetMaxLen: (len: number) => void;
    inputHistorySave: (path: string) => number;
    inputHistoryLoad: (path: string) => number;
    inputEAGAIN: () => number;
    createPipe: () => [number, number];
    dupFd: (fd: number) => number;
    dup2Fd: (src: number, dst: number) => number;
    closeFd: (fd: number) => void;
    writeFd: (fd: number, data: string) => void;
};

describe("input engine native binding", () => {
    it("should export all expected functions", () => {
        assert.strictEqual(typeof native.inputStart, "function");
        assert.strictEqual(typeof native.inputStop, "function");
        assert.strictEqual(typeof native.inputGetCols, "function");
        assert.strictEqual(typeof native.inputWriteRaw, "function");
        assert.strictEqual(typeof native.inputRenderLine, "function");
        assert.strictEqual(typeof native.inputHistoryAdd, "function");
        assert.strictEqual(typeof native.inputHistorySetMaxLen, "function");
        assert.strictEqual(typeof native.inputHistorySave, "function");
        assert.strictEqual(typeof native.inputHistoryLoad, "function");
        assert.strictEqual(typeof native.inputEAGAIN, "function");
    });

    it("should export fd utility functions", () => {
        assert.strictEqual(typeof native.closeFd, "function");
        assert.strictEqual(typeof native.createPipe, "function");
        assert.strictEqual(typeof native.dupFd, "function");
        assert.strictEqual(typeof native.dup2Fd, "function");
        assert.strictEqual(typeof native.writeFd, "function");
    });

    it("should read a line from a pipe", (t, done) => {
        const [readFd, writeFd] = native.createPipe();
        const savedStdin = native.dupFd(0);
        native.dup2Fd(readFd, 0);
        native.closeFd(readFd);

        native.writeFd(writeFd, "hello world\n");
        native.closeFd(writeFd);

        native.inputStart({
            onRender: () => {},
            onLine: (line) => {
                native.dup2Fd(savedStdin, 0);
                native.closeFd(savedStdin);
                assert.strictEqual(line, "hello world");
                done();
            },
        });
    });

    it("should handle EOF on pipe", (t, done) => {
        const [readFd, writeFd] = native.createPipe();
        const savedStdin = native.dupFd(0);
        native.dup2Fd(readFd, 0);
        native.closeFd(readFd);
        native.closeFd(writeFd);

        native.inputStart({
            onRender: () => {},
            onLine: (line) => {
                native.dup2Fd(savedStdin, 0);
                native.closeFd(savedStdin);
                assert.strictEqual(line, null);
                done();
            },
        });
    });

    it("should add to history without throwing", () => {
        native.inputHistoryAdd("ls -la");
        native.inputHistoryAdd("git status");
        native.inputHistorySetMaxLen(100);
    });

    it("should render a line with prompt and cursor position", () => {
        const result = native.inputRenderLine("$ ", "hello", "", 80, "hello", 5);
        assert.ok(result.line.includes("$ "));
        assert.ok(result.line.includes("hello"));
        assert.strictEqual(typeof result.cursorCol, "number");
    });

    it("should return terminal columns", () => {
        const cols = native.inputGetCols();
        assert.ok(cols > 0);
    });

    it("should return EAGAIN constant", () => {
        const eagain = native.inputEAGAIN();
        assert.strictEqual(typeof eagain, "number");
        assert.ok(eagain > 0);
    });
});
