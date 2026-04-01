import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { addHistoryEntry, expandHistory, getLastEntry } from "../src/history/index.js";

// Note: history state persists across tests since it's module-level.
// We seed history entries at the start.

describe("history expansion", () => {
    // Seed history
    beforeEach(() => {
        // These accumulate but that's fine for testing
    });

    it("should return input unchanged when no ! patterns", () => {
        assert.strictEqual(expandHistory("echo hello"), "echo hello");
    });

    it("should expand !! to last command", () => {
        addHistoryEntry("echo first");
        addHistoryEntry("echo second");
        assert.strictEqual(expandHistory("!!"), "echo second");
    });

    it("should expand !$ to last argument of last command", () => {
        addHistoryEntry("ls /tmp/foo");
        assert.strictEqual(expandHistory("echo !$"), "echo /tmp/foo");
    });

    it("should expand !^ to first argument of last command", () => {
        addHistoryEntry("git commit -m message");
        assert.strictEqual(expandHistory("echo !^"), "echo commit");
    });

    it("should expand !N to Nth history entry", () => {
        // History so far: echo first, echo second, ls /tmp/foo, git commit...
        // Entry 1 = "echo first"
        assert.strictEqual(expandHistory("!1"), "echo first");
    });

    it("should expand !-N to Nth previous command", () => {
        addHistoryEntry("echo recent");
        assert.strictEqual(expandHistory("!-1"), "echo recent");
    });

    it("should expand !string to most recent matching command", () => {
        addHistoryEntry("grep pattern file.txt");
        assert.strictEqual(expandHistory("!grep"), "grep pattern file.txt");
    });

    it("should return null on event not found", () => {
        assert.strictEqual(expandHistory("!999"), null);
    });

    it("should not expand ! at end of line", () => {
        assert.strictEqual(expandHistory("echo wow!"), "echo wow!");
    });

    it("should not expand ! before space", () => {
        assert.strictEqual(expandHistory("echo ! hello"), "echo ! hello");
    });

    it("should not expand inside single quotes", () => {
        assert.strictEqual(expandHistory("echo '!!'"), "echo '!!'");
    });

    it("should handle escaped !", () => {
        assert.strictEqual(expandHistory("echo \\!"), "echo !");
    });

    it("should expand !! in middle of line", () => {
        addHistoryEntry("world");
        assert.strictEqual(expandHistory("echo !!"), "echo world");
    });
});
