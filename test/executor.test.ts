import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run commands through jsh and return trimmed stdout.
function run(cmd: string): string {
    const r = spawnSync("node", ["dist/index.js"], {
        input: cmd + "\nexit\n",
        encoding: "utf8",
        cwd: process.cwd(),
    });
    return r.stdout.trim();
}

function ec(cmd: string): number {
    // Use $? to capture exit code from the command.
    const r = spawnSync("node", ["dist/index.js"], {
        input: `${cmd}\necho $?\nexit\n`,
        encoding: "utf8",
        cwd: process.cwd(),
    });
    const lines = r.stdout.trim().split("\n");
    return parseInt(lines[lines.length - 1]!, 10);
}

describe("executor — simple commands", () => {
    it("runs a command and captures stdout", () => {
        assert.strictEqual(run("echo hello"), "hello");
    });

    it("passes arguments correctly", () => {
        assert.strictEqual(run("echo foo bar baz"), "foo bar baz");
    });

    it("exit code 0 on success", () => {
        assert.strictEqual(ec("true"), 0);
    });

    it("exit code 1 on failure", () => {
        assert.strictEqual(ec("false"), 1);
    });

    it("command not found returns 127", () => {
        assert.strictEqual(ec("__no_such_command__"), 127);
    });
});

describe("executor — pipelines", () => {
    it("pipes stdout between commands", () => {
        assert.strictEqual(run("echo hello | cat"), "hello");
    });

    it("multi-stage pipeline", () => {
        assert.strictEqual(run("echo hello | cat | cat"), "hello");
    });

    it("pipeline with transformation", () => {
        assert.strictEqual(run("echo hello | tr a-z A-Z"), "HELLO");
    });

    it("exit code from last stage", () => {
        assert.strictEqual(ec("echo hi | false"), 1);
    });
});

describe("executor — redirections", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-test-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("redirects stdout to file", () => {
        const f = join(tmp, "out.txt");
        run(`echo hello > ${f}`);
        assert.strictEqual(run(`cat ${f}`), "hello");
    });

    it("appends with >>", () => {
        const f = join(tmp, "append.txt");
        run(`echo a > ${f}`);
        run(`echo b >> ${f}`);
        assert.strictEqual(run(`cat ${f}`), "a\nb");
    });

    it("reads stdin from file", () => {
        const f = join(tmp, "in.txt");
        run(`echo world > ${f}`);
        assert.strictEqual(run(`cat < ${f}`), "world");
    });
});

describe("executor — logical operators", () => {
    it("&& executes right side on success", () => {
        assert.strictEqual(run("echo a && echo b"), "a\nb");
    });

    it("&& skips right side on failure", () => {
        assert.strictEqual(run("false && echo b"), "");
    });

    it("|| skips right side on success", () => {
        assert.strictEqual(run("true || echo b"), "");
    });

    it("|| executes right side on failure", () => {
        assert.strictEqual(run("false || echo b"), "b");
    });
});

describe("executor — builtins", () => {
    it("echo builtin", () => {
        assert.strictEqual(run("echo hi"), "hi");
    });

    it("true and false", () => {
        assert.strictEqual(ec("true"), 0);
        assert.strictEqual(ec("false"), 1);
    });

    it("cd changes directory and PWD is updated", () => {
        assert.strictEqual(run("cd /tmp && echo $PWD"), "/tmp");
    });

    it("export makes variable visible to children", () => {
        assert.strictEqual(run("export MYJSHVAR=hello && env | grep MYJSHVAR"), "MYJSHVAR=hello");
    });
});

describe("executor — control flow", () => {
    it("if true executes consequent", () => {
        assert.strictEqual(run("if true; then echo yes; fi"), "yes");
    });

    it("if false executes else", () => {
        assert.strictEqual(run("if false; then echo no; else echo yes; fi"), "yes");
    });

    it("if with elif", () => {
        assert.strictEqual(
            run("if false; then echo a; elif true; then echo b; else echo c; fi"),
            "b"
        );
    });

    it("for loop iterates over items", () => {
        assert.deepStrictEqual(run("for i in 1 2 3; do echo $i; done").split("\n"), ["1", "2", "3"]);
    });

    it("while loop exits when condition is false", () => {
        assert.strictEqual(run("while false; do echo x; done; echo done"), "done");
    });
});

describe("executor — shell functions", () => {
    it("defines and calls a function", () => {
        assert.strictEqual(run("greet() { echo hello; }; greet"), "hello");
    });

    it("function receives positional params", () => {
        assert.strictEqual(run("greet() { echo hello $1; }; greet world"), "hello world");
    });

    it("function with multiple params", () => {
        assert.strictEqual(run("add() { echo $1 $2; }; add foo bar"), "foo bar");
    });
});

describe("executor — expansion", () => {
    it("variable expansion", () => {
        assert.strictEqual(run("X=hello; echo $X"), "hello");
    });

    it("arithmetic expansion", () => {
        assert.strictEqual(run("echo $((2 + 3))"), "5");
    });

    it("arithmetic with variable", () => {
        assert.strictEqual(run("X=7; echo $((X * 2))"), "14");
    });

    it("command substitution", () => {
        assert.strictEqual(run("echo $(echo inner)"), "inner");
    });

    it("command substitution in pipeline", () => {
        assert.strictEqual(run("echo $(echo hello | tr a-z A-Z)"), "HELLO");
    });

    it("glob expansion", () => {
        const out = run("echo test/*.test.ts");
        assert.ok(out.includes("lexer.test.ts"), `expected glob match, got: ${out}`);
    });

    it("tilde expansion", () => {
        const out = run("echo ~/foo");
        assert.ok(out.startsWith("/"), `expected absolute path, got: ${out}`);
        assert.ok(out.endsWith("/foo"));
    });

    it("default parameter expansion", () => {
        assert.strictEqual(run("unset NOVAR; echo ${NOVAR:-fallback}"), "fallback");
    });
});
