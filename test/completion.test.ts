import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { registerCompletion, getCompletions } from "../src/completion/index.js";
import { registerJsFunction } from "../src/jsfunctions/index.js";

const require = createRequire(import.meta.url);

before(() => {
    // Ensure native is loaded (needed by completion for PATH/$ lookups).
    require("../build/Release/jsh_native.node").initExecutor();
});

describe("completion — file/directory", () => {
    it("should complete files in current directory", () => {
        const completions = getCompletions("echo test/");
        assert.ok(completions.some(c => c.includes("lexer.test.ts")), `got: ${completions.slice(0,5)}`);
    });

    it("should complete with directory trailing slash", () => {
        const completions = getCompletions("ls src/");
        assert.ok(completions.some(c => c.includes("executor")));
    });

    it("should return full input replacements", () => {
        const completions = getCompletions("cat test/lex");
        assert.ok(completions.every(c => c.startsWith("cat test/")), `got: ${completions}`);
        assert.ok(completions.some(c => c.includes("lexer")));
    });

    it("should complete dotfiles only when prefix starts with dot", () => {
        const noDot = getCompletions("ls ./");
        const withDot = getCompletions("ls ./.git");
        // .git shouldn't appear without dot prefix
        assert.ok(!noDot.some(c => c.includes(".git")));
        // but should appear with dot prefix
        assert.ok(withDot.some(c => c.endsWith(".git") || c.endsWith(".git/")));
    });
});

describe("completion — command", () => {
    it("should complete builtin commands", () => {
        const completions = getCompletions("ec");
        assert.ok(completions.includes("echo"), `got: ${completions}`);
    });

    it("should complete from beginning of line", () => {
        const completions = getCompletions("exi");
        assert.ok(completions.includes("exit"), `got: ${completions}`);
    });

    it("should complete @ function names", () => {
        registerJsFunction("__test_complete_fn", async function* () { yield ""; });
        const completions = getCompletions("@__test_complete");
        assert.ok(completions.includes("@__test_complete_fn"), `got: ${completions}`);
    });

    it("should fall back to file completion for non-first words", () => {
        const completions = getCompletions("cat src/");
        assert.ok(completions.some(c => c.startsWith("cat src/")));
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
        const completions = getCompletions("git co");
        assert.ok(completions.includes("git commit"), `got: ${completions}`);
    });

    it("should return all subcommands when prefix is empty", () => {
        const completions = getCompletions("git ");
        assert.ok(completions.includes("git add"));
        assert.ok(completions.includes("git push"));
    });

    it("should filter by prefix", () => {
        const completions = getCompletions("git p");
        assert.ok(completions.includes("git push"));
        assert.ok(completions.includes("git pull"));
        assert.ok(!completions.includes("git add"));
    });

    it("should support async handlers returning a promise", async () => {
        registerCompletion("async-test", async (ctx) => {
            // Simulate async work.
            await new Promise(r => setTimeout(r, 10));
            return ["one", "two", "three"].filter(s => s.startsWith(ctx.current));
        });
        const result = getCompletions("async-test t");
        assert.ok(result instanceof Promise, "should return a Promise");
        const completions = await result;
        assert.ok(completions.includes("async-test two"));
        assert.ok(completions.includes("async-test three"));
        assert.ok(!completions.includes("async-test one"));
    });
});
