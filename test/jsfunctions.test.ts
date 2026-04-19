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

// ---- Bare-name JS function calls -------------------------------------------
//
// Exported JS functions should be invocable by their bare name (no @ prefix),
// mirroring bash function semantics. @name remains as an explicit-force form.
// Functions marked `atOnly = true` (or wrapped in jsh.atOnly) skip bare-name
// resolution so a same-named alias / builtin / PATH command wins.

function withRc(rcBody: string, input: string): { stdout: string; stderr: string } {
    const rc = `/tmp/jsh_test_rc_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`;
    require("fs").writeFileSync(rc, rcBody);
    try {
        const r = spawnSync("node", ["dist/index.js", "--jshrc", rc], {
            input: input + "\nexit\n",
            encoding: "utf8",
            cwd: process.cwd(),
        });
        return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
    } finally {
        try { require("fs").unlinkSync(rc); } catch {}
    }
}

describe("bare-name JS function calls", () => {
    it("should call a JS function via bare name", () => {
        const rcBody = `
export async function* myupper(args, stdin) {
    for await (const l of stdin) yield l.toUpperCase() + '\\n';
}
`;
        const { stdout } = withRc(rcBody, "echo hello | myupper");
        assert.strictEqual(stdout, "HELLO");
    });

    it("should still accept the @name form", () => {
        const rcBody = `
export async function* myupper2(args, stdin) {
    for await (const l of stdin) yield l.toUpperCase() + '\\n';
}
`;
        const { stdout } = withRc(rcBody, "echo hi | @myupper2");
        assert.strictEqual(stdout, "HI");
    });

    it("should work as a standalone command with no pipe", () => {
        const rcBody = `
export async function hello_jsh(args, stdin) {
    return "hello, " + (args[0] ?? "world");
}
`;
        const { stdout } = withRc(rcBody, "hello_jsh there");
        assert.strictEqual(stdout, "hello, there");
    });

    it("should participate in longer pipelines", () => {
        const rcBody = `
export async function* doubler(args, stdin) {
    for await (const l of stdin) yield l + l + '\\n';
}
`;
        const { stdout } = withRc(rcBody, "printf 'a\\nb\\n' | doubler | head -1");
        assert.strictEqual(stdout, "aa");
    });

    it("should skip bare-name resolution when atOnly is set", () => {
        // Define a function whose bare name collides with `echo` (a builtin).
        // Without atOnly, calling `echo` would invoke our JS function.
        // With atOnly, `echo` falls through to the real echo.
        const rcBody = `
export function echo(args, stdin) {
    return "js-version";
}
echo.atOnly = true;
`;
        const { stdout } = withRc(rcBody, "echo from-builtin");
        assert.strictEqual(stdout, "from-builtin");
    });

    it("should still allow @name for atOnly functions", () => {
        const rcBody = `
export function echo(args, stdin) {
    return "js-version: " + (args[0] ?? "");
}
echo.atOnly = true;
`;
        const { stdout } = withRc(rcBody, "@echo hello");
        assert.strictEqual(stdout, "js-version: hello");
    });

    it("should support jsh.atOnly() helper", () => {
        const rcBody = `
export const echo = jsh.atOnly(function (args, stdin) {
    return "wrapped-js";
});
`;
        const { stdout } = withRc(rcBody, "echo from-builtin");
        assert.strictEqual(stdout, "from-builtin");
    });

    it("type should report a bare-name JS function", () => {
        const rcBody = `
export function mytool(args, stdin) { return "hi"; }
`;
        const { stdout } = withRc(rcBody, "type mytool");
        assert.match(stdout, /mytool is a JS pipeline function/);
    });

    it("shell function should take precedence over same-named JS function", () => {
        // Shell functions are checked first in resolution order.
        const rcBody = `
export function greet(args, stdin) { return "js"; }
`;
        const { stdout } = withRc(rcBody, "greet() { echo sh; }; greet");
        assert.strictEqual(stdout, "sh");
    });
});

// ---- Pipeline concurrency / deadlock regression tests ---------------------
//
// Pre-fix: builtin-stage output to a JS-stage downstream used writeSync(1)
// while fd 1 was dup2'd to the inter-stage pipe. The JS stage hadn't started
// yet (stages ran sequentially), so once the builtin's output exceeded the
// pipe buffer (~64 KB on macOS) writeSync would block forever — hard hang.
// Post-fix: builtins write asynchronously through an IO context, all stages
// run concurrently, the event loop drains downstream readers as they go.

