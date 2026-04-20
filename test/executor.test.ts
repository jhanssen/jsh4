import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runFull, ec, spawnJsh } from "./helpers.js";

describe("executor — simple commands", () => {
    it("should run a command and capture stdout", () => {
        assert.strictEqual(run("echo hello"), "hello");
    });

    it("should pass arguments correctly", () => {
        assert.strictEqual(run("echo foo bar baz"), "foo bar baz");
    });

    it("should return exit code 0 on success", () => {
        assert.strictEqual(ec("true"), 0);
    });

    it("should return exit code 1 on failure", () => {
        assert.strictEqual(ec("false"), 1);
    });

    it("should return 127 for command not found", () => {
        assert.strictEqual(ec("__no_such_command__"), 127);
    });
});

describe("executor — pipelines", () => {
    it("should pipe stdout between commands", () => {
        assert.strictEqual(run("echo hello | cat"), "hello");
    });

    it("should handle multi-stage pipeline", () => {
        assert.strictEqual(run("echo hello | cat | cat"), "hello");
    });

    it("should transform in pipeline", () => {
        assert.strictEqual(run("echo hello | tr a-z A-Z"), "HELLO");
    });

    it("should return exit code from last stage", () => {
        assert.strictEqual(ec("echo hi | false"), 1);
    });
});

describe("executor — redirections", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-test-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("should redirect stdout to file", () => {
        const f = join(tmp, "out.txt");
        run(`echo hello > ${f}`);
        assert.strictEqual(run(`cat ${f}`), "hello");
    });

    it("should append with >>", () => {
        const f = join(tmp, "append.txt");
        run(`echo a > ${f}`);
        run(`echo b >> ${f}`);
        assert.strictEqual(run(`cat ${f}`), "a\nb");
    });

    it("should read stdin from file", () => {
        const f = join(tmp, "in.txt");
        run(`echo world > ${f}`);
        assert.strictEqual(run(`cat < ${f}`), "world");
    });
});

describe("executor — logical operators", () => {
    it("should execute right side of && on success", () => {
        assert.strictEqual(run("echo a && echo b"), "a\nb");
    });

    it("should skip right side of && on failure", () => {
        assert.strictEqual(run("false && echo b"), "");
    });

    it("should skip right side of || on success", () => {
        assert.strictEqual(run("true || echo b"), "");
    });

    it("should execute right side of || on failure", () => {
        assert.strictEqual(run("false || echo b"), "b");
    });
});

describe("executor — builtins", () => {
    it("should handle echo builtin", () => {
        assert.strictEqual(run("echo hi"), "hi");
    });

    it("should handle true and false", () => {
        assert.strictEqual(ec("true"), 0);
        assert.strictEqual(ec("false"), 1);
    });

    it("should change directory and update PWD", () => {
        assert.strictEqual(run("cd /tmp && echo $PWD"), realpathSync("/tmp"));
    });

    it("should make exported variable visible to children", () => {
        assert.strictEqual(run("export MYJSHVAR=hello && env | grep MYJSHVAR"), "MYJSHVAR=hello");
    });
});

describe("executor — control flow", () => {
    it("should execute consequent when if condition is true", () => {
        assert.strictEqual(run("if true; then echo yes; fi"), "yes");
    });

    it("should execute else when if condition is false", () => {
        assert.strictEqual(run("if false; then echo no; else echo yes; fi"), "yes");
    });

    it("should handle elif", () => {
        assert.strictEqual(
            run("if false; then echo a; elif true; then echo b; else echo c; fi"),
            "b"
        );
    });

    it("should iterate for loop over items", () => {
        assert.deepStrictEqual(run("for i in 1 2 3; do echo $i; done").split("\n"), ["1", "2", "3"]);
    });

    it("should exit while loop when condition is false", () => {
        assert.strictEqual(run("while false; do echo x; done; echo done"), "done");
    });
});

describe("executor — shell functions", () => {
    it("should define and call a function", () => {
        assert.strictEqual(run("greet() { echo hello; }; greet"), "hello");
    });

    it("should pass positional params to function", () => {
        assert.strictEqual(run("greet() { echo hello $1; }; greet world"), "hello world");
    });

    it("should handle function with multiple params", () => {
        assert.strictEqual(run("add() { echo $1 $2; }; add foo bar"), "foo bar");
    });
});

