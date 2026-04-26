// Schema extractor — turns a TypeScript source file's exported pipeline
// functions into SchemaFile entries consumed by the registry, the unifier,
// and tab completion.
//
// V1 scope:
//   - Exported `function` and `const` bindings whose value is a function.
//   - Async generator return types: `AsyncGenerator<T>` → output T.
//   - Async iterable input types: `AsyncIterable<T>` → input T.
//   - Object literal types → ObjectIR (named fields, optionality).
//   - Primitive types, arrays, tuples, unions, literals.
//
// Out of scope (returns UnknownIR):
//   - Mapped/conditional/template-literal types.
//   - Class types, decorators, parameter properties.
//   - Inferring callback return types for `@map`-style generic transforms.
//
// The extractor is invoked from two places:
//   - tools/extract-builtin-schemas.ts at build time for the shipped
//     built-ins (output bundled into dist/structured/schemas.json).
//   - The runtime registry on cache miss for user-registered functions.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as ts from "typescript";
import {
    EXTRACTOR_VERSION,
    type SchemaFile, type FunctionSchema, type TypeIR, type ObjectField,
} from "../ir.js";

const UNKNOWN: TypeIR = { kind: "unknown" };

interface ExtractCtx {
    checker: ts.TypeChecker;
    types: Record<string, TypeIR>;
    seen: WeakMap<ts.Type, string>;
    nextId: number;
}

export interface ExtractResult {
    schemaFile: SchemaFile;
    diagnostics: string[];
}

/** Extract schemas from a single TS source file. */
export function extractSchemas(absSourcePath: string): ExtractResult {
    const program = ts.createProgram([absSourcePath], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
        allowJs: false,
        noEmit: true,
    });
    const sourceFile = program.getSourceFile(absSourcePath);
    const diagnostics: string[] = [];
    const empty: SchemaFile = {
        sourceFile: absSourcePath,
        sourceHash: hashFile(absSourcePath),
        extractorVersion: EXTRACTOR_VERSION,
        functions: {},
        types: {},
    };
    if (!sourceFile) {
        diagnostics.push(`extractor: source file not found: ${absSourcePath}`);
        return { schemaFile: empty, diagnostics };
    }

    const checker = program.getTypeChecker();
    const ctx: ExtractCtx = { checker, types: {}, seen: new WeakMap(), nextId: 0 };
    const functions: Record<string, FunctionSchema> = {};

    // Walk top-level statements for `export function` and `export const x = fn`.
    sourceFile.forEachChild(node => {
        if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
            const schema = extractFromFunction(ctx, node, node.name.text);
            if (schema) functions[schema.name] = schema;
        } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
            for (const decl of node.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name)) continue;
                const name = decl.name.text;
                const init = decl.initializer;
                if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) {
                    const schema = extractFromFunction(ctx, init, name);
                    if (schema) functions[name] = schema;
                }
            }
        }
    });

    return {
        schemaFile: {
            sourceFile: absSourcePath,
            sourceHash: hashFile(absSourcePath),
            extractorVersion: EXTRACTOR_VERSION,
            functions,
            types: ctx.types,
        },
        diagnostics,
    };
}

function hashFile(p: string): string {
    try { return createHash("sha1").update(readFileSync(p)).digest("hex"); }
    catch { return ""; }
}

function hasExportModifier(node: ts.HasModifiers): boolean {
    const mods = ts.getModifiers(node);
    return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function extractFromFunction(ctx: ExtractCtx, fn: FnLike, name: string): FunctionSchema | null {
    const sig = ctx.checker.getSignatureFromDeclaration(fn);
    if (!sig) return null;

    const typeVars: string[] = (fn.typeParameters ?? []).map(tp => tp.name.text);

    // args: first parameter, expected to be `string[]` or a tuple type.
    const params = sig.getParameters();
    const args: TypeIR = params[0]
        ? typeToIR(ctx, ctx.checker.getTypeOfSymbolAtLocation(params[0], fn))
        : UNKNOWN;

    // input: second parameter, expected to be `AsyncIterable<T>` or `null`.
    let input: TypeIR = UNKNOWN;
    if (params[1]) {
        const t = ctx.checker.getTypeOfSymbolAtLocation(params[1], fn);
        input = unwrapIterable(ctx, t) ?? typeToIR(ctx, t);
    }

    // output: unwrap AsyncGenerator<T> / AsyncIterable<T> / Promise<T>.
    const ret = sig.getReturnType();
    let output: TypeIR = UNKNOWN;
    const unwrappedReturn = unwrapPromise(ctx, ret);
    output = unwrapIterable(ctx, unwrappedReturn) ?? typeToIR(ctx, unwrappedReturn);

    return {
        name,
        args,
        input,
        output,
        typeVars,
        sourceLine: fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart()).line + 1,
    };
}

function unwrapPromise(ctx: ExtractCtx, t: ts.Type): ts.Type {
    const sym = t.getSymbol();
    if (sym?.getName() === "Promise" && (t as ts.TypeReference).typeArguments?.[0]) {
        return (t as ts.TypeReference).typeArguments![0]!;
    }
    return t;
}

