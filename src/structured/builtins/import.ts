// Dynamically load one or more JS/TS modules at runtime, registering their
// exported functions as `@`-fns. Lets users package completion shims and
// reusable @-function libraries as modules instead of pasting them into
// jshrc. Yields one row per imported path with the names that registered.
//
//   @import ./completions/git.ts
//   @import a.ts b.ts | @count
//   @import scripts/utils.mjs | @select loaded
//
// Path resolution: relative to the current working directory; absolute
// paths used as-is. The Node ESM module cache means importing the same
// path twice is a no-op (the second @import yields the export list again
// from the cached module — a re-registration with the same `fn` reference,
// emitting `reregistered` events to onRegistryChange listeners).
//
// Schema extraction is async (same as jshrc registration). The next call
// site that uses an unquoted lambda for one of the imported functions
// may parse as word args until extraction lands; users can gate on
// `await jsh.awaitSchema(name)` if they need the schema synchronously.
//
// Note: exported under the name `importMod` because `import` is a JS
// reserved word. Registered to users as `@import` via `schemaFnName`.

import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { registerJsFunction, type JsPipelineFunction } from "../../jsfunctions/index.js";

export interface ImportResult {
    from: string;
    loaded: string[];
}

export async function* importMod(
    args: string[],
    _stdin: AsyncIterable<unknown>,
): AsyncGenerator<ImportResult> {
    if (args.length === 0) {
        throw new Error("@import: at least one path required");
    }
    for (const path of args) {
        const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
        const url = pathToFileURL(abs).href;
        let mod: Record<string, unknown>;
        try {
            mod = await import(url) as Record<string, unknown>;
        } catch (e) {
            throw new Error(`@import: ${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
        const loaded: string[] = [];
        for (const [name, value] of Object.entries(mod)) {
            if (name === "default") continue;
            if (typeof value !== "function") continue;
            const fn = value as JsPipelineFunction & { atOnly?: boolean };
            registerJsFunction(name, fn, {
                atOnly: fn.atOnly === true,
                source: url,
            });
            loaded.push(name);
        }
        yield { from: path, loaded };
    }
}
