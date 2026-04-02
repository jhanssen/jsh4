import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorize, setTheme, getCurrentTheme, registerCommandExists } from "../src/colorize/index.js";
import { commandExists } from "../src/completion/index.js";

// Register command lookup so colorizer can detect valid commands.
registerCommandExists((name: string) => commandExists(name));

const RESET = "\x1b[0m";

describe("colorizer", () => {
    it("should return empty string for empty input", () => {
        assert.strictEqual(colorize(""), "");
    });

    it("should colorize a valid command", () => {
        const result = colorize("ls");
        // Should contain ANSI codes (not plain "ls")
        assert.ok(result.includes("\x1b["), "expected ANSI escape in output");
        assert.ok(result.includes("ls"), "expected command text in output");
        assert.ok(result.includes(RESET), "expected reset in output");
    });

    it("should colorize an invalid command differently", () => {
        const result = colorize("__no_such_cmd__");
        // Should contain the curly underline escape for invalid command
        assert.ok(result.includes("\x1b[4:3m"), "expected curly underline for invalid command");
    });

    it("should colorize keywords", () => {
        const result = colorize("if");
        // "if" is a keyword, should get keyword color
        const theme = getCurrentTheme();
        const [r, g, b] = theme.keyword as [number, number, number];
        assert.ok(result.includes(`\x1b[38;2;${r};${g};${b}m`), "expected keyword color");
    });

    it("should colorize pipe operators", () => {
        const result = colorize("ls | cat");
        const theme = getCurrentTheme();
        const [r, g, b] = theme.operator as [number, number, number];
        assert.ok(result.includes(`\x1b[38;2;${r};${g};${b}m`), "expected operator color");
    });

    it("should handle partial/incomplete input gracefully", () => {
        // Unterminated string should not throw
        const result = colorize("echo 'hello");
        assert.ok(typeof result === "string");
        assert.ok(result.includes("echo"));
    });

    it("should recognize command position after pipe", () => {
        const result = colorize("echo hello | cat");
        // "cat" after pipe should be colored as a command (green), not argument
        const theme = getCurrentTheme();
        const [r, g, b] = theme.command as [number, number, number];
        const cmdColor = `\x1b[38;2;${r};${g};${b}m`;
        // Count occurrences of command color — should appear for both "echo" and "cat"
        const matches = result.split(cmdColor).length - 1;
        assert.ok(matches >= 2, `expected at least 2 command-colored tokens, got ${matches}`);
    });

    it("should preserve whitespace between tokens", () => {
        const result = colorize("echo   hello");
        // Strip ANSI to check spacing
        const stripped = result.replace(/\x1b\[[^m]*m/g, "");
        assert.strictEqual(stripped, "echo   hello");
    });

    it("should accept custom theme via setTheme", () => {
        const origTheme = { ...getCurrentTheme() };
        setTheme({ keyword: [255, 0, 0] });
        const result = colorize("if");
        assert.ok(result.includes("\x1b[38;2;255;0;0m"), "expected custom keyword color");
        // Restore
        setTheme(origTheme);
    });

    it("should resolve hex colors", () => {
        const origTheme = { ...getCurrentTheme() };
        setTheme({ keyword: "#ff0000" });
        const result = colorize("if");
        assert.ok(result.includes("\x1b[38;2;255;0;0m"), "expected hex-resolved color");
        setTheme(origTheme);
    });

    it("should resolve named colors", () => {
        const origTheme = { ...getCurrentTheme() };
        setTheme({ keyword: "bold red" });
        const result = colorize("if");
        assert.ok(result.includes("\x1b[1m"), "expected bold");
        assert.ok(result.includes("\x1b[31m"), "expected red");
        setTheme(origTheme);
    });
});
