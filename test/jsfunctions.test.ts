import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parse } from "../src/parser/index.js";
import type { JsFunction } from "../src/parser/index.js";
import { registerJsFunction, lookupJsFunction } from "../src/jsfunctions/index.js";

const require = createRequire(import.meta.url);

// No before hook needed — tests spawn jsh subprocesses.

// Run commands through jsh subprocess and return trimmed stdout.
function run(cmd: string): string {
    const r = spawnSync("node", ["dist/index.js"], {
        input: cmd + "\nexit\n",
        encoding: "utf8",
        cwd: process.cwd(),
    });
    return r.stdout.trim();
}

function runFull(cmd: string): { stdout: string; stderr: string } {
    const r = spawnSync("node", ["dist/index.js"], {
        input: cmd + "\nexit\n",
        encoding: "utf8",
        cwd: process.cwd(),
    });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

describe("@ syntax — parser", () => {
    it("should parse @name as JsFunction node", () => {
        const ast = parse("@upper") as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.strictEqual(ast.name, "upper");
        assert.strictEqual(ast.buffered, false);
    });

    it("should parse @!name as buffered JsFunction", () => {
        const ast = parse("@!parse") as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.strictEqual(ast.name, "parse");
        assert.strictEqual(ast.buffered, true);
    });

    it("should parse @name with args", () => {
        const ast = parse("@filter pattern") as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.strictEqual(ast.args.length, 1);
    });

    it("should parse @{ expr } as inline JsFunction", () => {
        const ast = parse('@{ (args, stdin) => "ok" }') as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.strictEqual(ast.name, "");
        assert.ok(ast.inlineBody !== undefined);
    });

    it("should parse @!{ expr } as buffered inline JsFunction", () => {
        const ast = parse("@!{ (args, s) => s }") as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.strictEqual(ast.buffered, true);
    });

    it("should parse @{ expr } with nested braces", () => {
        const ast = parse("@{ x => ({ key: x }) }") as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.ok(ast.inlineBody!.includes("key"));
    });

    it("should parse @{ } with JS string containing closing brace", () => {
        const ast = parse('@{ x => "hello}" }') as JsFunction;
        assert.strictEqual(ast.type, "JsFunction");
        assert.ok(ast.inlineBody!.includes("hello}"));
    });
});

describe("@ syntax — inline execution", () => {
    it("should return string from @{ }", () => {
        assert.strictEqual(run('@{ () => "hello" }'), "hello");
    });

    it("should transform in @{ } pipeline", () => {
        assert.strictEqual(run('echo hello | @{ (args, stdin) => "world" }'), "world");
    });

    it("should filter with @{ } async generator", () => {
        const out = run("seq 6 | @{ async function*(args, stdin) { for await (const l of stdin) { if (parseInt(l) % 2 === 0) yield l + '\\n'; } } }");
        assert.deepStrictEqual(out.split("\n"), ["2", "4", "6"]);
    });

    it("should handle @{ } in three-stage pipeline", () => {
        const out = run("seq 5 | @{ async function*(a, s) { for await (const l of s) yield l + '\\n'; } } | head -3");
        assert.deepStrictEqual(out.split("\n"), ["1", "2", "3"]);
    });

    it("should output non-function expression result", () => {
        assert.strictEqual(run('@{ 2 + 2 }'), "4");
    });

    it("should handle standalone generator with no stdin", () => {
        // Generator that only reads stdin — should produce no output, no error
        assert.strictEqual(run('@{ async function*(a, s) { for await (const l of s) yield l; } }'), "");
    });

    it("should not add extra newline when piped", () => {
        // Function return piped to wc -l — should be 0 lines (no trailing newline in pipe)
        assert.strictEqual(run('@{ () => "hello" } | wc -l').trim(), "0");
    });

    it("should handle console.log in @{ } without error", () => {
        const { stdout, stderr } = runFull('@{ console.log("test") }');
        assert.strictEqual(stdout, "test");
        assert.strictEqual(stderr, "");
    });

    it("should add newline to terminal output from function return", () => {
        // Use raw stdout (no trim) to verify trailing newline is present.
        const r = spawnSync("node", ["dist/index.js"], {
            input: '@{ () => "hello" }\nexit\n',
            encoding: "utf8",
        });
        assert.strictEqual(r.stdout, "hello\n");
    });

    it("should add newline to terminal output from expression", () => {
        const r = spawnSync("node", ["dist/index.js"], {
            input: '@{ "world" }\nexit\n',
            encoding: "utf8",
        });
        assert.strictEqual(r.stdout, "world\n");
    });

    it("should pipe function return without extra newline", () => {
        // "hello" without newline → wc -c should be 5
        assert.strictEqual(run('@{ () => "hello" } | wc -c').trim(), "5");
    });
});

describe("@ syntax — named functions via .jshrc", () => {
    it("should register and lookup a function", () => {
        registerJsFunction("__test_upper", async function* (_args, stdin) {
            for await (const line of stdin as AsyncIterable<string>) {
                yield line.trimEnd().toUpperCase() + "\n";
            }
        });
        const fn = lookupJsFunction("__test_upper");
        assert.ok(fn, "registered function should be retrievable");
        assert.strictEqual(typeof fn, "function");
    });

    it("should work with named function via temp file", () => {
        const rc = `/tmp/jsh_test_rc_${Date.now()}.mjs`;
        require("fs").writeFileSync(rc, `
export async function* upper2(args, stdin) {
    for await (const l of stdin) yield l.trimEnd().toUpperCase() + '\\n';
}
`);
        try {
            const r = spawnSync("node", ["dist/index.js", "--jshrc", rc], {
                input: "echo hello | @upper2\nexit\n",
                encoding: "utf8",
                cwd: process.cwd(),
            });
            assert.strictEqual(r.stdout.trim(), "HELLO");
        } finally {
            try { require("fs").unlinkSync(rc); } catch {}
        }
    });
});

describe("@ syntax — buffered mode", () => {
    it("should receive full input as string with @!{ }", () => {
        // Count words — buffered mode joins all input into one string
        const out = run('printf "hello world\\nfoo bar\\n" | @!{ (args, text) => String(text.trim().split(/\\s+/).length) }');
        assert.strictEqual(out, "4");
    });
});
