// Registry for @ JS pipeline functions.
// Functions are registered by name and called when @name appears in a pipeline.
//
// Calling convention:
//   fn(args: string[], stdin: AsyncIterable<string> | null) => ReturnType
//
// Return types handled by the executor:
//   string | Buffer       → written to stdout
//   AsyncGenerator        → each yielded value written to stdout
//   Generator             → same
//   Promise               → awaited, then above rules applied
//   void / undefined      → nothing written, exit 0
//   throw / reject        → exit 1, error to stderr

export type JsPipelineFunction = (
    args: string[],
    stdin: AsyncIterable<string> | null
) => unknown;

const registry = new Map<string, JsPipelineFunction>();

export function registerJsFunction(name: string, fn: JsPipelineFunction): void {
    registry.set(name, fn);
}

export function lookupJsFunction(name: string): JsPipelineFunction | undefined {
    return registry.get(name);
}

export function listJsFunctions(): string[] {
    return [...registry.keys()];
}
