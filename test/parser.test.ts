import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser/index.js";
import type { SimpleCommand } from "../src/parser/index.js";

describe("parser", () => {
    it("should export a parse function", () => {
        assert.strictEqual(typeof parse, "function");
    });

    it("should return an AST node for simple input", () => {
        const result = parse("echo hello world");
        assert.strictEqual(result.type, "SimpleCommand");
        const cmd = result as SimpleCommand;
        assert.deepStrictEqual(cmd.words, ["echo", "hello", "world"]);
    });

    it("should handle single-word input", () => {
        const result = parse("ls") as SimpleCommand;
        assert.strictEqual(result.type, "SimpleCommand");
        assert.deepStrictEqual(result.words, ["ls"]);
    });

    it("should handle empty input", () => {
        const result = parse("") as SimpleCommand;
        assert.strictEqual(result.type, "SimpleCommand");
        assert.deepStrictEqual(result.words, []);
    });
});
