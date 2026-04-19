import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { registerCompletion, getCompletions } from "../src/completion/index.js";
import type { CompletionResult, CompletionEntry } from "../src/completion/index.js";
import { registerJsFunction } from "../src/jsfunctions/index.js";

const require = createRequire(import.meta.url);

before(() => {
    // Ensure native is loaded (needed by completion for PATH/$ lookups).
    require("../build/Release/jsh_native.node").initExecutor();
});

// Entry text (strip optional desc metadata).
function text(e: CompletionEntry): string {
    return typeof e === "string" ? e : e.text;
}

function sync(r: CompletionResult | Promise<CompletionResult>): CompletionResult {
    if (r instanceof Promise) throw new Error("expected sync result");
    return r;
}

describe("completion — file/directory", () => {
    it("should complete files in a directory via trailing slash", () => {
        const r = sync(getCompletions("echo test/"));
        const entries = r.entries.map(text);
        assert.ok(entries.some(c => c.includes("lexer.test.ts")), `got: ${entries.slice(0,5)}`);
    });

    it("should complete with directory trailing slash", () => {
        const r = sync(getCompletions("ls src/"));
        const entries = r.entries.map(text);
        assert.ok(entries.some(c => c.includes("executor")));
    });

    it("should complete partial path with bare candidate", () => {
        const r = sync(getCompletions("cat test/lex"));
        const entries = r.entries.map(text);
        // Entries are bare filenames now (no "cat test/" prefix).
        assert.ok(entries.some(c => c.includes("lexer")), `got: ${entries}`);
    });

    it("should complete dotfiles only when prefix starts with dot", () => {
        const noDot = sync(getCompletions("ls ./"));
        const withDot = sync(getCompletions("ls ./.git"));
        const noDotEntries = noDot.entries.map(text);
        const withDotEntries = withDot.entries.map(text);
        assert.ok(!noDotEntries.some(c => c.includes(".git")));
        assert.ok(withDotEntries.some(c => c.endsWith(".git") || c.endsWith(".git/")));
    });
});

describe("completion — command", () => {
    it("should complete builtin commands", () => {
        const r = sync(getCompletions("ec"));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("echo"), `got: ${entries}`);
    });

    it("should complete from beginning of line", () => {
        const r = sync(getCompletions("exi"));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("exit"), `got: ${entries}`);
    });

    it("should complete @ function names", () => {
        registerJsFunction("__test_complete_fn", async function* () { yield ""; });
        const r = sync(getCompletions("@__test_complete"));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("@__test_complete_fn"), `got: ${entries}`);
    });

    it("should fall back to file completion for non-first words", () => {
        const r = sync(getCompletions("cat src/"));
        const entries = r.entries.map(text);
        assert.ok(entries.length > 0);
    });
});

describe("completion — user-defined handlers", () => {
    before(() => {
        registerCompletion("git", (ctx) => {
            const subcmds = ["add", "commit", "push", "pull", "status", "log"];
            if (ctx.words.length <= 2) {
                return subcmds.filter(s => s.startsWith(ctx.current));
            }
            return [];
        });
    });

    it("should call registered handler for matching command", () => {
        const r = sync(getCompletions("git co"));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("commit"), `got: ${entries}`);
    });

    it("should return all subcommands when prefix is empty", () => {
        const r = sync(getCompletions("git "));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("add"));
        assert.ok(entries.includes("push"));
    });

    it("should filter by prefix", () => {
        // "push" and "pull" share the prefix "pu" — LCP extension collapses
        // the result to a single pseudo-match marked ambiguous.
        const r = sync(getCompletions("git p"));
        assert.equal(r.ambiguous, true);
        assert.deepEqual(r.entries.map(text), ["pu"]);

        // Now fully disambiguated — single match, not ambiguous.
        const r2 = sync(getCompletions("git pus"));
        assert.equal(r2.ambiguous, undefined);
        assert.deepEqual(r2.entries.map(text), ["push"]);
    });

    it("should support async handlers returning a promise", async () => {
        registerCompletion("async-test", async (ctx) => {
            await new Promise(r => setTimeout(r, 10));
            return ["one", "two", "three"].filter(s => s.startsWith(ctx.current));
        });
        const result = getCompletions("async-test t");
        assert.ok(result instanceof Promise, "should return a Promise");
        const r = await result;
        const entries = r.entries.map(text);
        assert.ok(entries.includes("two"));
        assert.ok(entries.includes("three"));
        assert.ok(!entries.includes("one"));
    });
});

