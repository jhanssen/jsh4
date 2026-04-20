// Shared test helpers for spawning jsh subprocesses.
//
// `spawnJsh` is the single source of truth — every test that needs a jsh
// subprocess goes through it. Adding a new flag, env var, or default
// argument should require changes here only.
//
// By default we pass `--jshrc /dev/null` so tests don't pick up the
// developer's personal jshrc and silently change behavior. Tests that
// explicitly need an rc (see `withRc`) can override.

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

export interface SpawnJshOptions {
    /** Stdin to feed (already includes any trailing `\nexit\n`). */
    input?: string;
    /** Path to a custom jshrc. Default: `/dev/null` (no rc). */
    jshrc?: string;
    /** Extra args after `--jshrc <path>`. */
    extraArgs?: string[];
    /** Working directory. Default: process.cwd(). */
    cwd?: string;
    /** Pass-through for any spawnSync option we don't model explicitly. */
    spawnOptions?: SpawnSyncOptions;
}

export function spawnJsh(opts: SpawnJshOptions = {}): SpawnSyncReturns<string> {
    const args = ["dist/index.js", "--jshrc", opts.jshrc ?? "/dev/null", ...(opts.extraArgs ?? [])];
    return spawnSync("node", args, {
        input: opts.input,
        encoding: "utf8",
        cwd: opts.cwd ?? process.cwd(),
        ...opts.spawnOptions,
    });
}

/** Run `cmd` then exit; return trimmed stdout. */
export function run(cmd: string): string {
    return spawnJsh({ input: cmd + "\nexit\n" }).stdout.trim();
}

/** Run `cmd` then exit; return both streams trimmed. */
export function runFull(cmd: string): { stdout: string; stderr: string } {
    const r = spawnJsh({ input: cmd + "\nexit\n" });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** Run `cmd`, then `echo $?`, then exit. Returns the captured exit code. */
export function ec(cmd: string): number {
    const r = spawnJsh({ input: `${cmd}\necho $?\nexit\n` });
    const lines = r.stdout.trim().split("\n");
    return parseInt(lines[lines.length - 1] ?? "0", 10);
}

/** Run `input` against a one-shot temp jshrc containing `rcBody`. */
export function withRc(rcBody: string, input: string): { stdout: string; stderr: string } {
    const rc = `/tmp/jsh_test_rc_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`;
    writeFileSync(rc, rcBody);
    try {
        const r = spawnJsh({ jshrc: rc, input: input + "\nexit\n" });
        return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
    } finally {
        try { unlinkSync(rc); } catch {}
    }
}
