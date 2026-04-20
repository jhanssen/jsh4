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

// Field order is the table column order — metadata first, name last so a
// long name doesn't push the rest of the row around. Matches `ls -l`.
export interface File {
    mode: number;
    nlink: number;
    uid: number;
    gid: number;
    size: number;
    mtime: Date;
    isDir: boolean;
    isFile: boolean;
    isSymlink: boolean;
    name: string;
}

interface LsOpts { all: boolean; dir: string; }

function parseLsArgs(args: string[]): LsOpts {
    let all = false;
    let dir = ".";
    for (const a of args) {
        if (a === "-a" || a === "--all") all = true;
        else if (!a.startsWith("-")) dir = a;
    }
    return { all, dir };
}

export async function* ls(
    args: string[],
    _stdin: AsyncIterable<unknown>,
): AsyncGenerator<File> {
    const opts = parseLsArgs(args);
    const entries = await fsp.readdir(opts.dir, { withFileTypes: true });
    for (const entry of entries) {
        if (!opts.all && entry.name.startsWith(".")) continue;
        let st;
        try { st = await fsp.lstat(join(opts.dir, entry.name)); }
        catch { continue; }
        yield {
            mode: st.mode,
            nlink: st.nlink,
            uid: st.uid,
            gid: st.gid,
            size: st.size,
            mtime: st.mtime,
            isDir: st.isDirectory(),
            isFile: st.isFile(),
            isSymlink: st.isSymbolicLink(),
            name: entry.name,
        };
    }
}
