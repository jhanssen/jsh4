// Registry for @ JS pipeline functions.
// Functions are registered by name and called when @name appears in a pipeline.
//
// Two modes:
//
//   "byte" (default for .js/.mjs sources, the historical mode):
//     fn(args: string[], stdin: AsyncIterable<string> | null) => ReturnType
//     stdin yields plain lines (no trailing "\n"; CRLF normalized). Yielded
//     strings/Buffers are written raw to the next stage's fd. A line-emitter
//     must include its own "\n".
//
//   "object" (default for .ts/.mts sources, opt-in elsewhere):
//     fn(args: string[], stdin: AsyncIterable<unknown>) => AsyncIterable<unknown>
//     Adjacent object-mode stages share the iterable directly — no fd, no
//     serialization. Crossing to a byte-mode neighbor requires an explicit
//     adapter (@from-jsonl / @to-jsonl) until auto-insertion lands.
//
// Return types handled by the byte-mode executor:
//   string | Buffer       → written to stdout
//   AsyncGenerator        → each yielded value written to stdout (raw, no sep)
//   Generator             → same
//   Promise               → awaited, then above rules applied
//   void / undefined      → nothing written, exit 0
//   throw / reject        → exit 1, error to stderr
//
// Object-mode return values must be (or resolve to) an AsyncIterable / Iterable.
// A non-iterable return value is wrapped as a single-element iterable so simple
// reducers like @count can `return n` and still satisfy the contract.

import type { TypeIR } from "../structured/ir.js";
import { cacheLookup, cacheStore } from "../structured/cache.js";
import { fileURLToPath } from "node:url";

// Args are a mixed array. Word-shaped args (`@where foo`) arrive as strings;
// `@{...}` inline-JS args arrive as their evaluated value (function, object,
// number, ...). Receivers that expect a specific shape (e.g. @where wants
// args[0] to be a function) check `typeof` and throw on mismatch.
export type JsPipelineFunction = (
    args: unknown[],
    stdin: AsyncIterable<string> | AsyncIterable<unknown> | null
) => unknown;

export type JsFunctionMode = "byte" | "object";

export interface JsFunctionOptions {
    // When true, this function is callable only via the @-prefixed form
    // (@name). Bare-name resolution skips it, so a same-named alias,
    // shell function, builtin, or PATH command can still be invoked
    // without the prefix.
    atOnly?: boolean;

    // Stage I/O mode. Default depends on the source file's extension:
    // .ts/.mts → "object"; .js/.mjs/unknown → "byte".
    mode?: JsFunctionMode;

    // Source file URL, captured automatically by the loader prologue
    // (see src/structured/loader-wrap.ts) for .ts/.mts modules. Used to
    // (a) infer the default mode and (b) look up extracted schemas.
    source?: string;

    // Schemas. Usually populated by the schema extractor at build time
    // for built-ins, or at registration-cache-miss time for user files.
    // Either may be omitted; absent schemas are treated as `unknown` by
    // the unifier (no type errors, no completion for that stage).
    input?: TypeIR;
    output?: TypeIR;
    args?: TypeIR;

    // Name of another registered @-fn to use as the implicit sink when this
    // function is the last stage of an interactive (tty) pipeline. Late-bound
    // by name — the named function need not be registered yet at the time
    // this option is set; the lookup happens at pipeline-execution time. If
    // the named function isn't registered when the pipeline runs, the
    // executor falls back to @table.
    defaultSink?: string;

    // True if this function emits its own formatted output (strings/bytes).
    // The executor never auto-wraps a sink in another sink. Defaults to
    // `true` for the built-in @table / @to-jsonl / etc.; user-defined
    // formatters opt in.
    isSink?: boolean;

    // Hide from tab completion + `type` listings. Useful for formatters
    // that are usually only invoked indirectly via `defaultSink`.
    hidden?: boolean;
}

interface RegistryEntry {
    fn: JsPipelineFunction;
    atOnly: boolean;
    mode: JsFunctionMode;
    source?: string;
    input?: TypeIR;
    output?: TypeIR;
    args?: TypeIR;
    defaultSink?: string;
    isSink: boolean;
    hidden: boolean;
}

