import { readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { $ } from "../variables/index.js";
import { getAlias } from "../api/index.js";
import { listJsFunctions, listBareJsFunctions } from "../jsfunctions/index.js";
import { Lexer, TokenType } from "../parser/lexer.js";
import type { Token } from "../parser/lexer.js";

// ---- Completion entry type --------------------------------------------------

export type CompletionEntry = string | { text: string; desc?: string };

// Lexer-driven completion result. `replaceStart` / `replaceEnd` are byte
// offsets into the full buffer; the native engine splices entries in by
// replacing buf[replaceStart..replaceEnd]. Entries are bare candidates —
// NOT pre-prefixed with the buffer text up to the cursor.
export interface CompletionResult {
    entries: CompletionEntry[];
    replaceStart: number;
    replaceEnd: number;
}

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

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch { return []; }

    const visible = names.filter(e => showDotFiles || !e.startsWith("."));
    // Strict prefix first; if empty and base is non-empty, fall back to
    // substring match (zsh's `r:|?=**`-style matcher).
    let matched = visible.filter(e => e.startsWith(base));
    if (matched.length === 0 && base.length > 0) {
        matched = visible.filter(e => e.includes(base));
    }

    return matched
        .map(e => {
            const full = dir === "." ? e : join(dir, e);
            try {
                const isDir = statSync(full).isDirectory();
                const result = expanded.endsWith("/")
                    ? prefix + e
                    : hasSlash
                    ? join(dirname(prefix), e)
                    : e;
                return isDir ? result + "/" : result;
            } catch {
                return expanded.endsWith("/") ? prefix + e
                     : hasSlash ? join(dirname(prefix), e) : e;
            }
        })
        .sort();
}

function completeCommand(prefix: string): string[] {
    const candidates = [
        ...BUILTINS_LIST,
        ...getPathCommands(),
        // Bare-name callable JS functions (atOnly ones are only reachable
        // through the @-prefixed form, added via the "@" branch below).
        ...listBareJsFunctions(),
        // @-prefixed forms of every registered JS function.
        ...listJsFunctions().map(f => "@" + f),
        ...[...handlers.keys()],
    ];
    // Include aliases too.
    // (aliasMap is private; getAlias checks one at a time — skip for perf)

    const unique = [...new Set(candidates)];
    let matched = unique.filter(c => c.startsWith(prefix));
    if (matched.length === 0 && prefix.length > 0) {
        matched = unique.filter(c => c.includes(prefix));
    }
    return matched.sort();
}

// ---- Main completion entry point --------------------------------------------

// Byte offset i is "inside" token t if it falls within [t.start, t.end) OR
// (special case for Word tokens) sits exactly at t.end — the cursor-at-end
// of a word is still that word. Separator tokens at exactly t.end are NOT
// treated as "inside" because a pipe/semi ends a command cleanly.
function cursorInToken(t: Token, cursor: number): boolean {
    if (cursor >= t.start && cursor < t.end) return true;
    if (t.type === TokenType.Word && cursor === t.end) return true;
    return false;
}

// Walk the token stream up to (but not including) the cursor to determine
// command context: is the current token in command position (first word
// after a separator), and if in argument position, what's the command?
function findCommandContext(tokens: Token[], cursorToken: Token | null, cursor: number):
    { isFirstWord: boolean; cmd: string; words: string[] } {
    let isFirstWord = true;
    let cmd = "";
    const words: string[] = [];
    for (const t of tokens) {
        if (t === cursorToken) break;
        // Stop at cursor even if we're between tokens (cursor in whitespace).
        if (!cursorToken && t.start >= cursor) break;
        if (t.type === TokenType.EOF) continue;
        if (t.type === TokenType.Pipe || t.type === TokenType.PipeAnd ||
            t.type === TokenType.And  || t.type === TokenType.Or      ||
            t.type === TokenType.Semi || t.type === TokenType.Newline ||
            t.type === TokenType.LParen || t.type === TokenType.LBrace ||
            t.type === TokenType.CaseSemi) {
            isFirstWord = true;
            cmd = "";
            words.length = 0;
            continue;
        }
        if (t.type === TokenType.Word) {
            if (isFirstWord) {
                cmd = t.value;
                isFirstWord = false;
            }
            words.push(t.value);
        }
    }
    return { isFirstWord, cmd, words };
}

