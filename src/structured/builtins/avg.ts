// Buffered: arithmetic mean of a numeric field (or primitive numeric input).
// Yields `{ avg: N | null }`. `null` if no finite values were observed.
// Non-finite values are excluded from both the sum and the count.
//
//   @ls | @avg size
//
// For lambda extraction, see @avg-by.

export async function* avg(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<{ avg: number | null }> {
    const field = args[0];
    let total = 0;
    let n = 0;
    for await (const row of stdin) {
        const v = field
            ? (row as Record<string, unknown> | null)?.[field]
            : row;
        const x = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(x)) { total += x; n++; }
    }
    yield { avg: n === 0 ? null : total / n };
}
