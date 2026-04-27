import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { exec } from "../src/exec/index.js";

const require = createRequire(import.meta.url);

before(() => {
    const native = require("../build/Release/jsh_native.node");
    native.initExecutor();
});

describe("jsh.exec() — await path", () => {
    it("should return stdout as trimmed string", async () => {
        const { stdout } = await exec("echo hello");
        assert.strictEqual(stdout, "hello");
    });

    it("should return correct exitCode", async () => {
        assert.strictEqual((await exec("true")).exitCode, 0);
        assert.strictEqual((await exec("false")).exitCode, 1);
    });

    it("should set ok to true on exit 0", async () => {
        assert.strictEqual((await exec("true")).ok, true);
    });

    it("should set ok to false on non-zero exit", async () => {
        assert.strictEqual((await exec("false")).ok, false);
    });

    it("should capture multi-line stdout", async () => {
        const { stdout } = await exec("seq 3");
        assert.strictEqual(stdout, "1\n2\n3");
    });

    it("should strip trailing newlines", async () => {
        const { stdout } = await exec("printf 'a\\n\\n\\n'");
        assert.strictEqual(stdout, "a");
    });

    it("should work with pipelines", async () => {
        const { stdout } = await exec("seq 5 | tail -2");
        assert.strictEqual(stdout, "4\n5");
    });

    it("should return empty stderr when not captured", async () => {
        const { stderr } = await exec("echo hi");
        assert.strictEqual(stderr, "");
    });
});

describe("jsh.exec() — iterate path", () => {
    it("should yield lines one at a time", async () => {
        const lines: string[] = [];
        for await (const line of exec("seq 3")) lines.push(line);
        assert.deepStrictEqual(lines, ["1", "2", "3"]);
    });

    it("should not include trailing newline in lines", async () => {
        const lines: string[] = [];
        for await (const line of exec("echo hello")) lines.push(line);
        assert.strictEqual(lines[0], "hello");
        assert.ok(!lines[0]!.endsWith("\n"));
    });

    it("should support iteration then await", async () => {
        const handle = exec("seq 3");
        const lines: string[] = [];
        for await (const line of handle) lines.push(line);
        const result = await handle;
        assert.deepStrictEqual(lines, ["1", "2", "3"]);
        assert.strictEqual(result.exitCode, 0);
    });

    it("should yield no lines for empty output", async () => {
        const lines: string[] = [];
        for await (const line of exec("true")) lines.push(line);
        assert.strictEqual(lines.length, 0);
    });
});

describe("jsh.exec() — stdin option", () => {
    it("should feed string stdin to command", async () => {
        const { stdout } = await exec("cat", { stdin: "hello\n" });
        assert.strictEqual(stdout, "hello");
    });

    it("should feed multi-line string stdin", async () => {
        const { stdout } = await exec("cat", { stdin: "a\nb\nc\n" });
        assert.strictEqual(stdout, "a\nb\nc");
    });

    it("should feed stdin to processing command", async () => {
        const { stdout } = await exec("grep b", { stdin: "a\nb\nc\n" });
        assert.strictEqual(stdout, "b");
    });

    it("should feed async iterable stdin", async () => {
        async function* gen() { yield "hello\n"; yield "world\n"; }
        const { stdout } = await exec("cat", { stdin: gen() });
        assert.strictEqual(stdout, "hello\nworld");
    });
});

describe("jsh.exec() — stderr option", () => {
    it("should not capture stderr by default", async () => {
        const { stderr } = await exec("echo hi");
        assert.strictEqual(stderr, "");
    });

    it("should capture stderr with pipe option", async () => {
        const { stderr, exitCode } = await exec("ls /nonexistent_jsh_test", { stderr: "pipe" });
        assert.ok(stderr.length > 0, "expected stderr to be captured");
        assert.notStrictEqual(exitCode, 0);
    });

    it("should capture stdout and stderr separately", async () => {
        const { stdout, stderr } = await exec(
            "sh -c 'echo stdout_line; echo stderr_line >&2'",
            { stderr: "pipe" }
        );
        assert.strictEqual(stdout, "stdout_line");
        assert.strictEqual(stderr, "stderr_line");
    });

    it("should merge stderr into stdout", async () => {
        const { stdout } = await exec("ls /nonexistent_jsh_test", { stderr: "merge" });
        assert.ok(stdout.length > 0, "expected merged stderr in stdout");
    });

    it("should merge stderr in iterate path", async () => {
        const lines: string[] = [];
        for await (const l of exec("ls /nonexistent_jsh_test", { stderr: "merge" })) {
            lines.push(l);
        }
        assert.ok(lines.length > 0);
    });
});

