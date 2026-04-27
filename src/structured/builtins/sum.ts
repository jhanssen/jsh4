// Buffered: sum a numeric field (or primitive numeric input). Yields one
// row `{ sum: N }`. Non-finite values are skipped silently.
//
//   @ls | @sum size                total bytes across all entries
//   echo 1 2 3 | @from-jsonl | @sum  → { sum: 6 }
//
// For lambda extraction, see @sum-by.

export async function* sum(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<{ sum: number }> {
    const field = args[0];
    let total = 0;
    for await (const row of stdin) {
        const v = field
            ? (row as Record<string, unknown> | null)?.[field]
            : row;
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) total += n;
    }
    yield { sum: total };
}
