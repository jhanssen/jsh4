import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
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
        assert.strictEqual(run("cd /tmp && echo $PWD"), realpathSync("/tmp"));
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

describe("executor — test / [ builtin", () => {
    // String tests
    it("test with no args returns false", () => {
        assert.strictEqual(ec("test"), 1);
    });
    it("test non-empty string is true", () => {
        assert.strictEqual(ec("test hello"), 0);
    });
    it("test empty string is false", () => {
        assert.strictEqual(ec('test ""'), 1);
    });
    it("-z empty string", () => {
        assert.strictEqual(ec('test -z ""'), 0);
    });
    it("-z non-empty string", () => {
        assert.strictEqual(ec("test -z hello"), 1);
    });
    it("-n non-empty string", () => {
        assert.strictEqual(ec("test -n hello"), 0);
    });
    it("-n empty string", () => {
        assert.strictEqual(ec('test -n ""'), 1);
    });

    // String comparison
    it("string equality", () => {
        assert.strictEqual(ec('test foo = foo'), 0);
    });
    it("string inequality", () => {
        assert.strictEqual(ec('test foo = bar'), 1);
    });
    it("string !=", () => {
        assert.strictEqual(ec('test foo != bar'), 0);
    });

    // Integer comparison
    it("-eq", () => {
        assert.strictEqual(ec("test 5 -eq 5"), 0);
    });
    it("-ne", () => {
        assert.strictEqual(ec("test 5 -ne 3"), 0);
    });
    it("-lt", () => {
        assert.strictEqual(ec("test 3 -lt 5"), 0);
    });
    it("-gt", () => {
        assert.strictEqual(ec("test 5 -gt 3"), 0);
    });
    it("-le equal", () => {
        assert.strictEqual(ec("test 5 -le 5"), 0);
    });
    it("-ge less", () => {
        assert.strictEqual(ec("test 3 -ge 5"), 1);
    });

    // File tests
    it("-f on existing file", () => {
        assert.strictEqual(ec("test -f package.json"), 0);
    });
    it("-f on nonexistent file", () => {
        assert.strictEqual(ec("test -f __nope__"), 1);
    });
    it("-d on directory", () => {
        assert.strictEqual(ec("test -d src"), 0);
    });
    it("-d on file", () => {
        assert.strictEqual(ec("test -d package.json"), 1);
    });
    it("-e on existing file", () => {
        assert.strictEqual(ec("test -e package.json"), 0);
    });

    // Negation
    it("! inverts result", () => {
        assert.strictEqual(ec("test ! -f __nope__"), 0);
    });

    // [ ] syntax
    it("[ ] syntax works", () => {
        assert.strictEqual(ec('[ foo = foo ]'), 0);
    });
    it("[ ] missing ] is error", () => {
        assert.strictEqual(ec('[ foo = foo'), 2);
    });

    // Used with if
    it("if [ -f file ] works", () => {
        assert.strictEqual(run('if [ -f package.json ]; then echo yes; else echo no; fi'), "yes");
    });
    it("if test string = string", () => {
        assert.strictEqual(run('if test foo = foo; then echo match; fi'), "match");
    });

    // Logical operators
    it("-a (and)", () => {
        assert.strictEqual(ec('test -f package.json -a -d src'), 0);
    });
    it("-o (or)", () => {
        assert.strictEqual(ec('test -f __nope__ -o -d src'), 0);
    });
});

describe("executor — read builtin", () => {
    it("should read into REPLY with no var name", () => {
        assert.strictEqual(run('read <<< hello; echo $REPLY'), "hello");
    });
    it("should read into named variable", () => {
        assert.strictEqual(run('read X <<< world; echo $X'), "world");
    });
    it("should split into multiple variables", () => {
        assert.strictEqual(run('read X Y Z <<< "a b c"; echo $X $Y $Z'), "a b c");
    });
    it("should assign remainder to last variable", () => {
        assert.strictEqual(run('read X Y <<< "a b c d"; echo "$X:$Y"'), "a:b c d");
    });
    it("should return 1 on EOF with empty input", () => {
        assert.strictEqual(ec('read X < /dev/null'), 1);
    });
    it("should strip backslash escapes without -r", () => {
        assert.strictEqual(run("read X <<< 'hello\\_world'; echo $X"), "hello_world");
    });
    it("should preserve backslashes with -r", () => {
        assert.strictEqual(run("read -r X <<< 'hello\\_world'; echo $X"), "hello\\_world");
    });
});

