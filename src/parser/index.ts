export type {
    ASTNode, SimpleCommand, Pipeline, AndOr, List, Assignment,
    Subshell, BraceGroup, Redirection, Word, WordSegment,
    LiteralSegment, SingleQuotedSegment, DoubleQuotedSegment,
    VariableExpansion, CommandSubstitution, ArithmeticExpansion, GlobSegment, ProcessSubstitution,
    IfClause, WhileClause, ForClause, ArithmeticFor, SelectClause, FunctionDef, JsFunction, JsArg, CaseClause,
    ConditionalExpr,
} from "./ast.js";

export { Lexer, TokenType, LexerError } from "./lexer.js";
export { IncompleteInputError } from "./errors.js";
export type { Token } from "./lexer.js";

export { Parser, ParseError } from "./parser.js";
export type { SlotTypeLookup, ParserOptions } from "./parser.js";

import { Parser } from "./parser.js";
import type { ASTNode } from "./ast.js";
import type { ParserOptions } from "./parser.js";
import { lookupSlotType } from "../jsfunctions/index.js";

// Default options consult the global @-fn registry for slot types so the
// parser can pick JS-expression mode for function-typed arg slots
// (e.g. `@where f => f.x > 10`). Tests / isolated parser uses can opt out
// by passing an empty options object or a stub lookup.
export function parse(input: string, options: ParserOptions = { lookupSlotType }): ASTNode | null {
    return new Parser(input, options).parse();
}
