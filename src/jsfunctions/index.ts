// Registry for @ JS pipeline functions.
// Functions are registered by name and called when @name appears in a pipeline.
//
// Calling convention:
//   fn(args: string[], stdin: AsyncIterable<string> | null) => ReturnType
//
// stdin yields plain lines: no trailing "\n" and no trailing "\r" (CRLF is
// normalized). Empty lines yield "" (still a distinct iteration). Matches
// Node readline / Go bufio.Scanner / Rust .lines().
//
// Generators that yield strings have those strings written to stdout raw —
// no separators inserted. A function emitting line-delimited output must
// include its own "\n":
//     for await (const line of stdin) yield line.toUpperCase() + "\n";
// Buffered return values (plain string) are written as-is.
//
// Return types handled by the executor:
//   string | Buffer       → written to stdout
//   AsyncGenerator        → each yielded value written to stdout (raw, no sep)
//   Generator             → same
//   Promise               → awaited, then above rules applied
//   void / undefined      → nothing written, exit 0
//   throw / reject        → exit 1, error to stderr

export type JsPipelineFunction = (
    args: string[],
    stdin: AsyncIterable<string> | null
) => unknown;

export interface JsFunctionOptions {
    // When true, this function is callable only via the @-prefixed form
    // (@name). Bare-name resolution skips it, so a same-named alias,
    // shell function, builtin, or PATH command can still be invoked
    // without the prefix.
    atOnly?: boolean;
}

interface RegistryEntry {
    fn: JsPipelineFunction;
    atOnly: boolean;
}

const registry = new Map<string, RegistryEntry>();

export function registerJsFunction(
    name: string,
    fn: JsPipelineFunction,
    opts: JsFunctionOptions = {},
): void {
    registry.set(name, { fn, atOnly: opts.atOnly === true });
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

export function listJsFunctions(): string[] {
    return [...registry.keys()];
}

// List function names that are callable via bare-name (excludes atOnly).
// Used by tab completion and `type`.
export function listBareJsFunctions(): string[] {
    const out: string[] = [];
    for (const [name, entry] of registry) {
        if (!entry.atOnly) out.push(name);
    }
    return out;
}