function unwrapIterable(ctx: ExtractCtx, t: ts.Type): TypeIR | null {
    const sym = t.getSymbol();
    if (!sym) return null;
    const name = sym.getName();
    const ITERABLES = new Set([
        "AsyncIterable", "AsyncGenerator", "AsyncIterableIterator",
        "Iterable", "Generator", "IterableIterator",
    ]);
    if (!ITERABLES.has(name)) return null;
    const targs = (t as ts.TypeReference).typeArguments;
    if (!targs || targs.length === 0) return null;
    return typeToIR(ctx, targs[0]!);
}

function typeToIR(ctx: ExtractCtx, t: ts.Type): TypeIR {
    if (t.flags & ts.TypeFlags.Any) return UNKNOWN;
    if (t.flags & ts.TypeFlags.Unknown) return UNKNOWN;
    if (t.flags & ts.TypeFlags.Never) return UNKNOWN;
    if (t.flags & ts.TypeFlags.String)  return { kind: "primitive", name: "string" };
    if (t.flags & ts.TypeFlags.Number)  return { kind: "primitive", name: "number" };
    if (t.flags & ts.TypeFlags.Boolean) return { kind: "primitive", name: "boolean" };
    if (t.flags & ts.TypeFlags.BigInt)  return { kind: "primitive", name: "bigint" };
    if (t.flags & ts.TypeFlags.Null)    return { kind: "primitive", name: "null" };
    if (t.flags & ts.TypeFlags.Undefined) return { kind: "primitive", name: "undefined" };
    if (t.flags & ts.TypeFlags.Void)    return { kind: "primitive", name: "undefined" };

    if (t.isStringLiteral())  return { kind: "literal", value: t.value };
    if (t.isNumberLiteral())  return { kind: "literal", value: t.value };
    if (t.flags & ts.TypeFlags.BooleanLiteral) {
        const intrinsic = (t as ts.Type & { intrinsicName?: string }).intrinsicName;
        return { kind: "literal", value: intrinsic === "true" };
    }

    if (t.isUnion()) {
        return { kind: "union", members: t.types.map(m => typeToIR(ctx, m)) };
    }

    const sym = t.getSymbol();
    const symName = sym?.getName();

    // Arrays.
    if (symName === "Array" || symName === "ReadonlyArray") {
        const targ = (t as ts.TypeReference).typeArguments?.[0];
        return { kind: "array", element: targ ? typeToIR(ctx, targ) : UNKNOWN };
    }

    // Date.
    if (symName === "Date") return { kind: "primitive", name: "date" };

    // Tuple types.
    if (ctx.checker.isTupleType(t)) {
        const targs = (t as ts.TypeReference).typeArguments ?? [];
        return { kind: "tuple", elements: targs.map(a => typeToIR(ctx, a)) };
    }

    // Callable types (functions / callable objects). Tested before the
    // generic Object branch since functions are objects in TS's type system.
    // Used by the parser to decide whether an @-fn arg slot should be lexed
    // as a JS expression instead of a shell word.
    const callSigs = t.getCallSignatures();
    if (callSigs.length > 0) {
        const sig = callSigs[0]!;
        const params: TypeIR[] = sig.getParameters().map(p => {
            const decl = p.valueDeclaration ?? p.declarations?.[0];
            const pt = decl
                ? ctx.checker.getTypeOfSymbolAtLocation(p, decl)
                : null;
            return pt ? typeToIR(ctx, pt) : UNKNOWN;
        });
        const returns = typeToIR(ctx, sig.getReturnType());
        return { kind: "function", params, returns };
    }

    // Object literal / interface — extract structural fields.
    if (t.flags & ts.TypeFlags.Object) {
        // Reuse via ref if we've seen this type already (handles cycles + shared types).
        const seenId = ctx.seen.get(t);
        if (seenId) return { kind: "ref", id: seenId };
        const props = ctx.checker.getPropertiesOfType(t);
        if (props.length === 0) return UNKNOWN;
        // Reserve an id before recursing so cycles resolve to a ref.
        const id = sym?.getName() && /^[A-Za-z_]\w*$/.test(sym.getName())
            ? sym.getName()
            : `_anon${ctx.nextId++}`;
        ctx.seen.set(t, id);
        const fields: ObjectField[] = [];
        for (const prop of props) {
            const decl = prop.valueDeclaration ?? prop.declarations?.[0];
            const ptype = decl
                ? ctx.checker.getTypeOfSymbolAtLocation(prop, decl)
                : ((prop as { type?: ts.Type }).type ?? null);
            const ir = ptype ? typeToIR(ctx, ptype) : UNKNOWN;
            fields.push({
                name: prop.getName(),
                type: ir,
                optional: !!(prop.flags & ts.SymbolFlags.Optional),
            });
        }
        ctx.types[id] = { kind: "object", fields };
        return { kind: "ref", id };
    }

    return UNKNOWN;
}
