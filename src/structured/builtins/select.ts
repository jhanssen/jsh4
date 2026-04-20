// Project rows down to a subset of fields, or transform via a lambda.
//
// Two arg shapes:
//   @select name,size,mtime              shorthand string: comma-separated keys
//   @select @{ p => ({n: p.name}) }      lambda via inline-JS arg
//
// String args go through the comma-list path. A function arg is used as
// the projector directly.

export async function* select(
    args: unknown[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    if (args.length === 0) throw new Error("@select: field name(s) or lambda required");
    let project: (row: unknown) => unknown;

    const first = args[0];
    if (typeof first === "function") {
        project = first as (row: unknown) => unknown;
    } else if (typeof first === "string") {
        const text = args.map(a => String(a)).join(" ");
        const fields = text.split(",").map(s => s.trim()).filter(Boolean);
        if (fields.length === 0) throw new Error("@select: no fields provided");
        project = (row: unknown) => {
            const out: Record<string, unknown> = {};
            const r = row as Record<string, unknown>;
            for (const f of fields) out[f] = r?.[f];
            return out;
        };
    } else {
        throw new Error("@select: arg must be a comma-list string or a lambda via @{ ... }");
    }

    for await (const row of stdin) yield project(row);
}
