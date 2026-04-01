import type {
    Word, WordSegment, VariableExpansion, CommandSubstitution,
    LiteralSegment, SingleQuotedSegment, DoubleQuotedSegment,
} from "../parser/index.js";
import { $ } from "../variables/index.js";
import { getParam, getAllParams, getParamCount } from "../variables/positional.js";
import { shellOpts } from "../shellopts/index.js";
import { glob } from "node:fs/promises";
import * as os from "node:os";

// Registered by the executor to break the circular dependency.
type CaptureFunc = (body: string) => Promise<string>;
let captureImpl: CaptureFunc = async () => "";
export function registerCaptureImpl(fn: CaptureFunc): void { captureImpl = fn; }

// expandWord: returns potentially multiple strings after brace + glob expansion.
// Use this for command arguments.
export async function expandWord(word: Word): Promise<string[]> {
    const hasGlob = word.segments.some(s => s.type === "Glob");
    const str = await expandWordToStr(word);
    // Brace expansion first (produces multiple words), then glob each.
    const braceExpanded = expandBraces(str);
    if (!hasGlob && braceExpanded.length <= 1) return braceExpanded.length === 0 ? [str] : braceExpanded;
    const results: string[] = [];
    for (const w of braceExpanded) {
        if (hasGlob) {
            results.push(...await expandGlob(w));
        } else {
            results.push(w);
        }
    }
    return results;
}

// expandWordToStr: returns a single string, no glob expansion.
// Use this for redirections, assignments, and variable operands.
export async function expandWordToStr(word: Word): Promise<string> {
    const segs = word.segments;
    if (segs.length === 0) return "";

    const first = segs[0]!;
    if (first.type === "Literal" && (first.value === "~" || first.value.startsWith("~/"))) {
        const home = String($["HOME"] ?? os.homedir());
        const rest = first.value.slice(1);
        const tail = (await Promise.all(segs.slice(1).map(expandSegment))).join("");
        return home + rest + tail;
    }

    return (await Promise.all(segs.map(expandSegment))).join("");
}

// ---- Brace expansion --------------------------------------------------------

function expandBraces(str: string): string[] {
    // Find the first top-level { ... } with a comma or .. inside.
    const open = findBraceOpen(str);
    if (open === -1) return [str];
    const close = findBraceClose(str, open);
    if (close === -1) return [str];

    const prefix = str.slice(0, open);
    const body = str.slice(open + 1, close);
    const suffix = str.slice(close + 1);

    // Sequence: {a..b} or {a..b..step}
    const seqMatch = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
    if (seqMatch) {
        const start = parseInt(seqMatch[1]!, 10);
        const end = parseInt(seqMatch[2]!, 10);
        const step = seqMatch[3] !== undefined ? Math.abs(parseInt(seqMatch[3]!, 10)) : 1;
        if (step === 0) return [str];
        const items: string[] = [];
        if (start <= end) {
            for (let i = start; i <= end; i += step) items.push(String(i));
        } else {
            for (let i = start; i >= end; i -= step) items.push(String(i));
        }
        // Recursively expand suffix for nested braces.
        const results: string[] = [];
        for (const item of items) {
            results.push(...expandBraces(prefix + item + suffix));
        }
        return results;
    }

    // Character sequence: {a..z}
    const charMatch = body.match(/^(.)\.\.(.)(\.\.(-?\d+))?$/);
    if (charMatch && charMatch[1]!.length === 1 && charMatch[2]!.length === 1) {
        const startCode = charMatch[1]!.charCodeAt(0);
        const endCode = charMatch[2]!.charCodeAt(0);
        const step = charMatch[4] !== undefined ? Math.abs(parseInt(charMatch[4]!, 10)) : 1;
        if (step === 0) return [str];
        const items: string[] = [];
        if (startCode <= endCode) {
            for (let i = startCode; i <= endCode; i += step) items.push(String.fromCharCode(i));
        } else {
            for (let i = startCode; i >= endCode; i -= step) items.push(String.fromCharCode(i));
        }
        const results: string[] = [];
        for (const item of items) {
            results.push(...expandBraces(prefix + item + suffix));
        }
        return results;
    }

    // Comma-separated: {a,b,c}
    const parts = splitBraceBody(body);
    if (parts.length <= 1) return [str]; // No comma found — not a brace expansion
    const results: string[] = [];
    for (const part of parts) {
        results.push(...expandBraces(prefix + part + suffix));
    }
    return results;
}

