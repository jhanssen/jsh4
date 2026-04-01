// Public jsh API — available as globals in .jshrc and importable directly.

export { $ } from "../variables/index.js";
export { registerJsFunction } from "../jsfunctions/index.js";
export { exec } from "../exec/index.js";
export type { ExecResult, ExecOptions } from "../exec/index.js";
export { registerCompletion } from "../completion/index.js";

// ---- Prompt -----------------------------------------------------------------

let promptFn: (() => string) | null = null;

export function setPrompt(fn: () => string): void {
    promptFn = fn;
}

export function getPrompt(): string {
    if (!promptFn) return "$ ";
    try {
        return promptFn();
    } catch {
        return "$ ";
    }
}

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
