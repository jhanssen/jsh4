import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Lexer, TokenType, LexerError, IncompleteInputError } from "../src/parser/lexer.js";

function tokenTypes(input: string): TokenType[] {
    const lexer = new Lexer(input);
    return lexer.getTokens().map(t => t.type);
}

function tokenValues(input: string): string[] {
    const lexer = new Lexer(input);
    return lexer.getTokens().filter(t => t.type !== TokenType.EOF).map(t => t.value);
}

describe("lexer", () => {
    describe("words", () => {
        it("should tokenize a single word", () => {
            assert.deepStrictEqual(tokenValues("ls"), ["ls"]);
        });

        it("should tokenize multiple words", () => {
            assert.deepStrictEqual(tokenValues("echo hello world"), ["echo", "hello", "world"]);
        });

        it("should handle tabs between words", () => {
            assert.deepStrictEqual(tokenValues("echo\thello"), ["echo", "hello"]);
        });
    });

    describe("single quotes", () => {
        it("should tokenize single-quoted string", () => {
            const lexer = new Lexer("'hello world'");
            const tokens = lexer.getTokens();
            assert.strictEqual(tokens[0]!.type, TokenType.Word);
            assert.strictEqual(tokens[0]!.word!.segments[0]!.type, "SingleQuoted");
            if (tokens[0]!.word!.segments[0]!.type === "SingleQuoted") {
                assert.strictEqual(tokens[0]!.word!.segments[0]!.value, "hello world");
            }
        });

        it("should throw on unclosed single quote", () => {
            assert.throws(() => new Lexer("'unclosed"), IncompleteInputError);
        });
    });

    describe("double quotes", () => {
        it("should tokenize double-quoted string", () => {
            const lexer = new Lexer('"hello world"');
            const tok = lexer.getTokens()[0]!;
            assert.strictEqual(tok.word!.segments[0]!.type, "DoubleQuoted");
        });

        it("should parse variable inside double quotes", () => {
            const lexer = new Lexer('"hello $VAR"');
            const tok = lexer.getTokens()[0]!;
            const dq = tok.word!.segments[0]!;
            assert.strictEqual(dq.type, "DoubleQuoted");
            if (dq.type === "DoubleQuoted") {
                assert.strictEqual(dq.segments.length, 2);
                assert.strictEqual(dq.segments[0]!.type, "Literal");
                assert.strictEqual(dq.segments[1]!.type, "VariableExpansion");
            }
        });

        it("should handle backslash escapes in double quotes", () => {
            const lexer = new Lexer('"hello\\"world"');
            const tok = lexer.getTokens()[0]!;
            const dq = tok.word!.segments[0]!;
            assert.strictEqual(dq.type, "DoubleQuoted");
            if (dq.type === "DoubleQuoted") {
                // Should have literal: hello"world
                const text = dq.segments.filter(s => s.type === "Literal").map(s => (s as any).value).join("");
                assert.strictEqual(text, 'hello"world');
            }
        });

        it("should throw on unclosed double quote", () => {
            assert.throws(() => new Lexer('"unclosed'), IncompleteInputError);
        });
    });

    describe("backslash escapes", () => {
        it("should escape special characters", () => {
            const lexer = new Lexer("hello\\ world");
            const tokens = lexer.getTokens().filter(t => t.type !== TokenType.EOF);
            // "hello\ world" is one word since backslash escapes the space
            assert.strictEqual(tokens.length, 1);
        });

        it("should handle line continuation", () => {
            const lexer = new Lexer("hello\\\nworld");
            const tokens = lexer.getTokens().filter(t => t.type !== TokenType.EOF);
            assert.strictEqual(tokens.length, 1);
        });

        it("should request continuation on trailing backslash at EOF", () => {
            // Mirrors what the REPL sees when the user ends a line with `\` —
            // line arrives without the newline, so the lexer must ask for more
            // input (IncompleteInputError) rather than silently drop the `\`.
            assert.throws(() => new Lexer("echo foo \\").getTokens(), IncompleteInputError);
        });
    });

    describe("variable expansion", () => {
        it("should tokenize $VAR", () => {
            const lexer = new Lexer("$HOME");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "VariableExpansion");
            if (seg.type === "VariableExpansion") {
                assert.strictEqual(seg.name, "HOME");
            }
        });

        it("should tokenize ${VAR}", () => {
            const lexer = new Lexer("${HOME}");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "VariableExpansion");
            if (seg.type === "VariableExpansion") {
                assert.strictEqual(seg.name, "HOME");
            }
        });

        it("should tokenize ${VAR:-default}", () => {
            const lexer = new Lexer("${VAR:-default}");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "VariableExpansion");
            if (seg.type === "VariableExpansion") {
                assert.strictEqual(seg.name, "VAR");
                assert.strictEqual(seg.operator, ":-");
                assert.ok(seg.operand);
                assert.strictEqual(seg.operand![0]!.type, "Literal");
            }
        });

        it("should tokenize ${VAR%%pattern}", () => {
            const lexer = new Lexer("${VAR%%*.txt}");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "VariableExpansion");
            if (seg.type === "VariableExpansion") {
                assert.strictEqual(seg.name, "VAR");
                assert.strictEqual(seg.operator, "%%");
            }
        });

        it("should tokenize special variables $? $$ $!", () => {
            for (const ch of ["?", "$", "!", "#"]) {
                const lexer = new Lexer("$" + ch);
                const seg = lexer.getTokens()[0]!.word!.segments[0]!;
                assert.strictEqual(seg.type, "VariableExpansion");
                if (seg.type === "VariableExpansion") {
                    assert.strictEqual(seg.name, ch);
                }
            }
        });

        it("should handle bare $ as literal", () => {
            const lexer = new Lexer("$ ");
            const tokens = lexer.getTokens().filter(t => t.type !== TokenType.EOF);
            assert.strictEqual(tokens[0]!.word!.segments[0]!.type, "Literal");
        });
    });

    describe("command substitution", () => {
        it("should tokenize $(command)", () => {
            const lexer = new Lexer("$(ls -la)");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "CommandSubstitution");
            if (seg.type === "CommandSubstitution") {
                assert.strictEqual(seg.body, "ls -la");
            }
        });

        it("should tokenize backtick substitution", () => {
            const lexer = new Lexer("`ls -la`");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "CommandSubstitution");
            if (seg.type === "CommandSubstitution") {
                assert.strictEqual(seg.body, "ls -la");
            }
        });

        it("should handle nested $()", () => {
            const lexer = new Lexer("$(echo $(pwd))");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "CommandSubstitution");
            if (seg.type === "CommandSubstitution") {
                assert.strictEqual(seg.body, "echo $(pwd)");
            }
        });
    });

    describe("arithmetic expansion", () => {
        it("should tokenize $((expression))", () => {
            const lexer = new Lexer("$((1 + 2))");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "ArithmeticExpansion");
            if (seg.type === "ArithmeticExpansion") {
                assert.strictEqual(seg.expression, "1 + 2");
            }
        });
    });

    describe("ANSI-C quoting", () => {
        it("should handle $'...' with escape sequences", () => {
            const lexer = new Lexer("$'hello\\nworld'");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            assert.strictEqual(seg.type, "Literal");
            if (seg.type === "Literal") {
                assert.strictEqual(seg.value, "hello\nworld");
            }
        });

        it("should handle $'...' with hex escapes", () => {
            const lexer = new Lexer("$'\\x41'");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            if (seg.type === "Literal") {
                assert.strictEqual(seg.value, "A");
            }
        });

        it("should handle $'...' with embedded single quote", () => {
            const lexer = new Lexer("$'it\\'s'");
            const seg = lexer.getTokens()[0]!.word!.segments[0]!;
            if (seg.type === "Literal") {
                assert.strictEqual(seg.value, "it's");
            }
        });
    });

    describe("operators", () => {
        it("should tokenize pipe", () => {
            assert.deepStrictEqual(tokenTypes("a | b"), [
                TokenType.Word, TokenType.Pipe, TokenType.Word, TokenType.EOF
            ]);
        });

        it("should tokenize ||", () => {
            assert.deepStrictEqual(tokenTypes("a || b"), [
                TokenType.Word, TokenType.Or, TokenType.Word, TokenType.EOF
            ]);
        });

        it("should tokenize &&", () => {
            assert.deepStrictEqual(tokenTypes("a && b"), [
                TokenType.Word, TokenType.And, TokenType.Word, TokenType.EOF
            ]);
        });

        it("should tokenize ;", () => {
            assert.deepStrictEqual(tokenTypes("a ; b"), [
                TokenType.Word, TokenType.Semi, TokenType.Word, TokenType.EOF
            ]);
        });

        it("should tokenize &", () => {
            assert.deepStrictEqual(tokenTypes("a &"), [
                TokenType.Word, TokenType.Amp, TokenType.EOF
            ]);
        });

        it("should tokenize |&", () => {
            assert.deepStrictEqual(tokenTypes("a |& b"), [
                TokenType.Word, TokenType.PipeAnd, TokenType.Word, TokenType.EOF
            ]);
        });

        it("should tokenize parentheses", () => {
            assert.deepStrictEqual(tokenTypes("( a )"), [
                TokenType.LParen, TokenType.Word, TokenType.RParen, TokenType.EOF
            ]);
        });

        it("should tokenize braces", () => {
            assert.deepStrictEqual(tokenTypes("{ a; }"), [
                TokenType.LBrace, TokenType.Word, TokenType.Semi, TokenType.RBrace, TokenType.EOF
            ]);
        });
    });

    describe("redirections", () => {
        it("should tokenize > redirect", () => {
            const tokens = new Lexer("echo hi > file").getTokens();
            const redir = tokens.find(t => t.type === TokenType.Redirect);
            assert.ok(redir);
            assert.strictEqual(redir!.value, ">");
        });

        it("should tokenize >> redirect", () => {
            const tokens = new Lexer("echo hi >> file").getTokens();
            const redir = tokens.find(t => t.type === TokenType.Redirect);
            assert.strictEqual(redir!.value, ">>");
        });

        it("should tokenize < redirect", () => {
            const tokens = new Lexer("cmd < input").getTokens();
            const redir = tokens.find(t => t.type === TokenType.Redirect);
            assert.strictEqual(redir!.value, "<");
        });

        it("should tokenize 2>&1", () => {
            const tokens = new Lexer("cmd 2>&1").getTokens();
            const redir = tokens.find(t => t.type === TokenType.Redirect);
            assert.ok(redir);
            assert.strictEqual(redir!.value, ">&");
            assert.strictEqual(redir!.fd, 2);
        });

        it("should tokenize &>", () => {
            const tokens = new Lexer("cmd &> file").getTokens();
            const redir = tokens.find(t => t.type === TokenType.Redirect);
            assert.strictEqual(redir!.value, "&>");
        });
    });

    describe("comments", () => {
        it("should strip comments", () => {
            const tokens = new Lexer("echo hello # this is a comment").getTokens();
            const words = tokens.filter(t => t.type === TokenType.Word);
            assert.strictEqual(words.length, 2);
        });

        it("should handle comment-only input", () => {
            const tokens = new Lexer("# just a comment").getTokens();
            assert.deepStrictEqual(tokenTypes("# just a comment"), [TokenType.EOF]);
        });
    });

    describe("mixed quoting", () => {
        it("should handle adjacent quoted segments in one word", () => {
            const lexer = new Lexer("\"hello\"'world'");
            const tokens = lexer.getTokens().filter(t => t.type !== TokenType.EOF);
            assert.strictEqual(tokens.length, 1);
            const segs = tokens[0]!.word!.segments;
            assert.strictEqual(segs.length, 2);
            assert.strictEqual(segs[0]!.type, "DoubleQuoted");
            assert.strictEqual(segs[1]!.type, "SingleQuoted");
        });

        it("should handle unquoted + quoted in one word", () => {
            const lexer = new Lexer("hello'world'");
            const tokens = lexer.getTokens().filter(t => t.type !== TokenType.EOF);
            assert.strictEqual(tokens.length, 1);
            assert.strictEqual(tokens[0]!.word!.segments.length, 2);
        });
    });

    describe("glob patterns", () => {
        it("should tokenize * as glob", () => {
            const lexer = new Lexer("*.txt");
            const segs = lexer.getTokens()[0]!.word!.segments;
            assert.strictEqual(segs[0]!.type, "Glob");
            if (segs[0]!.type === "Glob") {
                assert.strictEqual(segs[0]!.pattern, "*");
            }
        });

        it("should tokenize ? as glob", () => {
            const lexer = new Lexer("file?.txt");
            const segs = lexer.getTokens()[0]!.word!.segments;
            const glob = segs.find(s => s.type === "Glob");
            assert.ok(glob);
        });

        it("should tokenize [...] as glob", () => {
            const lexer = new Lexer("[abc]");
            const segs = lexer.getTokens()[0]!.word!.segments;
            assert.strictEqual(segs[0]!.type, "Glob");
            if (segs[0]!.type === "Glob") {
                assert.strictEqual(segs[0]!.pattern, "[abc]");
            }
        });
    });

    describe("empty and whitespace", () => {
        it("should produce only EOF for empty input", () => {
            assert.deepStrictEqual(tokenTypes(""), [TokenType.EOF]);
        });

        it("should produce only EOF for whitespace input", () => {
            assert.deepStrictEqual(tokenTypes("   \t  "), [TokenType.EOF]);
        });
    });

    describe("token positions", () => {
        it("should track start and end offsets", () => {
            const lexer = new Lexer("echo hello");
            const tokens = lexer.getTokens();
            assert.strictEqual(tokens[0]!.start, 0);
            assert.strictEqual(tokens[0]!.end, 4);
            assert.strictEqual(tokens[1]!.start, 5);
            assert.strictEqual(tokens[1]!.end, 10);
        });

        it("should track operator positions", () => {
            const lexer = new Lexer("a | b && c");
            const tokens = lexer.getTokens();
            // a
            assert.strictEqual(tokens[0]!.start, 0);
            assert.strictEqual(tokens[0]!.end, 1);
            // |
            assert.strictEqual(tokens[1]!.start, 2);
            assert.strictEqual(tokens[1]!.end, 3);
            // b
            assert.strictEqual(tokens[2]!.start, 4);
            assert.strictEqual(tokens[2]!.end, 5);
            // &&
            assert.strictEqual(tokens[3]!.start, 6);
            assert.strictEqual(tokens[3]!.end, 8);
        });

        it("should track EOF at input length", () => {
            const lexer = new Lexer("ls");
            const tokens = lexer.getTokens();
            const eof = tokens[tokens.length - 1]!;
            assert.strictEqual(eof.type, TokenType.EOF);
            assert.strictEqual(eof.start, 2);
        });
    });

    describe("partial mode", () => {
        it("should not throw on incomplete input in partial mode", () => {
            const lexer = new Lexer("echo 'unterminated", { partial: true });
            const tokens = lexer.getTokens();
            assert.ok(tokens.length >= 1);
            assert.strictEqual(tokens[tokens.length - 1]!.type, TokenType.EOF);
        });

        it("should produce tokens before the error", () => {
            const lexer = new Lexer("echo hello | ", { partial: true });
            const tokens = lexer.getTokens().filter(t => t.type !== TokenType.EOF);
            assert.ok(tokens.length >= 3); // echo, hello, |
        });

        it("should still throw in normal mode", () => {
            assert.throws(() => new Lexer("echo 'unterminated"));
        });
    });
});