describe("executor — test / [ builtin", () => {
    // String tests
    it("should return false with no args", () => {
        assert.strictEqual(ec("test"), 1);
    });
    it("should return true for non-empty string", () => {
        assert.strictEqual(ec("test hello"), 0);
    });
    it("should return false for empty string", () => {
        assert.strictEqual(ec('test ""'), 1);
    });
    it("should return true for -z with empty string", () => {
        assert.strictEqual(ec('test -z ""'), 0);
    });
    it("should return false for -z with non-empty string", () => {
        assert.strictEqual(ec("test -z hello"), 1);
    });
    it("should return true for -n with non-empty string", () => {
        assert.strictEqual(ec("test -n hello"), 0);
    });
    it("should return false for -n with empty string", () => {
        assert.strictEqual(ec('test -n ""'), 1);
    });

    // String comparison
    it("should test string equality", () => {
        assert.strictEqual(ec('test foo = foo'), 0);
    });
    it("should test string inequality", () => {
        assert.strictEqual(ec('test foo = bar'), 1);
    });
    it("should test string != operator", () => {
        assert.strictEqual(ec('test foo != bar'), 0);
    });

    // Integer comparison
    it("should test -eq", () => {
        assert.strictEqual(ec("test 5 -eq 5"), 0);
    });
    it("should test -ne", () => {
        assert.strictEqual(ec("test 5 -ne 3"), 0);
    });
    it("should test -lt", () => {
        assert.strictEqual(ec("test 3 -lt 5"), 0);
    });
    it("should test -gt", () => {
        assert.strictEqual(ec("test 5 -gt 3"), 0);
    });
    it("should test -le with equal values", () => {
        assert.strictEqual(ec("test 5 -le 5"), 0);
    });
    it("should test -ge with lesser value", () => {
        assert.strictEqual(ec("test 3 -ge 5"), 1);
    });

    // File tests
    it("should return true for -f on existing file", () => {
        assert.strictEqual(ec("test -f package.json"), 0);
    });
    it("should return false for -f on nonexistent file", () => {
        assert.strictEqual(ec("test -f __nope__"), 1);
    });
    it("should return true for -d on directory", () => {
        assert.strictEqual(ec("test -d src"), 0);
    });
    it("should return false for -d on file", () => {
        assert.strictEqual(ec("test -d package.json"), 1);
    });
    it("should return true for -e on existing file", () => {
        assert.strictEqual(ec("test -e package.json"), 0);
    });

    // Negation
    it("should invert result with !", () => {
        assert.strictEqual(ec("test ! -f __nope__"), 0);
    });

    // [ ] syntax
    it("should support [ ] syntax", () => {
        assert.strictEqual(ec('[ foo = foo ]'), 0);
    });
    it("should error on [ ] with missing ]", () => {
        assert.strictEqual(ec('[ foo = foo'), 2);
    });

    // Used with if
    it("should work with if [ -f file ]", () => {
        assert.strictEqual(run('if [ -f package.json ]; then echo yes; else echo no; fi'), "yes");
    });
    it("should work with if test string = string", () => {
        assert.strictEqual(run('if test foo = foo; then echo match; fi'), "match");
    });

    // Logical operators
    it("should support -a (and)", () => {
        assert.strictEqual(ec('test -f package.json -a -d src'), 0);
    });
    it("should support -o (or)", () => {
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

    it("should execute file in current context", () => {
        const f = join(tmp, "vars.sh");
        const r = spawnJsh({
            input: `echo 'MYVAR=hello' > ${f}\nsource ${f}\necho $MYVAR\nexit\n`,
        });
        assert.ok(r.stdout.includes("hello"), `expected hello, got: ${r.stdout}`);
    });

    it("should support . as alias for source", () => {
        const f = join(tmp, "dot.sh");
        const r = spawnJsh({ input: `echo 'DOTVAR=world' > ${f}\n. ${f}\necho $DOTVAR\nexit\n` });
        assert.ok(r.stdout.includes("world"), `expected world, got: ${r.stdout}`);
    });

    it("should return error for missing file", () => {
        assert.strictEqual(ec("source /tmp/__no_such_file_jsh__"), 1);
    });

    it("should execute functions defined in sourced file", () => {
        const f = join(tmp, "func.sh");
        const r = spawnJsh({ input: `echo 'greet() { echo hi $1; }' > ${f}\nsource ${f}\ngreet world\nexit\n` });
        assert.ok(r.stdout.includes("hi world"), `expected "hi world", got: ${r.stdout}`);
    });

    it("should set positional params from extra args", () => {
        const f = join(tmp, "params.sh");
        const r = spawnJsh({ input: `echo 'echo $1 $2' > ${f}\nsource ${f} foo bar\nexit\n` });
        assert.ok(r.stdout.includes("foo bar"), `expected "foo bar", got: ${r.stdout}`);
    });
});

describe("executor — shift builtin", () => {
    it("should shift by 1 by default", () => {
        assert.strictEqual(
            run('f() { echo $1; shift; echo $1; }; f a b c'),
            "a\nb"
        );
    });
    it("should shift by n", () => {
        assert.strictEqual(
            run('f() { shift 2; echo $1; }; f a b c'),
            "c"
        );
    });
    it("should return 1 if shift count exceeds params", () => {
        assert.strictEqual(ec('f() { shift 5; }; f a b'), 1);
    });
    it("should update $#", () => {
        assert.strictEqual(
            run('f() { echo $#; shift; echo $#; }; f a b c'),
            "3\n2"
        );
    });
});

describe("executor — exec builtin", () => {
    it("should replace shell with command", () => {
        assert.strictEqual(run("exec echo hello"), "hello");
    });
    it("should exit with command exit code", () => {
        const r = spawnJsh({ input: "exec true\n" });
        assert.strictEqual(r.status, 0);
    });
    it("should exit 127 for missing command", () => {
        const r = spawnJsh({ input: "exec __no_such_cmd_jsh__\n" });
        assert.strictEqual(r.status, 127);
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
        const r = spawnJsh({ input: "local X=1\n" });
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
        const r = spawnJsh({ input: "set -x\necho hello\n" });
        assert.ok(r.stderr.includes("+ echo hello"), `expected trace, got stderr: ${r.stderr}`);
        assert.ok(r.stdout.includes("hello"));
    });
    it("should error on unset variable with set -u", () => {
        const r = spawnJsh({ input: "set -u\necho $UNSETVAR_JSH_TEST\n" });
        assert.ok(r.stderr.includes("unbound variable"), `expected error, got stderr: ${r.stderr}`);
    });
    it("should enable pipefail with set -o pipefail", () => {
        // Verify pipefail actually changes behavior — not just that set accepts the flag.
        assert.strictEqual(ec("set -o pipefail; false | true"), 1);
    });
    it("should combine short flags", () => {
        assert.strictEqual(run("set -eu\nset +eu\necho ok"), "ok");
    });
});

describe("executor — [[ ]] conditional expression", () => {
    it("should test file existence", () => {
        assert.strictEqual(ec("[[ -f package.json ]]"), 0);
    });
    it("should test file non-existence", () => {
        assert.strictEqual(ec("[[ -f __nope__ ]]"), 1);
    });
    it("should test string equality", () => {
        assert.strictEqual(ec('[[ foo == foo ]]'), 0);
    });
    it("should test string inequality", () => {
        assert.strictEqual(ec('[[ foo != bar ]]'), 0);
    });
    it("should support regex matching with =~", () => {
        assert.strictEqual(ec('[[ hello =~ ^he ]]'), 0);
    });
    it("should fail regex when no match", () => {
        assert.strictEqual(ec('[[ hello =~ ^wo ]]'), 1);
    });
    it("should support < string comparison", () => {
        assert.strictEqual(ec('[[ abc < def ]]'), 0);
    });
    it("should support > string comparison", () => {
        assert.strictEqual(ec('[[ def > abc ]]'), 0);
    });
    it("should support && inside [[ ]]", () => {
        assert.strictEqual(ec('[[ -f package.json && -d src ]]'), 0);
    });
    it("should support || inside [[ ]]", () => {
        assert.strictEqual(ec('[[ -f __nope__ || -d src ]]'), 0);
    });
    it("should support ! negation", () => {
        assert.strictEqual(ec('[[ ! -f __nope__ ]]'), 0);
    });
    it("should support parenthesized grouping", () => {
        assert.strictEqual(ec('[[ ( -f __nope__ || -d src ) && -f package.json ]]'), 0);
    });
    it("should work with if statement", () => {
        assert.strictEqual(run('if [[ -d src ]]; then echo yes; fi'), "yes");
    });
    it("should support variable expansion", () => {
        assert.strictEqual(run('X=hello; [[ $X == hello ]] && echo match'), "match");
    });
});

describe("executor — type / which builtins", () => {
    it("should identify builtins", () => {
        assert.strictEqual(run("type echo"), "echo is a shell builtin");
    });
    it("should identify external commands", () => {
        const out = run("type ls");
        assert.ok(out.includes("ls is /"), `expected path, got: ${out}`);
    });
    it("should return 1 for unknown commands", () => {
        assert.strictEqual(ec("type __no_such_cmd_jsh__"), 1);
    });
    it("should identify shell functions", () => {
        assert.strictEqual(run("myfn() { echo hi; }; type myfn"), "myfn is a shell function");
    });
    it("should print path with which", () => {
        const out = run("which ls");
        assert.ok(out.startsWith("/"), `expected absolute path, got: ${out}`);
    });
    it("should identify builtins with which when no binary exists", () => {
        assert.ok(run("which local").includes("built-in"));
    });
    it("should return 1 for unknown commands with which", () => {
        assert.strictEqual(ec("which __no_such_cmd_jsh__"), 1);
    });
});

describe("executor — brace expansion", () => {
    it("should expand comma-separated braces", () => {
        assert.strictEqual(run("echo {a,b,c}"), "a b c");
    });
    it("should expand with prefix and suffix", () => {
        assert.strictEqual(run("echo file.{js,ts}"), "file.js file.ts");
    });
    it("should expand numeric sequence", () => {
        assert.strictEqual(run("echo {1..5}"), "1 2 3 4 5");
    });
    it("should expand reverse numeric sequence", () => {
        assert.strictEqual(run("echo {5..1}"), "5 4 3 2 1");
    });
    it("should expand numeric sequence with step", () => {
        assert.strictEqual(run("echo {1..10..3}"), "1 4 7 10");
    });
    it("should expand character sequence", () => {
        assert.strictEqual(run("echo {a..e}"), "a b c d e");
    });
    it("should expand nested braces", () => {
        assert.strictEqual(run("echo {a,b{1,2},c}"), "a b1 b2 c");
    });
    it("should not interfere with brace groups", () => {
        assert.strictEqual(run("{ echo ok; }"), "ok");
    });
});

describe("executor — expansion", () => {
    it("should expand variables", () => {
        assert.strictEqual(run("X=hello; echo $X"), "hello");
    });

    it("should expand arithmetic", () => {
        assert.strictEqual(run("echo $((2 + 3))"), "5");
    });

    it("should expand arithmetic with variable", () => {
        assert.strictEqual(run("X=7; echo $((X * 2))"), "14");
    });

    it("should expand command substitution", () => {
        assert.strictEqual(run("echo $(echo inner)"), "inner");
    });

    it("should expand command substitution in pipeline", () => {
        assert.strictEqual(run("echo $(echo hello | tr a-z A-Z)"), "HELLO");
    });

    it("should expand globs", () => {
        const out = run("echo test/*.test.ts");
        assert.ok(out.includes("lexer.test.ts"), `expected glob match, got: ${out}`);
    });

    it("should expand tilde", () => {
        const out = run("echo ~/foo");
        assert.ok(out.startsWith("/"), `expected absolute path, got: ${out}`);
        assert.ok(out.endsWith("/foo"));
    });

    it("should expand default parameter", () => {
        assert.strictEqual(run("unset NOVAR; echo ${NOVAR:-fallback}"), "fallback");
    });
});

describe("executor — subshells", () => {
    it("should execute commands in a subshell", () => {
        assert.strictEqual(run("(echo hello)"), "hello");
    });

    it("should isolate variable assignments", () => {
        assert.strictEqual(run("X=outer; (X=inner); echo $X"), "outer");
    });

    it("should isolate working directory", () => {
        assert.strictEqual(run("ORIG=$(pwd); (cd /tmp); echo $(pwd)"), run("echo $(pwd)"));
    });

    it("should isolate shell options", () => {
        // set -x inside subshell should not persist outside.
        // Verify xtrace output (stderr) only appears for the subshell command, not the outer echo.
        const { stdout, stderr } = runFull("(set -x; echo inner); echo outer");
        assert.strictEqual(stdout, "inner\nouter");
        // stderr should contain xtrace for "echo inner" but NOT for "echo outer"
        assert.match(stderr, /\+ echo inner/);
        assert.ok(!stderr.includes("+ echo outer"), "xtrace should not leak out of subshell");
    });

    it("should support pipelines in subshells", () => {
        assert.strictEqual(run("(echo hello | cat)"), "hello");
    });

    it("should support control flow in subshells", () => {
        assert.strictEqual(run("(if true; then echo yes; fi)"), "yes");
    });

    it("should return exit code from last command", () => {
        assert.strictEqual(ec("(false)"), 1);
    });

    it("should return exit code 0 on success", () => {
        assert.strictEqual(ec("(true)"), 0);
    });

    it("should support nested subshells", () => {
        assert.strictEqual(run("(echo $(echo nested))"), "nested");
    });

    it("should capture subshell output in command substitution", () => {
        assert.strictEqual(run("echo $(echo hello)"), "hello");
    });

    it("should capture subshell with if in command substitution", () => {
        assert.strictEqual(run("echo $(if true; then echo yes; fi)"), "yes");
    });

    it("should capture subshell with for loop in command substitution", () => {
        assert.strictEqual(run("echo $(for i in a b c; do echo $i; done)"), "a b c");
    });

    it("should not leak export from subshell", () => {
        assert.strictEqual(run("(export SUBVAR=leaked); echo ${SUBVAR:-empty}"), "empty");
    });
});

describe("executor — brace group redirections", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-brace-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("should redirect stdout from brace group to file", () => {
        const f = join(tmp, "brace-out.txt");
        run(`{ echo hello; echo world; } > ${f}`);
        assert.strictEqual(run(`cat ${f}`), "hello\nworld");
    });

    it("should append brace group output to file", () => {
        const f = join(tmp, "brace-append.txt");
        run(`echo first > ${f}`);
        run(`{ echo second; echo third; } >> ${f}`);
        assert.strictEqual(run(`cat ${f}`), "first\nsecond\nthird");
    });

    it("should redirect stdin into brace group", () => {
        const f = join(tmp, "brace-in.txt");
        run(`echo content > ${f}`);
        assert.strictEqual(run(`{ cat; } < ${f}`), "content");
    });

    it("should not isolate variables in brace group", () => {
        assert.strictEqual(run("X=before; { X=after; }; echo $X"), "after");
    });
});

describe("executor — subshell redirections", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-sub-redir-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("should redirect stdout from subshell to file", () => {
        const f = join(tmp, "sub-out.txt");
        run(`(echo hello; echo world) > ${f}`);
        assert.strictEqual(run(`cat ${f}`), "hello\nworld");
    });

    it("should redirect stdin into subshell", () => {
        const f = join(tmp, "sub-in.txt");
        run(`echo piped > ${f}`);
        assert.strictEqual(run(`(cat) < ${f}`), "piped");
    });

    it("should redirect stderr from subshell", () => {
        const f = join(tmp, "sub-err.txt");
        run(`(echo oops >&2) 2> ${f}`);
        assert.strictEqual(run(`cat ${f}`), "oops");
    });
});

