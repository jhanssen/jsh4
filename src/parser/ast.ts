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
    index?: string;      // array subscript: "0", "1", "@", "*"
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

export interface HereDocSegment {
    type: "HereDoc";
    body: string;     // literal body of the here-doc (already collected)
    quoted: boolean;  // true if delimiter was quoted (no expansion)
}

export interface ProcessSubstitution {
    type: "ProcessSubstitution";
    body: string;     // command string inside <(...) or >(...)
    direction: "<" | ">";  // < = readable, > = writable
}

export type WordSegment =
    | LiteralSegment
    | SingleQuotedSegment
    | DoubleQuotedSegment
    | VariableExpansion
    | CommandSubstitution
    | ArithmeticExpansion
    | GlobSegment
    | HereDocSegment
    | ProcessSubstitution;

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

export interface Assignment {
    name: string;
    index?: string;           // array subscript: arr[0]=val
    value: Word;
    append?: boolean;         // +=
    array?: Word[];           // arr=(word1 word2 ...)
}

export interface SimpleCommand extends ASTNode {
    type: "SimpleCommand";
    assignments: Assignment[];
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

export interface ArithmeticFor extends ASTNode {
    type: "ArithmeticFor";
    init: string;
    condition: string;
    update: string;
    body: ASTNode;
}

export interface SelectClause extends ASTNode {
    type: "SelectClause";
    name: string;
    items: Word[];
    body: ASTNode;
}

export interface FunctionDef extends ASTNode {
    type: "FunctionDef";
    name: string;
    body: ASTNode;
}

export interface CaseItem {
    patterns: Word[];
    body: ASTNode | null; // null for empty body (;;)
}

export interface CaseClause extends ASTNode {
    type: "CaseClause";
    word: Word;
    items: CaseItem[];
}

export interface ConditionalExpr extends ASTNode {
    type: "ConditionalExpr";
    words: Word[];  // tokens between [[ and ]]
}

export interface JsFunction extends ASTNode {
    type: "JsFunction";
    name: string;           // function name (empty for inline @{ })
    inlineBody?: string;    // raw JS expression for @{ expr }
    args: Word[];
    buffered: boolean;      // true for @! mode
    redirections: Redirection[];
}
