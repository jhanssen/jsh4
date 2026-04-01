// Word segments — represent parts of a shell word that need different expansion treatment

export interface LiteralSegment {
    type: "Literal";
    value: string;
}

export interface SingleQuotedSegment {
    type: "SingleQuoted";
    value: string;
}

export interface DoubleQuotedSegment {
    type: "DoubleQuoted";
    segments: WordSegment[];
}

export interface VariableExpansion {
    type: "VariableExpansion";
    name: string;
    operator?: string;   // e.g. ":-", ":+", "%%", "#", etc.
    operand?: WordSegment[];
}

export interface CommandSubstitution {
    type: "CommandSubstitution";
    body: string;
}

export interface ArithmeticExpansion {
    type: "ArithmeticExpansion";
    expression: string;
}

export interface GlobSegment {
    type: "Glob";
    pattern: string;  // *, ?, or [...] content
}

export type WordSegment =
    | LiteralSegment
    | SingleQuotedSegment
    | DoubleQuotedSegment
    | VariableExpansion
    | CommandSubstitution
    | ArithmeticExpansion
    | GlobSegment;

export interface Word {
    segments: WordSegment[];
}

// Redirections

export interface Redirection {
    op: string;       // ">", ">>", "<", ">&", "<&", "&>", "&>>"
    fd?: number;      // source fd (e.g. 2 in 2>file)
    target: Word;     // target filename or fd number
}

// AST nodes

export interface ASTNode {
    type: string;
}

export interface SimpleCommand extends ASTNode {
    type: "SimpleCommand";
    assignments: { name: string; value: Word }[];
    words: Word[];
    redirections: Redirection[];
}

export interface Pipeline extends ASTNode {
    type: "Pipeline";
    commands: ASTNode[];
    negated: boolean;
    pipeOps: string[];  // "|" or "|&" between commands
}

export interface AndOr extends ASTNode {
    type: "AndOr";
    left: ASTNode;
    op: "&&" | "||";
    right: ASTNode;
}

export interface List extends ASTNode {
    type: "List";
    entries: { node: ASTNode; separator: ";" | "&" | "\n" }[];
}

export interface Subshell extends ASTNode {
    type: "Subshell";
    body: ASTNode;
    redirections: Redirection[];
}

export interface BraceGroup extends ASTNode {
    type: "BraceGroup";
    body: ASTNode;
    redirections: Redirection[];
}

export interface IfClause extends ASTNode {
    type: "IfClause";
    condition: ASTNode;
    consequent: ASTNode;
    elseClause: ASTNode | null; // another IfClause for elif, or a list for else
}

export interface WhileClause extends ASTNode {
    type: "WhileClause";
    condition: ASTNode;
    body: ASTNode;
    until: boolean;
}

export interface ForClause extends ASTNode {
    type: "ForClause";
    name: string;
    items: Word[] | null; // null = iterate over positional params
    body: ASTNode;
}

export interface FunctionDef extends ASTNode {
    type: "FunctionDef";
    name: string;
    body: ASTNode;
}

export interface JsFunction extends ASTNode {
    type: "JsFunction";
    name: string;           // function name (empty for inline @{ })
    inlineBody?: string;    // raw JS expression for @{ expr }
    args: Word[];
    buffered: boolean;      // true for @! mode
    redirections: Redirection[];
}
