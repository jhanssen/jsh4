// History — thin wrapper over the native input-engine store. The C++ side
// is the single source of truth; this module exists to keep call sites
// (history expansion, jsh.history(), etc.) decoupled from N-API details.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const native = require("../../build/Release/jsh_native.node") as {
    inputHistoryAdd: (line: string) => void;
    inputHistoryCount: () => number;
    inputHistoryGet: (idx: number) => string | null;
    inputHistoryAll: () => string[];
    inputHistorySearchPrefix: (prefix: string) => string | null;
};

export function addHistoryEntry(line: string): void {
    native.inputHistoryAdd(line);
}

export function getHistoryEntry(n: number): string | undefined {
    // !n is 1-based across the full (finalized) history.
    if (n <= 0) return undefined;
    return native.inputHistoryGet(n - 1) ?? undefined;
}

export function getLastEntry(): string | undefined {
    const n = native.inputHistoryCount();
    if (n === 0) return undefined;
    return native.inputHistoryGet(n - 1) ?? undefined;
}

export function getEntryFromEnd(n: number): string | undefined {
    const len = native.inputHistoryCount();
    if (n <= 0 || n > len) return undefined;
    return native.inputHistoryGet(len - n) ?? undefined;
}

export function searchHistory(prefix: string): string | undefined {
    return native.inputHistorySearchPrefix(prefix) ?? undefined;
}

export function getHistoryLength(): number {
    return native.inputHistoryCount();
}

export function getAllEntries(): string[] {
    return native.inputHistoryAll();
}

// Expand history references in an input line.
// Returns the expanded line, or null if no expansion occurred.
export function expandHistory(input: string): string | null {
    // Don't expand inside single quotes.
    let changed = false;
    let result = "";
    let i = 0;

    while (i < input.length) {
        // Skip single-quoted regions
        if (input[i] === "'") {
            const end = input.indexOf("'", i + 1);
            if (end === -1) {
                result += input.slice(i);
                break;
            }
            result += input.slice(i, end + 1);
            i = end + 1;
            continue;
        }

        // Skip double-quoted regions (history expansion in double quotes is
        // allowed by some shells but jsh doesn't need it and it breaks JS
        // string literals inside @{ } blocks).
        if (input[i] === '"') {
            let j = i + 1;
            while (j < input.length) {
                if (input[j] === "\\" && j + 1 < input.length) { j += 2; continue; }
                if (input[j] === '"') { j++; break; }
                j++;
            }
            result += input.slice(i, j);
            i = j;
            continue;
        }

        // Skip @{ ... } and @!{ ... } JS inline blocks — JavaScript, not shell.
        if (input[i] === "@" && i + 1 < input.length &&
            (input[i + 1] === "{" ||
             (input[i + 1] === "!" && i + 2 < input.length && input[i + 2] === "{"))) {
            const openLen = input[i + 1] === "!" ? 3 : 2;
            let j = i + openLen;
            let depth = 1;
            while (j < input.length && depth > 0) {
                const ch = input[j]!;
                if (ch === "\\" && j + 1 < input.length) { j += 2; continue; }
                if (ch === "'" || ch === '"' || ch === "`") {
                    const q = ch;
                    j++;
                    while (j < input.length) {
                        if (input[j] === "\\" && j + 1 < input.length) { j += 2; continue; }
                        if (input[j] === q) { j++; break; }
                        j++;
                    }
                    continue;
                }
                if (ch === "{") depth++;
                else if (ch === "}") depth--;
                j++;
            }
            result += input.slice(i, j);
            i = j;
            continue;
        }

        // Skip escaped !
        if (input[i] === "\\" && i + 1 < input.length && input[i + 1] === "!") {
            result += "!";
            i += 2;
            changed = true;
            continue;
        }

        if (input[i] !== "!") {
            result += input[i];
            i++;
            continue;
        }

        // ! at end of input or before space — literal
        if (i + 1 >= input.length || input[i + 1] === " " || input[i + 1] === "\t" || input[i + 1] === "=") {
            result += "!";
            i++;
            continue;
        }

        const next = input[i + 1]!;

        // !! — last command
        if (next === "!") {
            const last = getLastEntry();
            if (!last) {
                process.stderr.write("jsh: !!: event not found\n");
                return null;
            }
            result += last;
            i += 2;
            changed = true;
            continue;
        }

        // !$ — last argument of last command
        if (next === "$") {
            const last = getLastEntry();
            if (!last) {
                process.stderr.write("jsh: !$: event not found\n");
                return null;
            }
            const words = last.trim().split(/\s+/);
            result += words[words.length - 1]!;
            i += 2;
            changed = true;
            continue;
        }

        // !^ — first argument of last command
        if (next === "^") {
            const last = getLastEntry();
            if (!last) {
                process.stderr.write("jsh: !^: event not found\n");
                return null;
            }
            const words = last.trim().split(/\s+/);
            result += words.length > 1 ? words[1]! : "";
            i += 2;
            changed = true;
            continue;
        }

        // !-N — Nth previous command
        if (next === "-") {
            let num = "";
            let j = i + 2;
            while (j < input.length && input[j]! >= "0" && input[j]! <= "9") {
                num += input[j]; j++;
            }
            if (num) {
                const entry = getEntryFromEnd(parseInt(num, 10));
                if (!entry) {
                    process.stderr.write(`jsh: !-${num}: event not found\n`);
                    return null;
                }
                result += entry;
                i = j;
                changed = true;
                continue;
            }
        }

        // !N — command number N
        if (next >= "0" && next <= "9") {
            let num = "";
            let j = i + 1;
            while (j < input.length && input[j]! >= "0" && input[j]! <= "9") {
                num += input[j]; j++;
            }
            const entry = getHistoryEntry(parseInt(num, 10));
            if (!entry) {
                process.stderr.write(`jsh: !${num}: event not found\n`);
                return null;
            }
            result += entry;
            i = j;
            changed = true;
            continue;
        }

        // !string — most recent command starting with string
        if (/[a-zA-Z_\/.]/.test(next)) {
            let prefix = "";
            let j = i + 1;
            while (j < input.length && input[j] !== " " && input[j] !== "\t" && input[j] !== "\n") {
                prefix += input[j]; j++;
            }
            const entry = searchHistory(prefix);
            if (!entry) {
                process.stderr.write(`jsh: !${prefix}: event not found\n`);
                return null;
            }
            result += entry;
            i = j;
            changed = true;
            continue;
        }

        // Unrecognized ! pattern — pass through literally
        result += "!";
        i++;
    }

    return changed ? result : input;
}
