// Syntax highlighting for the line editor.

import { Lexer, TokenType } from "../parser/index.js";
// Command resolution is injected to avoid circular imports.
let commandExistsImpl: (name: string) => boolean = () => false;
export function registerCommandExists(fn: (name: string) => boolean): void { commandExistsImpl = fn; }

// ---- Color types and resolution ---------------------------------------------

export type Color =
    | [number, number, number]    // RGB tuple
    | `#${string}`                // hex "#rrggbb"
    | string;                     // named: "red", "bold green", etc.

export interface Theme {
    command?: Color;
    commandNotFound?: Color;
    keyword?: Color;
    operator?: Color;
    redirect?: Color;
    string?: Color;
    variable?: Color;
    comment?: Color;
    argument?: Color;
    paren?: Color;
    jsInline?: Color;
    suggestion?: Color;
}

const DEFAULT_THEME: Theme = {
    command:         [130, 224, 170],
    commandNotFound: [255, 85, 85],
    keyword:         [255, 203, 107],
    operator:        [199, 146, 234],
    redirect:        [199, 146, 234],
    string:          [195, 232, 141],
    variable:        [137, 221, 255],
    comment:         [105, 105, 105],
    paren:           [255, 203, 107],
    jsInline:        [255, 203, 107],
    suggestion:      "dim",
};

let currentTheme: Theme = { ...DEFAULT_THEME };

// Pre-resolved ANSI strings for the current theme — rebuilt on setTheme().
interface ResolvedTheme {
    command: string | null;
    commandNotFound: string | null;
    keyword: string | null;
    operator: string | null;
    redirect: string | null;
    string: string | null;
    variable: string | null;
    comment: string | null;
    argument: string | null;
    paren: string | null;
    jsInline: string | null;
    suggestion: string | null;
}

const NAMED_COLORS: Record<string, number> = {
    black: 30, red: 31, green: 32, yellow: 33,
    blue: 34, magenta: 35, cyan: 36, white: 37,
};

function resolveColor(c: Color | undefined): string | null {
    if (c === undefined) return null;
    if (Array.isArray(c)) {
        return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
    }
    if (typeof c === "string" && c.startsWith("#") && c.length === 7) {
        const r = parseInt(c.slice(1, 3), 16);
        const g = parseInt(c.slice(3, 5), 16);
        const b = parseInt(c.slice(5, 7), 16);
        return `\x1b[38;2;${r};${g};${b}m`;
    }
    if (typeof c === "string") {
        const parts = c.split(" ");
        let seq = "";
        for (const part of parts) {
            if (part === "bold") seq += "\x1b[1m";
            else if (part === "italic") seq += "\x1b[3m";
            else if (part === "underline") seq += "\x1b[4m";
            else if (NAMED_COLORS[part] !== undefined) seq += `\x1b[${NAMED_COLORS[part]}m`;
        }
        return seq || null;
    }
    return null;
}

function buildResolved(t: Theme): ResolvedTheme {
    return {
        command: resolveColor(t.command),
        commandNotFound: resolveColor(t.commandNotFound),
        keyword: resolveColor(t.keyword),
        operator: resolveColor(t.operator),
        redirect: resolveColor(t.redirect),
        string: resolveColor(t.string),
        variable: resolveColor(t.variable),
        comment: resolveColor(t.comment),
        argument: resolveColor(t.argument),
        paren: resolveColor(t.paren),
        jsInline: resolveColor(t.jsInline),
        suggestion: resolveColor(t.suggestion),
    };
}

let resolved: ResolvedTheme = buildResolved(currentTheme);

export function setTheme(theme: Partial<Theme>): void {
    currentTheme = { ...DEFAULT_THEME, ...theme };
    resolved = buildResolved(currentTheme);
}

export function getCurrentTheme(): Theme {
    return currentTheme;
}

export function getResolvedColor(key: keyof ResolvedTheme): string | null {
    return resolved[key];
}

// ---- Keyword detection ------------------------------------------------------

const KEYWORDS = new Set([
    "if", "then", "elif", "else", "fi",
    "while", "until", "for", "do", "done",
    "case", "esac", "in",
    "function", "select", "time",
]);

// ---- Command resolution (cached for current line) ---------------------------

