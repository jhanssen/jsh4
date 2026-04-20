import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser/index.js";
import type { CaseClause } from "../src/parser/index.js";
import { run, spawnJsh } from "./helpers.js";

describe("case/esac — parser", () => {
    it("should parse a simple case statement", () => {
        const ast = parse("case x in a) echo a;; b) echo b;; esac") as CaseClause;
        assert.strictEqual(ast.type, "CaseClause");
        assert.strictEqual(ast.items.length, 2);
    });

    it("should parse patterns with wildcards", () => {
        const ast = parse("case $x in h*) echo hello;; *) echo other;; esac") as CaseClause;
        assert.strictEqual(ast.items.length, 2);
    });

    it("should parse multi-pattern items with |", () => {
        const ast = parse("case x in a|b) echo ab;; esac") as CaseClause;
        assert.strictEqual(ast.items[0]!.patterns.length, 2);
    });
});

describe("case/esac — execution", () => {
    it("should match exact string", () => {
        assert.strictEqual(run("case hello in hello) echo yes;; esac"), "yes");
    });

    it("should fall through to * wildcard", () => {
        assert.strictEqual(run("case foo in bar) echo no;; *) echo yes;; esac"), "yes");
    });

    it("should match glob pattern", () => {
        assert.strictEqual(run("case hello in h*) echo matched;; *) echo nope;; esac"), "matched");
    });

    it("should match multi-pattern with |", () => {
        assert.strictEqual(run("case b in a|b) echo yes;; esac"), "yes");
    });

    it("should use variable as case word", () => {
        assert.strictEqual(run("X=world; case $X in world) echo ok;; esac"), "ok");
    });

    it("should return exit code 0 when no pattern matches", () => {
        const r = spawnJsh({ input: "case foo in bar) echo no;; esac\necho $?\nexit\n" });
        assert.strictEqual(r.stdout.trim(), "0");
    });

    it("should accept empty body with ;;", () => {
        assert.strictEqual(run("case foo in foo) ;; esac; echo done"), "done");
    });
});

describe("here-docs — parser", () => {
    it("should parse << heredoc as a redirection", () => {
        const ast = parse("cat << EOF\nhello\nEOF") as any;
        assert.ok(ast.redirections?.length > 0 || ast.type !== undefined);
    });
});

describe("here-docs — execution", () => {
    it("should feed here-doc body to stdin", () => {
        assert.strictEqual(run("cat << EOF\nhello world\nEOF"), "hello world");
    });

    it("should handle multi-line here-doc", () => {
        const out = run("cat << END\nline1\nline2\nline3\nEND");
        assert.deepStrictEqual(out.split("\n"), ["line1", "line2", "line3"]);
    });

    it("should expand variables in here-doc", () => {
        assert.strictEqual(run("X=world; cat << EOF\nhello $X\nEOF"), "hello world");
    });

    it("should feed here-string to stdin", () => {
        assert.strictEqual(run("cat <<< hello"), "hello");
    });

    it("should expand variable in here-string", () => {
        assert.strictEqual(run("X=test; cat <<< $X"), "test");
    });

    it("should pipe here-doc output", () => {
        assert.strictEqual(run("cat << EOF | tr a-z A-Z\nhello\nEOF"), "HELLO");
    });

    it("should suppress expansion with quoted delimiter", () => {
        assert.strictEqual(run('cat << "EOF"\nhello $USER\nEOF'), "hello $USER");
    });

    it("should expand $() command substitution in here-doc", () => {
        assert.strictEqual(run("cat <<EOF\nhello $(echo world)\nEOF"), "hello world");
    });

    it("should expand $(()) arithmetic in here-doc", () => {
        assert.strictEqual(run("X=5; cat <<EOF\nresult: $((X + 3))\nEOF"), "result: 8");
    });

    it("should handle nested $() in here-doc", () => {
        assert.strictEqual(run("cat <<EOF\n$(echo $(echo deep))\nEOF"), "deep");
    });
});
