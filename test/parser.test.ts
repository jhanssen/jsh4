import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse, ParseError, LexerError } from "../src/parser/index.js";
import type { SimpleCommand, Pipeline, AndOr, List, Subshell, BraceGroup } from "../src/parser/index.js";

function wordText(word: { segments: { type: string; value?: string }[] }): string {
    return word.segments.map(s => {
        if (s.type === "Literal" || s.type === "SingleQuoted") return s.value ?? "";
        if (s.type === "DoubleQuoted") return (s as any).segments.map((ds: any) => ds.value ?? "").join("");
        return "";
    }).join("");
}

function simpleWords(node: SimpleCommand): string[] {
    return node.words.map(w => wordText(w));
}

describe("parser", () => {
    it("should export a parse function", () => {
        assert.strictEqual(typeof parse, "function");
    });

    describe("simple commands", () => {
        it("should parse a single command", () => {
            const result = parse("ls") as SimpleCommand;
            assert.strictEqual(result.type, "SimpleCommand");
            assert.deepStrictEqual(simpleWords(result), ["ls"]);
        });

        it("should parse command with arguments", () => {
            const result = parse("echo hello world") as SimpleCommand;
            assert.strictEqual(result.type, "SimpleCommand");
            assert.deepStrictEqual(simpleWords(result), ["echo", "hello", "world"]);
        });

        it("should parse command with flags", () => {
            const result = parse("ls -la /tmp") as SimpleCommand;
            assert.deepStrictEqual(simpleWords(result), ["ls", "-la", "/tmp"]);
        });

        it("should return null for empty input", () => {
            assert.strictEqual(parse(""), null);
        });

        it("should return null for whitespace-only input", () => {
            assert.strictEqual(parse("   \t  "), null);
        });
    });

    describe("assignments", () => {
        it("should parse bare assignment", () => {
            const result = parse("FOO=bar") as SimpleCommand;
            assert.strictEqual(result.type, "SimpleCommand");
            assert.strictEqual(result.assignments.length, 1);
            assert.strictEqual(result.assignments[0]!.name, "FOO");
            assert.strictEqual(result.words.length, 0);
        });

        it("should parse assignment with command", () => {
            const result = parse("FOO=bar cmd") as SimpleCommand;
            assert.strictEqual(result.assignments.length, 1);
            assert.strictEqual(result.assignments[0]!.name, "FOO");
            assert.deepStrictEqual(simpleWords(result), ["cmd"]);
        });

        it("should parse multiple assignments", () => {
            const result = parse("A=1 B=2 cmd") as SimpleCommand;
            assert.strictEqual(result.assignments.length, 2);
            assert.strictEqual(result.assignments[0]!.name, "A");
            assert.strictEqual(result.assignments[1]!.name, "B");
        });
    });

    describe("pipelines", () => {
        it("should parse two-command pipeline", () => {
            const result = parse("a | b") as Pipeline;
            assert.strictEqual(result.type, "Pipeline");
            assert.strictEqual(result.commands.length, 2);
            assert.strictEqual(result.negated, false);
        });

        it("should parse three-command pipeline", () => {
            const result = parse("a | b | c") as Pipeline;
            assert.strictEqual(result.type, "Pipeline");
            assert.strictEqual(result.commands.length, 3);
        });

        it("should parse negated pipeline", () => {
            const result = parse("! a | b") as Pipeline;
            assert.strictEqual(result.type, "Pipeline");
            assert.strictEqual(result.negated, true);
        });

        it("should parse |& pipe", () => {
            const result = parse("a |& b") as Pipeline;
            assert.strictEqual(result.type, "Pipeline");
            assert.deepStrictEqual(result.pipeOps, ["|&"]);
        });
    });

    describe("and/or lists", () => {
        it("should parse && operator", () => {
            const result = parse("a && b") as AndOr;
            assert.strictEqual(result.type, "AndOr");
            assert.strictEqual(result.op, "&&");
        });

        it("should parse || operator", () => {
            const result = parse("a || b") as AndOr;
            assert.strictEqual(result.type, "AndOr");
            assert.strictEqual(result.op, "||");
        });

        it("should parse chained and/or", () => {
            const result = parse("a && b || c") as AndOr;
            assert.strictEqual(result.type, "AndOr");
            assert.strictEqual(result.op, "||");
            const left = result.left as AndOr;
            assert.strictEqual(left.type, "AndOr");
            assert.strictEqual(left.op, "&&");
        });
    });

    describe("command lists", () => {
        it("should parse semicolon-separated commands", () => {
            const result = parse("a; b; c") as List;
            assert.strictEqual(result.type, "List");
            assert.strictEqual(result.entries.length, 3);
        });

        it("should parse background command", () => {
            const result = parse("a & b") as List;
            assert.strictEqual(result.type, "List");
            assert.strictEqual(result.entries[0]!.separator, "&");
        });

        it("should parse trailing &", () => {
            const result = parse("a; b &") as List;
            assert.strictEqual(result.type, "List");
            const lastWithSep = result.entries.find(e => e.separator === "&");
            assert.ok(lastWithSep);
        });
    });

    describe("redirections", () => {
        it("should parse output redirect", () => {
            const result = parse("echo hi > file") as SimpleCommand;
            assert.strictEqual(result.type, "SimpleCommand");
            assert.strictEqual(result.redirections.length, 1);
            assert.strictEqual(result.redirections[0]!.op, ">");
        });

        it("should parse append redirect", () => {
            const result = parse("echo hi >> file") as SimpleCommand;
            assert.strictEqual(result.redirections[0]!.op, ">>");
        });

        it("should parse input redirect", () => {
            const result = parse("cmd < input") as SimpleCommand;
            assert.strictEqual(result.redirections[0]!.op, "<");
        });

        it("should parse fd redirect 2>&1", () => {
            const result = parse("cmd 2>&1") as SimpleCommand;
            assert.strictEqual(result.redirections.length, 1);
            assert.strictEqual(result.redirections[0]!.op, ">&");
            assert.strictEqual(result.redirections[0]!.fd, 2);
        });

        it("should parse multiple redirections", () => {
            const result = parse("cmd < input > output") as SimpleCommand;
            assert.strictEqual(result.redirections.length, 2);
        });

        it("should parse &> redirect", () => {
            const result = parse("cmd &> file") as SimpleCommand;
            assert.strictEqual(result.redirections[0]!.op, "&>");
        });
    });

    describe("subshells", () => {
        it("should parse simple subshell", () => {
            const result = parse("(a; b)") as Subshell;
            assert.strictEqual(result.type, "Subshell");
        });

        it("should parse subshell with redirect", () => {
            const result = parse("(a | b) > file") as Subshell;
            assert.strictEqual(result.type, "Subshell");
            assert.strictEqual(result.redirections.length, 1);
        });
    });

    describe("brace groups", () => {
        it("should parse brace group", () => {
            const result = parse("{ a; b; }") as BraceGroup;
            assert.strictEqual(result.type, "BraceGroup");
        });

        it("should parse brace group with redirect", () => {
            const result = parse("{ a; b; } > file") as BraceGroup;
            assert.strictEqual(result.type, "BraceGroup");
            assert.strictEqual(result.redirections.length, 1);
        });
    });

    describe("quoting", () => {
        it("should parse double-quoted words", () => {
            const result = parse('echo "hello world"') as SimpleCommand;
            assert.strictEqual(result.words.length, 2);
            assert.strictEqual(result.words[1]!.segments[0]!.type, "DoubleQuoted");
        });

        it("should parse single-quoted words", () => {
            const result = parse("echo 'hello world'") as SimpleCommand;
            assert.strictEqual(result.words.length, 2);
            assert.strictEqual(result.words[1]!.segments[0]!.type, "SingleQuoted");
        });

        it("should parse mixed variable in double quotes", () => {
            const result = parse('echo "mixed $VAR text"') as SimpleCommand;
            const dq = result.words[1]!.segments[0]!;
            assert.strictEqual(dq.type, "DoubleQuoted");
            if (dq.type === "DoubleQuoted") {
                const types = dq.segments.map(s => s.type);
                assert.ok(types.includes("VariableExpansion"));
            }
        });
    });

    describe("complex commands", () => {
        it("should parse ls -la | grep foo > out.txt", () => {
            const result = parse("ls -la | grep foo > out.txt") as Pipeline;
            assert.strictEqual(result.type, "Pipeline");
            assert.strictEqual(result.commands.length, 2);
            const grep = result.commands[1] as SimpleCommand;
            assert.strictEqual(grep.type, "SimpleCommand");
            assert.strictEqual(grep.redirections.length, 1);
            assert.strictEqual(grep.redirections[0]!.op, ">");
        });

        it("should parse pipeline into and/or with redirect", () => {
            const result = parse("make && make install || echo fail") as AndOr;
            assert.strictEqual(result.type, "AndOr");
        });
    });

    describe("error cases", () => {
        it("should throw on unclosed quotes", () => {
            assert.throws(() => parse('"unclosed'), LexerError);
        });

        it("should throw on trailing pipe", () => {
            assert.throws(() => parse("a |"), ParseError);
        });

        it("should throw on && without right side", () => {
            assert.throws(() => parse("a &&"), ParseError);
        });

        it("should throw on unclosed subshell", () => {
            assert.throws(() => parse("(a; b"), ParseError);
        });

        it("should throw on unclosed brace group", () => {
            assert.throws(() => parse("{ a; b"), ParseError);
        });
    });
});
