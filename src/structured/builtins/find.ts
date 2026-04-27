// Recursively walk one or more paths, yielding a row per entry.
//
//   @find                            walk current directory
//   @find src test                   walk multiple roots
//   @find | @where r => r.isFile     filter to files only
//
// Paths in the yielded rows are relative to the walk root for the first
// arg ("." for default), or the literal arg for additional roots. Symlinks
// are reported but not followed (mirrors POSIX `find -P`).

import { promises as fsp } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import type { File } from "./ls.js";

const require = createRequire(import.meta.url);
const native = require("../../../build/Release/jsh_native.node") as {
    hasXattr: (path: string) => boolean;
};

async function* walk(root: string, rootForRel: string): AsyncGenerator<File> {
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            let st;
            try { st = await fsp.lstat(path); }
            catch { continue; }
            const relName = relative(rootForRel, path) || path;
            yield {
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
                name: relName,
            };
            // Don't descend into symlinks.
            if (st.isDirectory() && !st.isSymbolicLink()) stack.push(path);
        }
    }
}

export async function* find(
    args: string[],
    _stdin: AsyncIterable<unknown>,
): AsyncGenerator<File> {
    const roots = args.length > 0 ? args : ["."];
    for (const root of roots) {
        const abs = resolve(root);
        yield* walk(root, abs);
    }
}
