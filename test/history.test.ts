import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { addHistoryEntry, expandHistory, getLastEntry, shouldRecordHistory } from "../src/history/index.js";
import { $ } from "../src/variables/index.js";

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

describe("HISTCONTROL / HISTIGNORE filtering", () => {
    function clearHistVars() {
        delete $["HISTCONTROL"];
        delete $["HISTIGNORE"];
    }

    it("should record everything by default", () => {
        clearHistVars();
        addHistoryEntry("ls");
        assert.strictEqual(shouldRecordHistory("ls"), true);
        assert.strictEqual(shouldRecordHistory(" ls"), true);
        assert.strictEqual(shouldRecordHistory("anything"), true);
    });

    it("should drop consecutive duplicates with HISTCONTROL=ignoredups", () => {
        clearHistVars();
        $["HISTCONTROL"] = "ignoredups";
        addHistoryEntry("foo cmd");
        assert.strictEqual(shouldRecordHistory("foo cmd"), false);
        assert.strictEqual(shouldRecordHistory("bar cmd"), true);
        clearHistVars();
    });

    it("should drop space-prefixed lines with HISTCONTROL=ignorespace", () => {
        clearHistVars();
        $["HISTCONTROL"] = "ignorespace";
        assert.strictEqual(shouldRecordHistory(" secret password"), false);
        assert.strictEqual(shouldRecordHistory("\tsecret password"), false);
        assert.strictEqual(shouldRecordHistory("regular cmd"), true);
        clearHistVars();
    });

    it("should combine both with HISTCONTROL=ignoreboth", () => {
        clearHistVars();
        $["HISTCONTROL"] = "ignoreboth";
        addHistoryEntry("alpha");
        assert.strictEqual(shouldRecordHistory("alpha"), false);    // dup
        assert.strictEqual(shouldRecordHistory(" beta"), false);    // space
        assert.strictEqual(shouldRecordHistory("gamma"), true);
        clearHistVars();
    });

    it("should drop lines matching HISTIGNORE patterns", () => {
        clearHistVars();
        $["HISTIGNORE"] = "ls:cd:exit:clear";
        assert.strictEqual(shouldRecordHistory("ls"), false);
        assert.strictEqual(shouldRecordHistory("cd"), false);
        assert.strictEqual(shouldRecordHistory("exit"), false);
        assert.strictEqual(shouldRecordHistory("ls -la"), true);  // not exact match
        assert.strictEqual(shouldRecordHistory("git status"), true);
        clearHistVars();
    });

    it("should support glob patterns in HISTIGNORE", () => {
        clearHistVars();
        $["HISTIGNORE"] = "ls*:?";
        // `*` matches zero or more, so `ls*` matches "ls" too.
        assert.strictEqual(shouldRecordHistory("ls"), false);
        assert.strictEqual(shouldRecordHistory("ls -la"), false);
        assert.strictEqual(shouldRecordHistory("ls /tmp"), false);
        assert.strictEqual(shouldRecordHistory("a"), false);     // matches "?"
        assert.strictEqual(shouldRecordHistory("ab"), true);     // doesn't match "?"
        assert.strictEqual(shouldRecordHistory("git status"), true);
        clearHistVars();
    });

    it("should compose HISTCONTROL with HISTIGNORE", () => {
        clearHistVars();
        $["HISTCONTROL"] = "ignorespace";
        $["HISTIGNORE"] = "exit";
        assert.strictEqual(shouldRecordHistory(" foo"), false);  // space
        assert.strictEqual(shouldRecordHistory("exit"), false);  // pattern
        assert.strictEqual(shouldRecordHistory("foo"), true);
        clearHistVars();
    });

    it("should ignore unknown HISTCONTROL tokens silently", () => {
        clearHistVars();
        $["HISTCONTROL"] = "nonsense:blah";
        assert.strictEqual(shouldRecordHistory("anything"), true);
        clearHistVars();
    });

    it("should treat empty HISTCONTROL/HISTIGNORE as no-filter", () => {
        clearHistVars();
        $["HISTCONTROL"] = "";
        $["HISTIGNORE"] = "";
        assert.strictEqual(shouldRecordHistory(" with space"), true);
        clearHistVars();
    });
});
