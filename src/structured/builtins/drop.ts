// Discard the first N rows; yield the rest. Streaming.
//
//   @ls | @drop 10               skip the first 10 rows
//   @ls | @drop                  default N=1

export async function* drop<T>(
    args: string[],
    stdin: AsyncIterable<T>,
): AsyncGenerator<T> {
    const raw = args[0] ?? "1";
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`@drop: invalid count: ${raw}`);
    }
    let dropped = 0;
    for await (const row of stdin) {
        if (dropped < n) { dropped++; continue; }
        yield row;
    }
}
