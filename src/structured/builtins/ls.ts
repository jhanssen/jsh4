// List directory entries as structured File objects.
//
//   @ls               # current directory
//   @ls /var/log      # specified directory
//   @ls -a            # include dotfiles
//
// Each yielded row is shaped like:
//   { name, size, mtime, mode, isDir, isFile, isSymlink }

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../../build/Release/jsh_native.node") as {
    hasXattr: (path: string) => boolean;
};

// Field order is the table column order — metadata first, name last so a
// long name doesn't push the rest of the row around. Matches `ls -l`.
export interface File {
    mode: number;
    nlink: number;
    uid: number;
    gid: number;
    size: number;
    blocks: number;   // st_blocks (512-byte units), used by @ls-format for `total`
    mtime: Date;
    isDir: boolean;
    isFile: boolean;
    isSymlink: boolean;
    hasXattr: boolean;
    name: string;
}

interface LsOpts { all: boolean; dir: string; }

function parseLsArgs(args: string[]): LsOpts {
    let all = false;
    let dir = ".";
    for (const a of args) {
        if (a === "--all") { all = true; continue; }
        if (a.startsWith("--")) continue;
        if (a.startsWith("-") && a.length > 1) {
            // Short-flag cluster like `-la` / `-lah`. Pick out the ones we care
            // about; ignore unknown chars (forwarded to the formatter where
            // -l, -h, etc. live).
            for (const c of a.slice(1)) if (c === "a") all = true;
            continue;
        }
        dir = a;
    }
    return { all, dir };
}

export async function* ls(
    args: string[],
    _stdin: AsyncIterable<unknown>,
): AsyncGenerator<File> {
    const opts = parseLsArgs(args);
    const entries = await fsp.readdir(opts.dir, { withFileTypes: true });
    // `ls -a` includes . and ..; readdir doesn't, so synthesize them.
    const names: string[] = [];
    if (opts.all) names.push(".", "..");
    for (const e of entries) {
        if (!opts.all && e.name.startsWith(".")) continue;
        names.push(e.name);
    }
    for (const name of names) {
        const path = join(opts.dir, name);
        let st;
        try { st = await fsp.lstat(path); }
        catch { continue; }
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
            name,
        };
    }
}
