// Stage 3 smoke tests for the first three built-in operators (@where,
// @select, @take). They exercise the full path: registration of built-ins
// at startup, schema loaded from dist/structured/schemas.json, in-process
// iterable channel between operators, JSON sink for terminal output.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withRcTs } from "./helpers.js";

function jsonLines(s: string): unknown[] {
    return s.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("@where built-in", () => {
    it("should filter rows matching a predicate", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { n: 1 }; yield { n: 2 }; yield { n: 3 };
            })());
        `;
        const r = withRcTs(rc, "@src | @where @{ r => r.n >= 2 }");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ n: 2 }, { n: 3 }]);
    });

    it("should error on missing predicate", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() { yield {n:1}; })());
        `;
        const r = withRcTs(rc, "@src | @where");
        assert.match(r.stderr, /@where: predicate must be a function/);
    });

    it("should accept an unquoted lambda for the predicate slot", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { n: 1 }; yield { n: 2 }; yield { n: 3 };
            })());
        `;
        const r = withRcTs(rc, "@src | @where r => r.n >= 2");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ n: 2 }, { n: 3 }]);
    });

    it("should preserve a downstream pipe past an unquoted lambda body", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { n: 1 }; yield { n: 2 }; yield { n: 3 };
            })());
        `;
        const r = withRcTs(rc, "@src | @where r => r.n > 1 | @count");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ count: 2 }]);
    });

    it("should preserve a numbered redirection after the lambda", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { n: 1 }; yield { n: 2 };
            })());
        `;
        const r = withRcTs(rc, "@src | @where r => r.n > 0 2>/dev/null");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ n: 1 }, { n: 2 }]);
    });

    it("should accept a parenthesized arrow", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { a: 1, b: 2 }; yield { a: 5, b: 1 };
            })());
        `;
        const r = withRcTs(rc, "@src | @where (r) => r.a + r.b > 5");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ a: 5, b: 1 }]);
    });

    it("should error on non-function predicate", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() { yield {n:1}; })());
        `;
        const r = withRcTs(rc, "@src | @where @{ 42 }");
        assert.match(r.stderr, /@where: predicate must be a function/);
    });
});

describe("@select built-in", () => {
    it("should project shorthand field list", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { name: "a", size: 10, mode: 0o644 };
                yield { name: "b", size: 20, mode: 0o755 };
            })());
        `;
        const r = withRcTs(rc, "@src | @select name,size");
        assert.deepStrictEqual(jsonLines(r.stdout), [
            { name: "a", size: 10 },
            { name: "b", size: 20 },
        ]);
    });

    it("should project via lambda", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { first: "Jan", last: "Doe" };
            })());
        `;
        const r = withRcTs(rc, "@src | @select @{ r => ({full: r.first + ' ' + r.last}) }");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ full: "Jan Doe" }]);
    });
});

describe("@take built-in", () => {
    it("should yield only the first N rows", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                for (let i = 1; i <= 100; i++) yield { i };
            })());
        `;
        const r = withRcTs(rc, "@src | @take 3");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ i: 1 }, { i: 2 }, { i: 3 }]);
    });

    it("should yield zero rows for take 0", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { x: 1 };
            })());
        `;
        const r = withRcTs(rc, "@src | @take 0");
        assert.strictEqual(r.stdout.trim(), "");
    });

    it("should error on non-numeric arg", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() { yield {x:1}; })());
        `;
        const r = withRcTs(rc, "@src | @take abc");
        assert.match(r.stderr, /@take: invalid count/);
    });
});

