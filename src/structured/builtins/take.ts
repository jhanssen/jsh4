// Yield only the first N rows, then end the iteration. Upstream stages stop
// being pulled (and so stop producing) once the iterator is closed.
//
//   @ls | @sort -k mtime | @take 10

export async function* take(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    const n = parseInt(args[0] ?? "", 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`@take: invalid count: ${args[0] ?? ""}`);
    if (n === 0) return;
    let i = 0;
    for await (const row of stdin) {
        yield row;
        if (++i >= n) return;
    }
}
