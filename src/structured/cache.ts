// Schema cache for extracted .ts/.mts files.
//
// Layout (POSIX-only):
//   $XDG_CACHE_HOME/jsh/types/v1/<sha1(absSourcePath)>.json
//
// No central index — deterministic per-source-file naming makes lookups
// O(stat()), eliminates index-write races, and simplifies eviction.
//
// Writes go to a same-dir tmp file then atomic rename(). POSIX rename is
// atomic within a filesystem; readers see either old or new, never partial.
// Multiple jsh instances racing on the same source produce identical content
// (extractions are deterministic from input) — last rename wins, no harm.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
    promises as fsp,
    statSync, readFileSync,
} from "node:fs";
import { EXTRACTOR_VERSION, type SchemaFile } from "./ir.js";

const xdgCacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const CACHE_ROOT = join(xdgCacheHome, "jsh", "types", "v1");

function fileNameFor(absSourcePath: string): string {
    const hash = createHash("sha1").update(absSourcePath).digest("hex");
    return join(CACHE_ROOT, `${hash}.json`);
}

function hashContent(absSourcePath: string): string {
    try {
        const buf = readFileSync(absSourcePath);
        return createHash("sha1").update(buf).digest("hex");
    } catch {
        return "";
    }
}

/** Look up cached SchemaFile if (mtime + content hash + extractor version) match. */
export function cacheLookup(absSourcePath: string): SchemaFile | null {
    const cachePath = fileNameFor(absSourcePath);
    let entry: SchemaFile;
    try {
        const text = readFileSync(cachePath, "utf8");
        entry = JSON.parse(text) as SchemaFile;
    } catch {
        return null;
    }
    if (entry.extractorVersion !== EXTRACTOR_VERSION) return null;
    // mtime fast path — if file's mtime hasn't changed since cache write, trust it.
    let mtime = 0;
    try { mtime = statSync(absSourcePath).mtimeMs; } catch { return null; }
    if ((entry as SchemaFile & { sourceMtime?: number }).sourceMtime === mtime) {
        return entry;
    }
    // Mtime mismatch — fall back to content hash to dodge mtime-noise.
    if (entry.sourceHash === hashContent(absSourcePath)) {
        return entry;
    }
    return null;
}

/** Store SchemaFile via atomic rename. Caller must have produced it via the extractor. */
export async function cacheStore(absSourcePath: string, schema: SchemaFile): Promise<void> {
    const cachePath = fileNameFor(absSourcePath);
    await fsp.mkdir(dirname(cachePath), { recursive: true });
    const stamped = { ...schema, sourceMtime: 0 } as SchemaFile & { sourceMtime: number };
    try { stamped.sourceMtime = statSync(absSourcePath).mtimeMs; } catch {}
    const tmp = `${cachePath}.tmp.${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(stamped));
    await fsp.rename(tmp, cachePath);
}

export function cacheRoot(): string { return CACHE_ROOT; }
