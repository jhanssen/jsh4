import { readdirSync, statSync, globSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { $ } from "../variables/index.js";
import { getAlias } from "../api/index.js";
import { listJsFunctions, listBareJsFunctions } from "../jsfunctions/index.js";
import { Lexer, TokenType } from "../parser/lexer.js";
import type { Token } from "../parser/lexer.js";

// ---- Completion entry type --------------------------------------------------

// `text` is the value spliced into the buffer on accept.
// `display` (optional) is what the menu grid shows for this entry — handy
//    when entries share a common directory prefix (`src/api/`, `src/completion/`)
//    and you want just the basenames on screen but the full path on accept.
//    Defaults to `text`.
// `desc` is a description (future: second column in the grid).
export type CompletionEntry = string | { text: string; display?: string; desc?: string };

// Lexer-driven completion result. `replaceStart` / `replaceEnd` are byte
// offsets into the full buffer; the native engine splices entries in by
// replacing buf[replaceStart..replaceEnd]. Entries are bare candidates —
// NOT pre-prefixed with the buffer text up to the cursor.
export interface CompletionResult {
    entries: CompletionEntry[];
    replaceStart: number;
    replaceEnd: number;
    // `ambiguous` means "this is a longest-common-prefix extension of the
    // underlying match list, not a final commit". The native splice uses it
    // to suppress auto-space so the user can press Tab again to see the
    // remaining candidates.
    ambiguous?: boolean;
}

/**
 * Split CompletionEntry[] into parallel arrays for C++.
 * - texts: spliced on accept.
 * - displays: shown in the menu grid (falls back to text when unset).
 * - descs: optional description.
 */
export function normalizeEntries(entries: CompletionEntry[]): { texts: string[]; displays: string[]; descs: string[] } {
    const texts: string[] = [];
    const displays: string[] = [];
    const descs: string[] = [];
    for (const e of entries) {
        if (typeof e === "string") {
            texts.push(e);
            displays.push(e);
            descs.push("");
        } else {
            texts.push(e.text);
            displays.push(e.display ?? e.text);
            descs.push(e.desc ?? "");
        }
    }
    return { texts, displays, descs };
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

function completeFile(prefix: string): CompletionEntry[] {
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

    const results: CompletionEntry[] = matched.map(e => {
        const full = dir === "." ? e : join(dir, e);
        let isDir = false;
        try { isDir = statSync(full).isDirectory(); } catch { /* ignore */ }
        const text = expanded.endsWith("/")
            ? prefix + e
            : hasSlash
            ? join(dirname(prefix), e)
            : e;
        const finalText = isDir ? text + "/" : text;
        const finalDisplay = isDir ? e + "/" : e;
        // Only emit a display override if it differs from the text (i.e. the
        // entry has a directory prefix). Avoids churn for simple cases.
        return finalText === finalDisplay
            ? finalText
            : { text: finalText, display: finalDisplay };
    });
    results.sort((a, b) => {
        const at = typeof a === "string" ? a : a.text;
        const bt = typeof b === "string" ? b : b.text;
        return at < bt ? -1 : at > bt ? 1 : 0;
    });
    return results;
}

// If prefix contains glob metacharacters (* ? [), expand it via fs.globSync
// and return literal matches. Falls back to regular completeFile otherwise.
function completeFileOrGlob(prefix: string): CompletionEntry[] {
    if (!/[*?[]/.test(prefix)) return completeFile(prefix);
    const expanded = expandTilde(prefix);
    try {
        const raw = [...globSync(expanded)].map(m => {
            try { return statSync(m).isDirectory() ? m + "/" : m; }
            catch { return m; }
        });
        raw.sort();
        // Glob matches are full-path; strip shared leading directory for the
        // menu display (same rationale as completeFile).
        return raw.map(m => {
            const b = basename(m.replace(/\/$/, ""));
            const display = m.endsWith("/") ? b + "/" : b;
            return m === display ? m : { text: m, display };
        });
    } catch {
        return completeFile(prefix);
    }
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

// Commands that are "command-position modifiers": if they appear as the
// first word and are followed by more text, the following word is ALSO a
// command (e.g. `sudo git ...` → `git` should be command-completed).
const MODIFIER_COMMANDS = new Set([
    "sudo", "env", "time", "nohup", "command", "builtin", "exec",
]);

// Walk the token stream up to (but not including) the cursor to determine
// command context: is the current token in command position (first word
// after a separator), and if in argument position, what's the command?
// Also reports whether the immediately preceding non-EOF, non-whitespace
// token was a Redirect (`>`, `>>`, `<`, `>&`, …) — in that case the cursor
// word is a redirection target and should file-complete regardless of the
// enclosing command.
function findCommandContext(tokens: Token[], cursorToken: Token | null, cursor: number):
    { isFirstWord: boolean; cmd: string; words: string[]; prevIsRedirect: boolean } {
    let isFirstWord = true;
    let cmd = "";
    let words: string[] = [];
    let lastNonWord: Token | null = null;
    for (const t of tokens) {
        if (t === cursorToken) break;
        if (!cursorToken && t.start >= cursor) break;
        if (t.type === TokenType.EOF) continue;
        if (t.type === TokenType.Pipe || t.type === TokenType.PipeAnd ||
            t.type === TokenType.And  || t.type === TokenType.Or      ||
            t.type === TokenType.Semi || t.type === TokenType.Newline ||
            t.type === TokenType.LParen || t.type === TokenType.LBrace ||
            t.type === TokenType.CaseSemi) {
            isFirstWord = true;
            cmd = "";
            words = [];
            lastNonWord = t;
            continue;
        }
        if (t.type === TokenType.Redirect) {
            lastNonWord = t;
            continue;
        }
        if (t.type === TokenType.Word) {
            if (isFirstWord) {
                cmd = t.value;
                isFirstWord = false;
            } else if (words.length === 1 && MODIFIER_COMMANDS.has(cmd)) {
                // Modifier (`sudo`, `env`, …) promotes its first argument back
                // to command position: everything after the modifier is itself
                // a command line.
                cmd = t.value;
                words = [];
                isFirstWord = false;
            }
            words.push(t.value);
            lastNonWord = null;
        }
    }
    const prevIsRedirect = lastNonWord !== null && lastNonWord.type === TokenType.Redirect;
    // Post-loop promotion: if the cursor word is the one that *immediately*
    // follows a modifier (`sudo <cursor>`), treat it as command position.
    if (cmd && words.length === 1 && MODIFIER_COMMANDS.has(cmd)) {
        isFirstWord = true;
        cmd = "";
        words = [];
    }
    return { isFirstWord, cmd, words, prevIsRedirect };
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

function longestCommonPrefix(strs: string[]): string {
    if (strs.length === 0) return "";
    let lcp = strs[0]!;
    for (let i = 1; i < strs.length; i++) {
        const s = strs[i]!;
        const max = Math.min(lcp.length, s.length);
        let j = 0;
        while (j < max && lcp[j] === s[j]) j++;
        lcp = lcp.slice(0, j);
        if (lcp === "") break;
    }
    return lcp;
}

// Wrap a raw entries list into a CompletionResult, collapsing to an LCP
// pseudo-match when the matches still share a common prefix longer than
// what's typed — zsh's ambiguous-Tab behavior. The native splice sees the
// `ambiguous` flag and skips auto-space so the next Tab re-queries and
// shows the (now narrower) list.
function makeResult(
    entries: CompletionEntry[],
    replaceStart: number,
    replaceEnd: number,
    buf: string,
): CompletionResult {
    if (entries.length <= 1) return { entries, replaceStart, replaceEnd };
    const texts = entries.map(e => typeof e === "string" ? e : e.text);
    const lcp = longestCommonPrefix(texts);
    const typed = buf.slice(replaceStart, replaceEnd);
    if (lcp.length > typed.length) {
        return { entries: [lcp], replaceStart, replaceEnd, ambiguous: true };
    }
    return { entries, replaceStart, replaceEnd };
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

    // Redirection target (`cmd > f<cursor>`): always file-complete regardless
    // of the enclosing command.
    if (ctx.prevIsRedirect) {
        return makeResult(completeFile(current), replaceStart, replaceEnd, buf);
    }

    // Assignment RHS (`FOO=b<cursor>`): split at `=`, complete the value as
    // a file and adjust the replacement range so the `FOO=` part survives.
    const eqMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(current);
    if (eqMatch) {
        const eqEnd = eqMatch[0]!.length;
        const value = current.slice(eqEnd);
        const valueEntries = completeFileOrGlob(value);
        return makeResult(valueEntries, replaceStart + eqEnd, replaceEnd, buf);
    }

    if (ctx.isFirstWord) {
        let candidates: string[];
        if (current.startsWith("@")) {
            candidates = listJsFunctions()
                .map(f => "@" + f)
                .filter(f => f.startsWith(current));
        } else {
            candidates = completeCommand(current);
        }
        return makeResult(candidates, replaceStart, replaceEnd, buf);
    }

    const handler = handlers.get(ctx.cmd);
    if (handler) {
        const result = handler({ words: [...ctx.words, current], current });
        if (result && typeof (result as Promise<CompletionEntry[]>).then === "function") {
            return (result as Promise<CompletionEntry[]>).then(
                entries => makeResult(entries, replaceStart, replaceEnd, buf)
            );
        }
        return makeResult(result as CompletionEntry[], replaceStart, replaceEnd, buf);
    }

    // Default argument completion: filesystem (with glob support).
    return makeResult(completeFileOrGlob(current), replaceStart, replaceEnd, buf);
}
