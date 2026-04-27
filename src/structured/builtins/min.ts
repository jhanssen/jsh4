// Buffered: row with the minimum value of a field (or primitive minimum).
// Yields `{ min: V | null }` — `V` is whatever the field/row evaluates to;
// `null` if the stream was empty. Comparison falls back to localeCompare
// for non-numeric values.
//
//   @ls | @min size               smallest size value
//
// For lambda extraction, see @min-by.

function compareScalar(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b));
}

export async function* min(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<{ min: unknown }> {
    const field = args[0];
    let best: unknown = undefined;
    let seen = false;
    for await (const row of stdin) {
        const v = field
            ? (row as Record<string, unknown> | null)?.[field]
            : row;
        if (!seen || compareScalar(v, best) < 0) {
            best = v;
            seen = true;
        }
    }
    yield { min: seen ? best : null };
}