describe("@table built-in", () => {
    it("should render objects as a table with header", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { name: "alpha", size: 10 };
                yield { name: "beta",  size: 200 };
            })());
        `;
        const r = withRcTs(rc, "@src | @table");
        // Strip ANSI for portable matching.
        const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
        const lines = plain.split("\n").filter(Boolean);
        assert.strictEqual(lines.length, 3, plain);
        assert.match(lines[0]!, /name\s+size/);
        assert.match(lines[1]!, /alpha\s+10/);
        assert.match(lines[2]!, /beta\s+200/);
    });

    it("should support --no-header", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { x: 1 };
            })());
        `;
        const r = withRcTs(rc, "@src | @table --no-header");
        const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
        const lines = plain.split("\n").filter(Boolean);
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0]!, /^1\s*$/);
    });

    it("should right-align numeric columns", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { n: 5 };
                yield { n: 1234 };
            })());
        `;
        // Keep the header row so trim() doesn't eat the leading-space padding
        // on the first data row (trim is whole-string, not per-line).
        const r = withRcTs(rc, "@src | @table");
        const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
        const lines = plain.split("\n");
        // header, row1, row2
        assert.match(lines[1]!, /^   5\s*$/);
        assert.match(lines[2]!, /^1234\s*$/);
    });

    it("should fall back to JSON when stdout is not a tty (no implicit @table)", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { x: 1 };
            })());
        `;
        // spawnJsh in tests pipes stdin/stdout (non-tty) so there's no implicit table.
        const r = withRcTs(rc, "@src");
        assert.strictEqual(r.stdout.trim(), '{"x":1}');
    });
});

describe("@map built-in", () => {
    it("should transform each row through a lambda", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { x: 1 }; yield { x: 2 }; yield { x: 3 };
            })());
        `;
        const r = withRcTs(rc, "@src | @map r => r.x * 10");
        assert.deepStrictEqual(jsonLines(r.stdout), [10, 20, 30]);
    });

    it("should support unquoted lambdas via the schema-driven slot", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { name: "a", n: 1 }; yield { name: "b", n: 2 };
            })());
        `;
        const r = withRcTs(rc, "@src | @map r => ({ doubled: r.n * 2 })");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ doubled: 2 }, { doubled: 4 }]);
    });

    it("should error when arg is not a function", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() { yield {x:1}; })());
        `;
        const r = withRcTs(rc, "@src | @map @{ 42 }");
        assert.match(r.stderr, /@map: transform must be a function/);
    });
});

describe("@sort built-in", () => {
    it("should sort by a single key ascending", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { n: 3 }; yield { n: 1 }; yield { n: 2 };
            })());
        `;
        const r = withRcTs(rc, "@src | @sort n");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it("should sort by multiple keys with tiebreakers", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { a: 1, b: 2 }; yield { a: 1, b: 1 }; yield { a: 0, b: 5 };
            })());
        `;
        const r = withRcTs(rc, "@src | @sort a,b");
        assert.deepStrictEqual(jsonLines(r.stdout), [
            { a: 0, b: 5 }, { a: 1, b: 1 }, { a: 1, b: 2 },
        ]);
    });

    it("should sort primitives naturally without args", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield 3; yield 1; yield 2;
            })());
        `;
        const r = withRcTs(rc, "@src | @sort");
        assert.deepStrictEqual(jsonLines(r.stdout), [1, 2, 3]);
    });
});

describe("@sort-by built-in", () => {
    it("should sort by computed key via unquoted lambda", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { name: "Cab" }; yield { name: "abc" }; yield { name: "BAC" };
            })());
        `;
        const r = withRcTs(rc, "@src | @sort-by r => r.name.toLowerCase()");
        assert.deepStrictEqual(jsonLines(r.stdout), [
            { name: "abc" }, { name: "BAC" }, { name: "Cab" },
        ]);
    });

    it("should error when arg is not a function", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() { yield {x:1}; })());
        `;
        const r = withRcTs(rc, "@src | @sort-by @{ 42 }");
        assert.match(r.stderr, /@sort-by: key extractor must be a function/);
    });
});

