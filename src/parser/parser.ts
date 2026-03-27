import type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List,
    Subshell, BraceGroup, Redirection, Word, WordSegment
} from "./ast.js";
import { Lexer, TokenType } from "./lexer.js";
import type { Token } from "./lexer.js";

export class ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParseError";
    }
}

export class Parser {
    private lexer: Lexer;

    constructor(input: string) {
        this.lexer = new Lexer(input);
    }

    parse(): ASTNode | null {
        this.skipNewlines();

        if (this.lexer.peek().type === TokenType.EOF) {
            return null;
        }

        const result = this.parseList();
        this.skipNewlines();

        if (this.lexer.peek().type !== TokenType.EOF) {
            const tok = this.lexer.peek();
            throw new ParseError(`Unexpected token: ${tok.value} (${tok.type})`);
        }

        return result;
    }

    private skipNewlines(): void {
        while (this.lexer.peek().type === TokenType.Newline) {
            this.lexer.next();
        }
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
                next.type === TokenType.RBrace
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
                const right = this.parsePipeline();
                left = { type: "AndOr", left, op: "&&", right } as AndOr;
            } else if (tok.type === TokenType.Or) {
                this.lexer.next();
                this.skipNewlines();
                const right = this.parsePipeline();
                left = { type: "AndOr", left, op: "||", right } as AndOr;
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

        if (commands.length === 1 && !negated) {
            return commands[0]!;
        }

        return { type: "Pipeline", commands, negated, pipeOps } as Pipeline;
    }

    // command : simple_command | subshell [redirections] | brace_group [redirections]
    private parseCommand(): ASTNode {
        const tok = this.lexer.peek();

        if (tok.type === TokenType.LParen) {
            return this.parseSubshell();
        }

        if (tok.type === TokenType.LBrace) {
            return this.parseBraceGroup();
        }

        return this.parseSimpleCommand();
    }

    // subshell : '(' list ')'
    private parseSubshell(): Subshell {
        this.lexer.next(); // skip (
        this.skipNewlines();
        const body = this.parseList();
        this.skipNewlines();

        if (this.lexer.peek().type !== TokenType.RParen) {
            throw new ParseError("Expected ')' to close subshell");
        }
        this.lexer.next();

        const redirections = this.parseRedirections();
        return { type: "Subshell", body, redirections };
    }

    // brace_group : '{' list '}'
    private parseBraceGroup(): BraceGroup {
        this.lexer.next(); // skip {
        this.skipNewlines();
        const body = this.parseList();
        this.skipNewlines();

        if (this.lexer.peek().type !== TokenType.RBrace) {
            throw new ParseError("Expected '}' to close brace group");
        }
        this.lexer.next();

        const redirections = this.parseRedirections();
        return { type: "BraceGroup", body, redirections };
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

            if (tok.type !== TokenType.Word) break;

            // Check for assignment before command word
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
            throw new ParseError(`Expected command, got ${this.lexer.peek().type} (${this.lexer.peek().value})`);
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
        const target = this.lexer.peek();

        if (target.type !== TokenType.Word) {
            throw new ParseError(`Expected redirection target after ${tok.value}`);
        }
        this.lexer.next();

        return { op: tok.value, fd: tok.fd, target: target.word! };
    }

    private isAssignment(tok: Token): boolean {
        // NAME=value pattern — the first segment must be a literal containing =
        // and the part before = must be a valid name
        if (!tok.word || tok.word.segments.length === 0) return false;
        const first = tok.word.segments[0]!;
        if (first.type !== "Literal") return false;
        const eqIdx = first.value.indexOf("=");
        if (eqIdx <= 0) return false;
        const name = first.value.slice(0, eqIdx);
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
    }

    private parseAssignment(tok: Token): { name: string; value: Word } {
        const first = tok.word!.segments[0]! as { type: "Literal"; value: string };
        const eqIdx = first.value.indexOf("=");
        const name = first.value.slice(0, eqIdx);
        const rest = first.value.slice(eqIdx + 1);

        const valueSegments: WordSegment[] = [];
        if (rest) {
            valueSegments.push({ type: "Literal", value: rest });
        }
        for (let i = 1; i < tok.word!.segments.length; i++) {
            valueSegments.push(tok.word!.segments[i]!);
        }

        return { name, value: { segments: valueSegments } };
    }
}
