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
import { fromJsonl } from "./from_jsonl.js";
import { toJsonl } from "./to_jsonl.js";
import { map } from "./map.js";
import { sort } from "./sort.js";
import { sortBy } from "./sort_by.js";
import { uniq } from "./uniq.js";
import { uniqBy } from "./uniq_by.js";
import { drop } from "./drop.js";
import { tail } from "./tail.js";
import { sum } from "./sum.js";
import { sumBy } from "./sum_by.js";
import { avg } from "./avg.js";
import { avgBy } from "./avg_by.js";
import { min } from "./min.js";
import { minBy } from "./min_by.js";
import { max } from "./max.js";
import { maxBy } from "./max_by.js";
import { env } from "./env.js";
import { stat } from "./stat.js";
import { find } from "./find.js";
import { du } from "./du.js";
import { importMod } from "./import.js";

interface BuiltinSpec {
    name: string;
    fn: JsPipelineFunction;
    schemaKey: string;        // matches the basename used by the build CLI
    // Function identifier inside the source file (the export name). Defaults
    // to `name` but must be set when the registry name differs from the TS
    // identifier — e.g. `from-jsonl` (registry) vs `fromJsonl` (TS export),
    // since hyphenated names can't be JS identifiers.
    schemaFnName?: string;
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
    // @head is a POSIX-shaped synonym for @take. Same fn, same schema.
    { name: "head",   fn: take   as unknown as JsPipelineFunction, schemaKey: "take",   atOnly: true },
    { name: "table",  fn: table  as unknown as JsPipelineFunction, schemaKey: "table",  atOnly: true, isSink: true },
    { name: "ls",     fn: ls     as unknown as JsPipelineFunction, schemaKey: "ls",     atOnly: true,
                                                                   defaultSink: "ls-format" },
    { name: "ls-format", fn: lsFormat as unknown as JsPipelineFunction, schemaKey: "ls_format",
                                                                   atOnly: true, isSink: true, hidden: true },
    { name: "ps",     fn: ps     as unknown as JsPipelineFunction, schemaKey: "ps",     atOnly: true },
    { name: "count",  fn: count  as unknown as JsPipelineFunction, schemaKey: "count",  atOnly: true },
    { name: "from-jsonl", fn: fromJsonl as unknown as JsPipelineFunction, schemaKey: "from_jsonl", schemaFnName: "fromJsonl", atOnly: true },
    { name: "to-jsonl",   fn: toJsonl   as unknown as JsPipelineFunction, schemaKey: "to_jsonl",   schemaFnName: "toJsonl",   atOnly: true, isSink: true },
    { name: "map",        fn: map       as unknown as JsPipelineFunction, schemaKey: "map",        atOnly: true },
    { name: "sort",       fn: sort      as unknown as JsPipelineFunction, schemaKey: "sort",       atOnly: true },
    { name: "sort-by",    fn: sortBy    as unknown as JsPipelineFunction, schemaKey: "sort_by",    schemaFnName: "sortBy",    atOnly: true },
    { name: "uniq",       fn: uniq      as unknown as JsPipelineFunction, schemaKey: "uniq",       atOnly: true },
    { name: "uniq-by",    fn: uniqBy    as unknown as JsPipelineFunction, schemaKey: "uniq_by",    schemaFnName: "uniqBy",    atOnly: true },
    { name: "drop",       fn: drop      as unknown as JsPipelineFunction, schemaKey: "drop",       atOnly: true },
    { name: "tail",       fn: tail      as unknown as JsPipelineFunction, schemaKey: "tail",       atOnly: true },
    { name: "sum",        fn: sum       as unknown as JsPipelineFunction, schemaKey: "sum",        atOnly: true },
    { name: "sum-by",     fn: sumBy     as unknown as JsPipelineFunction, schemaKey: "sum_by",     schemaFnName: "sumBy", atOnly: true },
    { name: "avg",        fn: avg       as unknown as JsPipelineFunction, schemaKey: "avg",        atOnly: true },
    { name: "avg-by",     fn: avgBy     as unknown as JsPipelineFunction, schemaKey: "avg_by",     schemaFnName: "avgBy", atOnly: true },
    { name: "min",        fn: min       as unknown as JsPipelineFunction, schemaKey: "min",        atOnly: true },
    { name: "min-by",     fn: minBy     as unknown as JsPipelineFunction, schemaKey: "min_by",     schemaFnName: "minBy", atOnly: true },
    { name: "max",        fn: max       as unknown as JsPipelineFunction, schemaKey: "max",        atOnly: true },
    { name: "max-by",     fn: maxBy     as unknown as JsPipelineFunction, schemaKey: "max_by",     schemaFnName: "maxBy", atOnly: true },
    { name: "env",        fn: env       as unknown as JsPipelineFunction, schemaKey: "env",        atOnly: true },
    { name: "stat",       fn: stat      as unknown as JsPipelineFunction, schemaKey: "stat",       atOnly: true },
    { name: "find",       fn: find      as unknown as JsPipelineFunction, schemaKey: "find",       atOnly: true },
    { name: "du",         fn: du        as unknown as JsPipelineFunction, schemaKey: "du",         atOnly: true },
    { name: "import",     fn: importMod as unknown as JsPipelineFunction, schemaKey: "import",     schemaFnName: "importMod", atOnly: true },
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
        const fnSchema = file?.functions[b.schemaFnName ?? b.name];
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
