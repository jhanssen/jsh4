// Default formatter for @ls — mimics `ls` (short) and `ls -l` (long).
// Used as the implicit sink when @ls is the last stage of an interactive
// pipeline. Reads LS_COLORS via the native parser shared with the
// completion-menu colorizer, so colors stay consistent across UI surfaces.

import { createRequire } from "node:module";
import type { File } from "./ls.js";

const require = createRequire(import.meta.url);
const native = require("../../../build/Release/jsh_native.node") as {
    inputColorForFile: (typeHint: "dir" | "exec" | "link" | "file" | "", name: string) => string;
    getpwuidName: (uid: number) => string;
    getgrgidName: (gid: number) => string;
};

// ---- Mode → symbolic ("drwxr-xr-x") ----------------------------------------

function modeString(mode: number, isDir: boolean, isSymlink: boolean): string {
    const type = isSymlink ? "l" : isDir ? "d" : "-";
    const perms = (bits: number) =>
        ((bits & 4) ? "r" : "-") +
        ((bits & 2) ? "w" : "-") +
        ((bits & 1) ? "x" : "-");
    return type + perms((mode >> 6) & 7) + perms((mode >> 3) & 7) + perms(mode & 7);
}

// ---- uid/gid → name --------------------------------------------------------
// Resolved through native getpwuid_r / getgrgid_r so NSS-backed users (Open
// Directory on macOS, LDAP/NIS on Linux) work. Per-uid result is memoized
// for the formatter's lifetime to keep streaming cheap.

const userMap  = new Map<number, string>();
const groupMap = new Map<number, string>();

function uidName(uid: number): string {
    const cached = userMap.get(uid);
    if (cached !== undefined) return cached;
    const name = native.getpwuidName(uid) || String(uid);
    userMap.set(uid, name);
    return name;
}
function gidName(gid: number): string {
    const cached = groupMap.get(gid);
    if (cached !== undefined) return cached;
    const name = native.getgrgidName(gid) || String(gid);
    groupMap.set(gid, name);
    return name;
}

// ---- mtime → ls-style date -------------------------------------------------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const HALF_YEAR_MS = 1000 * 60 * 60 * 24 * 180;

function mtimeString(d: Date): string {
    const month = MONTHS[d.getMonth()]!;
    const day = String(d.getDate()).padStart(2, " ");
    if (Date.now() - d.getTime() < HALF_YEAR_MS) {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${month} ${day} ${hh}:${mm}`;
    }
    return `${month} ${day}  ${d.getFullYear()}`;
}

// ---- size → human-readable -------------------------------------------------

const SIZE_UNITS = ["K", "M", "G", "T", "P"];
function humanSize(n: number): string {
    if (n < 1024) return String(n);
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < SIZE_UNITS.length - 1) { v /= 1024; i++; }
    return v < 10 ? `${v.toFixed(1)}${SIZE_UNITS[i]}` : `${Math.round(v)}${SIZE_UNITS[i]}`;
}

// ---- LS_COLORS application -------------------------------------------------

function colorForFile(f: File): string {
    let hint: "dir" | "exec" | "link" | "file" | "";
    if (f.isSymlink) hint = "link";
    else if (f.isDir) hint = "dir";
    else if (f.isFile && (f.mode & 0o111)) hint = "exec";
    else if (f.isFile) hint = "file";
    else hint = "";
    return native.inputColorForFile(hint, f.name);
}

function colorize(text: string, sgr: string): string {
    if (!sgr) return text;
    return `\x1b[${sgr}m${text}\x1b[0m`;
}

// ---- Padding helpers -------------------------------------------------------

function padLeft(s: string, w: number): string {
    return s.length >= w ? s : " ".repeat(w - s.length) + s;
}
function padRight(s: string, w: number): string {
    return s.length >= w ? s : s + " ".repeat(w - s.length);
}

// ---- Arg parsing -----------------------------------------------------------

interface FmtOpts { long: boolean; human: boolean; }

function parseFmtArgs(args: string[]): FmtOpts {
    let long = false, human = false;
    for (const a of args) {
        if (!a.startsWith("-") || a.startsWith("--")) continue;
        for (const c of a.slice(1)) {
            if (c === "l") long = true;
            else if (c === "h") human = true;
        }
    }
    return { long, human };
}

// ---- Formatter --------------------------------------------------------------
// Buffers all rows so we can compute column widths (matching real `ls -l`,
// which buffers entire dir before printing). For huge dirs this is fine —
// `ls` itself does the same.

export async function* lsFormat(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<string> {
    const opts = parseFmtArgs(args);
    const rows: File[] = [];
    for await (const r of stdin) rows.push(r as File);

    if (!opts.long) {
        for (const f of rows) {
            yield colorize(f.name, colorForFile(f)) + "\n";
        }
        return;
    }

    // Long form widths: nlink, user, group, size — right- or left-aligned per ls.
    let wNlink = 0, wUser = 0, wGroup = 0, wSize = 0;
    const sized = rows.map(f => {
        const u = uidName(f.uid);
        const g = gidName(f.gid);
        const sz = opts.human ? humanSize(f.size) : String(f.size);
        if (String(f.nlink).length > wNlink) wNlink = String(f.nlink).length;
        if (u.length > wUser) wUser = u.length;
        if (g.length > wGroup) wGroup = g.length;
        if (sz.length > wSize) wSize = sz.length;
        return { f, u, g, sz };
    });

    const total = rows.reduce((acc, f) => acc + Math.ceil(f.size / 1024) * 2, 0);
    yield `total ${total}\n`;
    for (const { f, u, g, sz } of sized) {
        yield [
            modeString(f.mode, f.isDir, f.isSymlink),
            padLeft(String(f.nlink), wNlink),
            padRight(u, wUser),
            padRight(g, wGroup),
            padLeft(sz, wSize),
            mtimeString(f.mtime),
            colorize(f.name, colorForFile(f)),
        ].join(" ") + "\n";
    }
}
