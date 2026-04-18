import type { Word, WordSegment, VariableExpansion } from "./ast.js";

export enum TokenType {
    Word = "Word",
    Pipe = "Pipe",          // |
    PipeAnd = "PipeAnd",    // |&
    And = "And",            // &&
    Or = "Or",              // ||
    Semi = "Semi",          // ;
    Amp = "Amp",            // &
    Newline = "Newline",    // \n
    LParen = "LParen",     // (
    RParen = "RParen",     // )
    LBrace = "LBrace",     // {
    RBrace = "RBrace",     // }
    Redirect = "Redirect", // >, >>, <, etc.
    EOF = "EOF",
    Bang = "Bang",         // !
    JsInline = "JsInline", // @{ expr } or @!{ expr }
    CaseSemi = "CaseSemi", // ;;
}

export interface Token {
    type: TokenType;
    value: string;
    start: number;        // byte offset of token start in input
    end: number;          // byte offset of token end in input
    word?: Word;          // parsed word with segments (for Word tokens)
    fd?: number;          // for redirections: the fd number prefix
    jsBuffered?: boolean; // for JsInline tokens: true if @!{ }
    hereDoc?: { delim: string; body: string; quoted: boolean }; // for << tokens
}

import { LexerError, IncompleteInputError } from "./errors.js";
export { LexerError, IncompleteInputError };

export class Lexer {
    private input: string;
    private pos: number;
    private tokens: Token[] = [];
    private tokenIndex: number = 0;
    // Pending here-doc tokens awaiting body scan after end of current line.
    private pendingHereDocs: Array<{ token: Token; delim: string; quoted: boolean; stripTabs: boolean }> = [];

    constructor(input: string, options?: { partial?: boolean }) {
        this.input = input;
        this.pos = 0;
        if (options?.partial) {
            try {
                this.tokenize();
            } catch (e) {
                if (e instanceof IncompleteInputError || e instanceof LexerError) {
                    this.tokens.push({ type: TokenType.EOF, value: "", start: this.input.length, end: this.input.length });
                } else {
                    throw e;
                }
            }
        } else {
            this.tokenize();
        }
    }

    private tokenize(): void {
        while (this.pos < this.input.length) {
            this.skipSpacesAndTabs();
            if (this.pos >= this.input.length) break;

            const ch = this.input[this.pos]!;

            // Comments
            if (ch === "#") {
                this.skipComment();
                continue;
            }

            // Newline — process any pending here-doc bodies first.
            if (ch === "\n") {
                const nlStart = this.pos;
                this.pos++;
                if (this.pendingHereDocs.length > 0) {
                    for (const hd of this.pendingHereDocs) {
                        const body = this.readHeredocBodyAtPos(hd.delim, hd.quoted, hd.stripTabs);
                        hd.token.hereDoc = { delim: hd.delim, body, quoted: hd.quoted };
                    }
                    this.pendingHereDocs = [];
                }
                this.tokens.push({ type: TokenType.Newline, value: "\n", start: nlStart, end: this.pos });
                continue;
            }

            // Operators
            const op = this.tryOperator();
            if (op) {
                this.tokens.push(op);
                continue;
            }

            // Redirections with optional fd prefix
            const redir = this.tryRedirection();
            if (redir) {
                this.tokens.push(redir);
                continue;
            }

            // Word
            const word = this.readWord();
            if (word) {
                this.tokens.push(word);
                continue;
            }

            throw new LexerError(`Unexpected character: ${ch}`, this.pos);
        }

        // Unterminated here-doc — need more input.
        if (this.pendingHereDocs.length > 0) {
            throw new IncompleteInputError(
                `Unclosed here-doc (<<${this.pendingHereDocs[0]!.delim})`
            );
        }

        this.tokens.push({ type: TokenType.EOF, value: "", start: this.input.length, end: this.input.length });
    }

