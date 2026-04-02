import { readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { $ } from "../variables/index.js";
import { getAlias } from "../api/index.js";
import { listJsFunctions } from "../jsfunctions/index.js";

// ---- Completion entry type --------------------------------------------------

export type CompletionEntry = string | { text: string; desc?: string };

/** Split CompletionEntry[] into parallel texts[] and descs[] arrays for C++. */
export function normalizeEntries(entries: CompletionEntry[]): { texts: string[]; descs: string[] } {
    const texts: string[] = [];
    const descs: string[] = [];
    for (const e of entries) {
        if (typeof e === "string") {
            texts.push(e);
            descs.push("");
        } else {
            texts.push(e.text);
            descs.push(e.desc ?? "");
        }
    }
    return { texts, descs };
}

/** Extract the text value from a CompletionEntry. */
export function entryText(e: CompletionEntry): string {
    return typeof e === "string" ? e : e.text;
}

// ---- User-defined completion handlers ---------------------------------------

type CompletionCtx = { words: string[]; current: string };
type CompletionFn = (ctx: CompletionCtx) => CompletionEntry[] | Promise<CompletionEntry[]>;

const handlers = new Map<string, CompletionFn>();

export function registerCompletion(cmd: string, fn: CompletionFn): void {
    handlers.set(cmd, fn);
}

// ---- Built-in completions ---------------------------------------------------

const BUILTINS_LIST = [
    "cd", "exit", "export", "unset", "source", "eval", "exec",
    "jobs", "fg", "bg", "alias", "unalias", "set", "shift",
    "read", "echo", "printf", "test", "true", "false", "type",
    "which", "local", "kill", "disown", "hash", "let", "declare",
    "time", "pwd", "umask", "ulimit", "command", "readonly",
    "getopts", "trap", "return", "break", "continue",
    "pushd", "popd", "dirs", "basename", "dirname", "select",
];
const BUILTINS_SET = new Set(BUILTINS_LIST);

// Cached PATH command list — rebuilt when PATH changes.
let pathCache: string[] | null = null;
let lastPath: string | undefined;
let pathSet: Set<string> | null = null;

export function commandExists(name: string): boolean {
    if (BUILTINS_SET.has(name)) return true;
    getPathCommands(); // ensure cache is populated
    return pathSet!.has(name);
}

function getPathCommands(): string[] {
    const path = String($["PATH"] ?? process.env["PATH"] ?? "");
    if (pathCache && lastPath === path) return pathCache;
    lastPath = path;
    const cmds = new Set<string>();
    for (const dir of path.split(":")) {
        try {
            for (const f of readdirSync(dir)) cmds.add(f);
        } catch { /* skip unreadable dirs */ }
    }
    pathSet = cmds;
    pathCache = [...cmds].sort();
    return pathCache;
}

function expandTilde(s: string): string {
    if (s === "~" || s.startsWith("~/")) {
        return String($["HOME"] ?? homedir()) + s.slice(1);
    }
    return s;
}

function completeFile(prefix: string): string[] {
    const expanded = expandTilde(prefix);
    let dir: string, base: string;
    if (expanded.endsWith("/")) {
        // Trailing slash — list contents of that directory.
        dir  = expanded.slice(0, -1) || "/";
        base = "";
    } else if (expanded.includes("/")) {
        dir  = dirname(expanded) || "/";
        base = basename(expanded);
    } else {
        dir  = ".";
        base = expanded;
    }
    const hasSlash = expanded.includes("/");
    const showDotFiles = base.startsWith(".");

    try {
        const entries = readdirSync(dir);
        return entries
            .filter(e => e.startsWith(base) && (showDotFiles || !e.startsWith(".")))
            .map(e => {
                const full = dir === "." ? e : join(dir, e);
                try {
                    const isDir = statSync(full).isDirectory();
                    const result = expanded.endsWith("/")
                        ? prefix + e                    // trailing slash: keep full prefix
                        : hasSlash
                        ? join(dirname(prefix), e)      // has slash but no trailing
                        : e;
                    return isDir ? result + "/" : result;
                } catch {
                    return expanded.endsWith("/") ? prefix + e
                         : hasSlash ? join(dirname(prefix), e) : e;
                }
            })
            .sort();
    } catch { return []; }
}

function completeCommand(prefix: string): string[] {
    const candidates = [
        ...BUILTINS_LIST,
        ...getPathCommands(),
        ...listJsFunctions().map(f => "@" + f),
        ...[...handlers.keys()],
    ];
    // Include aliases too.
    // (aliasMap is private; getAlias checks one at a time — skip for perf)

    return [...new Set(candidates)]
        .filter(c => c.startsWith(prefix))
        .sort();
}

// ---- Main completion entry point --------------------------------------------

// Splits the input into words, handling simple quoting.
function splitWords(input: string): string[] {
    const words: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;

    for (const ch of input) {
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
            if (current) { words.push(current); current = ""; }
            continue;
        }
        current += ch;
    }
    if (current || input.endsWith(" ") || input.endsWith("\t")) words.push(current);
    return words;
}

/** Prepend inputPrefix to each entry's text, preserving description. */
function prefixEntries(entries: CompletionEntry[], inputPrefix: string): CompletionEntry[] {
    if (!inputPrefix) return entries;
    return entries.map(e => {
        if (typeof e === "string") return inputPrefix + e;
        return { text: inputPrefix + e.text, desc: e.desc };
    });
}

export function getCompletions(input: string): CompletionEntry[] | Promise<CompletionEntry[]> {
    const words = splitWords(input);
    const isFirstWord = words.length === 0 || (words.length === 1 && !input.endsWith(" ") && !input.endsWith("\t"));
    const current = isFirstWord ? (words[0] ?? "") : (input.endsWith(" ") || input.endsWith("\t") ? "" : (words[words.length - 1] ?? ""));

    // Prefix of the input before the current word.
    const prefixLen = input.length - current.length;
    const inputPrefix = input.slice(0, prefixLen);

    if (isFirstWord) {
        // Complete as a command name (always sync).
        let candidates: string[];
        if (current.startsWith("@")) {
            candidates = listJsFunctions()
                .map(f => "@" + f)
                .filter(f => f.startsWith(current));
        } else {
            candidates = completeCommand(current);
        }
        return candidates.map(c => inputPrefix + c);
    }

    const cmd = words[0] ?? "";
    const handler = handlers.get(cmd);
    if (handler) {
        const result = handler({ words, current });
        if (result && typeof (result as Promise<CompletionEntry[]>).then === "function") {
            // Async handler — propagate the promise.
            return (result as Promise<CompletionEntry[]>).then(
                candidates => prefixEntries(candidates, inputPrefix)
            );
        }
        return prefixEntries(result as CompletionEntry[], inputPrefix);
    }

    // Default: file completion (sync).
    return completeFile(current).map(c => inputPrefix + c);
}
