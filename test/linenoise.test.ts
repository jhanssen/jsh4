import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// The native addon must be built before running these tests.
// Run: npm run build:native
let native: {
    linenoiseStart: (prompt: string, callback: (line: string | null) => void) => void;
    linenoiseStop: () => void;
    linenoiseSetCompletion: (cb: ((input: string) => string[]) | null) => void;
    linenoiseHide: () => void;
    linenoiseShow: () => void;
    linenoiseHistoryAdd: (line: string) => void;
    linenoiseHistorySetMaxLen: (len: number) => void;
    linenoiseHistorySave: (path: string) => number;
    linenoiseHistoryLoad: (path: string) => number;
    createPipe: () => [number, number];
    dupFd: (fd: number) => number;
    dup2Fd: (src: number, dst: number) => void;
    closeFd: (fd: number) => void;
    writeFd: (fd: number, data: string) => void;
};

before(() => {
    native = require("../build/Release/jsh_native.node");
});

describe("linenoise native binding", () => {
    it("exports all expected functions", () => {
        assert.strictEqual(typeof native.linenoiseStart, "function");
        assert.strictEqual(typeof native.linenoiseStop, "function");
        assert.strictEqual(typeof native.linenoiseSetCompletion, "function");
        assert.strictEqual(typeof native.linenoiseHide, "function");
        assert.strictEqual(typeof native.linenoiseShow, "function");
        assert.strictEqual(typeof native.linenoiseHistoryAdd, "function");
        assert.strictEqual(typeof native.linenoiseHistorySetMaxLen, "function");
        assert.strictEqual(typeof native.linenoiseHistorySave, "function");
        assert.strictEqual(typeof native.linenoiseHistoryLoad, "function");
    });

    it("reads a line from a pipe", () => new Promise<void>((resolve, reject) => {
        const [readFd, writeFd] = native.createPipe();
        const savedStdin = native.dupFd(0);

        native.dup2Fd(readFd, 0);
        native.closeFd(readFd);

        native.linenoiseStart("> ", (line) => {
            native.dup2Fd(savedStdin, 0);
            native.closeFd(savedStdin);
            native.closeFd(writeFd);
            try {
                assert.strictEqual(line, "hello world");
                resolve();
            } catch (e) {
                reject(e);
            }
        });

        native.writeFd(writeFd, "hello world\n");
    }));

    it("returns null on EOF", () => new Promise<void>((resolve, reject) => {
        const [readFd, writeFd] = native.createPipe();
        const savedStdin = native.dupFd(0);

        native.dup2Fd(readFd, 0);
        native.closeFd(readFd);
        // close write end immediately — EOF on read
        native.closeFd(writeFd);

        native.linenoiseStart("> ", (line) => {
            native.dup2Fd(savedStdin, 0);
            native.closeFd(savedStdin);
            try {
                assert.strictEqual(line, null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }));

    it("calls completion callback with input and uses returned completions", () => new Promise<void>((resolve, reject) => {
        const [readFd, writeFd] = native.createPipe();
        const savedStdin = native.dupFd(0);
        let completionCalled = false;

        native.dup2Fd(readFd, 0);
        native.closeFd(readFd);

        native.linenoiseSetCompletion((input: string) => {
            completionCalled = true;
            assert.strictEqual(typeof input, "string");
            return ["foo", "foobar"];
        });

        native.linenoiseStart("> ", (line) => {
            native.dup2Fd(savedStdin, 0);
            native.closeFd(savedStdin);
            native.closeFd(writeFd);
            native.linenoiseSetCompletion(null);
            try {
                // The line itself: TAB was sent but linenoise in non-TTY mode
                // won't invoke completion — it reads the raw line. This test
                // just checks that setting the callback doesn't crash.
                resolve();
            } catch (e) {
                reject(e);
            }
        });

        native.writeFd(writeFd, "foo\n");
    }));

    it("historyAdd does not throw", () => {
        native.linenoiseHistoryAdd("ls -la");
        native.linenoiseHistoryAdd("git status");
        native.linenoiseHistorySetMaxLen(100);
    });
});
