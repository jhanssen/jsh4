// Drop adjacent and non-adjacent duplicate rows. Streaming; memory grows
// with the number of distinct keys.
//
//   @ls | @uniq                  dedupe whole rows (JSON identity)
//   @ls | @uniq mode             dedupe by .mode field
//
// For lambda-keyed dedup, see @uniq-by.

function keyOf(value: unknown): string {
    if (value === undefined) return "__undef__";
    if (value === null) return "__null__";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return typeof value + ":" + String(value);
    }
    return "json:" + JSON.stringify(value);
}

export async function* uniq(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    const seen = new Set<string>();
    const field = args[0];
    for await (const row of stdin) {
        const v = field
            ? (row as Record<string, unknown> | null)?.[field]
            : row;
        const k = keyOf(v);
        if (seen.has(k)) continue;
        seen.add(k);
        yield row;
    }
}