describe("completion — cursor awareness", () => {
    it("should complete based on cursor position mid-buffer", () => {
        // Buffer "ls  foo", cursor at position 3 (on second space) — user
        // wants to complete a new argument before " foo".
        const r = sync(getCompletions("ls  foo", 3));
        // Replacement range is empty at cursor (whitespace).
        assert.equal(r.replaceStart, 3);
        assert.equal(r.replaceEnd, 3);
    });

    it("should replace the full word containing the cursor", () => {
        // Buffer "ls DE", cursor on 'D' (pos 3). The token "DE" spans [3,5).
        const r = sync(getCompletions("ls DE", 3));
        assert.equal(r.replaceStart, 3);
        assert.equal(r.replaceEnd, 5);
    });

    it("should filter by the whole word regardless of cursor position", () => {
        // Cursor at position 2 ("gi|t"): filter uses "git" (full word), not
        // prefix-before-cursor. Otherwise cursor on the first letter of a
        // word would degenerate to "match everything".
        const r = sync(getCompletions("git add", 2));
        const entries = r.entries.map(text);
        assert.equal(r.replaceStart, 0);
        assert.equal(r.replaceEnd, 3);
        assert.ok(entries.every(c => c.startsWith("git")), `got: ${entries.slice(0,5)}`);
    });
});

describe("completion — redirection target", () => {
    it("should file-complete after `>` regardless of command", () => {
        const r = sync(getCompletions("git log > src/", 14));
        const entries = r.entries.map(text);
        assert.ok(entries.some(c => c.includes("executor")), `got: ${entries}`);
    });
});

describe("completion — assignment RHS", () => {
    it("should complete path as the value of FOO=path", () => {
        const r = sync(getCompletions("FOO=src/", 8));
        const entries = r.entries.map(text);
        assert.ok(entries.length > 0, `got: ${entries}`);
        // Replacement range should skip the `FOO=` part.
        assert.equal(r.replaceStart, 4);
    });
});

describe("completion — command modifiers", () => {
    it("should complete as command after `sudo <cursor>`", () => {
        const r = sync(getCompletions("sudo ec", 7));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("echo"), `got: ${entries}`);
    });

    it("should dispatch to git handler after `sudo git <cursor>`", () => {
        // "push" / "pull" → LCP "pu" with ambiguous=true.
        const r = sync(getCompletions("sudo git p", 10));
        assert.equal(r.ambiguous, true);
        assert.deepEqual(r.entries.map(text), ["pu"]);
    });
});

describe("completion — glob expansion", () => {
    it("should expand globs in the current word", () => {
        const r = sync(getCompletions("ls *.md", 7));
        const entries = r.entries.map(text);
        assert.ok(entries.some(c => c.endsWith(".md")), `got: ${entries}`);
    });
});

describe("completion — LCP extension", () => {
    it("should return an ambiguous pseudo-match at the longest common prefix", () => {
        // `pac` prefix matches package.json and package-lock.json, both
        // starting with "package". LCP extends beyond typed prefix.
        const r = sync(getCompletions("ls pac"));
        assert.equal(r.ambiguous, true);
        assert.equal(r.entries.length, 1);
        const t = text(r.entries[0]!);
        assert.ok(t.startsWith("package"), `got: ${t}`);
    });

    it("should NOT LCP-extend when typed already equals the common prefix", () => {
        // "package" — both package.json and package-lock.json match. LCP is
        // still "package", same length as typed. No extension.
        const r = sync(getCompletions("ls package"));
        assert.notEqual(r.ambiguous, true);
        assert.ok(r.entries.length >= 2);
    });
});

describe("completion — variable expansion", () => {
    it("should complete variable names after $", () => {
        process.env["JSH_TEST_VAR_FOOBAR"] = "1";
        const r = sync(getCompletions("echo $JSH_TEST_VAR_FO"));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("JSH_TEST_VAR_FOOBAR"), `got: ${entries}`);
        // Replacement covers just the variable name (starts after $).
        assert.equal(r.replaceStart, "echo $".length);
    });

    it("should complete variables inside ${", () => {
        process.env["JSH_TEST_VAR_BAZ"] = "1";
        const r = sync(getCompletions("echo ${JSH_TEST_VAR_B"));
        const entries = r.entries.map(text);
        assert.ok(entries.includes("JSH_TEST_VAR_BAZ"), `got: ${entries}`);
    });
});
