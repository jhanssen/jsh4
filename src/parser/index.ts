export type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List,
    Subshell, BraceGroup, Redirection, Word, WordSegment,
    LiteralSegment, SingleQuotedSegment, DoubleQuotedSegment,
    VariableExpansion, CommandSubstitution, ArithmeticExpansion, GlobSegment, ProcessSubstitution,
    IfClause, WhileClause, ForClause, SelectClause, FunctionDef, JsFunction, CaseClause,
    ConditionalExpr,
} from "./ast.js";

export { Lexer, TokenType, LexerError } from "./lexer.js";
export { IncompleteInputError } from "./errors.js";
export type { Token } from "./lexer.js";

export { Parser, ParseError } from "./parser.js";

import { Parser } from "./parser.js";
import type { ASTNode } from "./ast.js";

export function parse(input: string): ASTNode | null {
    return new Parser(input).parse();
}
