import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List,
    Subshell, BraceGroup, Redirection, Word, WordSegment,
    IfClause, WhileClause, ForClause, FunctionDef, CaseClause, CaseItem,
} from "./ast.js";
import { Lexer, TokenType } from "./lexer.js";
import type { Token } from "./lexer.js";

export { ParseError, IncompleteInputError } from "./errors.js";
import { ParseError, IncompleteInputError } from "./errors.js";
import type { JsFunction } from "./ast.js";

// Keywords that terminate a compound command body.
const COMPOUND_TERMINATORS = new Set(["then", "elif", "else", "fi", "do", "done", "esac", "in"]);

export class Parser {
    private lexer: Lexer;

    constructor(input: string) {
        this.lexer = new Lexer(input);
    }

    parse(): ASTNode | null {
        this.skipNewlines();
        if (this.lexer.peek().type === TokenType.EOF) return null;
        const result = this.parseList();
        this.skipNewlines();
        if (this.lexer.peek().type !== TokenType.EOF) {
            const tok = this.lexer.peek();
            throw new ParseError(`Unexpected token: ${tok.value} (${tok.type})`);
        }
        return result;
    }

    private skipNewlines(): void {
        while (this.lexer.peek().type === TokenType.Newline) this.lexer.next();
    }

    // Returns the literal string value of a word if it consists of a single
    // unquoted literal segment, otherwise null.  Used for keyword detection.
    private literalValue(tok: Token): string | null {
        if (tok.type !== TokenType.Word || !tok.word) return null;
        const segs = tok.word.segments;
        if (segs.length === 1 && segs[0]!.type === "Literal") {
            return (segs[0] as { type: "Literal"; value: string }).value;
        }
        return null;
    }

    private isCompoundTerminator(): boolean {
        const tok = this.lexer.peek();
        if (tok.type === TokenType.CaseSemi) return true;
        const v = this.literalValue(tok);
        return v !== null && COMPOUND_TERMINATORS.has(v);
    }

    private expectKeyword(kw: string): void {
        this.skipNewlines();
        const tok = this.lexer.peek();
        if (tok.type === TokenType.EOF) {
            throw new IncompleteInputError(`Expected '${kw}'`);
        }
        const v = this.literalValue(tok);
        if (v !== kw) {
            throw new ParseError(
                `Expected '${kw}', got '${tok.value}' (${tok.type})`
            );
        }
        this.lexer.next();
    }

    // list : and_or ((';' | '&' | '\n') and_or)* [';' | '&' | '\n']
    private parseList(): ASTNode {
        const entries: { node: ASTNode; separator: ";" | "&" | "\n" }[] = [];
        let node = this.parseAndOr();

        while (true) {
            const tok = this.lexer.peek();
            let sep: ";" | "&" | "\n";

            if (tok.type === TokenType.Semi) {
                sep = ";";
                this.lexer.next();
            } else if (tok.type === TokenType.Amp) {
                sep = "&";
                this.lexer.next();
            } else if (tok.type === TokenType.Newline) {
                sep = "\n";
                this.lexer.next();
                this.skipNewlines();
            } else {
                entries.push({ node, separator: ";" });
                break;
            }

            entries.push({ node, separator: sep });

            this.skipNewlines();
            const next = this.lexer.peek();
            if (
                next.type === TokenType.EOF ||
                next.type === TokenType.RParen ||
                next.type === TokenType.RBrace ||
                this.isCompoundTerminator()
            ) {
                break;
            }

            node = this.parseAndOr();
        }

        if (entries.length === 1 && entries[0]!.separator === ";") {
            return entries[0]!.node;
        }
        return { type: "List", entries } as List;
    }

    // and_or : pipeline (('&&' | '||') pipeline)*
    private parseAndOr(): ASTNode {
        let left = this.parsePipeline();
        while (true) {
            const tok = this.lexer.peek();
            if (tok.type === TokenType.And) {
                this.lexer.next();
                this.skipNewlines();
                left = { type: "AndOr", left, op: "&&", right: this.parsePipeline() } as AndOr;
            } else if (tok.type === TokenType.Or) {
                this.lexer.next();
                this.skipNewlines();
                left = { type: "AndOr", left, op: "||", right: this.parsePipeline() } as AndOr;
            } else {
                break;
            }
        }
        return left;
    }

