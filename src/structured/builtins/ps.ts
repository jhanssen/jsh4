// List running processes as structured Process objects.
//
// Implementation note: shells out to the system `ps` and parses fixed-format
// output. Avoids the LOC + native-binding cost of /proc (Linux) or libproc
// (macOS) at the price of a one-shot subprocess. Acceptable for v1; replace
// with platform-native readers if @ps becomes hot in real use.
//
//   @ps                    # all processes
//
// Each yielded row:
//   { pid, ppid, user, cpu, mem, rss, command, args }

import { spawnSync } from "node:child_process";

export interface Process {
    pid: number;
    ppid: number;
    user: string;
    cpu: number;     // %CPU
    mem: number;     // %MEM
    rss: number;     // resident set size in KB
    command: string; // executable name (no path)
    args: string;    // full command line
}

export async function* ps(
    _args: string[],
    _stdin: AsyncIterable<unknown>,
): AsyncGenerator<Process> {
    // Trailing `=` on each format spec strips the column header.
    const r = spawnSync("ps", [
        "-axo", "pid=,ppid=,user=,pcpu=,pmem=,rss=,comm=,args=",
    ], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`@ps: ps exited ${r.status}: ${r.stderr.trim()}`);

    for (const raw of r.stdout.split("\n")) {
        const line = raw.trimStart();
        if (!line) continue;
        // Split on whitespace for the first 7 numeric/short columns; remainder
        // is the args line (may itself contain spaces).
        const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        yield {
            pid:     parseInt(m[1]!, 10),
            ppid:    parseInt(m[2]!, 10),
            user:    m[3]!,
            cpu:     parseFloat(m[4]!),
            mem:     parseFloat(m[5]!),
            rss:     parseInt(m[6]!, 10),
            command: m[7]!,
            args:    m[8]!,
        };
    }
}
