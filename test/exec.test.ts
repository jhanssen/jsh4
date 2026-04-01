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
    it("returns stdout as trimmed string", async () => {
        const { stdout } = await exec("echo hello");
        assert.strictEqual(stdout, "hello");
    });

    it("returns correct exitCode", async () => {
        assert.strictEqual((await exec("true")).exitCode, 0);
        assert.strictEqual((await exec("false")).exitCode, 1);
    });

    it("ok is true on exit 0", async () => {
        assert.strictEqual((await exec("true")).ok, true);
    });

    it("ok is false on non-zero exit", async () => {
        assert.strictEqual((await exec("false")).ok, false);
    });

    it("captures multi-line stdout", async () => {
        const { stdout } = await exec("seq 3");
        assert.strictEqual(stdout, "1\n2\n3");
    });

    it("strips trailing newlines", async () => {
        const { stdout } = await exec("printf 'a\\n\\n\\n'");
        assert.strictEqual(stdout, "a");
    });

    it("works with pipelines", async () => {
        const { stdout } = await exec("seq 5 | tail -2");
        assert.strictEqual(stdout, "4\n5");
    });

    it("stderr is empty when not captured", async () => {
        const { stderr } = await exec("echo hi");
        assert.strictEqual(stderr, "");
    });
});

describe("jsh.exec() — iterate path", () => {
    it("yields lines one at a time", async () => {
        const lines: string[] = [];
        for await (const line of exec("seq 3")) lines.push(line);
        assert.deepStrictEqual(lines, ["1", "2", "3"]);
    });

    it("lines do not include trailing newline", async () => {
        const lines: string[] = [];
        for await (const line of exec("echo hello")) lines.push(line);
        assert.strictEqual(lines[0], "hello");
        assert.ok(!lines[0]!.endsWith("\n"));
    });

    it("can be iterated and then awaited", async () => {
        const handle = exec("seq 3");
        const lines: string[] = [];
        for await (const line of handle) lines.push(line);
        const result = await handle;
        assert.deepStrictEqual(lines, ["1", "2", "3"]);
        assert.strictEqual(result.exitCode, 0);
    });

    it("empty output yields no lines", async () => {
        const lines: string[] = [];
        for await (const line of exec("true")) lines.push(line);
        assert.strictEqual(lines.length, 0);
    });
});

describe("jsh.exec() — stdin option", () => {
    it("string stdin feeds input to command", async () => {
        const { stdout } = await exec("cat", { stdin: "hello\n" });
        assert.strictEqual(stdout, "hello");
    });

    it("multi-line string stdin", async () => {
        const { stdout } = await exec("cat", { stdin: "a\nb\nc\n" });
        assert.strictEqual(stdout, "a\nb\nc");
    });

    it("stdin with processing command", async () => {
        const { stdout } = await exec("grep b", { stdin: "a\nb\nc\n" });
        assert.strictEqual(stdout, "b");
    });

    it("async iterable stdin", async () => {
        async function* gen() { yield "hello\n"; yield "world\n"; }
        const { stdout } = await exec("cat", { stdin: gen() });
        assert.strictEqual(stdout, "hello\nworld");
    });
});

describe("jsh.exec() — stderr option", () => {
    it("stderr inherit (default) — not captured", async () => {
        const { stderr } = await exec("echo hi");
        assert.strictEqual(stderr, "");
    });

    it("stderr pipe — captures stderr", async () => {
        const { stderr, exitCode } = await exec("ls /nonexistent_jsh_test", { stderr: "pipe" });
        assert.ok(stderr.length > 0, "expected stderr to be captured");
        assert.notStrictEqual(exitCode, 0);
    });

    it("stderr pipe — stdout and stderr captured separately", async () => {
        const { stdout, stderr } = await exec(
            "sh -c 'echo stdout_line; echo stderr_line >&2'",
            { stderr: "pipe" }
        );
        assert.strictEqual(stdout, "stdout_line");
        assert.strictEqual(stderr, "stderr_line");
    });

    it("stderr merge — appears in stdout", async () => {
        const { stdout } = await exec("ls /nonexistent_jsh_test", { stderr: "merge" });
        assert.ok(stdout.length > 0, "expected merged stderr in stdout");
    });

    it("stderr merge in iterate path", async () => {
        const lines: string[] = [];
        for await (const l of exec("ls /nonexistent_jsh_test", { stderr: "merge" })) {
            lines.push(l);
        }
        assert.ok(lines.length > 0);
    });
});