describe("jsh.exec() — compound commands", () => {
    it("should handle && (both succeed)", async () => {
        const { stdout, ok } = await exec("echo a && echo b");
        assert.strictEqual(stdout, "a\nb");
        assert.strictEqual(ok, true);
    });

    it("should handle && (first fails)", async () => {
        const { stdout, ok } = await exec("false && echo b");
        assert.strictEqual(stdout, "");
        assert.strictEqual(ok, false);
    });

    it("should handle || (first succeeds)", async () => {
        const { stdout, ok } = await exec("echo a || echo b");
        assert.strictEqual(stdout, "a");
        assert.strictEqual(ok, true);
    });

    it("should handle || (first fails)", async () => {
        const { stdout, ok } = await exec("false || echo b");
        assert.strictEqual(stdout, "b");
        assert.strictEqual(ok, true);
    });

    it("should handle semicolon-separated commands", async () => {
        const { stdout } = await exec("echo a; echo b");
        assert.strictEqual(stdout, "a\nb");
    });

    it("should handle mixed && and ||", async () => {
        const { stdout } = await exec("true && echo yes || echo no");
        assert.strictEqual(stdout, "yes");
    });

    it("should iterate lines from compound command", async () => {
        const lines: string[] = [];
        for await (const line of exec("echo x && echo y")) lines.push(line);
        assert.deepStrictEqual(lines, ["x", "y"]);
    });
});

describe("jsh.exec() — stderr iteration", () => {
    it("should leave default iter as stdout-only (backward compat)", async () => {
        const lines: string[] = [];
        const h = exec("sh -c 'echo OUT; echo ERR >&2'", { stderr: "pipe" });
        for await (const line of h) lines.push(line);
        assert.deepStrictEqual(lines, ["OUT"]);
    });

    it("should yield stderr lines via iterStderr()", async () => {
        const out: string[] = [];
        const err: string[] = [];
        const h = exec("sh -c 'echo A; echo X >&2; echo B; echo Y >&2'", { stderr: "pipe" });
        const stdoutTask = (async () => { for await (const l of h) out.push(l); })();
        const stderrTask = (async () => { for await (const l of h.iterStderr()) err.push(l); })();
        await Promise.all([stdoutTask, stderrTask, h]);
        assert.deepStrictEqual(out, ["A", "B"]);
        assert.deepStrictEqual(err, ["X", "Y"]);
    });

    it("should yield interleaved tagged records via iterAll()", async () => {
        const recs: Array<{ stream: string; line: string }> = [];
        const h = exec("sh -c 'echo A; echo B >&2; echo C'", { stderr: "pipe" });
        for await (const r of h.iterAll()) recs.push(r);
        // Order across separate fds isn't strictly deterministic, but the
        // contents should be exactly these three records.
        const sorted = [...recs].sort((a, b) => (a.stream + a.line).localeCompare(b.stream + b.line));
        assert.deepStrictEqual(sorted, [
            { stream: "stderr", line: "B" },
            { stream: "stdout", line: "A" },
            { stream: "stdout", line: "C" },
        ]);
    });

    it("should still buffer stderr into the awaited result", async () => {
        const h = exec("sh -c 'echo OUT; echo ERR >&2'", { stderr: "pipe" });
        // Don't iterate — just await.
        const r = await h;
        assert.strictEqual(r.stdout, "OUT");
        assert.strictEqual(r.stderr, "ERR");
    });

    it("should produce empty iterStderr() when stderr is inherit (default)", async () => {
        const err: string[] = [];
        const h = exec("echo hello");
        for await (const l of h.iterStderr()) err.push(l);
        assert.deepStrictEqual(err, []);
    });

    it("should mix stderr into stdout under the merge mode", async () => {
        // When stderr === "merge", stderr lines are written to the stdout fd
        // by the kernel, so they appear under the "stdout" tag in iterAll
        // (and in the default iterator).
        const out: string[] = [];
        const h = exec("sh -c 'echo OUT; echo ERR >&2'", { stderr: "merge" });
        for await (const line of h) out.push(line);
        const sorted = [...out].sort();
        assert.deepStrictEqual(sorted, ["ERR", "OUT"]);
    });
});
