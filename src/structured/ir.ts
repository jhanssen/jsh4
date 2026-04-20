// Type IR for structured pipelines.
//
// Schemas are produced at registration time (extracted from .ts source by
// `src/structured/extract`) and consumed at pipeline-construction time by
// the unifier (tab completion, type-error reporting, table rendering).
//
// Only the subset of TypeScript that maps cleanly to runtime values is
// represented. Anything richer (mapped/conditional types, decorators,
// classes-as-types) is reduced to `unknown` at extraction time.

export type TypeIR =
    | PrimitiveIR
    | ObjectIR
    | ArrayIR
    | TupleIR
    | UnionIR
    | LiteralIR
    | TypeVarIR
    | RefIR
    | UnknownIR;

export interface PrimitiveIR {
    kind: "primitive";
    name: "string" | "number" | "boolean" | "bigint" | "date" | "null" | "undefined";
}

export interface ObjectIR {
    kind: "object";
    fields: ObjectField[];
}

export interface ObjectField {
    name: string;
    type: TypeIR;
    optional: boolean;
}

export interface ArrayIR {
    kind: "array";
    element: TypeIR;
}

export interface TupleIR {
    kind: "tuple";
    elements: TypeIR[];
}

export interface UnionIR {
    kind: "union";
    members: TypeIR[];
}

export interface LiteralIR {
    kind: "literal";
    value: string | number | boolean | null;
}

// Generic parameter, e.g. T in `@where<T>(stdin: AsyncIterable<T>) => AsyncGenerator<T>`.
// Bound during pipeline-construction unification.
export interface TypeVarIR {
    kind: "typeVar";
    name: string;
}

// Reference to a named type defined in `SchemaFile.types`. Used to keep
// the IR compact when the same shape appears multiple times, and to break
// recursion.
export interface RefIR {
    kind: "ref";
    id: string;
}

export interface UnknownIR {
    kind: "unknown";
}

// One extracted source file's worth of schemas. Cache entries on disk are
// serialized SchemaFile JSON keyed by sha1(absSourcePath).
export interface SchemaFile {
    sourceFile: string;        // absolute path or file URL
    sourceHash: string;        // content hash of the source (and transitive .ts imports)
    extractorVersion: number;  // bumped when IR shape changes
    functions: Record<string, FunctionSchema>;
    types: Record<string, TypeIR>;  // shared/recursive type pool referenced by RefIR
}

export interface FunctionSchema {
    name: string;
    args: TypeIR;        // the args[] tuple/array shape
    input: TypeIR;       // upstream value type (often AsyncIterable<T> unwrapped to T)
    output: TypeIR;      // downstream value type (often AsyncGenerator<T> unwrapped to T)
    typeVars: string[];  // generic parameter names declared on the function
    sourceLine?: number;
    doc?: string;
}

export const EXTRACTOR_VERSION = 1;