describe("executor — source / . builtin", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-source-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("source executes file in current context", () => {
        const f = join(tmp, "vars.sh");
        const r = spawnSync("node", ["dist/index.js"], {
            input: `echo 'MYVAR=hello' > ${f}\nsource ${f}\necho $MYVAR\nexit\n`,
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stdout.includes("hello"), `expected hello, got: ${r.stdout}`);
    });

    it(". is alias for source", () => {
        const f = join(tmp, "dot.sh");
        const r = spawnSync("node", ["dist/index.js"], {
            input: `echo 'DOTVAR=world' > ${f}\n. ${f}\necho $DOTVAR\nexit\n`,
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stdout.includes("world"), `expected world, got: ${r.stdout}`);
    });

    it("source with missing file returns error", () => {
        assert.strictEqual(ec("source /tmp/__no_such_file_jsh__"), 1);
    });

    it("source executes functions defined in file", () => {
        const f = join(tmp, "func.sh");
        const r = spawnSync("node", ["dist/index.js"], {
            input: `echo 'greet() { echo hi $1; }' > ${f}\nsource ${f}\ngreet world\nexit\n`,
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stdout.includes("hi world"), `expected "hi world", got: ${r.stdout}`);
    });

    it("source with extra args sets positional params", () => {
        const f = join(tmp, "params.sh");
        const r = spawnSync("node", ["dist/index.js"], {
            input: `echo 'echo $1 $2' > ${f}\nsource ${f} foo bar\nexit\n`,
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stdout.includes("foo bar"), `expected "foo bar", got: ${r.stdout}`);
    });
});

describe("executor — local builtin", () => {
    it("should scope variable to function", () => {
        assert.strictEqual(
            run('X=global\nmyfunc() { local X=local; echo $X; }\nmyfunc\necho $X'),
            "local\nglobal"
        );
    });
    it("should restore unset variable after function", () => {
        assert.strictEqual(
            run('unset LOCALTEST\nmyfunc() { local LOCALTEST=val; echo $LOCALTEST; }\nmyfunc\necho "after:$LOCALTEST"'),
            "val\nafter:"
        );
    });
    it("should allow local without assignment", () => {
        assert.strictEqual(
            run('X=global\nmyfunc() { local X; X=local; echo $X; }\nmyfunc\necho $X'),
            "local\nglobal"
        );
    });
    it("should handle multiple local declarations", () => {
        assert.strictEqual(
            run('A=1\nB=2\nmyfunc() { local A=x B=y; echo $A $B; }\nmyfunc\necho $A $B'),
            "x y\n1 2"
        );
    });
    it("should warn when used outside function", () => {
        const r = spawnSync("node", ["dist/index.js"], {
            input: "local X=1\n",
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stderr.includes("can only be used in a function"));
    });
});

describe("executor — set builtin", () => {
    it("should enable errexit with set -e", () => {
        assert.strictEqual(run("set -e\nfalse\necho should not print"), "");
    });
    it("should disable errexit with set +e", () => {
        assert.strictEqual(run("set -e\nset +e\nfalse\necho ok"), "ok");
    });
    it("should enable xtrace with set -x", () => {
        const r = spawnSync("node", ["dist/index.js"], {
            input: "set -x\necho hello\n",
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stderr.includes("+ echo hello"), `expected trace, got stderr: ${r.stderr}`);
        assert.ok(r.stdout.includes("hello"));
    });
    it("should error on unset variable with set -u", () => {
        const r = spawnSync("node", ["dist/index.js"], {
            input: "set -u\necho $UNSETVAR_JSH_TEST\n",
            encoding: "utf8",
            cwd: process.cwd(),
        });
        assert.ok(r.stderr.includes("unbound variable"), `expected error, got stderr: ${r.stderr}`);
    });
    it("should enable pipefail with set -o pipefail", () => {
        assert.strictEqual(ec("set -o pipefail"), 0);
    });
    it("should combine short flags", () => {
        assert.strictEqual(run("set -eu\nset +eu\necho ok"), "ok");
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
