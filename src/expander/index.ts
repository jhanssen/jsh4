import type {
    Word, WordSegment, VariableExpansion, CommandSubstitution, ProcessSubstitution,
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

// Registered by the executor for process substitution.
type ProcessSubstFunc = (body: string, direction: "<" | ">") => string;
let processSubstImpl: ProcessSubstFunc = () => "/dev/null";
export function registerProcessSubstImpl(fn: ProcessSubstFunc): void { processSubstImpl = fn; }

// ---- Fragment-based expansion for IFS word splitting ------------------------

type Fragment =
    | { type: "literal"; text: string }     // no IFS splitting
    | { type: "splittable"; text: string }   // subject to IFS splitting
    | { type: "break" };                     // word boundary (from "$@")

function getIFS(): string {
    const ifs = $["IFS"];
    if (ifs === undefined) return " \t\n";
    return String(ifs);
}

// Split a string on IFS characters, returning the parts.
// Adjacent IFS whitespace chars are collapsed; non-whitespace IFS chars each
// delimit a field (POSIX rules).
function ifsSplit(text: string, ifs: string): string[] {
    if (text === "") return [];
    if (ifs === "") return [text]; // empty IFS → no splitting

    const isIfsWs = (ch: string) => (ch === " " || ch === "\t" || ch === "\n") && ifs.includes(ch);
    const isIfs = (ch: string) => ifs.includes(ch);

    const fields: string[] = [];
    let current = "";
    let i = 0;

    // Skip leading IFS whitespace.
    while (i < text.length && isIfsWs(text[i]!)) i++;

    while (i < text.length) {
        const ch = text[i]!;
        if (isIfs(ch)) {
            fields.push(current);
            current = "";
            if (isIfsWs(ch)) {
                // Consume all adjacent IFS whitespace.
                while (i < text.length && isIfsWs(text[i]!)) i++;
                // If a non-whitespace IFS char follows, it's another delimiter.
                if (i < text.length && isIfs(text[i]!) && !isIfsWs(text[i]!)) {
                    i++;
                    // Consume trailing IFS whitespace after non-ws delimiter.
                    while (i < text.length && isIfsWs(text[i]!)) i++;
                }
            } else {
                i++;
                // Consume IFS whitespace after non-ws delimiter.
                while (i < text.length && isIfsWs(text[i]!)) i++;
            }
        } else {
            current += ch;
            i++;
        }
    }
    // Add last field if non-empty (trailing IFS whitespace already consumed).
    if (current !== "") fields.push(current);

    return fields;
}

// Convert fragments into words by applying IFS splitting on splittable parts.
function fragmentsToWords(fragments: Fragment[]): string[] {
    const ifs = getIFS();
    const words: string[] = [];
    let current = "";

    for (const frag of fragments) {
        if (frag.type === "break") {
            words.push(current);
            current = "";
            continue;
        }
        if (frag.type === "literal") {
            current += frag.text;
            continue;
        }
        // splittable
        const parts = ifsSplit(frag.text, ifs);
        if (parts.length === 0) {
            // Entirely IFS chars — produces no fields but doesn't break the word.
            // Actually in POSIX: an unquoted expansion that expands to nothing
            // after splitting should be removed entirely.  We handle this by
            // not appending anything.
            continue;
        }
        // First part joins with current word being built.
        current += parts[0]!;
        if (parts.length > 1) {
            // Remaining parts each start a new word.
            words.push(current);
            for (let i = 1; i < parts.length - 1; i++) {
                words.push(parts[i]!);
            }
            current = parts[parts.length - 1]!;
        }
    }
    words.push(current);

    // Remove completely empty words that resulted from empty expansions,
    // but keep words that are explicitly empty from quoting (those would be
    // literal fragments with "").
    return words.filter(w => w !== "" || fragments.some(f => f.type === "literal" && f.text === ""));
}

// Expand a segment into fragments, tracking quoted context.
async function expandSegmentToFragments(seg: WordSegment, quoted: boolean): Promise<Fragment[]> {
    switch (seg.type) {
        case "Literal":
            return [{ type: "literal", text: (seg as LiteralSegment).value }];
        case "SingleQuoted":
            return [{ type: "literal", text: (seg as SingleQuotedSegment).value }];
        case "DoubleQuoted": {
            const result: Fragment[] = [];
            for (const inner of (seg as DoubleQuotedSegment).segments) {
                result.push(...await expandSegmentToFragments(inner, true));
            }
            return result;
        }
        case "VariableExpansion": {
            const vexp = seg as VariableExpansion;
            // "$@" → separate words (one per param)
            if (vexp.name === "@" && quoted && !vexp.operator) {
                const params = getAllParams();
                if (params.length === 0) return [];
                const frags: Fragment[] = [{ type: "literal", text: params[0]! }];
                for (let i = 1; i < params.length; i++) {
                    frags.push({ type: "break" });
                    frags.push({ type: "literal", text: params[i]! });
                }
                return frags;
            }
            // "$*" → join with first IFS char
            if (vexp.name === "*" && quoted && !vexp.operator) {
                const ifs = getIFS();
                const sep = ifs.length > 0 ? ifs[0]! : "";
                return [{ type: "literal", text: getAllParams().join(sep) }];
            }
            const text = expandVariable(vexp);
            return [quoted ? { type: "literal", text } : { type: "splittable", text }];
        }
        case "CommandSubstitution": {
            const text = await captureImpl((seg as CommandSubstitution).body);
            return [quoted ? { type: "literal", text } : { type: "splittable", text }];
        }
        case "ArithmeticExpansion": {
            const text = evalArithmetic(seg.expression);
            return [quoted ? { type: "literal", text } : { type: "splittable", text }];
        }
        case "Glob":
            return [{ type: "literal", text: seg.pattern }];
        case "HereDoc":
            return [{ type: "literal", text: seg.body }];
        case "ProcessSubstitution": {
            const text = processSubstImpl((seg as ProcessSubstitution).body, (seg as ProcessSubstitution).direction);
            return [{ type: "literal", text }];
        }
        default:
            return [];
    }
}

// expandWord: returns potentially multiple strings after IFS splitting,
// brace expansion, and glob expansion.  Use this for command arguments.
export async function expandWord(word: Word): Promise<string[]> {
    const hasGlob = word.segments.some(s => s.type === "Glob");

    // Check if any segment could produce IFS splitting or "$@" breaks.
    const hasExpansion = word.segments.some(s =>
        s.type === "VariableExpansion" || s.type === "CommandSubstitution" ||
        s.type === "ArithmeticExpansion" ||
        (s.type === "DoubleQuoted" && (s as DoubleQuotedSegment).segments.some(
            inner => inner.type === "VariableExpansion" || inner.type === "CommandSubstitution" ||
                     inner.type === "ArithmeticExpansion"
        ))
    );

    if (!hasExpansion) {
        // Fast path: no expansions that need splitting — use old string path.
        const str = await expandWordToStr(word);
        const braceExpanded = expandBraces(str);
        if (!hasGlob && braceExpanded.length <= 1) return braceExpanded.length === 0 ? [str] : braceExpanded;
        const results: string[] = [];
        for (const w of braceExpanded) {
            results.push(...(hasGlob ? await expandGlob(w) : [w]));
        }
        return results;
    }

    // Fragment-based path: expand with IFS splitting awareness.
    // Handle tilde expansion on leading literal.
    const segs = word.segments;
    const fragments: Fragment[] = [];
    let startIdx = 0;
    if (segs.length > 0 && segs[0]!.type === "Literal") {
        const lit = (segs[0] as LiteralSegment).value;
        if (lit === "~" || lit.startsWith("~/")) {
            const home = String($["HOME"] ?? os.homedir());
            fragments.push({ type: "literal", text: home + lit.slice(1) });
            startIdx = 1;
        }
    }
    for (let i = startIdx; i < segs.length; i++) {
        fragments.push(...await expandSegmentToFragments(segs[i]!, false));
    }

    // Convert fragments to words via IFS splitting.
    const words = fragmentsToWords(fragments);

    // Apply brace and glob expansion to each resulting word.
    const results: string[] = [];
    for (const w of words) {
        const braceExpanded = expandBraces(w);
        for (const b of braceExpanded) {
            results.push(...(hasGlob ? await expandGlob(b) : [b]));
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
        case "ProcessSubstitution": return processSubstImpl((seg as ProcessSubstitution).body, (seg as ProcessSubstitution).direction);
        default:              return "";
    }
}

// Resolve a variable value, handling array indexing if seg.index is set.
function resolveVariable(seg: VariableExpansion): { raw: unknown; val: string | undefined } {
    const raw = $[seg.name];
    if (seg.index !== undefined && Array.isArray(raw)) {
        if (seg.index === "@" || seg.index === "*") {
            const joined = raw.map(String).join(" ");
            return { raw: joined, val: joined };
        }
        const idx = parseInt(seg.index, 10);
        const elem = raw[idx];
        const val = elem !== undefined ? String(elem) : undefined;
        return { raw: elem, val };
    }
    // ${VAR} where VAR is an array but no index → first element (bash compat)
    if (Array.isArray(raw) && seg.index === undefined) {
        const elem = raw[0];
        const val = elem !== undefined ? String(elem) : undefined;
        return { raw: elem, val };
    }
    const val = raw !== undefined ? String(raw) : undefined;
    return { raw, val };
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

    // ${#VAR} — length of variable value
    if (seg.name.startsWith("#") && !seg.operator) {
        const realName = seg.name.slice(1);
        const v = $[realName];
        return String(v !== undefined ? String(v).length : 0);
    }

    const { val } = resolveVariable(seg);
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
        case "#": {
            // Shortest prefix removal: ${VAR#pattern}
            const pat = expandOperand(seg);
            const str = val ?? "";
            for (let i = 0; i <= str.length; i++) {
                if (matchGlobSimple(str.slice(0, i), pat)) return str.slice(i);
            }
            return str;
        }
        // Pattern removal
        case "##": {
            const pat = expandOperand(seg);
            const str = val ?? "";
            // Greedy prefix removal
            for (let i = str.length; i >= 0; i--) {
                if (matchGlobSimple(str.slice(0, i), pat)) return str.slice(i);
            }
            return str;
        }
        case "%": {
            const pat = expandOperand(seg);
            const str = val ?? "";
            // Shortest suffix removal
            for (let i = str.length; i >= 0; i--) {
                if (matchGlobSimple(str.slice(i), pat)) return str.slice(0, i);
            }
            return str;
        }
        case "%%": {
            const pat = expandOperand(seg);
            const str = val ?? "";
            // Greedy suffix removal
            for (let i = 0; i <= str.length; i++) {
                if (matchGlobSimple(str.slice(i), pat)) return str.slice(0, i);
            }
            return str;
        }
        // Search/replace
        case "/": {
            const operandStr = expandOperand(seg);
            const sepIdx = operandStr.indexOf("/");
            const pat = sepIdx >= 0 ? operandStr.slice(0, sepIdx) : operandStr;
            const rep = sepIdx >= 0 ? operandStr.slice(sepIdx + 1) : "";
            const str = val ?? "";
            // First match only
            for (let i = 0; i < str.length; i++) {
                for (let j = i + 1; j <= str.length; j++) {
                    if (matchGlobSimple(str.slice(i, j), pat)) {
                        return str.slice(0, i) + rep + str.slice(j);
                    }
                }
            }
            return str;
        }
        case "//": {
            const operandStr = expandOperand(seg);
            const sepIdx = operandStr.indexOf("/");
            const pat = sepIdx >= 0 ? operandStr.slice(0, sepIdx) : operandStr;
            const rep = sepIdx >= 0 ? operandStr.slice(sepIdx + 1) : "";
            let str = val ?? "";
            let result = "";
            let i = 0;
            while (i < str.length) {
                let matched = false;
                for (let j = i + 1; j <= str.length; j++) {
                    if (matchGlobSimple(str.slice(i, j), pat)) {
                        result += rep;
                        i = j;
                        matched = true;
                        break;
                    }
                }
                if (!matched) { result += str[i]; i++; }
            }
            return result;
        }
        // Case modification
        case "^": return (val ?? "").length > 0 ? (val ?? "")[0]!.toUpperCase() + (val ?? "").slice(1) : "";
        case "^^": return (val ?? "").toUpperCase();
        case ",": return (val ?? "").length > 0 ? (val ?? "")[0]!.toLowerCase() + (val ?? "").slice(1) : "";
        case ",,": return (val ?? "").toLowerCase();
        // Substring: ${VAR:offset} or ${VAR:offset:length}
        case ":": {
            const operandStr = expandOperand(seg);
            const parts = operandStr.split(":");
            const str = val ?? "";
            let offset = parseInt(parts[0] ?? "0", 10);
            if (isNaN(offset)) offset = 0;
            if (offset < 0) offset = Math.max(0, str.length + offset);
            if (parts.length > 1) {
                let length = parseInt(parts[1] ?? "0", 10);
                if (isNaN(length)) length = 0;
                if (length < 0) length = Math.max(0, str.length + length - offset);
                return str.slice(offset, offset + length);
            }
            return str.slice(offset);
        }
        default:  return val ?? "";
    }
}

function evalArithmetic(expr: string): string {
    let e = expr;

    // Handle assignment operators: VAR=expr, VAR+=expr, VAR-=expr, VAR*=expr, VAR/=expr, VAR%=expr
    const assignMatch = e.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([-+*/%]?)=\s*(.+)$/);
    if (assignMatch && assignMatch[2] !== "=") {
        const [, name, op, rhs] = assignMatch as [string, string, string, string];
        const rhsVal = Number(evalArithmetic(rhs));
        let result: number;
        if (op === "") {
            result = rhsVal;
        } else {
            const cur = Number($[name] ?? 0);
            switch (op) {
                case "+": result = cur + rhsVal; break;
                case "-": result = cur - rhsVal; break;
                case "*": result = cur * rhsVal; break;
                case "/": result = rhsVal !== 0 ? Math.trunc(cur / rhsVal) : 0; break;
                case "%": result = rhsVal !== 0 ? cur % rhsVal : 0; break;
                default: result = rhsVal;
            }
        }
        const truncated = Math.trunc(result);
        $[name] = String(truncated);
        return String(truncated);
    }

    // Handle pre-increment/decrement: ++VAR, --VAR
    e = e.replace(/\+\+([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
        const val = Math.trunc(Number($[name] ?? 0)) + 1;
        $[name] = String(val);
        return String(val);
    });
    e = e.replace(/--([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
        const val = Math.trunc(Number($[name] ?? 0)) - 1;
        $[name] = String(val);
        return String(val);
    });

    // Handle post-increment/decrement: VAR++, VAR--
    e = e.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\+\+/g, (_, name) => {
        const val = Math.trunc(Number($[name] ?? 0));
        $[name] = String(val + 1);
        return String(val);
    });
    e = e.replace(/([a-zA-Z_][a-zA-Z0-9_]*)--/g, (_, name) => {
        const val = Math.trunc(Number($[name] ?? 0));
        $[name] = String(val - 1);
        return String(val);
    });

    // Substitute $var and bare variable names with their values.
    e = e.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) =>
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

function matchGlobSimple(str: string, pattern: string): boolean {
    // Simple glob matching for ${VAR#pattern} etc. Supports * and ?
    let si = 0, pi = 0;
    let starSi = -1, starPi = -1;
    while (si < str.length) {
        if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === str[si])) {
            si++; pi++;
        } else if (pi < pattern.length && pattern[pi] === "*") {
            starPi = pi; starSi = si; pi++;
        } else if (starPi >= 0) {
            pi = starPi + 1; starSi++; si = starSi;
        } else {
            return false;
        }
    }
    while (pi < pattern.length && pattern[pi] === "*") pi++;
    return pi === pattern.length;
}

function expandOperand(seg: VariableExpansion): string {
    if (!seg.operand) return "";
    return seg.operand.map(s => {
        if (s.type === "Literal")      return (s as LiteralSegment).value;
        if (s.type === "SingleQuoted") return (s as SingleQuotedSegment).value;
        return "";
    }).join("");
}