function findBraceOpen(str: string): number {
    for (let i = 0; i < str.length; i++) {
        if (str[i] === "{") return i;
        if (str[i] === "\\") i++; // skip escaped char
    }
    return -1;
}

function findBraceClose(str: string, open: number): number {
    let depth = 0;
    for (let i = open; i < str.length; i++) {
        if (str[i] === "\\") { i++; continue; }
        if (str[i] === "{") depth++;
        else if (str[i] === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function splitBraceBody(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (let i = 0; i < body.length; i++) {
        const ch = body[i]!;
        if (ch === "\\") {
            current += ch + (body[i + 1] ?? "");
            i++;
        } else if (ch === "{") {
            depth++;
            current += ch;
        } else if (ch === "}") {
            depth--;
            current += ch;
        } else if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts;
}

// ---- Glob expansion ---------------------------------------------------------

async function expandGlob(pattern: string): Promise<string[]> {
    try {
        const matches: string[] = [];
        for await (const match of glob(pattern, { withFileTypes: false })) {
            matches.push(match as string);
        }
        if (matches.length === 0) return [pattern]; // no match → pass through literally
        return matches.sort();
    } catch {
        return [pattern];
    }
}

// ---- Segment expansion ------------------------------------------------------

async function expandSegment(seg: WordSegment): Promise<string> {
    switch (seg.type) {
        case "Literal":       return (seg as LiteralSegment).value;
        case "SingleQuoted":  return (seg as SingleQuotedSegment).value;
        case "DoubleQuoted":
            return (await Promise.all(
                (seg as DoubleQuotedSegment).segments.map(expandSegment)
            )).join("");
        case "VariableExpansion":  return expandVariable(seg as VariableExpansion);
        case "CommandSubstitution": return captureImpl((seg as CommandSubstitution).body);
        case "ArithmeticExpansion": return evalArithmetic(seg.expression);
        case "Glob":          return seg.pattern; // raw chars, assembled before glob expand
        case "HereDoc":       return seg.body;    // body already collected; expand later
        default:              return "";
    }
}

function expandVariable(seg: VariableExpansion): string {
    if (/^\d+$/.test(seg.name)) {
        const n = parseInt(seg.name, 10);
        return n === 0 ? "jsh" : (getParam(n) ?? "");
    }
    if (seg.name === "$") return String(process.pid);
    if (seg.name === "?") return String($["?"] ?? 0);
    if (seg.name === "#") return String(getParamCount());
    if (seg.name === "@" || seg.name === "*") return getAllParams().join(" ");

    const raw = $[seg.name];
    const val = raw !== undefined ? String(raw) : undefined;
    if (!seg.operator) {
        if (val === undefined && shellOpts.nounset) {
            throw new Error(`${seg.name}: unbound variable`);
        }
        return val ?? "";
    }

    switch (seg.operator) {
        case ":-": case "-":
            return (val !== undefined && val !== "") ? val : expandOperand(seg);
        case ":+": case "+":
            return (val !== undefined && val !== "") ? expandOperand(seg) : "";
        case ":=": case "=":
            if (val === undefined || val === "") {
                const def = expandOperand(seg);
                $[seg.name] = def;
                return def;
            }
            return val;
        case ":?": case "?": {
            if (val === undefined || val === "") {
                throw new Error(expandOperand(seg) || `${seg.name}: parameter null or not set`);
            }
            return val;
        }
        case "#": return String((val ?? "").length);
        default:  return val ?? "";
    }
}

function evalArithmetic(expr: string): string {
    // Substitute $var and bare variable names with their values.
    let e = expr.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) =>
        String($[name] ?? 0)
    );
    e = e.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (_, name) =>
        String($[name] ?? 0)
    );
    try {
        // eslint-disable-next-line no-new-func
        const result = new Function(`"use strict"; return (${e})`)();
        const n = typeof result === "number" ? result : Number(result);
        return String(Math.trunc(n));
    } catch {
        process.stderr.write(`jsh: arithmetic: ${expr}: syntax error\n`);
        return "0";
    }
}

function expandOperand(seg: VariableExpansion): string {
    if (!seg.operand) return "";
    return seg.operand.map(s => {
        if (s.type === "Literal")      return (s as LiteralSegment).value;
        if (s.type === "SingleQuoted") return (s as SingleQuotedSegment).value;
        return "";
    }).join("");
}
