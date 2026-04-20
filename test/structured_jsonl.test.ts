// Stage 6 tests: NDJSON adapters and cross-process boundary support.
//
// Pipelines mix object-mode @-fns with byte-mode external commands, with
// @jsonl / @to-jsonl serving as the bytes↔objects bridges.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnJsh } from "./helpers.js";

function jsonLines(s: string): unknown[] {
    return s.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("@to-jsonl: object → bytes boundary", () => {
    it("should serialize each row as one JSON line", () => {
        const r = spawnJsh({
            input: "@ls | @select name | @take 3 | @to-jsonl | head -3\nexit\n",
            jshrc: "/dev/null",
        });
        const rows = jsonLines(r.stdout) as Array<{ name: string }>;
        assert.strictEqual(rows.length, 3);
        for (const row of rows) assert.strictEqual(typeof row.name, "string");
    });

    it("should bridge to grep for filtering", () => {
        const r = spawnJsh({
            input: "@ls | @select name | @to-jsonl | grep package\nexit\n",
            jshrc: "/dev/null",
        });
        const lines = r.stdout.split("\n").filter(Boolean);
        for (const l of lines) {
            const parsed = JSON.parse(l) as { name: string };
            assert.match(parsed.name, /package/);
        }
    });
});

describe("@jsonl: bytes → object boundary", () => {
    it("should parse one JSON value per line into objects", () => {
        const r = spawnJsh({
            input: 'printf \'{"a":1}\\n{"a":2}\\n{"a":3}\\n\' | @jsonl | @where @{ r => r.a > 1 } | @to-jsonl\nexit\n',
            jshrc: "/dev/null",
        });
        const rows = jsonLines(r.stdout) as Array<{ a: number }>;
        assert.deepStrictEqual(rows, [{ a: 2 }, { a: 3 }]);
    });

    it("should skip blank lines", () => {
        const r = spawnJsh({
            input: 'printf \'{"x":1}\\n\\n{"x":2}\\n\' | @jsonl | @count\nexit\n',
            jshrc: "/dev/null",
        });
        const out = jsonLines(r.stdout)[0] as { count: number };
        assert.strictEqual(out.count, 2);
    });

    it("should error on malformed JSON", () => {
        const r = spawnJsh({
            input: 'printf \'not-json\\n\' | @jsonl | @count\nexit\n',
            jshrc: "/dev/null",
        });
        assert.match(r.stderr, /jsh: @\w+:/);
    });
});

describe("sandwich pipelines: bytes → object → bytes", () => {
    it("should support cat | @jsonl | @select | @to-jsonl | sort", () => {
        const r = spawnJsh({
            input: 'printf \'{"n":3}\\n{"n":1}\\n{"n":2}\\n\' | @jsonl | @select n | @to-jsonl | sort\nexit\n',
            jshrc: "/dev/null",
        });
        const rows = jsonLines(r.stdout) as Array<{ n: number }>;
        // sorted lexicographically as strings, so {"n":1} < {"n":2} < {"n":3}
        assert.deepStrictEqual(rows.map(r => r.n), [1, 2, 3]);
    });
});

describe("interleaved object stages still rejected", () => {
    it("should error on byte-stage between two object stages", () => {
        const r = spawnJsh({
            input: "@ls | cat | @count\nexit\n",
            jshrc: "/dev/null",
        });
        assert.match(r.stderr, /object-mode @-fn stages must be contiguous/);
    });
});
