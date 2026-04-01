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

// expandWord: returns potentially multiple strings after glob expansion.
// Use this for command arguments.
export async function expandWord(word: Word): Promise<string[]> {
    const hasGlob = word.segments.some(s => s.type === "Glob");
    const str = await expandWordToStr(word);
    if (!hasGlob) return [str];
    return expandGlob(str);
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