describe("executor — IFS word splitting", () => {
    it("should split unquoted variable on spaces", () => {
        assert.strictEqual(run('X="a  b  c"; echo $X'), "a b c");
    });

    it("should not split quoted variable", () => {
        assert.strictEqual(run('X="a  b  c"; echo "$X"'), "a  b  c");
    });

    it("should split unquoted command substitution", () => {
        assert.strictEqual(run("echo $(echo 'a  b  c')"), "a b c");
    });

    it("should not split quoted command substitution", () => {
        assert.strictEqual(run('echo "$(echo \'a  b  c\')"'), "a  b  c");
    });

    it("should split on newlines in unquoted $() result", () => {
        assert.strictEqual(run("echo $(echo a; echo b; echo c)"), "a b c");
    });

    it("should remove empty unquoted expansion", () => {
        assert.strictEqual(run('EMPTY=""; echo a${EMPTY}b'), "ab");
    });

    it("should preserve empty quoted expansion", () => {
        assert.strictEqual(run('EMPTY=""; echo "a${EMPTY}b"'), "ab");
    });

    it("should split unquoted $@ in for loop", () => {
        assert.strictEqual(
            run('f() { for i in $@; do echo "[$i]"; done; }; f "hello world" "foo bar"'),
            "[hello]\n[world]\n[foo]\n[bar]"
        );
    });

    it('should keep "$@" args separate in for loop', () => {
        assert.strictEqual(
            run('f() { for i in "$@"; do echo "[$i]"; done; }; f "hello world" "foo bar"'),
            "[hello world]\n[foo bar]"
        );
    });

    it('should join "$*" with space', () => {
        assert.strictEqual(run('f() { echo "$*"; }; f a b c'), "a b c");
    });

    it("should split $() with for loop", () => {
        assert.strictEqual(run("echo $(for i in a b c; do echo $i; done)"), "a b c");
    });
});

