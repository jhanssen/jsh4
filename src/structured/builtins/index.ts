// Register the structured-pipeline built-in functions and attach their
// pre-extracted schemas (built by tools/extract-builtin-schemas.ts and
// shipped at dist/structured/schemas.json).
//
// Called once at jsh startup, before the user rc is loaded — that way
// the rc can override built-ins by registering a same-named function.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerJsFunction, type JsPipelineFunction } from "../../jsfunctions/index.js";
import type { SchemaFile } from "../ir.js";

import { where } from "./where.js";
import { select } from "./select.js";
import { take } from "./take.js";
import { table } from "./table.js";
import { ls } from "./ls.js";
import { lsFormat } from "./ls_format.js";
import { ps } from "./ps.js";
import { count } from "./count.js";
import { jsonl } from "./jsonl.js";
import { toJsonl } from "./to_jsonl.js";

interface BuiltinSpec {
    name: string;
    fn: JsPipelineFunction;
    schemaKey: string;        // matches the basename used by the build CLI
    atOnly?: boolean;
    defaultSink?: string;
    isSink?: boolean;
    hidden?: boolean;
}

// Built-ins are registered atOnly: true so bare `where` / `select` / `take`
// keep falling through to PATH / aliases / shell keywords (`select` is also a
// shell construct). The structured form is `@where` etc.
const BUILTINS: BuiltinSpec[] = [
    { name: "where",  fn: where  as unknown as JsPipelineFunction, schemaKey: "where",  atOnly: true },
    { name: "select", fn: select as unknown as JsPipelineFunction, schemaKey: "select", atOnly: true },
    { name: "take",   fn: take   as unknown as JsPipelineFunction, schemaKey: "take",   atOnly: true },
    { name: "table",  fn: table  as unknown as JsPipelineFunction, schemaKey: "table",  atOnly: true, isSink: true },
    { name: "ls",     fn: ls     as unknown as JsPipelineFunction, schemaKey: "ls",     atOnly: true,
                                                                   defaultSink: "ls-format" },
    { name: "ls-format", fn: lsFormat as unknown as JsPipelineFunction, schemaKey: "ls_format",
                                                                   atOnly: true, isSink: true },
    { name: "ps",     fn: ps     as unknown as JsPipelineFunction, schemaKey: "ps",     atOnly: true },
    { name: "count",  fn: count  as unknown as JsPipelineFunction, schemaKey: "count",  atOnly: true },
    { name: "jsonl",    fn: jsonl   as unknown as JsPipelineFunction, schemaKey: "jsonl",    atOnly: true },
    { name: "to-jsonl", fn: toJsonl as unknown as JsPipelineFunction, schemaKey: "to_jsonl", atOnly: true, isSink: true },
];

let registered = false;

function loadSchemas(): Record<string, SchemaFile> {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const path = join(here, "..", "schemas.json");
        const text = readFileSync(path, "utf8");
        return JSON.parse(text) as Record<string, SchemaFile>;
    } catch {
        return {};
    }
}

export function registerStructuredBuiltins(): void {
    if (registered) return;
    registered = true;
    const schemas = loadSchemas();
    for (const b of BUILTINS) {
        const file = schemas[b.schemaKey];
        const fnSchema = file?.functions[b.name];
        registerJsFunction(b.name, b.fn, {
            mode: "object",
            atOnly: b.atOnly,
            input:  fnSchema?.input,
            output: fnSchema?.output,
            args:   fnSchema?.args,
            defaultSink: b.defaultSink,
            isSink: b.isSink,
            hidden: b.hidden,
        });
    }
}
