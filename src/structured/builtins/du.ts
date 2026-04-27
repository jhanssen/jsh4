// Disk usage: total bytes under each path. Recursive; follows the same
// non-following-symlink rule as @find. Yields `{ path, size }` per arg
// (or `{ path: ".", size }` if no args).
//
//   @du                              size of "."
//   @du src test                     size per directory
//   @du | @sort -k size              sort by size (when @sort gains -k)

import { promises as fsp } from "node:fs";
import { join } from "node:path";

export interface DiskUsage {
    path: string;
    size: number;
}

async function totalBytes(root: string): Promise<number> {
    let total = 0;
    const stack: string[] = [root];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let st;
        try { st = await fsp.lstat(cur); }
        catch { continue; }
        if (st.isSymbolicLink()) {
            // Don't follow; count the link's own size only.
            total += st.size;
            continue;
        }
        total += st.size;
        if (st.isDirectory()) {
            let entries;
            try { entries = await fsp.readdir(cur); }
            catch { continue; }
            for (const e of entries) stack.push(join(cur, e));
        }
    }
    return total;
}

export async function* du(
    args: string[],
    _stdin: AsyncIterable<unknown>,
): AsyncGenerator<DiskUsage> {
    const roots = args.length > 0 ? args : ["."];
    for (const root of roots) {
        yield { path: root, size: await totalBytes(root) };
    }
}