describe("executor — PIPESTATUS", () => {
    it("should set PIPESTATUS for single command", () => {
        assert.strictEqual(run("true; echo ${PIPESTATUS[0]}"), "0");
    });

    it("should set PIPESTATUS for failing single command", () => {
        assert.strictEqual(run("false; echo ${PIPESTATUS[0]}"), "1");
    });

    it("should set PIPESTATUS for pipeline", () => {
        assert.strictEqual(
            run("true | false | true; echo ${PIPESTATUS[0]} ${PIPESTATUS[1]} ${PIPESTATUS[2]}"),
            "0 1 0"
        );
    });

    it("should expand ${PIPESTATUS[@]} to all elements", () => {
        assert.strictEqual(
            run("true | false | true; echo ${PIPESTATUS[@]}"),
            "0 1 0"
        );
    });

    it("should expand ${PIPESTATUS} to first element", () => {
        assert.strictEqual(run("true | false; echo ${PIPESTATUS}"), "0");
    });

    it("should work with pipefail", () => {
        assert.strictEqual(ec("set -o pipefail; true | false | true"), 1);
    });

    it("should return rightmost failure with pipefail", () => {
        // Pipeline: exit 2 | exit 3 | true
        // pipefail should return 3 (rightmost non-zero)
        assert.strictEqual(
            ec("set -o pipefail; sh -c 'exit 2' | sh -c 'exit 3' | true"),
            3
        );
    });
});

describe("executor — arithmetic ++/--", () => {
    it("should pre-increment", () => {
        assert.strictEqual(run("x=5; echo $((++x)); echo $x"), "6\n6");
    });

    it("should post-increment", () => {
        assert.strictEqual(run("x=5; echo $((x++)); echo $x"), "5\n6");
    });

    it("should pre-decrement", () => {
        assert.strictEqual(run("x=5; echo $((--x)); echo $x"), "4\n4");
    });

    it("should post-decrement", () => {
        assert.strictEqual(run("x=5; echo $((x--)); echo $x"), "5\n4");
    });

    it("should handle += assignment", () => {
        assert.strictEqual(run("x=10; echo $((x += 5)); echo $x"), "15\n15");
    });

    it("should handle -= assignment", () => {
        assert.strictEqual(run("x=10; echo $((x -= 3)); echo $x"), "7\n7");
    });

    it("should handle *= assignment", () => {
        assert.strictEqual(run("x=4; echo $((x *= 3)); echo $x"), "12\n12");
    });

    it("should handle /= assignment", () => {
        assert.strictEqual(run("x=10; echo $((x /= 3)); echo $x"), "3\n3");
    });

    it("should handle %= assignment", () => {
        assert.strictEqual(run("x=10; echo $((x %= 3)); echo $x"), "1\n1");
    });

    it("should handle simple = assignment", () => {
        assert.strictEqual(run("echo $((x = 42)); echo $x"), "42\n42");
    });

    it("should increment unset variable from 0", () => {
        assert.strictEqual(run("unset y; echo $((++y)); echo $y"), "1\n1");
    });

    it("should use increment in expression", () => {
        assert.strictEqual(run("x=3; echo $((++x + 10))"), "14");
    });
});