    // pipeline : ['!'] command ('|' command)*
    private parsePipeline(): ASTNode {
        let negated = false;
        if (this.lexer.peek().type === TokenType.Bang) {
            negated = true;
            this.lexer.next();
        }

        const commands: ASTNode[] = [];
        const pipeOps: string[] = [];
        commands.push(this.parseCommand());

        while (true) {
            const tok = this.lexer.peek();
            if (tok.type === TokenType.Pipe) {
                pipeOps.push("|");
                this.lexer.next();
                this.skipNewlines();
                commands.push(this.parseCommand());
            } else if (tok.type === TokenType.PipeAnd) {
                pipeOps.push("|&");
                this.lexer.next();
                this.skipNewlines();
                commands.push(this.parseCommand());
            } else {
                break;
            }
        }

        if (commands.length === 1 && !negated) return commands[0]!;
        return { type: "Pipeline", commands, negated, pipeOps } as Pipeline;
    }

    // command : compound_command | simple_command | js_function
    private parseCommand(): ASTNode {
        const tok = this.lexer.peek();

        if (tok.type === TokenType.LParen) return this.parseSubshell();
        if (tok.type === TokenType.LBrace) return this.parseBraceGroup();

        // @{ expr } and @!{ expr } inline JS functions
        if (tok.type === TokenType.JsInline) {
            this.lexer.next();
            return {
                type: "JsFunction",
                name: "",
                inlineBody: tok.value,
                args: [],
                buffered: tok.jsBuffered ?? false,
                redirections: this.parseRedirections(),
            } as JsFunction;
        }

        if (tok.type === TokenType.Word) {
            const kw = this.literalValue(tok);

            if (kw === "if")    return this.parseIf();
            if (kw === "while") return this.parseWhile(false);
            if (kw === "until") return this.parseWhile(true);
            if (kw === "for")   return this.parseFor();
            if (kw === "case")  return this.parseCase();

            // Function definition: NAME ( )
            if (kw !== null && this.lexer.peekAt(1).type === TokenType.LParen &&
                               this.lexer.peekAt(2).type === TokenType.RParen) {
                return this.parseFunctionDef(kw);
            }

            // @name and @!name JS function calls
            if (kw !== null && kw.startsWith("@") && kw.length > 1) {
                return this.parseJsFunction(kw);
            }
        }

        return this.parseSimpleCommand();
    }

    private parseJsFunction(nameWithAt: string): JsFunction {
        this.lexer.next(); // consume @name token

        const buffered = nameWithAt.startsWith("@!");
        const name = buffered ? nameWithAt.slice(2) : nameWithAt.slice(1);

        const args: Word[] = [];
        const redirections: Redirection[] = [];

        while (true) {
            const tok = this.lexer.peek();
            if (tok.type === TokenType.Redirect) {
                redirections.push(this.parseOneRedirection());
                continue;
            }
            if (tok.type !== TokenType.Word) break;
            args.push(tok.word!);
            this.lexer.next();
        }

        return { type: "JsFunction", name, args, buffered, redirections };
    }

    // if list; then list [elif list; then list]* [else list] fi
    private parseIf(): IfClause {
        this.lexer.next(); // consume 'if'
        this.skipNewlines();
        const condition = this.parseList();
        this.expectKeyword("then");
        this.skipNewlines();
        const consequent = this.parseList();
        this.skipNewlines();

        let elseClause: ASTNode | null = null;
        const next = this.literalValue(this.lexer.peek());

        if (next === "elif") {
            // Treat elif as a nested if — reuse parseIf but consume 'elif' as 'if'.
            this.lexer.next(); // consume 'elif'
            this.skipNewlines();
            const elifCondition = this.parseList();
            this.expectKeyword("then");
            this.skipNewlines();
            const elifConsequent = this.parseList();
            this.skipNewlines();

            // Recursively handle further elif/else/fi
            let elifElse: ASTNode | null = null;
            const elifNext = this.literalValue(this.lexer.peek());
            if (elifNext === "elif") {
                // Another elif — synthesize an IfClause and recurse
                // We need to parse remaining elif/else/fi chain.
                // Easiest: put back is not possible, so inline the rest.
                elifElse = this.parseElifChain();
            } else if (elifNext === "else") {
                this.lexer.next();
                this.skipNewlines();
                elifElse = this.parseList();
                this.skipNewlines();
            }
            this.expectKeyword("fi");

            elseClause = {
                type: "IfClause",
                condition: elifCondition,
                consequent: elifConsequent,
                elseClause: elifElse,
            } as IfClause;

        } else if (next === "else") {
            this.lexer.next();
            this.skipNewlines();
            elseClause = this.parseList();
            this.skipNewlines();
            this.expectKeyword("fi");
        } else {
            this.expectKeyword("fi");
        }

        return { type: "IfClause", condition, consequent, elseClause };
    }