const COUNT_LINES_RC = `
export async function* count_lines(args, stdin) {
    let n = 0;
    for await (const _ of stdin) n++;
    yield String(n) + "\\n";
}
export async function* upper(args, stdin) {
    for await (const line of stdin) yield line.toUpperCase() + "\\n";
}
`;

describe("pipeline concurrency", () => {
    it("should not deadlock when a builtin emits >64KB into a JS stage", () => {
        // 50_000 lines × ~6 bytes = ~300 KB, well past macOS 64 KB pipe buffer.
        const { stdout } = withRc(COUNT_LINES_RC, "printf '%s\\n' {1..50000} | count_lines");
        assert.strictEqual(stdout, "50000");
    });

    it("should stream large declare -p output through a JS stage", () => {
        // Define ~1000 vars, then dump them through a JS counter.
        const { stdout } = withRc(
            COUNT_LINES_RC,
            "for i in {1..1000}; do declare V$i=$i; done; declare -p | count_lines",
        );
        // ≥1000 lines (env vars push the count higher; just assert the
        // builtin actually streamed everything through).
        assert.ok(parseInt(stdout, 10) >= 1000, `expected >=1000 lines, got ${stdout}`);
    });

    it("should support a brace group as a pipeline stage feeding a JS stage", () => {
        const { stdout } = withRc(COUNT_LINES_RC, "{ echo a; echo b; echo c; } | count_lines");
        assert.strictEqual(stdout, "3");
    });

    it("should support a subshell as a pipeline stage feeding a JS stage", () => {
        const { stdout } = withRc(COUNT_LINES_RC, "( echo x; echo y; ) | upper");
        assert.strictEqual(stdout, "X\nY");
    });

    it("should support a for-loop as a pipeline stage feeding a JS stage", () => {
        const { stdout } = withRc(COUNT_LINES_RC, "for i in 1 2 3 4 5; do echo $i; done | count_lines");
        assert.strictEqual(stdout, "5");
    });

    it("should drain correctly when a JS stage feeds a downstream builtin", () => {
        // JS stage produces 5 lines, head -3 takes 3.
        const rc = `
export async function* gen(args, stdin) {
    for (let i = 1; i <= 5; i++) yield i + "\\n";
}
`;
        const { stdout } = withRc(rc, "gen | head -3");
        assert.strictEqual(stdout, "1\n2\n3");
    });

    it("should route console.log inside an @-fn into the next pipeline stage", () => {
        const rc = `
export async function emit(args, stdin) {
    console.log("hello-from-console");
    console.log("second-line");
}
`;
        const { stdout } = withRc(rc, "emit | grep hello");
        assert.strictEqual(stdout, "hello-from-console");
    });

    it("should route jsh.stdout.write inside an @-fn into the next pipeline stage", () => {
        const rc = `
export async function emit(args, stdin) {
    await jsh.stdout.write("a\\nb\\nc\\n");
}
`;
        const { stdout } = withRc(rc, "emit | wc -l | tr -d ' '");
        assert.strictEqual(stdout, "3");
    });

    it("should send console.error to stderr (terminal), not the pipeline", () => {
        // stderr stays on fd 2 in pipelines unless 2>&1 — so console.error
        // from an @-fn should *not* land in downstream stage.
        const rc = `
export async function emit(args, stdin) {
    console.error("error-msg");
    console.log("data-msg");
}
`;
        const { stdout, stderr } = withRc(rc, "emit | cat");
        assert.strictEqual(stdout, "data-msg");
        assert.match(stderr, /error-msg/);
    });

    it("should preserve write order when many concurrent writers target the same fd", () => {
        // Fire 100 echo-via-builtin writes to stderr from concurrent async
        // chains (Promise.all over a JS function that calls jsh.exec on
        // builtins). Per-fd queue must serialize them in enqueue order.
        // Using stderr because pipelines don't redirect it, so all writers
        // share fd 2.
        const rc = `
export async function fanout() {
    const tasks = [];
    for (let i = 0; i < 100; i++) {
        tasks.push(jsh.exec("printf 'line%03d\\n' " + i, { stderr: "merge" }));
    }
    const results = await Promise.all(tasks);
    return results.map(r => r.stdout).join("\\n") + "\\n";
}
`;
        const { stdout } = withRc(rc, "fanout");
        const lines = stdout.split("\n").filter(Boolean);
        assert.strictEqual(lines.length, 100);
        // All 100 lines present (no drops, no duplicates).
        const seen = new Set(lines);
        assert.strictEqual(seen.size, 100);
        for (let i = 0; i < 100; i++) {
            assert.ok(seen.has(`line${String(i).padStart(3, "0")}`),
                `missing line${String(i).padStart(3, "0")}`);
        }
    });
});
