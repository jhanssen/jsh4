// Buffered: minimum value computed per-row by a lambda.
//
//   @ls | @min-by f => f.mtime

function compareScalar(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b));
}

export async function* minBy<T>(
    args: [(row: T) => unknown],
    stdin: AsyncIterable<T>,
): AsyncGenerator<{ min: unknown }> {
    const fn = args[0];
    if (typeof fn !== "function") {
        throw new Error("@min-by: extractor must be a function");
    }
    let best: unknown = undefined;
    let seen = false;
    for await (const row of stdin) {
        const v = fn(row);
        if (!seen || compareScalar(v, best) < 0) {
            best = v;
            seen = true;
        }
    }
    yield { min: seen ? best : null };
}
