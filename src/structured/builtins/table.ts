// Render objects as a terminal table.
//
// Buffers the first BUFFER_ROWS rows to derive column widths, prints a
// bold header, then streams subsequent rows formatted to the same widths.
// Width derivation uses the buffered sample only — later rows that exceed
// derived widths are truncated with an ellipsis. Numbers right-align,
// strings/booleans/etc. left-align. Long values truncate at MAX_COL_WIDTH.
//
// Yields formatted lines (strings ending in "\n"). The executor's drain
// writes string rows raw to stdout, so this works as a pipeline stage.
//
// args:
//   --no-header     omit the header row
//   --max-width=N   cap column width (default 60)

const BUFFER_ROWS = 10;
const DEFAULT_MAX_COL_WIDTH = 60;

interface Options {
    showHeader: boolean;
    maxColWidth: number;
}

function parseArgs(args: string[]): Options {
    const opts: Options = { showHeader: true, maxColWidth: DEFAULT_MAX_COL_WIDTH };
    for (const a of args) {
        if (a === "--no-header") opts.showHeader = false;
        else if (a.startsWith("--max-width=")) {
            const n = parseInt(a.slice("--max-width=".length), 10);
            if (Number.isFinite(n) && n > 0) opts.maxColWidth = n;
        }
    }
    return opts;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function valueToText(v: unknown): { text: string; rightAlign: boolean } {
    if (v === null) return { text: "null", rightAlign: false };
    if (v === undefined) return { text: "", rightAlign: false };
    if (typeof v === "number" || typeof v === "bigint") return { text: String(v), rightAlign: true };
    if (typeof v === "boolean") return { text: v ? "true" : "false", rightAlign: false };
    if (typeof v === "string") return { text: v, rightAlign: false };
    if (v instanceof Date) return { text: v.toISOString(), rightAlign: false };
    return { text: JSON.stringify(v), rightAlign: false };
}

function pad(text: string, width: number, right: boolean, max: number): string {
    let t = text;
    if (t.length > max) t = t.slice(0, Math.max(1, max - 1)) + "…";
    const w = Math.min(width, max);
    if (t.length >= w) return t;
    const padding = " ".repeat(w - t.length);
    return right ? padding + t : t + padding;
}

const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";

export async function* table(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<string> {
    const opts = parseArgs(args);

    // Phase 1: buffer up to BUFFER_ROWS rows to derive columns + widths.
    const buffer: unknown[] = [];
    const iter = stdin[Symbol.asyncIterator]();
    while (buffer.length < BUFFER_ROWS) {
        const { value, done } = await iter.next();
        if (done) break;
        buffer.push(value);
    }
    if (buffer.length === 0) return;

    // Column discovery: union of object keys, in first-seen order. Non-object
    // rows render as a single "value" column.
    let columns: string[];
    let scalarMode = false;
    if (buffer.every(r => isObject(r))) {
        const seen = new Set<string>();
        columns = [];
        for (const r of buffer) for (const k of Object.keys(r as object)) {
            if (!seen.has(k)) { seen.add(k); columns.push(k); }
        }
    } else {
        columns = ["value"];
        scalarMode = true;
    }

    // Width derivation: max of header + sample values per column.
    const widths = new Map<string, number>();
    const aligns = new Map<string, boolean>();  // true = right-align
    for (const c of columns) {
        widths.set(c, c.length);
        aligns.set(c, false);
    }
    for (const row of buffer) {
        for (const c of columns) {
            const raw = scalarMode ? row : (row as Record<string, unknown>)[c];
            const { text, rightAlign } = valueToText(raw);
            const w = Math.min(text.length, opts.maxColWidth);
            if (w > (widths.get(c) ?? 0)) widths.set(c, w);
            if (rightAlign) aligns.set(c, true);
        }
    }

    // Render header.
    if (opts.showHeader) {
        const cells = columns.map(c => pad(c, widths.get(c)!, aligns.get(c)!, opts.maxColWidth));
        yield `${BOLD}${cells.join("  ")}${RESET}\n`;
    }

    const renderRow = (row: unknown): string => {
        const cells = columns.map(c => {
            const raw = scalarMode ? row : (row as Record<string, unknown>)[c];
            const { text, rightAlign } = valueToText(raw);
            return pad(text, widths.get(c)!, aligns.get(c) ?? rightAlign, opts.maxColWidth);
        });
        return cells.join("  ") + "\n";
    };

    // Phase 2: emit buffered rows + stream remainder.
    for (const row of buffer) yield renderRow(row);
    while (true) {
        const { value, done } = await iter.next();
        if (done) break;
        yield renderRow(value);
    }
}