describe("@uniq built-in", () => {
    it("should dedupe by full row", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield 1; yield 2; yield 1; yield 3; yield 2;
            })());
        `;
        const r = withRcTs(rc, "@src | @uniq");
        assert.deepStrictEqual(jsonLines(r.stdout), [1, 2, 3]);
    });

    it("should dedupe by a key path", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { id: 1, t: 0 }; yield { id: 2, t: 1 }; yield { id: 1, t: 5 };
            })());
        `;
        const r = withRcTs(rc, "@src | @uniq id");
        assert.deepStrictEqual(jsonLines(r.stdout), [
            { id: 1, t: 0 }, { id: 2, t: 1 },
        ]);
    });
});

describe("@uniq-by built-in", () => {
    it("should dedupe by computed key via unquoted lambda", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { name: "Foo" }; yield { name: "foo" }; yield { name: "bar" };
            })());
        `;
        const r = withRcTs(rc, "@src | @uniq-by r => r.name.toLowerCase()");
        assert.deepStrictEqual(jsonLines(r.stdout), [
            { name: "Foo" }, { name: "bar" },
        ]);
    });
});

describe("@drop built-in", () => {
    it("should skip the first N rows", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                for (let i = 1; i <= 5; i++) yield { i };
            })());
        `;
        const r = withRcTs(rc, "@src | @drop 2");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ i: 3 }, { i: 4 }, { i: 5 }]);
    });

    it("should default to dropping 1 row", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield 1; yield 2; yield 3;
            })());
        `;
        const r = withRcTs(rc, "@src | @drop");
        assert.deepStrictEqual(jsonLines(r.stdout), [2, 3]);
    });

    it("should error on invalid count", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() { yield 1; })());
        `;
        const r = withRcTs(rc, "@src | @drop abc");
        assert.match(r.stderr, /@drop: invalid count/);
    });
});

describe("@tail built-in", () => {
    it("should yield the last N rows", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                for (let i = 1; i <= 5; i++) yield { i };
            })());
        `;
        const r = withRcTs(rc, "@src | @tail 2");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ i: 4 }, { i: 5 }]);
    });

    it("should yield zero rows for @tail 0", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield 1; yield 2;
            })());
        `;
        const r = withRcTs(rc, "@src | @tail 0");
        assert.strictEqual(r.stdout.trim(), "");
    });

    it("should yield all rows when N exceeds source size", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield 1; yield 2;
            })());
        `;
        const r = withRcTs(rc, "@src | @tail 10");
        assert.deepStrictEqual(jsonLines(r.stdout), [1, 2]);
    });
});

describe("@head built-in", () => {
    it("should behave identically to @take (POSIX-shaped synonym)", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                for (let i = 1; i <= 100; i++) yield { i };
            })());
        `;
        const r = withRcTs(rc, "@src | @head 3");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ i: 1 }, { i: 2 }, { i: 3 }]);
    });
});

describe("composed pipelines", () => {
    it("should chain @where | @select | @take", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                for (let i = 1; i <= 100; i++) yield { i, big: i > 50 };
            })());
        `;
        const r = withRcTs(rc, "@src | @where @{ r => r.big } | @select i | @take 3");
        assert.deepStrictEqual(jsonLines(r.stdout), [{ i: 51 }, { i: 52 }, { i: 53 }]);
    });
});

describe("built-in schemas loaded at startup", () => {
    it("should include @where output schema in the built-in registry", () => {
        // Indirect check: the build CLI emits dist/structured/schemas.json
        // and registerStructuredBuiltins attaches it. We verify by reading
        // the file directly here — runtime introspection of the registry is
        // not exposed yet.
        const here = resolve(process.cwd(), "dist/structured/schemas.json");
        const schemas = JSON.parse(readFileSync(here, "utf8")) as Record<string, { functions: Record<string, { typeVars: string[] }> }>;
        assert.ok(schemas.where, "expected `where` in dist schemas");
        const fn = schemas.where.functions["where"];
        assert.ok(fn, "expected `where` function schema");
        // @where declares a generic `<T>` so the predicate's row type can
        // unify with the upstream output type during pipeline construction.
        assert.deepStrictEqual(fn.typeVars, ["T"]);
    });
});