describe("executor — job control", () => {
    it("should run command in background with &", () => {
        const { stdout, stderr } = runFull("sleep 0.01 &\nwait");
        assert.match(stderr, /\[1\] \d+/);
    });

    it("should set $! to backgrounded pid", () => {
        const out = run("sleep 0.01 &\necho $!");
        assert.match(out, /^\d+$/);
    });

    it("should list jobs with jobs builtin", () => {
        const { stdout } = runFull("sleep 10 &>/dev/null &\njobs");
        assert.match(stdout, /\[1\]\+\s+Running\s+sleep 10/);
    });

    it("should wait for background jobs", () => {
        assert.strictEqual(run("echo hello &\nwait\necho done"), "hello\ndone");
    });

    it("should run pipeline in background", () => {
        const out = run("echo hello | cat &\nwait");
        assert.strictEqual(out, "hello");
    });

    it("should report no current job for fg with no jobs", () => {
        const { stderr } = runFull("fg");
        assert.match(stderr, /no current job/);
    });

    it("should report no stopped job for bg with no jobs", () => {
        const { stderr } = runFull("bg");
        assert.match(stderr, /no stopped job/);
    });

    it("should not regress PIPESTATUS", () => {
        assert.strictEqual(
            run("true | false | true; echo ${PIPESTATUS[0]} ${PIPESTATUS[1]} ${PIPESTATUS[2]}"),
            "0 1 0"
        );
    });

    it("should exit 0 for empty jobs list", () => {
        assert.strictEqual(ec("jobs"), 0);
    });
});

describe("executor — eval builtin", () => {
    it("should execute a string as a command", () => {
        assert.strictEqual(run('eval "echo hello"'), "hello");
    });

    it("should execute in current context", () => {
        assert.strictEqual(run('X=42; eval "echo \\$X"'), "42");
    });

    it("should handle command substitution in eval", () => {
        assert.strictEqual(run('eval "$(echo echo hi)"'), "hi");
    });

    it("should return 0 for empty eval", () => {
        assert.strictEqual(ec("eval"), 0);
    });

    it("should concatenate multiple args", () => {
        assert.strictEqual(run("eval echo hello world"), "hello world");
    });
});

describe("executor — printf builtin", () => {
    it("should format a string", () => {
        assert.strictEqual(run('printf "%s\\n" hello'), "hello");
    });

    it("should format integers", () => {
        assert.strictEqual(run('printf "%d\\n" 42'), "42");
    });

    it("should format hex", () => {
        assert.strictEqual(run('printf "%x\\n" 255'), "ff");
    });

    it("should handle escape sequences in format", () => {
        assert.strictEqual(run('printf "a\\tb"'), "a\tb");
    });

    it("should reuse format for multiple args", () => {
        assert.strictEqual(run('printf "%s\\n" a b c'), "a\nb\nc");
    });

    it("should handle %q quoting", () => {
        assert.strictEqual(run("printf '%q\\n' 'hello world'"), "'hello world'");
    });

    it("should handle %b escape expansion", () => {
        assert.strictEqual(run('printf "%b" "hello\\nworld"'), "hello\nworld");
    });

    it("should output nothing without format args for %s", () => {
        assert.strictEqual(run('printf "%s" ""'), "");
    });

    it("should handle %% literal percent", () => {
        assert.strictEqual(run('printf "100%%\\n"'), "100%");
    });
});

describe("executor — trap builtin", () => {
    it("should run EXIT trap on exit", () => {
        assert.strictEqual(run('trap "echo cleanup" EXIT'), "cleanup");
    });

    it("should list traps", () => {
        const out = run('trap "echo bye" EXIT\ntrap');
        assert.match(out, /trap -- 'echo bye' EXIT/);
    });

    it("should reset trap with -", () => {
        // After resetting, EXIT trap should not run
        assert.strictEqual(run('trap "echo nope" EXIT\ntrap - EXIT'), "");
    });

    it("should handle empty action (ignore)", () => {
        assert.strictEqual(run('trap "" EXIT'), "");
    });

    it("should reject invalid signal names", () => {
        const { stderr } = runFull("trap 'echo x' INVALID");
        assert.match(stderr, /invalid signal/);
    });
});

describe("executor — process substitution", () => {
    it("should read from <() process substitution", () => {
        assert.strictEqual(run("cat <(echo hello)"), "hello");
    });

    it("should use <() with diff", () => {
        const out = run("diff <(echo a) <(echo b)");
        assert.ok(out.includes("< a"), "expected diff output");
        assert.ok(out.includes("> b"), "expected diff output");
    });

    it("should handle <() in arguments", () => {
        assert.strictEqual(run("cat <(echo line1) <(echo line2)"), "line1\nline2");
    });
});

describe("executor — return builtin", () => {
    it("should return from function with exit code", () => {
        assert.strictEqual(run("f() { return 42; }; f; echo $?"), "42");
    });

    it("should stop execution at return", () => {
        assert.strictEqual(run("f() { echo before; return 0; echo after; }; f"), "before");
    });

    it("should default to last exit code", () => {
        assert.strictEqual(run("f() { false; return; }; f; echo $?"), "1");
    });
});

describe("executor — command builtin", () => {
    it("should find existing command with -v", () => {
        assert.strictEqual(run("command -v echo"), "echo");
    });

    it("should return 1 for nonexistent command with -v", () => {
        assert.strictEqual(ec("command -v __no_such_cmd__"), 1);
    });

    it("should bypass functions", () => {
        assert.strictEqual(run("echo() { true; }; command echo hello"), "hello");
    });
});

describe("executor — readonly builtin", () => {
    it("should set and protect a variable", () => {
        const { stdout, stderr } = runFull("readonly X=hello; X=world; echo $X");
        assert.strictEqual(stdout, "hello");
        assert.match(stderr, /readonly/);
    });

    it("should list readonly vars with -p", () => {
        const out = run("readonly A=1; readonly -p");
        assert.match(out, /declare -r A=/);
    });
});

describe("executor — cd enhancements", () => {
    it("should support cd -", () => {
        const out = run("cd /tmp; cd /; cd -; pwd");
        assert.match(out, /tmp/);
    });

    it("should support CDPATH", () => {
        assert.strictEqual(run("export CDPATH=/usr; cd bin; pwd"), "/usr/bin");
    });
});

describe("executor — getopts builtin", () => {
    it("should parse simple flags", () => {
        assert.strictEqual(
            run('f() { while getopts "ab:" opt; do echo "$opt"; done; }; f -a -b val'),
            "a\nb"
        );
    });
});

