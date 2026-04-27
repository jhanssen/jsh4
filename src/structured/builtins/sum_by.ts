// Buffered: sum a value computed per-row by a lambda.
//
//   @ls | @sum-by f => f.size
//   @ps | @sum-by p => p.cpu * p.threads

export async function* sumBy<T>(
    args: [(row: T) => unknown],
    stdin: AsyncIterable<T>,
): AsyncGenerator<{ sum: number }> {
    const fn = args[0];
    if (typeof fn !== "function") {
        throw new Error("@sum-by: extractor must be a function");
    }
    let total = 0;
    for await (const row of stdin) {
        const v = fn(row);
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) total += n;
    }
    yield { sum: total };
}