    // Parse remaining elif/else/fi after an elif body has been parsed.
    private parseElifChain(): IfClause {
        this.lexer.next(); // consume 'elif'
        this.skipNewlines();
        const condition = this.parseList();
        this.expectKeyword("then");
        this.skipNewlines();
        const consequent = this.parseList();
        this.skipNewlines();

        let elseClause: ASTNode | null = null;
        const next = this.literalValue(this.lexer.peek());
        if (next === "elif") {
            elseClause = this.parseElifChain();
        } else if (next === "else") {
            this.lexer.next();
            this.skipNewlines();
            elseClause = this.parseList();
            this.skipNewlines();
        }
        // fi is consumed by the caller
        return { type: "IfClause", condition, consequent, elseClause };
    }

    // while/until list; do list done
    private parseWhile(until: boolean): WhileClause {
        this.lexer.next(); // consume 'while' or 'until'
        this.skipNewlines();
        const condition = this.parseList();
        this.expectKeyword("do");
        this.skipNewlines();
        const body = this.parseList();
        this.skipNewlines();
        this.expectKeyword("done");
        return { type: "WhileClause", condition, body, until };
    }

    // for name [in word*]; do list done
    private parseFor(): ForClause {
        this.lexer.next(); // consume 'for'
        this.skipNewlines();

        const nameTok = this.lexer.peek();
        const name = this.literalValue(nameTok);
        if (!name) throw new ParseError("Expected variable name after 'for'");
        this.lexer.next();

        this.skipNewlines();

        let items: Word[] | null = null;
        if (this.literalValue(this.lexer.peek()) === "in") {
            this.lexer.next(); // consume 'in'
            items = [];
            while (
                this.lexer.peek().type === TokenType.Word &&
                !this.isCompoundTerminator()
            ) {
                items.push(this.lexer.peek().word!);
                this.lexer.next();
            }
        }

        // Optional semicolon or newlines before 'do'
        if (this.lexer.peek().type === TokenType.Semi) this.lexer.next();
        this.skipNewlines();

        this.expectKeyword("do");
        this.skipNewlines();
        const body = this.parseList();
        this.skipNewlines();
        this.expectKeyword("done");

        return { type: "ForClause", name, items, body };
    }

    // case word in [pattern) list ;;]* esac
    private parseCase(): CaseClause {
        this.lexer.next(); // consume 'case'
        this.skipNewlines();

        const wordTok = this.lexer.peek();
        if (wordTok.type !== TokenType.Word) {
            throw new ParseError("Expected word after 'case'");
        }
        const word = wordTok.word!;
        this.lexer.next();

        this.skipNewlines();
        this.expectKeyword("in");
        this.skipNewlines();

        const items: CaseItem[] = [];

        while (true) {
            // Check for esac
            if (this.literalValue(this.lexer.peek()) === "esac") {
                this.lexer.next();
                break;
            }
            if (this.lexer.peek().type === TokenType.EOF) {
                throw new IncompleteInputError("Expected 'esac'");
            }

            // Optional leading (
            if (this.lexer.peek().type === TokenType.LParen) this.lexer.next();

            // Pattern list: word | word | ...
            const patterns: Word[] = [];
            while (true) {
                const tok = this.lexer.peek();
                if (tok.type !== TokenType.Word) break;
                patterns.push(tok.word!);
                this.lexer.next();
                if (this.lexer.peek().type === TokenType.Pipe) {
                    this.lexer.next(); // consume |
                    this.skipNewlines();
                } else {
                    break;
                }
            }

            // )
            if (this.lexer.peek().type !== TokenType.RParen) {
                throw new ParseError("Expected ')' in case pattern");
            }
            this.lexer.next();
            this.skipNewlines();

            // Body (may be empty before ;;)
            let body: ASTNode | null = null;
            if (this.lexer.peek().type !== TokenType.CaseSemi &&
                this.literalValue(this.lexer.peek()) !== "esac") {
                body = this.parseList();
                this.skipNewlines();
            }

            // ;; or esac
            if (this.lexer.peek().type === TokenType.CaseSemi) {
                this.lexer.next();
                this.skipNewlines();
            }

            items.push({ patterns, body });
        }

        return { type: "CaseClause", word, items };
    }

    // name() compound-command
    private parseFunctionDef(name: string): FunctionDef {
        this.lexer.next(); // consume name
        this.lexer.next(); // consume (
        this.lexer.next(); // consume )
        this.skipNewlines();

        const tok = this.lexer.peek();
        let body: ASTNode;
        if (tok.type === TokenType.LBrace) {
            body = this.parseBraceGroup();
        } else if (tok.type === TokenType.LParen) {
            body = this.parseSubshell();
        } else {
            // compound command (if/while/etc.)
            body = this.parseCommand();
        }
        return { type: "FunctionDef", name, body };
    }