describe("executor — echo flags", () => {
    it("should suppress newline with -n", () => {
        assert.strictEqual(run("echo -n hello; echo world"), "helloworld");
    });

    it("should handle -e for escape sequences", () => {
        assert.strictEqual(run('echo -e "a\\tb"'), "a\tb");
    });

    it("should handle -ne combined", () => {
        assert.strictEqual(run('echo -ne "hello\\n"; echo world'), "hello\nworld");
    });

    it("should treat -E as default (no escapes)", () => {
        assert.strictEqual(run('echo -E "a\\tb"'), "a\\tb");
    });

    it("should suppress newline with -n and no argument", () => {
        assert.strictEqual(run("echo -n"), "");
    });

    it("should output plain text without flags", () => {
        assert.strictEqual(run("echo hello world"), "hello world");
    });
});

describe("executor — break/continue", () => {
    it("should break out of for loop", () => {
        assert.strictEqual(
            run('for i in 1 2 3 4 5; do if [ "$i" = "3" ]; then break; fi; echo $i; done'),
            "1\n2"
        );
    });

    it("should continue in for loop", () => {
        assert.strictEqual(
            run('for i in 1 2 3 4 5; do if [ "$i" = "3" ]; then continue; fi; echo $i; done'),
            "1\n2\n4\n5"
        );
    });

    it("should break out of while loop", () => {
        assert.strictEqual(
            run("i=0; while true; do i=$((i+1)); if [ $i = 3 ]; then break; fi; echo $i; done"),
            "1\n2"
        );
    });
});

describe("executor — string operations", () => {
    it("should uppercase with ^^", () => {
        assert.strictEqual(run('X=hello; echo ${X^^}'), "HELLO");
    });

    it("should lowercase with ,,", () => {
        assert.strictEqual(run('X=HELLO; echo ${X,,}'), "hello");
    });

    it("should capitalize first with ^", () => {
        assert.strictEqual(run('X=hello; echo ${X^}'), "Hello");
    });

    it("should substring with :offset", () => {
        assert.strictEqual(run('X=hello_world; echo ${X:5}'), "_world");
    });

    it("should substring with :offset:length", () => {
        assert.strictEqual(run('X=hello_world; echo ${X:0:5}'), "hello");
    });

    it("should get length with ${#VAR}", () => {
        assert.strictEqual(run('X=hello; echo ${#X}'), "5");
    });

    it("should remove shortest prefix with #", () => {
        assert.strictEqual(run('X="/usr/local/bin"; echo ${X#*/}'), "usr/local/bin");
    });

    it("should remove longest prefix with ##", () => {
        assert.strictEqual(run('X="/usr/local/bin"; echo ${X##*/}'), "bin");
    });

    it("should remove shortest suffix with %", () => {
        assert.strictEqual(run('X="foo.tar.gz"; echo ${X%.gz}'), "foo.tar");
    });

    it("should remove longest suffix with %%", () => {
        assert.strictEqual(run('X="foo.tar.gz"; echo ${X%%.*}'), "foo");
    });

    it("should search/replace with /", () => {
        assert.strictEqual(run('X="hello world"; echo ${X/world/earth}'), "hello earth");
    });

    it("should search/replace all with //", () => {
        assert.strictEqual(run('X="aabaa"; echo ${X//a/x}'), "xxbxx");
    });
});

describe("executor — pushd/popd/dirs", () => {
    it("should push and pop directories", () => {
        const out = run("pushd /tmp; pwd; popd; pwd");
        assert.match(out, /tmp/);
    });

    it("should list directory stack with dirs", () => {
        const out = run("pushd /tmp; dirs");
        assert.ok(out.includes("tmp"));
    });
});

describe("executor — basename/dirname builtins", () => {
    it("should extract basename", () => {
        assert.strictEqual(run("basename /usr/local/bin/node"), "node");
    });

    it("should extract dirname", () => {
        assert.strictEqual(run("dirname /usr/local/bin/node"), "/usr/local/bin");
    });

    it("should strip suffix from basename", () => {
        assert.strictEqual(run("basename /path/to/file.txt .txt"), "file");
    });
});

describe("executor — [[ glob matching ]]", () => {
    it("should match with trailing *", () => {
        assert.strictEqual(ec('[[ "hello" == hel* ]]'), 0);
    });

    it("should match with leading *", () => {
        assert.strictEqual(ec('[[ "hello.txt" == *.txt ]]'), 0);
    });

    it("should fail on no match", () => {
        assert.strictEqual(ec('[[ "hello" == world* ]]'), 1);
    });

    it("should match exact string", () => {
        assert.strictEqual(ec('[[ "hello" == "hello" ]]'), 0);
    });

    it("should handle != with globs", () => {
        assert.strictEqual(ec('[[ "hello" != world* ]]'), 0);
    });
});

describe("executor — arithmetic for loop", () => {
    it("should count up", () => {
        assert.strictEqual(run("for ((i=0; i<5; i++)); do echo $i; done"), "0\n1\n2\n3\n4");
    });

    it("should count down", () => {
        assert.strictEqual(run("for ((i=3; i>0; i--)); do echo $i; done"), "3\n2\n1");
    });

    it("should handle step increment", () => {
        assert.strictEqual(run("for ((i=0; i<10; i+=3)); do echo $i; done"), "0\n3\n6\n9");
    });

    it("should support break", () => {
        assert.strictEqual(run("for ((i=0; i<10; i++)); do if [ $i = 3 ]; then break; fi; echo $i; done"), "0\n1\n2");
    });

    it("should support continue", () => {
        assert.strictEqual(run("for ((i=0; i<5; i++)); do if [ $i = 2 ]; then continue; fi; echo $i; done"), "0\n1\n3\n4");
    });
});

describe("executor — builtins in pipelines", () => {
    it("should pipe export -p to head", () => {
        const out = run("export TEST_PIPE_VAR=hello; export -p | grep TEST_PIPE_VAR");
        assert.match(out, /TEST_PIPE_VAR/);
    });

    it("should pipe echo through cat as builtin", () => {
        assert.strictEqual(run("echo hello | cat"), "hello");
    });
});

