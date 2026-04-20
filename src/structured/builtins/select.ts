// Project rows down to a subset of fields, or transform via a lambda.
//
// Two arg shapes:
//   @select name,size,mtime          shorthand: comma-separated field names
//   @select 'p => ({n: p.name})'     lambda: arbitrary projection
//
// Lambda detection heuristic: if the joined args contain `=>` or start with
// `function`, treat as JS source; otherwise as a comma list.

export async function* select(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    if (args.length === 0) throw new Error("@select: field name(s) or lambda required");
    const text = args.join(" ");
    let project: (row: unknown) => unknown;

    if (text.includes("=>") || /^\s*function\b/.test(text)) {
        try {
            // eslint-disable-next-line no-new-func
            project = new Function(`"use strict"; return (${text})`)() as (row: unknown) => unknown;
        } catch (e) {
            throw new Error(`@select: bad lambda: ${e instanceof Error ? e.message : e}`);
        }
        if (typeof project !== "function") {
            throw new Error(`@select: lambda is not a function: ${text}`);
        }
    } else {
        const fields = text.split(",").map(s => s.trim()).filter(Boolean);
        if (fields.length === 0) throw new Error("@select: no fields provided");
        project = (row: unknown) => {
            const out: Record<string, unknown> = {};
            const r = row as Record<string, unknown>;
            for (const f of fields) out[f] = r?.[f];
            return out;
        };
    }

    for await (const row of stdin) yield project(row);
}
