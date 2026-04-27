// Buffered: row with the maximum value of a field (or primitive maximum).
// Yields `{ max: V | null }`. Comparison rules match @min.
//
//   @ls | @max size
//
// For lambda extraction, see @max-by.

function compareScalar(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b));
}

export async function* max(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<{ max: unknown }> {
    const field = args[0];
    let best: unknown = undefined;
    let seen = false;
    for await (const row of stdin) {
        const v = field
            ? (row as Record<string, unknown> | null)?.[field]
            : row;
        if (!seen || compareScalar(v, best) > 0) {
            best = v;
            seen = true;
        }
    }
    yield { max: seen ? best : null };
}