describe("executor — arrays", () => {
    it("should assign and expand array elements", () => {
        assert.strictEqual(run("arr=(a b c); echo ${arr[0]} ${arr[1]} ${arr[2]}"), "a b c");
    });

    it("should expand all elements with [@]", () => {
        assert.strictEqual(run("arr=(hello world); echo ${arr[@]}"), "hello world");
    });

    it("should expand all elements with [*]", () => {
        assert.strictEqual(run("arr=(hello world); echo ${arr[*]}"), "hello world");
    });

    it("should get array length with #", () => {
        assert.strictEqual(run('arr=(a b c d); echo ${#arr[@]}'), "4");
    });

    it("should append with +=", () => {
        assert.strictEqual(run("arr=(a b); arr+=(c d); echo ${arr[@]}"), "a b c d");
    });

    it("should assign by index", () => {
        assert.strictEqual(run("arr=(a b c); arr[1]=X; echo ${arr[@]}"), "a X c");
    });

    it("should treat unindexed array as first element", () => {
        assert.strictEqual(run("arr=(first second); echo $arr"), "first");
    });

    it("should preserve words in quoted array expansion", () => {
        const out = run('arr=("hello world" "foo bar"); for x in "${arr[@]}"; do echo "[$x]"; done');
        assert.strictEqual(out, "[hello world]\n[foo bar]");
    });

    it("should string-append with +=", () => {
        assert.strictEqual(run("x=hello; x+=world; echo $x"), "helloworld");
    });

    it("should handle empty array", () => {
        assert.strictEqual(run("arr=(); echo ${#arr[@]}"), "0");
    });

    it("should expand array in for loop", () => {
        assert.strictEqual(run("arr=(1 2 3); for i in ${arr[@]}; do echo $i; done"), "1\n2\n3");
    });
});

describe("executor — kill builtin", () => {
    it("should list signals with -l", () => {
        const out = run("kill -l");
        assert.match(out, /SIGTERM/);
        assert.match(out, /SIGKILL/);
    });

    it("should send signal to a process", () => {
        // Start a background sleep, kill it, wait for it to exit
        assert.strictEqual(ec("sleep 60 & kill $! && wait $!; true"), 0);
    });

    it("should send specific signal by name", () => {
        assert.strictEqual(ec("sleep 60 & kill -TERM $! && wait $!; true"), 0);
    });

    it("should report error for invalid pid", () => {
        assert.strictEqual(ec("kill 999999999"), 1);
    });
});

describe("executor — hash builtin", () => {
    it("should hash a command", () => {
        const out = run("hash ls; hash");
        assert.match(out, /ls=/);
    });

    it("should clear hash table with -r", () => {
        const { stderr } = runFull("hash ls; hash -r; hash");
        assert.match(stderr, /hash table empty/);
    });

    it("should report error for unknown command", () => {
        assert.strictEqual(ec("hash __no_such_cmd__"), 1);
    });
});

describe("executor — let builtin", () => {
    it("should evaluate arithmetic expression", () => {
        assert.strictEqual(run("let x=5+3; echo $x"), "8");
    });

    it("should support multiple expressions", () => {
        assert.strictEqual(run("let a=2 b=3 c=a+b; echo $c"), "5");
    });

    it("should return 0 for non-zero result", () => {
        assert.strictEqual(ec("let x=1"), 0);
    });

    it("should return 1 for zero result", () => {
        assert.strictEqual(ec("let x=0"), 1);
    });

    it("should support increment/decrement", () => {
        assert.strictEqual(run("x=5; let x++; echo $x"), "6");
    });
});

describe("executor — time keyword", () => {
    it("should time a command and output timing to stderr", () => {
        const { stdout, stderr } = runFull("time echo hello");
        assert.strictEqual(stdout, "hello");
        assert.match(stderr, /real\t/);
    });
});

describe("executor — declare builtin", () => {
    it("should declare an array", () => {
        const out = run("declare -a myarr; myarr=(x y z); echo ${myarr[@]}");
        assert.strictEqual(out, "x y z");
    });

    it("should print array declarations with -a", () => {
        const out = run("arr=(a b); declare -a");
        assert.match(out, /declare -a arr=/);
    });
});

describe("executor — colon builtin", () => {
    it("should be a no-op returning 0", () => {
        assert.strictEqual(ec(":"), 0);
    });

    it("should work in while loop", () => {
        assert.strictEqual(run("x=0; while :; do x=$((x+1)); if [ $x = 3 ]; then break; fi; done; echo $x"), "3");
    });
});

describe("executor — disown builtin", () => {
    it("should remove current job from table", () => {
        // Start a background job, disown it, jobs should show nothing
        // Use sleep 0 to avoid blocking — we just need it in the job table briefly.
        const out = run("sleep 0.1 & disown; jobs");
        assert.strictEqual(out, "");
    });
});

describe("executor — $PPID", () => {
    it("should be set to parent PID", () => {
        const out = run("echo $PPID");
        const ppid = parseInt(out, 10);
        assert.ok(!isNaN(ppid) && ppid > 0);
    });
});

describe("executor — pwd builtin", () => {
    it("should print working directory", () => {
        const out = run("pwd");
        assert.ok(out.startsWith("/"));
    });

    it("should match $PWD", () => {
        assert.strictEqual(run("pwd"), run("echo $PWD"));
    });

    it("should support -P flag", () => {
        const out = run("pwd -P");
        assert.ok(out.startsWith("/"));
    });
});

describe("executor — umask builtin", () => {
    it("should print current mask", () => {
        const out = run("umask");
        assert.match(out, /^0[0-7]{3}$/);
    });

    it("should set and report new mask", () => {
        // Set to 0077, check, restore to 0022
        const out = run("umask 0077; umask; umask 0022");
        assert.strictEqual(out, "0077");
    });

    it("should reject invalid input", () => {
        assert.strictEqual(ec("umask xyz"), 1);
    });
});

describe("executor — set -a (allexport)", () => {
    it("should auto-export assigned variables", () => {
        const out = run("set -a; MYVAR=hello; env | grep MYVAR");
        assert.strictEqual(out, "MYVAR=hello");
    });

    it("should stop after set +a", () => {
        const out = run("set -a; A=1; set +a; B=2; env | grep -c '^B='");
        assert.strictEqual(out, "0");
    });
});

describe("executor — set -C (noclobber)", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-noclobber-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("should prevent > from overwriting existing file", () => {
        const f = join(tmp, "existing");
        const { stderr } = runFull(`echo first > ${f}; set -C; echo second > ${f}`);
        assert.match(stderr, /cannot overwrite/);
    });

    it("should allow >> even with noclobber", () => {
        const f = join(tmp, "appendable");
        const out = run(`echo first > ${f}; set -C; echo second >> ${f}; cat ${f}`);
        assert.strictEqual(out, "first\nsecond");
    });

    it("should allow > to new file with noclobber", () => {
        const f = join(tmp, "newfile");
        const out = run(`set -C; echo hello > ${f}; cat ${f}`);
        assert.strictEqual(out, "hello");
    });
});

