// Yield the last N rows. Buffered (drains stdin to know which rows are
// last). Analogous to POSIX `tail -n N` for the bounded-stream case.
//
// No streaming-follow mode (`tail -f`) — feed `tail -f file` upstream and
// use @take / @head + @from-jsonl downstream if you want a live tail.
//
//   @ls | @tail 5                last 5 rows
//   @ls | @tail                  default N=1

export async function* tail<T>(
    args: string[],
    stdin: AsyncIterable<T>,
): AsyncGenerator<T> {
    const raw = args[0] ?? "1";
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`@tail: invalid count: ${raw}`);
    }
    if (n === 0) {
        for await (const _ of stdin) { /* drain */ }
        return;
    }
    // Ring buffer of size n.
    const buf: T[] = new Array(n);
    let head = 0;
    let count = 0;
    for await (const row of stdin) {
        buf[head] = row;
        head = (head + 1) % n;
        if (count < n) count++;
    }
    const start = (head - count + n) % n;
    for (let i = 0; i < count; i++) {
        yield buf[(start + i) % n]!;
    }
}
