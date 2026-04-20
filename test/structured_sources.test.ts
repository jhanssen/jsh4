// Stage 5 tests: real source/sink built-ins (@ls, @ps, @count).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnJsh } from "./helpers.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function jsonLines(s: string): unknown[] {
    return s.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("@ls built-in", () => {
    it("should list directory entries as File objects", () => {
        const dir = mkdtempSync(join(tmpdir(), "jsh_ls_"));
        try {
            writeFileSync(join(dir, "alpha.txt"), "hello");
            writeFileSync(join(dir, "beta.txt"), "world");
            const r = spawnJsh({
                input: `@ls ${dir} | @select name,size\nexit\n`,
                jshrc: "/dev/null",
            });
            const rows = jsonLines(r.stdout) as Array<{ name: string; size: number }>;
            const byName = new Map(rows.map(x => [x.name, x.size]));
            assert.strictEqual(byName.get("alpha.txt"), 5);
            assert.strictEqual(byName.get("beta.txt"), 5);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("should hide dotfiles by default", () => {
        const dir = mkdtempSync(join(tmpdir(), "jsh_ls_"));
        try {
            writeFileSync(join(dir, "visible"), "x");
            writeFileSync(join(dir, ".hidden"), "x");
            const r = spawnJsh({
                input: `@ls ${dir} | @select name\nexit\n`,
                jshrc: "/dev/null",
            });
            const names = (jsonLines(r.stdout) as Array<{ name: string }>).map(x => x.name);
            assert.ok(names.includes("visible"));
            assert.ok(!names.includes(".hidden"));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("should show dotfiles with -a", () => {
        const dir = mkdtempSync(join(tmpdir(), "jsh_ls_"));
        try {
            writeFileSync(join(dir, ".hidden"), "x");
            const r = spawnJsh({
                input: `@ls -a ${dir} | @select name\nexit\n`,
                jshrc: "/dev/null",
            });
            const names = (jsonLines(r.stdout) as Array<{ name: string }>).map(x => x.name);
            assert.ok(names.includes(".hidden"));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("@count built-in", () => {
    it("should return the number of rows from upstream", () => {
        const dir = mkdtempSync(join(tmpdir(), "jsh_count_"));
        try {
            for (const n of ["a", "b", "c", "d"]) writeFileSync(join(dir, n), "");
            const r = spawnJsh({ input: `@ls ${dir} | @count\nexit\n`, jshrc: "/dev/null" });
            const out = jsonLines(r.stdout)[0] as { count: number };
            assert.strictEqual(out.count, 4);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("should compose with @where", () => {
        const dir = mkdtempSync(join(tmpdir(), "jsh_count_"));
        try {
            writeFileSync(join(dir, "small"), "x");
            writeFileSync(join(dir, "big"), "x".repeat(100));
            const r = spawnJsh({
                input: `@ls ${dir} | @where @{ f => f.size >= 100 } | @count\nexit\n`,
                jshrc: "/dev/null",
            });
            const out = jsonLines(r.stdout)[0] as { count: number };
            assert.strictEqual(out.count, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("@ps built-in", () => {
    it("should yield process objects with pid and command fields", () => {
        const r = spawnJsh({ input: "@ps | @take 1\nexit\n", jshrc: "/dev/null" });
        const row = jsonLines(r.stdout)[0] as { pid: number; command: string };
        assert.strictEqual(typeof row.pid, "number");
        assert.ok(row.pid > 0);
        assert.strictEqual(typeof row.command, "string");
        assert.ok(row.command.length > 0);
    });

    it("should support filtering by user", () => {
        const r = spawnJsh({
            input: "@ps | @where @{ p => p.pid === 1 } | @select pid,user\nexit\n",
            jshrc: "/dev/null",
        });
        const rows = jsonLines(r.stdout) as Array<{ pid: number; user: string }>;
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0]!.pid, 1);
    });
});
