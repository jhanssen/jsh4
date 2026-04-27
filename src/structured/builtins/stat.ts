// Stat a list of paths, yielding the same row shape as @ls.
//
//   @stat /etc/passwd /tmp           paths from args
//   @ls | @stat                       restat each entry from upstream
//
// When stdin is provided and no paths are given as args, the operator
// consumes upstream rows. String rows are treated as paths directly;
// objects are read from `.path` first, then `.name`.

import { promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import type { File } from "./ls.js";

const require = createRequire(import.meta.url);
const native = require("../../../build/Release/jsh_native.node") as {
    hasXattr: (path: string) => boolean;
};

async function statOne(path: string): Promise<File | null> {
    let st;
    try { st = await fsp.lstat(path); }
    catch { return null; }
    return {
        mode: st.mode,
        nlink: st.nlink,
        uid: st.uid,
        gid: st.gid,
        size: st.size,
        blocks: st.blocks,
        mtime: st.mtime,
        isDir: st.isDirectory(),
        isFile: st.isFile(),
        isSymlink: st.isSymbolicLink(),
        hasXattr: native.hasXattr(path),
        name: path,
    };
}

export async function* stat(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<File> {
    if (args.length > 0) {
        for (const p of args) {
            const r = await statOne(p);
            if (r) yield r;
        }
        return;
    }
    for await (const row of stdin) {
        const path = typeof row === "string"
            ? row
            : (row as Record<string, unknown> | null)?.["path"]
                ?? (row as Record<string, unknown> | null)?.["name"];
        if (typeof path !== "string") continue;
        const r = await statOne(path);
        if (r) yield r;
    }
}
