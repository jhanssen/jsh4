// Build-time schema extractor for built-in @-functions.
//
// Walks src/structured/builtins/*.ts, runs the extractor on each, and
// emits a single dist/structured/schemas.json containing all built-in
// schemas. Loaded at jsh startup so built-ins ship with their schemas
// already extracted (no tsc on user machines for the bundled set).
//
// Run from the project root:
//   node --import tsx tools/extract-builtin-schemas.ts

import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractSchemas } from "../src/structured/extract/index.js";
import type { SchemaFile } from "../src/structured/ir.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const builtinsDir = join(root, "src/structured/builtins");
const outDir = join(root, "dist/structured");
const outFile = join(outDir, "schemas.json");

const out: Record<string, SchemaFile> = {};

let entries: string[] = [];
try { entries = readdirSync(builtinsDir).filter(f => f.endsWith(".ts")); }
catch { /* dir may not exist yet — emit empty */ }

const allDiagnostics: string[] = [];
for (const entry of entries) {
    const path = join(builtinsDir, entry);
    const { schemaFile, diagnostics } = extractSchemas(path);
    out[entry.replace(/\.ts$/, "")] = schemaFile;
    for (const d of diagnostics) allDiagnostics.push(`${entry}: ${d}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2));

if (allDiagnostics.length > 0) {
    for (const d of allDiagnostics) process.stderr.write(d + "\n");
}
process.stdout.write(`extracted ${entries.length} built-in schema file(s) → ${outFile}\n`);
