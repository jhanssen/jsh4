// Buffered: arithmetic mean of a value computed per-row by a lambda.
//
//   @ls | @avg-by f => f.size

export async function* avgBy<T>(
    args: [(row: T) => unknown],
    stdin: AsyncIterable<T>,
): AsyncGenerator<{ avg: number | null }> {
    const fn = args[0];
    if (typeof fn !== "function") {
        throw new Error("@avg-by: extractor must be a function");
    }
    let total = 0;
    let n = 0;
    for await (const row of stdin) {
        const v = fn(row);
        const x = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(x)) { total += x; n++; }
    }
    yield { avg: n === 0 ? null : total / n };
}