function isValidCommand(name: string): boolean {
    if (KEYWORDS.has(name)) return true;
    if (name.includes("/")) return true;
    return commandExistsImpl(name);
}

// ---- Separator detection for "command position" ----------------------------

const COMMAND_SEPARATORS = new Set<string>([
    TokenType.Pipe, TokenType.PipeAnd, TokenType.And, TokenType.Or,
    TokenType.Semi, TokenType.Amp, TokenType.Newline,
    TokenType.LParen, TokenType.LBrace, TokenType.Bang,
    TokenType.CaseSemi,
]);

// ---- Core colorize function ------------------------------------------------

const RESET = "\x1b[0m";

export function colorize(input: string, theme?: Theme, context?: string): string {
    const t = theme ? (theme === currentTheme ? resolved : buildResolved(theme)) : resolved;
    if (input.length === 0) return "";

    // If context is provided (continuation lines), lex the full input so the
    // lexer sees the complete state (e.g. an open string from a prior line).
    // We only emit colorized output for the portion after the context.
    const full = context !== undefined ? context + "\n" + input : input;
    const outputStart = context !== undefined ? context.length + 1 : 0;

    let tokens;
    try {
        const lexer = new Lexer(full, { partial: true });
        tokens = lexer.getTokens();
    } catch {
        return input;
    }

    let result = "";
    let pos = outputStart;
    let commandPosition = true;

    for (const tok of tokens) {
        if (tok.type === TokenType.EOF) break;

        let color: string | null = null;

        switch (tok.type) {
            case TokenType.Word: {
                if (KEYWORDS.has(tok.value)) {
                    color = t.keyword;
                    commandPosition = true;
                } else if (commandPosition) {
                    const name = tok.value;
                    if (isValidCommand(name)) {
                        color = t.command;
                    } else {
                        const fg = t.commandNotFound;
                        color = fg ? fg + "\x1b[4:3m" : "\x1b[4:3m";
                    }
                    commandPosition = false;
                } else {
                    const hasVar = tok.word?.segments.some(s =>
                        s.type === "VariableExpansion" || s.type === "CommandSubstitution"
                    );
                    const hasQuote = tok.word?.segments.some(s =>
                        s.type === "SingleQuoted" || s.type === "DoubleQuoted"
                    );
                    if (hasVar) {
                        color = t.variable;
                    } else if (hasQuote) {
                        color = t.string;
                    } else {
                        color = t.argument;
                    }
                }
                break;
            }
            case TokenType.Pipe:
            case TokenType.PipeAnd:
            case TokenType.And:
            case TokenType.Or:
            case TokenType.Semi:
            case TokenType.Amp:
            case TokenType.Bang:
            case TokenType.CaseSemi:
                color = t.operator;
                commandPosition = true;
                break;
            case TokenType.Redirect:
                color = t.redirect;
                break;
            case TokenType.LParen:
            case TokenType.RParen:
            case TokenType.LBrace:
            case TokenType.RBrace:
                color = t.paren;
                if (tok.type === TokenType.LParen || tok.type === TokenType.LBrace) {
                    commandPosition = true;
                }
                break;
            case TokenType.JsInline:
                color = t.jsInline;
                commandPosition = false;
                break;
            case TokenType.Newline:
                commandPosition = true;
                break;
        }

        // Only emit output for tokens that overlap with the current line
        if (tok.end <= outputStart) continue;

        const emitStart = Math.max(tok.start, outputStart);
        const emitEnd = tok.end;

        // Copy any gap (whitespace) between last position and this token
        if (emitStart > pos) {
            result += full.slice(pos, emitStart);
        }

        const raw = full.slice(emitStart, emitEnd);

        if (color) {
            result += color + raw + RESET;
        } else {
            result += raw;
        }
        pos = emitEnd;
    }

    // Copy any trailing content. If we're in continuation mode and there's
    // unprocessed text (e.g. inside an unterminated string), color it as string.
    if (pos < full.length) {
        const trailing = full.slice(pos);
        if (context !== undefined) {
            if (t.string) {
                result += t.string + trailing + RESET;
            } else {
                result += trailing;
            }
        } else {
            result += trailing;
        }
    }

    return result;
}
