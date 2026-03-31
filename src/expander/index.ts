import type {
    Word, WordSegment, VariableExpansion,
    LiteralSegment, SingleQuotedSegment, DoubleQuotedSegment,
} from "../parser/index.js";
import { $ } from "../variables/index.js";
import * as os from "node:os";

export function expandWord(word: Word): string {
    const segs = word.segments;
    if (segs.length === 0) return "";

    // Tilde expansion: first segment is a Literal starting with ~
    const first = segs[0]!;
    if (first.type === "Literal" && (first.value === "~" || first.value.startsWith("~/"))) {
        const home = String($["HOME"] ?? os.homedir());
        const rest = first.value.slice(1); // strip leading ~
        return home + rest + segs.slice(1).map(expandSegment).join("");
    }

    return segs.map(expandSegment).join("");
}

function expandSegment(seg: WordSegment): string {
    switch (seg.type) {
        case "Literal":
            return (seg as LiteralSegment).value;
        case "SingleQuoted":
            return (seg as SingleQuotedSegment).value;
        case "DoubleQuoted":
            return (seg as DoubleQuotedSegment).segments.map(expandSegment).join("");
        case "VariableExpansion":
            return expandVariable(seg as VariableExpansion);
        case "CommandSubstitution":
            // TODO
            return "";
        case "ArithmeticExpansion":
            // TODO
            return "";
        case "Glob":
            // TODO: pathname expansion — pass through for now
            return seg.pattern;
        default:
            return "";
    }
}

function expandVariable(seg: VariableExpansion): string {
    // Special single-char variables
    if (seg.name === "$") return String(process.pid);
    if (seg.name === "?") return String($["?"] ?? 0);
    if (seg.name === "#") return "0"; // no positional params in interactive use

    const raw = $[seg.name];
    const val = raw !== undefined ? String(raw) : undefined;

    if (!seg.operator) {
        return val ?? "";
    }

    switch (seg.operator) {
        case ":-":
        case "-":
            return (val !== undefined && val !== "") ? val : expandOperand(seg);
        case ":+":
        case "+":
            return (val !== undefined && val !== "") ? expandOperand(seg) : "";
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
        case "#":
            return String((val ?? "").length);
        case "##":
        case "%":
        case "%%":
        case "/":
        case "//":
            // TODO: pattern operations
            return val ?? "";
        default:
            return val ?? "";
    }
}

function expandOperand(seg: VariableExpansion): string {
    if (!seg.operand) return "";
    return seg.operand.map(expandSegment).join("");
}