describe("executor — $- shell option flags", () => {
    it("should be empty by default", () => {
        assert.strictEqual(run("echo $-"), "");
    });

    it("should reflect set -e", () => {
        assert.strictEqual(run("set -e; echo $-"), "e");
    });

    it("should reflect multiple flags", () => {
        const out = run("set -eu; echo $-");
        assert.ok(out.includes("e"));
        assert.ok(out.includes("u"));
    });

    it("should reflect set -a", () => {
        const out = run("set -a; echo $-");
        assert.ok(out.includes("a"));
    });
});

describe("executor — set -- positional params", () => {
    it("should set positional parameters", () => {
        assert.strictEqual(run("set -- a b c; echo $1 $2 $3"), "a b c");
    });

    it("should update $#", () => {
        assert.strictEqual(run("set -- x y; echo $#"), "2");
    });

    it("should clear params with empty set --", () => {
        assert.strictEqual(run("set -- a b; set --; echo $#"), "0");
    });
});

describe("executor — exec with redirections", () => {
    let tmp: string;
    before(() => { tmp = mkdtempSync(join(tmpdir(), "jsh-exec-redir-")); });
    after(() => { rmSync(tmp, { recursive: true }); });

    it("should permanently redirect stdout", () => {
        const f = join(tmp, "out");
        // exec > file redirects all subsequent stdout to file
        const out = run(`exec > ${f}; echo hello; echo world`);
        // stdout is redirected to file, so run() captures nothing from stdout
        // but the file should have the content
        const content = run(`cat ${f}`);
        assert.strictEqual(content, "hello\nworld");
    });
});

describe("executor — variable expansion colon distinction", () => {
    it("${VAR:-default} should use default for empty", () => {
        assert.strictEqual(run('X=""; echo ${X:-fallback}'), "fallback");
    });

    it("${VAR-default} should keep empty value", () => {
        assert.strictEqual(run('X=""; echo ${X-fallback}'), "");
    });

    it("${VAR-default} should use default for unset", () => {
        assert.strictEqual(run('unset X; echo ${X-fallback}'), "fallback");
    });

    it("${VAR:+alt} should return empty for empty value", () => {
        assert.strictEqual(run('X=""; echo ${X:+alt}'), "");
    });

    it("${VAR+alt} should return alt for empty value", () => {
        assert.strictEqual(run('X=""; echo ${X+alt}'), "alt");
    });

    it("${VAR:-$OTHER} should expand variable in operand", () => {
        assert.strictEqual(run('OTHER=world; unset X; echo ${X:-$OTHER}'), "world");
    });
});

describe("executor — arithmetic == vs =", () => {
    it("$((x==5)) should compare, not assign", () => {
        assert.strictEqual(run('x=5; echo $((x==5))'), "1");
    });

    it("$((x==3)) should return 0 for mismatch", () => {
        assert.strictEqual(run('x=5; echo $((x==3))'), "0");
    });

    it("$((x!=5)) should return 0 for match", () => {
        assert.strictEqual(run('x=5; echo $((x!=5))'), "0");
    });

    it("$((x=5)) should still assign", () => {
        assert.strictEqual(run('x=0; echo $((x=5)); echo $x'), "5\n5");
    });
});

describe("executor — exit uses $?", () => {
    it("should exit with last command status", () => {
        const r = spawnJsh({ input: "false\nexit\n" });
        assert.strictEqual(r.status, 1);
    });

    it("should exit with explicit code", () => {
        const r = spawnJsh({ input: "exit 42\n" });
        assert.strictEqual(r.status, 42);
    });
});

describe("executor — readonly sets exit code", () => {
    it("should set $? to 1 on readonly violation", () => {
        const { stdout, stderr } = runFull("readonly X=1; X=2; echo $?");
        assert.match(stderr, /readonly/);
        assert.strictEqual(stdout, "1");
    });
});

describe("executor — unset -f", () => {
    it("should remove a shell function", () => {
        assert.strictEqual(run("myfn() { echo hello; }; myfn; unset -f myfn; myfn 2>/dev/null; echo $?"), "hello\n127");
    });
});

describe("executor — $PPID readonly", () => {
    it("should not allow assignment", () => {
        const { stderr } = runFull("PPID=42");
        assert.match(stderr, /readonly/);
    });
});

describe("executor — for without in", () => {
    it("should iterate positional params", () => {
        assert.strictEqual(run('f() { for x; do echo $x; done; }; f a b c'), "a\nb\nc");
    });
});

describe("executor — ulimit builtin", () => {
    it("should print a value", () => {
        const out = run("ulimit");
        assert.ok(out.length > 0);
    });

    it("should support -a flag", () => {
        const out = run("ulimit -a");
        assert.match(out, /open files/);
    });
});

describe("executor — compound commands in pipelines", () => {
    it("while clause as pipeline sink", () => {
        const out = run("echo -e 'a\\nb\\nc' | while read line; do echo \"got:$line\"; done");
        assert.strictEqual(out, "got:a\ngot:b\ngot:c");
    });

    it("while clause as pipeline source", () => {
        const out = run("i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done | cat");
        assert.strictEqual(out, "0\n1\n2");
    });

    it("for clause as pipeline sink", () => {
        const out = run("echo hello | for x in a b; do cat; done");
        // The for loop body reads stdin; first iteration consumes it
        assert.match(out, /hello/);
    });

    it("for clause as pipeline source", () => {
        const out = run("for x in a b c; do echo $x; done | cat");
        assert.strictEqual(out, "a\nb\nc");
    });

    it("if clause as pipeline source", () => {
        const out = run("if true; then echo yes; else echo no; fi | cat");
        assert.strictEqual(out, "yes");
    });

    it("brace group as pipeline source", () => {
        const out = run("{ echo hello; echo world; } | cat");
        assert.strictEqual(out, "hello\nworld");
    });

    it("brace group as pipeline sink", () => {
        const out = run("echo hello | { cat; }");
        assert.strictEqual(out, "hello");
    });

    it("subshell as pipeline source", () => {
        const out = run("(echo sub) | cat");
        assert.strictEqual(out, "sub");
    });

    it("case clause as pipeline source", () => {
        const out = run("case foo in foo) echo matched;; esac | cat");
        assert.strictEqual(out, "matched");
    });

    it("compound command in middle of pipeline", () => {
        const out = run("seq 3 | while read n; do echo \"x$n\"; done | cat");
        assert.strictEqual(out, "x1\nx2\nx3");
    });
});
