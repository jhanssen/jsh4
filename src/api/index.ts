// Public jsh API — available as globals in .jshrc and importable directly.

export { $ } from "../variables/index.js";
export { registerJsFunction } from "../jsfunctions/index.js";
export { exec } from "../exec/index.js";
export type { ExecResult, ExecOptions } from "../exec/index.js";
export { registerCompletion } from "../completion/index.js";

// ---- Prompt -----------------------------------------------------------------

let promptFn: (() => string | Promise<string>) | null = null;

export function setPrompt(fn: () => string | Promise<string>): void {
    promptFn = fn;
}

export function getPrompt(): string {
    if (!promptFn) return "$ ";
    try {
        const result = promptFn();
        // Sync path for backward compat
        if (typeof result === "string") return result;
        return "$ ";
    } catch {
        return "$ ";
    }
}

export async function getPromptAsync(): Promise<string> {
    if (!promptFn) return "$ ";
    try {
        return await promptFn();
    } catch {
        return "$ ";
    }
}

// ---- Right Prompt -----------------------------------------------------------

let rightPromptFn: (() => string | Promise<string>) | null = null;

export function setRightPrompt(fn: (() => string | Promise<string>) | null): void {
    rightPromptFn = fn;
}

export async function getRightPromptAsync(): Promise<string> {
    if (!rightPromptFn) return "";
    try {
        return await rightPromptFn();
    } catch {
        return "";
    }
}

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
