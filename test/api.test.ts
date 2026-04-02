import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { alias, unalias, getAlias } from "../src/api/index.js";
import { registerJsFunction, lookupJsFunction, listJsFunctions } from "../src/jsfunctions/index.js";
import type { JsPipelineFunction } from "../src/jsfunctions/index.js";

// ---- alias ------------------------------------------------------------------

describe("alias", () => {
    after(() => { unalias("__test_ll"); unalias("__test_gs"); });

    it("should register an expansion", () => {
        alias("__test_ll", "ls -la");
        assert.strictEqual(getAlias("__test_ll"), "ls -la");
    });

    it("should overwrite existing alias", () => {
        alias("__test_ll", "ls -la");
        alias("__test_ll", "ls -lah");
        assert.strictEqual(getAlias("__test_ll"), "ls -lah");
    });

    it("should return undefined for unknown alias", () => {
        assert.strictEqual(getAlias("__no_such_alias__"), undefined);
    });

    it("should remove alias with unalias", () => {
        alias("__test_gs", "git status");
        unalias("__test_gs");
        assert.strictEqual(getAlias("__test_gs"), undefined);
    });

    it("should not throw on unalias of non-existent alias", () => {
        assert.doesNotThrow(() => unalias("__never_existed__"));
    });

    it("should support multiple coexisting aliases", () => {
        alias("__test_ll", "ls -la");
        alias("__test_gs", "git status");
        assert.strictEqual(getAlias("__test_ll"), "ls -la");
        assert.strictEqual(getAlias("__test_gs"), "git status");
        unalias("__test_gs");
    });
});

// ---- registerJsFunction / lookupJsFunction ----------------------------------

describe("registerJsFunction / lookupJsFunction", () => {
    const testFn: JsPipelineFunction = async function* (_args, stdin) {
        if (stdin) for await (const line of stdin as AsyncIterable<string>) yield line;
    };

    after(() => {
        // Clean up — no unregister API, but that's acceptable
    });

    it("should make function available by name", () => {
        registerJsFunction("__test_passthrough", testFn);
        assert.strictEqual(lookupJsFunction("__test_passthrough"), testFn);
    });

    it("should return undefined for unknown function", () => {
        assert.strictEqual(lookupJsFunction("__no_such_fn__"), undefined);
    });

    it("should overwrite existing registration", () => {
        const fn1: JsPipelineFunction = () => "a";
        const fn2: JsPipelineFunction = () => "b";
        registerJsFunction("__test_overwrite", fn1);
        registerJsFunction("__test_overwrite", fn2);
        assert.strictEqual(lookupJsFunction("__test_overwrite"), fn2);
    });

    it("should include registered functions in list", () => {
        registerJsFunction("__test_listed", testFn);
        const list = listJsFunctions();
        assert.ok(list.includes("__test_listed"));
    });

    it("should produce callable registered function", async () => {
        const fn: JsPipelineFunction = async function* (_args, _stdin) {
            yield "hello\n";
        };
        registerJsFunction("__test_callable", fn);
        const found = lookupJsFunction("__test_callable")!;
        const gen = found([], null) as AsyncGenerator<string>;
        const { value } = await gen.next();
        assert.strictEqual(value, "hello\n");
    });
});