    // subshell : '(' list ')'
    private parseSubshell(): Subshell {
        this.lexer.next();
        this.skipNewlines();
        const body = this.parseList();
        this.skipNewlines();
        if (this.lexer.peek().type !== TokenType.RParen) {
            const tok = this.lexer.peek();
            throw tok.type === TokenType.EOF
                ? new IncompleteInputError("Expected ')'")
                : new ParseError("Expected ')' to close subshell");
        }
        this.lexer.next();
        return { type: "Subshell", body, redirections: this.parseRedirections() };
    }

    // brace_group : '{' list '}'
    private parseBraceGroup(): BraceGroup {
        this.lexer.next();
        this.skipNewlines();
        const body = this.parseList();
        this.skipNewlines();
        if (this.lexer.peek().type !== TokenType.RBrace) {
            const tok = this.lexer.peek();
            throw tok.type === TokenType.EOF
                ? new IncompleteInputError("Expected '}'")
                : new ParseError("Expected '}' to close brace group");
        }
        this.lexer.next();
        return { type: "BraceGroup", body, redirections: this.parseRedirections() };
    }

    // simple_command : (assignment | word | redirection)+
    private parseSimpleCommand(): SimpleCommand {
        const assignments: { name: string; value: Word }[] = [];
        const words: Word[] = [];
        const redirections: Redirection[] = [];
        let seenCommandWord = false;

        while (true) {
            const tok = this.lexer.peek();

            if (tok.type === TokenType.Redirect) {
                redirections.push(this.parseOneRedirection());
                continue;
            }
            // `!` is only special at the start of a pipeline; inside a command's
            // argument list it is a plain word (e.g. `test ! -f foo`).
            if (tok.type === TokenType.Bang && seenCommandWord) {
                words.push({ segments: [{ type: "Literal", value: "!" }] });
                this.lexer.next();
                continue;
            }
            if (tok.type !== TokenType.Word) break;
            if (!seenCommandWord && this.isAssignment(tok)) {
                assignments.push(this.parseAssignment(tok));
                this.lexer.next();
                continue;
            }
            seenCommandWord = true;
            words.push(tok.word!);
            this.lexer.next();
        }

        if (words.length === 0 && assignments.length === 0 && redirections.length === 0) {
            const tok = this.lexer.peek();
            if (tok.type === TokenType.EOF) {
                throw new IncompleteInputError();
            }
            throw new ParseError(
                `Expected command, got ${tok.type} (${tok.value})`
            );
        }
        return { type: "SimpleCommand", assignments, words, redirections };
    }

    private parseRedirections(): Redirection[] {
        const result: Redirection[] = [];
        while (this.lexer.peek().type === TokenType.Redirect) {
            result.push(this.parseOneRedirection());
        }
        return result;
    }

    private parseOneRedirection(): Redirection {
        const tok = this.lexer.next();

        // Here-doc: body is embedded in the token.
        if (tok.hereDoc) {
            const { body, quoted } = tok.hereDoc;
            const word: Word = { segments: [{ type: "HereDoc", body, quoted }] };
            return { op: tok.value, fd: tok.fd, target: word };
        }

        // Here-string <<<
        if (tok.value === "<<<") {
            const target = this.lexer.peek();
            if (target.type !== TokenType.Word) throw new ParseError("Expected word after <<<");
            this.lexer.next();
            return { op: tok.value, fd: tok.fd, target: target.word! };
        }

        const target = this.lexer.peek();
        if (target.type !== TokenType.Word) {
            throw new ParseError(`Expected redirection target after ${tok.value}`);
        }
        this.lexer.next();
        return { op: tok.value, fd: tok.fd, target: target.word! };
    }

    private isAssignment(tok: Token): boolean {
        if (!tok.word || tok.word.segments.length === 0) return false;
        const first = tok.word.segments[0]!;
        if (first.type !== "Literal") return false;
        const eqIdx = (first as { type: "Literal"; value: string }).value.indexOf("=");
        if (eqIdx <= 0) return false;
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(
            (first as { type: "Literal"; value: string }).value.slice(0, eqIdx)
        );
    }

    private parseAssignment(tok: Token): { name: string; value: Word } {
        const first = tok.word!.segments[0]! as { type: "Literal"; value: string };
        const eqIdx = first.value.indexOf("=");
        const name = first.value.slice(0, eqIdx);
        const rest = first.value.slice(eqIdx + 1);
        const valueSegments: WordSegment[] = [];
        if (rest) valueSegments.push({ type: "Literal", value: rest });
        for (let i = 1; i < tok.word!.segments.length; i++) {
            valueSegments.push(tok.word!.segments[i]!);
        }
        return { name, value: { segments: valueSegments } };
    }
}