const registry = new Map<string, RegistryEntry>();

function defaultModeForSource(source: string | undefined): JsFunctionMode {
    if (!source) return "byte";
    if (source.endsWith(".ts") || source.endsWith(".mts")) return "object";
    return "byte";
}

export function registerJsFunction(
    name: string,
    fn: JsPipelineFunction,
    opts: JsFunctionOptions = {},
): void {
    const mode = opts.mode ?? defaultModeForSource(opts.source);

    // If schemas weren't passed in but the source is a .ts/.mts user file,
    // try the schema cache. Lazy-extract on miss happens in a fire-and-forget
    // task so the rc load isn't blocked by tsc cold-start.
    let input  = opts.input;
    let output = opts.output;
    let args   = opts.args;
    if ((!input || !output || !args) && opts.source && isExtractable(opts.source)) {
        const absPath = sourceToAbsPath(opts.source);
        if (absPath) {
            const cached = cacheLookup(absPath);
            if (cached?.functions[name]) {
                const fs = cached.functions[name];
                input  = input  ?? fs.input;
                output = output ?? fs.output;
                args   = args   ?? fs.args;
            } else {
                // Background extract; result lands in cache for the next run.
                void scheduleExtract(absPath);
            }
        }
    }

    const isSink = opts.isSink === true;
    const hidden = opts.hidden === true;
    registry.set(name, {
        fn,
        atOnly: opts.atOnly === true,
        mode,
        source: opts.source,
        input, output, args,
        defaultSink: opts.defaultSink,
        isSink,
        hidden,
    });
}

function isExtractable(source: string): boolean {
    return source.endsWith(".ts") || source.endsWith(".mts");
}

function sourceToAbsPath(source: string): string | null {
    if (source.startsWith("file://")) {
        try { return fileURLToPath(source); } catch { return null; }
    }
    if (source.startsWith("/")) return source;
    return null;
}

const extractInFlight = new Set<string>();
async function scheduleExtract(absPath: string): Promise<void> {
    if (extractInFlight.has(absPath)) return;
    extractInFlight.add(absPath);
    try {
        const { extractSchemas } = await import("../structured/extract/index.js");
        const { schemaFile } = extractSchemas(absPath);
        await cacheStore(absPath, schemaFile);
    } catch {
        // Extraction failures are non-fatal — registry just keeps no-schema entry.
    } finally {
        extractInFlight.delete(absPath);
    }
}

// Look up a function for explicit @-prefixed invocation. Returns the
// function regardless of atOnly.
export function lookupJsFunction(name: string): JsPipelineFunction | undefined {
    return registry.get(name)?.fn;
}

// Look up a function for bare-name invocation. Returns undefined for
// atOnly functions so the resolver falls through to other sources.
export function lookupBareJsFunction(name: string): JsPipelineFunction | undefined {
    const entry = registry.get(name);
    if (!entry || entry.atOnly) return undefined;
    return entry.fn;
}

// Full registry-entry lookup (mode, schemas, etc.) for callers that need
// more than just the function — the executor's object-mode pipeline path
// and the future unifier.
export function lookupJsFunctionEntry(name: string): Readonly<RegistryEntry> | undefined {
    return registry.get(name);
}

export function listJsFunctions(): string[] {
    return [...registry.keys()];
}

// List function names that are callable via bare-name (excludes atOnly
// and hidden entries).
export function listBareJsFunctions(): string[] {
    const out: string[] = [];
    for (const [name, entry] of registry) {
        if (entry.atOnly) continue;
        if (entry.hidden) continue;
        out.push(name);
    }
    return out;
}

// List @-callable function names, excluding hidden entries (formatters etc.
// registered as sinks). Used by @-prefix tab completion.
export function listVisibleJsFunctions(): string[] {
    const out: string[] = [];
    for (const [name, entry] of registry) {
        if (!entry.hidden) out.push(name);
    }
    return out;
}
