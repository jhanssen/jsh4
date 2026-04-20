// Stage 1 smoke tests for the object-mode @-fn channel.
//
// At this stage there are no built-in object-mode fns and no loader-prologue
// auto-mode (stage 2). Tests register fns from a one-shot jshrc with an
// explicit `mode: "object"` opt-in.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withRc } from "./helpers.js";

describe("structured pipelines — channel", () => {
    it("should chain two object-mode @-fns via in-process iterable", () => {
        const rc = `
            jsh.registerJsFunction("src", () => (async function*() {
                yield { name: "a", size: 10 };
                yield { name: "b", size: 200 };
                yield { name: "c", size: 3000 };
            })(), { mode: "object" });
            jsh.registerJsFunction("big", (_args, stdin) => (async function*() {
                for await (const row of stdin) {
                    if ((row).size >= 100) yield row;
                }
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "@src | @big");
        const lines = r.stdout.split("\n").filter(Boolean);
        assert.strictEqual(lines.length, 2);
        assert.deepStrictEqual(JSON.parse(lines[0]!), { name: "b", size: 200 });
        assert.deepStrictEqual(JSON.parse(lines[1]!), { name: "c", size: 3000 });
    });

    it("should handle a single-stage object-mode @-fn", () => {
        const rc = `
            jsh.registerJsFunction("one", () => (async function*() {
                yield { hello: "world" };
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "@one");
        assert.deepStrictEqual(JSON.parse(r.stdout), { hello: "world" });
    });

    it("should chain three object-mode stages", () => {
        const rc = `
            jsh.registerJsFunction("nums", () => (async function*() {
                for (let i = 1; i <= 5; i++) yield { n: i };
            })(), { mode: "object" });
            jsh.registerJsFunction("dbl", (_a, s) => (async function*() {
                for await (const r of s) yield { n: (r).n * 2 };
            })(), { mode: "object" });
            jsh.registerJsFunction("sum", (_a, s) => (async function() {
                let total = 0;
                for await (const r of s) total += (r).n;
                return { total };
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "@nums | @dbl | @sum");
        assert.deepStrictEqual(JSON.parse(r.stdout), { total: 30 });
    });

    it("should reject mixing object-mode and byte-mode in same pipeline", () => {
        const rc = `
            jsh.registerJsFunction("obj", () => (async function*() {
                yield { x: 1 };
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "@obj | cat");
        assert.match(r.stderr, /object-mode @-fn cannot pipe to a byte-mode stage/);
    });

    it("should support bare-name resolution for object-mode fns", () => {
        const rc = `
            jsh.registerJsFunction("myfn", () => (async function*() {
                yield { v: 42 };
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "myfn");
        assert.deepStrictEqual(JSON.parse(r.stdout), { v: 42 });
    });

    it("should propagate function errors with name in stderr", () => {
        const rc = `
            jsh.registerJsFunction("boom", () => (async function*() {
                throw new Error("bang");
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "@boom");
        assert.match(r.stderr, /jsh: @boom: bang/);
    });

    it("should pass args through to the object-mode fn", () => {
        const rc = `
            jsh.registerJsFunction("emit", (args) => (async function*() {
                for (const a of args) yield { arg: a };
            })(), { mode: "object" });
        `;
        const r = withRc(rc, "@emit hello world");
        const lines = r.stdout.split("\n").filter(Boolean);
        assert.strictEqual(lines.length, 2);
        assert.deepStrictEqual(JSON.parse(lines[0]!), { arg: "hello" });
        assert.deepStrictEqual(JSON.parse(lines[1]!), { arg: "world" });
    });

    it("should keep existing byte-mode @-fns unaffected", () => {
        const rc = `
            jsh.registerJsFunction("upper", (_a, stdin) => (async function*() {
                for await (const line of stdin) yield line.toUpperCase() + "\\n";
            })());
        `;
        const r = withRc(rc, "echo hello | @upper");
        assert.strictEqual(r.stdout.trim(), "HELLO");
    });
});