    private skipSpacesAndTabs(): void {
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === " " || ch === "\t") {
                this.pos++;
            } else {
                break;
            }
        }
    }

    private skipComment(): void {
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
            this.pos++;
        }
    }

    private at(offset: number): string {
        return this.pos + offset < this.input.length ? this.input[this.pos + offset]! : "";
    }

    private tryOperator(): Token | null {
        const s = this.pos;
        const c0 = this.at(0);
        const c1 = this.at(1);
        const c2 = this.at(2);

        // @{ expr } and @!{ expr } — inline JS functions
        if (c0 === "@" && c1 === "!" && c2 === "{") {
            this.pos += 3;
            const body = this.readJsExpression();
            return { type: TokenType.JsInline, value: body, start: s, end: this.pos, jsBuffered: true };
        }
        if (c0 === "@" && c1 === "{") {
            this.pos += 2;
            const body = this.readJsExpression();
            return { type: TokenType.JsInline, value: body, start: s, end: this.pos, jsBuffered: false };
        }

        // ;; case terminator (must come before single ;)
        if (c0 === ";" && c1 === ";") {
            this.pos += 2;
            return { type: TokenType.CaseSemi, value: ";;", start: s, end: this.pos };
        }

        // Two-char operators first
        if (c0 === "&" && c1 === "&") {
            this.pos += 2;
            return { type: TokenType.And, value: "&&", start: s, end: this.pos };
        }
        if (c0 === "|" && c1 === "|") {
            this.pos += 2;
            return { type: TokenType.Or, value: "||", start: s, end: this.pos };
        }
        if (c0 === "|" && c1 === "&") {
            this.pos += 2;
            return { type: TokenType.PipeAnd, value: "|&", start: s, end: this.pos };
        }

        const ch = this.input[this.pos]!;

        if (ch === "|") {
            this.pos++;
            return { type: TokenType.Pipe, value: "|", start: s, end: this.pos };
        }
        if (ch === ";") {
            this.pos++;
            return { type: TokenType.Semi, value: ";", start: s, end: this.pos };
        }
        // & but not &> or &>>
        if (ch === "&") {
            if (this.pos + 1 < this.input.length && (this.input[this.pos + 1] === ">" || this.input[this.pos + 1] === "<")) {
                return null; // let redirection handle it
            }
            this.pos++;
            return { type: TokenType.Amp, value: "&", start: s, end: this.pos };
        }
        if (ch === "(") {
            this.pos++;
            return { type: TokenType.LParen, value: "(", start: s, end: this.pos };
        }
        if (ch === ")") {
            this.pos++;
            return { type: TokenType.RParen, value: ")", start: s, end: this.pos };
        }
        if (ch === "!") {
            // Only treat as bang if followed by whitespace or at a position where it's the start of a pipeline
            const next = this.pos + 1 < this.input.length ? this.input[this.pos + 1] : "";
            if (next === " " || next === "\t" || next === "\n" || next === "" || next === "(") {
                this.pos++;
                return { type: TokenType.Bang, value: "!", start: s, end: this.pos };
            }
        }

        return null;
    }

    private tryRedirection(): Token | null {
        const startPos = this.pos;

        // Check for &> and &>>
        if (this.input[this.pos] === "&") {
            const c1 = this.at(1);
            const c2 = this.at(2);
            if (c1 === ">" && c2 === ">") {
                this.pos += 3;
                return { type: TokenType.Redirect, value: "&>>", start: startPos, end: this.pos };
            }
            if (c1 === ">") {
                this.pos += 2;
                return { type: TokenType.Redirect, value: "&>", start: startPos, end: this.pos };
            }
            return null;
        }

        // Check for fd-prefixed redirections: 2>, 2>>, 2>&1, etc.
        let fd: number | undefined;
        let fdDigits = "";
        let tmpPos = this.pos;

        while (tmpPos < this.input.length && this.input[tmpPos]! >= "0" && this.input[tmpPos]! <= "9") {
            fdDigits += this.input[tmpPos];
            tmpPos++;
        }

        if (fdDigits.length > 0 && tmpPos < this.input.length) {
            const nextCh = this.input[tmpPos]!;
            if (nextCh === ">" || nextCh === "<") {
                fd = parseInt(fdDigits, 10);
                this.pos = tmpPos;
            }
        }

        const ch = this.input[this.pos];
        if (ch !== ">" && ch !== "<") {
            this.pos = startPos;
            return null;
        }

        // Process substitution <(...) or >(...) — not a redirect.
        if (fd === undefined && this.pos + 1 < this.input.length && this.input[this.pos + 1] === "(") {
            this.pos = startPos;
            return null;
        }

        let op = ch;
        this.pos++;

        if (ch === ">") {
            if (this.pos < this.input.length) {
                if (this.input[this.pos] === ">") {
                    op = ">>";
                    this.pos++;
                } else if (this.input[this.pos] === "&") {
                    op = ">&";
                    this.pos++;
                }
            }
        } else if (ch === "<") {
            if (this.pos < this.input.length) {
                if (this.input[this.pos] === "&") {
                    op = "<&";
                    this.pos++;
                } else if (this.input[this.pos] === "<") {
                    this.pos++;
                    if (this.pos < this.input.length && this.input[this.pos] === "<") {
                        // <<<  here-string
                        op = "<<<";
                        this.pos++;
                    } else {
                        // << here-doc — read delimiter, defer body scan to after newline.
                        const stripTabs = this.pos < this.input.length && this.input[this.pos] === "-";
                        if (stripTabs) this.pos++;
                        op = stripTabs ? "<<-" : "<<";

                        while (this.pos < this.input.length && this.input[this.pos] === " ") this.pos++;

                        const { delim, quoted } = this.readHeredocDelim();
                        // Create token with empty body; body is filled after line ends.
                        const tok: Token = { type: TokenType.Redirect, value: op, start: startPos, end: this.pos, fd, hereDoc: { delim, body: "", quoted } };
                        this.pendingHereDocs.push({ token: tok, delim, quoted, stripTabs });
                        return tok;
                    }
                }
            }
        }

        return { type: TokenType.Redirect, value: op, start: startPos, end: this.pos, fd };
    }

    private readWord(): Token | null {
        const segments: WordSegment[] = [];
        const startPos = this.pos;

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;

            // Break on whitespace or operator chars
            if (ch === " " || ch === "\t" || ch === "\n") break;
            if (ch === "|" || ch === "&" || ch === ";" || ch === "(" || ch === ")") break;

            // Process substitution: <(...) or >(...)
            if ((ch === "<" || ch === ">") && this.pos + 1 < this.input.length && this.input[this.pos + 1] === "(") {
                segments.push(this.readProcessSubstitution(ch as "<" | ">"));
                continue;
            }

            // Break on redirect operators (but not if we're mid-word and it's not a digit>)
            if ((ch === ">" || ch === "<") && segments.length === 0 && startPos === this.pos) break;
            if (ch === ">" || ch === "<") {
                // Check if this is a redirect: only if all preceding segments form a number
                break;
            }

            if (ch === "'") {
                segments.push(this.readSingleQuoted());
            } else if (ch === '"') {
                segments.push(this.readDoubleQuoted());
            } else if (ch === "\\") {
                segments.push(this.readBackslashEscape());
            } else if (ch === "$") {
                segments.push(this.readDollar());
            } else if (ch === "`") {
                segments.push(this.readBacktickSubstitution());
            } else if (ch === "*" || ch === "?") {
                segments.push({ type: "Glob", pattern: ch });
                this.pos++;
            } else if (ch === "[") {
                const glob = this.tryGlobBracket();
                if (glob) {
                    segments.push(glob);
                } else {
                    segments.push({ type: "Literal", value: ch });
                    this.pos++;
                }
            } else if (ch === "{") {
                // { is a brace group keyword only when it's the first token and
                // followed by whitespace.  Otherwise it's a literal (brace expansion).
                if (segments.length === 0) {
                    const next = this.input[this.pos + 1];
                    if (next === undefined || next === " " || next === "\t" || next === "\n" || next === ";") {
                        break; // Let the post-loop handler emit LBrace
                    }
                }
                segments.push({ type: "Literal", value: ch });
                this.pos++;
            } else if (ch === "}") {
                if (segments.length === 0) break; // Let the post-loop handler emit RBrace
                segments.push({ type: "Literal", value: ch });
                this.pos++;
            } else if (ch === "#") {
                // # in mid-word is literal
                if (segments.length === 0) break;
                segments.push({ type: "Literal", value: ch });
                this.pos++;
            } else {
                segments.push(this.readLiteral());
            }
        }

        if (segments.length === 0) {
            // Check for { and } as standalone tokens
            if (this.pos < this.input.length) {
                const ch = this.input[this.pos]!;
                if (ch === "{") {
                    const s = this.pos;
                    this.pos++;
                    return { type: TokenType.LBrace, value: "{", start: s, end: this.pos };
                }
                if (ch === "}") {
                    const s = this.pos;
                    this.pos++;
                    return { type: TokenType.RBrace, value: "}", start: s, end: this.pos };
                }
            }
            return null;
        }

        const word: Word = { segments };
        return { type: TokenType.Word, value: this.input.slice(startPos, this.pos), start: startPos, end: this.pos, word };
    }

    private readLiteral(): WordSegment {
        let value = "";
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (
                ch === " " || ch === "\t" || ch === "\n" ||
                ch === "'" || ch === '"' || ch === "\\" ||
                ch === "$" || ch === "`" ||
                ch === "|" || ch === "&" || ch === ";" ||
                ch === "(" || ch === ")" ||
                ch === ">" || ch === "<" ||
                ch === "*" || ch === "?" || ch === "[" ||
                ch === "{" || ch === "}" ||
                ch === "#"
            ) {
                break;
            }
            value += ch;
            this.pos++;
        }
        return { type: "Literal", value };
    }

    private readSingleQuoted(): WordSegment {
        this.pos++; // skip opening '
        let value = "";
        while (this.pos < this.input.length) {
            if (this.input[this.pos] === "'") {
                this.pos++; // skip closing '
                return { type: "SingleQuoted", value };
            }
            value += this.input[this.pos];
            this.pos++;
        }
        throw new IncompleteInputError("Unclosed single quote");
    }

    private readDoubleQuoted(): WordSegment {
        this.pos++; // skip opening "
        const segments: WordSegment[] = [];
        let literal = "";

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;

            if (ch === '"') {
                if (literal) segments.push({ type: "Literal", value: literal });
                this.pos++; // skip closing "
                return { type: "DoubleQuoted", segments };
            }

            if (ch === "\\") {
                // In double quotes, backslash only escapes $, `, ", \, and newline
                if (this.pos + 1 < this.input.length) {
                    const next = this.input[this.pos + 1]!;
                    if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
                        if (literal) {
                            segments.push({ type: "Literal", value: literal });
                            literal = "";
                        }
                        this.pos += 2;
                        if (next !== "\n") {
                            literal += next;
                        }
                        continue;
                    }
                }
                literal += ch;
                this.pos++;
                continue;
            }

            if (ch === "$") {
                if (literal) {
                    segments.push({ type: "Literal", value: literal });
                    literal = "";
                }
                segments.push(this.readDollar());
                continue;
            }

            if (ch === "`") {
                if (literal) {
                    segments.push({ type: "Literal", value: literal });
                    literal = "";
                }
                segments.push(this.readBacktickSubstitution());
                continue;
            }

            literal += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed double quote");
    }

    private readBackslashEscape(): WordSegment {
        this.pos++; // skip backslash
        if (this.pos >= this.input.length) {
            // Trailing backslash — request continuation so the REPL reads the
            // next line. Once appended, the next parse sees `\<newline>` and
            // consumes it via the branch below.
            throw new IncompleteInputError("Trailing backslash");
        }
        const ch = this.input[this.pos]!;
        if (ch === "\n") {
            // Line continuation
            this.pos++;
            return { type: "Literal", value: "" };
        }
        this.pos++;
        return { type: "Literal", value: ch };
    }

    private readDollar(): WordSegment {
        this.pos++; // skip $
        if (this.pos >= this.input.length) {
            return { type: "Literal", value: "$" };
        }

        const ch = this.input[this.pos]!;

        // $'...' ANSI-C quoting
        if (ch === "'") {
            return this.readAnsiCQuoted();
        }

        // $((...)) arithmetic expansion
        if (ch === "(" && this.pos + 1 < this.input.length && this.input[this.pos + 1] === "(") {
            return this.readArithmeticExpansion();
        }

        // $(...) command substitution
        if (ch === "(") {
            return this.readCommandSubstitution();
        }

        // ${...} parameter expansion
        if (ch === "{") {
            return this.readBraceExpansion();
        }

        // $VAR simple variable
        if (this.isNameStart(ch) || ch === "?" || ch === "$" || ch === "!" || ch === "#" || ch === "-" || ch === "@" || ch === "*" || (ch >= "0" && ch <= "9")) {
            // Special single-char variables
            if (ch === "?" || ch === "$" || ch === "!" || ch === "#" || ch === "-" || ch === "@" || ch === "*") {
                this.pos++;
                return { type: "VariableExpansion", name: ch };
            }
            if (ch >= "0" && ch <= "9") {
                this.pos++;
                return { type: "VariableExpansion", name: ch };
            }
            return this.readSimpleVariable();
        }

        // Bare $ not followed by anything meaningful
        return { type: "Literal", value: "$" };
    }

    private readSimpleVariable(): VariableExpansion {
        let name = "";
        while (this.pos < this.input.length && this.isNameChar(this.input[this.pos]!)) {
            name += this.input[this.pos];
            this.pos++;
        }
        return { type: "VariableExpansion", name };
    }

    private readBraceExpansion(): VariableExpansion {
        this.pos++; // skip {
        let name = "";
        let operator: string | undefined;
        let operand: WordSegment[] | undefined;

        // Read the variable name
        let index: string | undefined;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === "}") {
                this.pos++;
                return { type: "VariableExpansion", name, index, operator, operand };
            }
            // Array subscript: ${VAR[idx]}
            if (ch === "[" && name.length > 0) {
                this.pos++;
                let idx = "";
                while (this.pos < this.input.length && this.input[this.pos] !== "]") {
                    idx += this.input[this.pos];
                    this.pos++;
                }
                if (this.pos < this.input.length) this.pos++; // skip ]
                index = idx;
                continue;
            }
            // Check for operators
            if (ch === ":" && this.pos + 1 < this.input.length) {
                const next = this.input[this.pos + 1]!;
                if (next === "-" || next === "+" || next === "=" || next === "?") {
                    operator = ":" + next;
                    this.pos += 2;
                    operand = this.readBraceOperand();
                    return { type: "VariableExpansion", name, index, operator, operand };
                }
                // Substring: ${VAR:offset} or ${VAR:offset:length}
                if (next === "}" || /[0-9 (+-]/.test(next)) {
                    operator = ":";
                    this.pos++; // skip :
                    operand = this.readBraceOperand();
                    return { type: "VariableExpansion", name, index, operator, operand };
                }
            }
            if ((ch === "%" || ch === "#") && name.length > 0) {
                if (this.pos + 1 < this.input.length && this.input[this.pos + 1] === ch) {
                    operator = ch + ch;
                    this.pos += 2;
                } else {
                    operator = ch;
                    this.pos++;
                }
                operand = this.readBraceOperand();
                return { type: "VariableExpansion", name, index, operator, operand };
            }
            if ((ch === "/" || ch === "^" || ch === ",") && name.length > 0) {
                if (this.pos + 1 < this.input.length && this.input[this.pos + 1] === ch) {
                    operator = ch + ch;
                    this.pos += 2;
                } else {
                    operator = ch;
                    this.pos++;
                }
                operand = this.readBraceOperand();
                return { type: "VariableExpansion", name, index, operator, operand };
            }
            // Also handle - + = ? without colon prefix
            if ((ch === "-" || ch === "+" || ch === "=" || ch === "?") && name.length > 0) {
                operator = ch;
                this.pos++;
                operand = this.readBraceOperand();
                return { type: "VariableExpansion", name, index, operator, operand };
            }
            name += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed ${");
    }

    private readBraceOperand(): WordSegment[] {
        const segments: WordSegment[] = [];
        let literal = "";
        let depth = 1; // we're inside one { already

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;

            if (ch === "}" && depth === 1) {
                if (literal) segments.push({ type: "Literal", value: literal });
                this.pos++; // skip closing }
                return segments;
            }

            if (ch === "{") depth++;
            if (ch === "}") depth--;

            if (ch === "$") {
                if (literal) {
                    segments.push({ type: "Literal", value: literal });
                    literal = "";
                }
                segments.push(this.readDollar());
                continue;
            }

            if (ch === "\\") {
                this.pos++;
                if (this.pos < this.input.length) {
                    literal += this.input[this.pos];
                    this.pos++;
                }
                continue;
            }

            if (ch === "'") {
                if (literal) {
                    segments.push({ type: "Literal", value: literal });
                    literal = "";
                }
                segments.push(this.readSingleQuoted());
                continue;
            }

            if (ch === '"') {
                if (literal) {
                    segments.push({ type: "Literal", value: literal });
                    literal = "";
                }
                segments.push(this.readDoubleQuoted());
                continue;
            }

            literal += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed ${");
    }

    private readCommandSubstitution(): WordSegment {
        this.pos++; // skip (
        let depth = 1;
        let body = "";

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === "(") depth++;
            if (ch === ")") {
                depth--;
                if (depth === 0) {
                    this.pos++;
                    return { type: "CommandSubstitution", body };
                }
            }
            body += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed $(");
    }

    private readArithmeticExpansion(): WordSegment {
        this.pos += 2; // skip ((
        let depth = 1;
        let expression = "";

        while (this.pos < this.input.length) {
            if (this.input[this.pos] === "(" && this.pos + 1 < this.input.length && this.input[this.pos + 1] === "(") {
                depth++;
                expression += "((";
                this.pos += 2;
                continue;
            }
            if (this.input[this.pos] === ")" && this.pos + 1 < this.input.length && this.input[this.pos + 1] === ")") {
                depth--;
                if (depth === 0) {
                    this.pos += 2;
                    return { type: "ArithmeticExpansion", expression };
                }
                expression += "))";
                this.pos += 2;
                continue;
            }
            expression += this.input[this.pos];
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed $((");
    }

    private readBacktickSubstitution(): WordSegment {
        this.pos++; // skip `
        let body = "";

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === "\\") {
                if (this.pos + 1 < this.input.length) {
                    const next = this.input[this.pos + 1]!;
                    if (next === "`" || next === "\\" || next === "$") {
                        body += next;
                        this.pos += 2;
                        continue;
                    }
                }
                body += ch;
                this.pos++;
                continue;
            }
            if (ch === "`") {
                this.pos++;
                return { type: "CommandSubstitution", body };
            }
            body += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed backtick");
    }

    private readProcessSubstitution(direction: "<" | ">"): WordSegment {
        this.pos += 2; // skip <( or >(
        let body = "";
        let depth = 1;
        while (this.pos < this.input.length && depth > 0) {
            if (this.input[this.pos] === "(") depth++;
            else if (this.input[this.pos] === ")") {
                depth--;
                if (depth === 0) { this.pos++; break; }
            }
            body += this.input[this.pos];
            this.pos++;
        }
        if (depth > 0) throw new IncompleteInputError("Unclosed process substitution");
        return { type: "ProcessSubstitution", body, direction };
    }

    private readAnsiCQuoted(): WordSegment {
        this.pos++; // skip ' (after $)
        let value = "";

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === "'") {
                this.pos++;
                return { type: "Literal", value };
            }
            if (ch === "\\") {
                this.pos++;
                if (this.pos >= this.input.length) break;
                const esc = this.input[this.pos]!;
                switch (esc) {
                    case "a": value += "\x07"; break;
                    case "b": value += "\b"; break;
                    case "e": case "E": value += "\x1b"; break;
                    case "f": value += "\f"; break;
                    case "n": value += "\n"; break;
                    case "r": value += "\r"; break;
                    case "t": value += "\t"; break;
                    case "v": value += "\v"; break;
                    case "\\": value += "\\"; break;
                    case "'": value += "'"; break;
                    case '"': value += '"'; break;
                    case "x": {
                        // hex escape
                        let hex = "";
                        this.pos++;
                        for (let i = 0; i < 2 && this.pos < this.input.length; i++) {
                            const h = this.input[this.pos]!;
                            if (/[0-9a-fA-F]/.test(h)) {
                                hex += h;
                                this.pos++;
                            } else break;
                        }
                        value += hex ? String.fromCharCode(parseInt(hex, 16)) : "\\x";
                        continue; // skip the this.pos++ at the end
                    }
                    case "0": case "1": case "2": case "3":
                    case "4": case "5": case "6": case "7": {
                        // octal escape
                        let oct = esc;
                        this.pos++;
                        for (let i = 0; i < 2 && this.pos < this.input.length; i++) {
                            const o = this.input[this.pos]!;
                            if (o >= "0" && o <= "7") {
                                oct += o;
                                this.pos++;
                            } else break;
                        }
                        value += String.fromCharCode(parseInt(oct, 8));
                        continue;
                    }
                    default:
                        value += "\\" + esc;
                        break;
                }
                this.pos++;
                continue;
            }
            value += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed $' quote");
    }

    private tryGlobBracket(): WordSegment | null {
        // Look ahead to find matching ]
        let tmpPos = this.pos + 1;
        // ] as first char is literal in bracket expression
        if (tmpPos < this.input.length && this.input[tmpPos] === "]") {
            tmpPos++;
        }
        let pattern = "";
        while (tmpPos < this.input.length) {
            const c = this.input[tmpPos]!;
            // Glob brackets cannot span whitespace or shell metacharacters
            if (c === " " || c === "\t" || c === "\n" || c === "|" || c === "&" || c === ";" || c === "(" || c === ")") {
                return null;
            }
            if (c === "]") {
                pattern = this.input.slice(this.pos, tmpPos + 1);
                this.pos = tmpPos + 1;
                return { type: "Glob", pattern };
            }
            tmpPos++;
        }
        return null;
    }

    private isNameStart(ch: string): boolean {
        return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
    }

    private isNameChar(ch: string): boolean {
        return this.isNameStart(ch) || (ch >= "0" && ch <= "9");
    }

    // Public API

    peek(): Token {
        return this.tokens[this.tokenIndex] ?? { type: TokenType.EOF, value: "" };
    }

    // ---- Here-doc scanner ---------------------------------------------------

    private readHeredocDelim(): { delim: string; quoted: boolean } {
        let delim = "";
        let quoted = false;

        if (this.pos < this.input.length) {
            const q = this.input[this.pos]!;
            if (q === "'" || q === '"') {
                quoted = true;
                this.pos++;
                while (this.pos < this.input.length && this.input[this.pos] !== q) {
                    delim += this.input[this.pos++];
                }
                if (this.pos < this.input.length) this.pos++; // closing quote
            } else {
                while (this.pos < this.input.length) {
                    const c = this.input[this.pos]!;
                    if (c === "\n" || c === " " || c === "\t" || c === ";" || c === "|" || c === "&") break;
                    delim += c;
                    this.pos++;
                }
            }
        }

        return { delim, quoted };
    }

    // Reads here-doc body starting at current this.pos (called after newline consumed).
    private readHeredocBodyAtPos(delim: string, _quoted: boolean, stripTabs: boolean): string {
        const lines: string[] = [];
        while (this.pos < this.input.length) {
            const lineStart = this.pos;
            while (this.pos < this.input.length && this.input[this.pos] !== "\n") this.pos++;
            const line = this.input.slice(lineStart, this.pos);
            if (this.pos < this.input.length) this.pos++; // consume \n

            const checkLine = stripTabs ? line.replace(/^\t+/, "") : line;
            if (checkLine === delim) {
                return lines.join("\n") + (lines.length > 0 ? "\n" : "");
            }
            lines.push(stripTabs ? line.replace(/^\t+/, "") : line);
        }
        throw new IncompleteInputError(`Unclosed here-doc (<<${delim})`);
    }

    // ---- JS expression scanner (for @{ } tokens) ---------------------------

    private readJsExpression(): string {
        let depth = 1;
        let expr = "";

        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;

            if (ch === "'" || ch === '"') {
                expr += this.readJsStringLiteral(ch);
                continue;
            }
            if (ch === "`") {
                expr += this.readJsTemplateLiteral();
                continue;
            }
            if (ch === "{") { depth++; expr += ch; this.pos++; continue; }
            if (ch === "}") {
                depth--;
                if (depth === 0) { this.pos++; return expr; }
                expr += ch; this.pos++; continue;
            }
            expr += ch;
            this.pos++;
        }

        throw new IncompleteInputError("Unclosed @{");
    }

    private readJsStringLiteral(quote: string): string {
        let result = quote;
        this.pos++;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === "\\") {
                // A backslash followed by a line terminator is a JS line
                // continuation — consume both so the string can span lines.
                result += ch + (this.input[this.pos + 1] ?? "");
                this.pos += 2;
                continue;
            }
            if (ch === "\n" || ch === "\r") {
                // Regular JS string literals ('...', "...") can't contain raw
                // line terminators; `new Function()` would reject later with
                // a vague "Invalid or unexpected token". Raise a pointed error
                // here instead. Triggered by multi-line paste into the REPL.
                throw new Error(
                    `@{}: unescaped newline in ${quote}...${quote} string — ` +
                    `use backticks \`...\` for multi-line strings, or escape as \\n`
                );
            }
            if (ch === quote) { result += ch; this.pos++; return result; }
            result += ch; this.pos++;
        }
        throw new IncompleteInputError("Unclosed JS string in @{");
    }

    private readJsTemplateLiteral(): string {
        let result = "`";
        this.pos++;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos]!;
            if (ch === "\\") {
                result += ch + (this.input[this.pos + 1] ?? "");
                this.pos += 2;
                continue;
            }
            if (ch === "`") { result += ch; this.pos++; return result; }
            if (ch === "$" && this.input[this.pos + 1] === "{") {
                result += "${"; this.pos += 2;
                let depth = 1;
                while (this.pos < this.input.length && depth > 0) {
                    const c = this.input[this.pos]!;
                    if (c === "{") depth++;
                    else if (c === "}") depth--;
                    result += c; this.pos++;
                }
                continue;
            }
            result += ch; this.pos++;
        }
        throw new IncompleteInputError("Unclosed template literal in @{");
    }

    // ---- Public API ---------------------------------------------------------

    peekAt(offset: number): Token {
        return this.tokens[this.tokenIndex + offset] ?? { type: TokenType.EOF, value: "" };
    }

    next(): Token {
        const token = this.tokens[this.tokenIndex] ?? { type: TokenType.EOF, value: "" };
        if (this.tokenIndex < this.tokens.length) {
            this.tokenIndex++;
        }
        return token;
    }

    expect(type: TokenType): Token {
        const token = this.next();
        if (token.type !== type) {
            throw new LexerError(`Expected ${type}, got ${token.type} (${token.value})`, this.pos);
        }
        return token;
    }

    getTokens(): Token[] {
        return this.tokens;
    }
}
