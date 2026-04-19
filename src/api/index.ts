// Public jsh API — available as globals in .jshrc and importable directly.

export { $ } from "../variables/index.js";
export { registerJsFunction } from "../jsfunctions/index.js";
export { exec } from "../exec/index.js";
export type { ExecResult, ExecOptions } from "../exec/index.js";
export { registerCompletion } from "../completion/index.js";

// ---- Colorize ---------------------------------------------------------------

let colorizeFn: ((input: string) => string) | null = null;

export function setColorize(fn: ((input: string) => string) | null): void {
    colorizeFn = fn;
}

export function getColorize(): ((input: string) => string) | null {
    return colorizeFn;
}

export { setTheme, getCurrentTheme } from "../colorize/index.js";

// ---- Aliases ----------------------------------------------------------------

const aliasMap = new Map<string, string>();

export function alias(name: string, expansion: string): void {
    aliasMap.set(name, expansion);
}

export function unalias(name: string): void {
    aliasMap.delete(name);
}

export function getAlias(name: string): string | undefined {
    return aliasMap.get(name);
}

export function getAllAliases(): Iterable<[string, string]> {
    return aliasMap.entries();
}
