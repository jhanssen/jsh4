import type {
    Word, WordSegment, VariableExpansion, CommandSubstitution,
    LiteralSegment, SingleQuotedSegment, DoubleQuotedSegment,
} from "../parser/index.js";
import { $ } from "../variables/index.js";
import { getParam, getAllParams, getParamCount } from "../variables/positional.js";
import * as os from "node:os";

// Registered by the executor to avoid a circular import.
type CaptureFunc = (body: string) => Promise<string>;
let captureImpl: CaptureFunc = async () => "";

export function registerCaptureImpl(fn: CaptureFunc): void {
    captureImpl = fn;
}

export async function expandWord(word: Word): Promise<string> {
    const segs = word.segments;
    if (segs.length === 0) return "";

    // Tilde expansion on first literal segment.
    const first = segs[0]!;
    if (first.type === "Literal" && (first.value === "~" || first.value.startsWith("~/"))) {
        const home = String($["HOME"] ?? os.homedir());
        const rest = first.value.slice(1);
        const tail = (await Promise.all(segs.slice(1).map(expandSegment))).join("");
        return home + rest + tail;
    }

    return (await Promise.all(segs.map(expandSegment))).join("");
}

async function expandSegment(seg: WordSegment): Promise<string> {
    switch (seg.type) {
        case "Literal":        return (seg as LiteralSegment).value;
        case "SingleQuoted":   return (seg as SingleQuotedSegment).value;
        case "DoubleQuoted":
            return (await Promise.all((seg as DoubleQuotedSegment).segments.map(expandSegment))).join("");
        case "VariableExpansion":
            return expandVariable(seg as VariableExpansion);
        case "CommandSubstitution":
            return captureImpl((seg as CommandSubstitution).body);
        case "ArithmeticExpansion":
            return ""; // TODO
        case "Glob":
            return seg.pattern; // TODO: pathname expansion
        default:
            return "";
    }
}

function expandVariable(seg: VariableExpansion): string {
    // Positional parameters
    if (/^\d+$/.test(seg.name)) {
        const n = parseInt(seg.name, 10);
        if (n === 0) return "jsh";
        return getParam(n) ?? "";
    }

    // Special variables
    if (seg.name === "$") return String(process.pid);
    if (seg.name === "?") return String($["?"] ?? 0);
    if (seg.name === "#") return String(getParamCount());
    if (seg.name === "@" || seg.name === "*") return getAllParams().join(" ");

    const raw = $[seg.name];
    const val = raw !== undefined ? String(raw) : undefined;

    if (!seg.operator) return val ?? "";

    switch (seg.operator) {
        case ":-":
        case "-":   return (val !== undefined && val !== "") ? val : expandOperand(seg);
        case ":+":
        case "+":   return (val !== undefined && val !== "") ? expandOperand(seg) : "";
        case ":=":
        case "=":
            if (val === undefined || val === "") {
                const def = expandOperand(seg);
                $[seg.name] = def;
                return def;
            }
            return val;
        case ":?":
        case "?": {
            if (val === undefined || val === "") {
                const msg = expandOperand(seg) || `${seg.name}: parameter null or not set`;
                throw new Error(msg);
            }
            return val;
        }
        case "#":  return String((val ?? "").length);
        default:   return val ?? "";
    }
}

function expandOperand(seg: VariableExpansion): string {
    if (!seg.operand) return "";
    // operand segments are sync-only in practice (no command substitution in operands for now)
    return seg.operand.map(s => {
        if (s.type === "Literal") return (s as LiteralSegment).value;
        if (s.type === "SingleQuoted") return (s as SingleQuotedSegment).value;
        return "";
    }).join("");
}