// Locate the token at the cursor (or null if the cursor sits in whitespace
// between tokens).
function findCursorToken(tokens: Token[], cursor: number): Token | null {
    for (const t of tokens) {
        if (t.type === TokenType.EOF) continue;
        if (cursorInToken(t, cursor)) return t;
    }
    return null;
}

// Variable completion: given `$FOO<cursor>` or `${FOO<cursor>` inside a Word
// token, returns the completion result matching available env/shell vars —
// or null if the cursor isn't inside such a context.
function tryVariableCompletion(buf: string, cursor: number): CompletionResult | null {
    // Scan backward from cursor over identifier chars — that's the partial
    // variable name.
    let nameStart = cursor;
    while (nameStart > 0 && /[A-Za-z0-9_]/.test(buf[nameStart - 1]!)) nameStart--;
    // Immediately before nameStart we expect `$` or `${`.
    if (nameStart >= 1 && buf[nameStart - 1] === "$") {
        // ok: $NAME
    } else if (nameStart >= 2 && buf[nameStart - 1] === "{" && buf[nameStart - 2] === "$") {
        // ok: ${NAME
    } else {
        return null;
    }
    const prefix = buf.slice(nameStart, cursor);
    const names = new Set<string>([
        ...Object.keys($),
        ...Object.keys(process.env),
    ]);
    const candidates = [...names].filter(n => n.startsWith(prefix)).sort();
    return { entries: candidates, replaceStart: nameStart, replaceEnd: cursor };
}

export function getCompletions(buf: string, cursor?: number): CompletionResult | Promise<CompletionResult> {
    const pos = cursor ?? buf.length;

    // Variable completion is lexer-independent (it works even inside a
    // partially-typed string). Try it first.
    const varResult = tryVariableCompletion(buf, pos);
    if (varResult) return varResult;

    // Lex the buffer up to the cursor in partial mode so unterminated quotes
    // / braces don't throw. We only inspect tokens before or at the cursor.
    let tokens: Token[];
    try {
        tokens = new Lexer(buf, { partial: true }).getTokens();
    } catch {
        return { entries: [], replaceStart: pos, replaceEnd: pos };
    }

    const cursorToken = findCursorToken(tokens, pos);
    // Compute replacement range:
    //  - cursor inside a Word token → replace the whole token.
    //  - cursor in whitespace between tokens → empty range at cursor.
    //  - cursor inside any other token type → don't attempt completion.
    let replaceStart = pos;
    let replaceEnd = pos;
    let current = "";
    if (cursorToken) {
        if (cursorToken.type !== TokenType.Word) {
            return { entries: [], replaceStart: pos, replaceEnd: pos };
        }
        replaceStart = cursorToken.start;
        replaceEnd = cursorToken.end;
        // Filter using the WHOLE word as the prefix, regardless of where in
        // the word the cursor sits. If we used only the prefix-before-cursor,
        // cursor-on-word-start would give an empty filter — showing every
        // file instead of the intended matches. The whole word is then
        // replaced on accept.
        current = cursorToken.value;
    }

    const ctx = findCommandContext(tokens, cursorToken, pos);

    if (ctx.isFirstWord) {
        let candidates: string[];
        if (current.startsWith("@")) {
            candidates = listJsFunctions()
                .map(f => "@" + f)
                .filter(f => f.startsWith(current));
        } else {
            candidates = completeCommand(current);
        }
        return { entries: candidates, replaceStart, replaceEnd };
    }

    const handler = handlers.get(ctx.cmd);
    if (handler) {
        const result = handler({ words: [...ctx.words, current], current });
        const wrap = (entries: CompletionEntry[]): CompletionResult =>
            ({ entries, replaceStart, replaceEnd });
        if (result && typeof (result as Promise<CompletionEntry[]>).then === "function") {
            return (result as Promise<CompletionEntry[]>).then(wrap);
        }
        return wrap(result as CompletionEntry[]);
    }

    // Default argument completion: filesystem.
    return { entries: completeFile(current), replaceStart, replaceEnd };
}
