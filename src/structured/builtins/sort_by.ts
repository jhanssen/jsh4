// Buffered sort by computed key. Lambda-only.
//
//   @ls | @sort-by f => f.size
//   @ls | @sort-by f => f.name.toLowerCase()

function compareScalar(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b));
}

export async function* sortBy<T>(
    args: [(row: T) => unknown],
    stdin: AsyncIterable<T>,
): AsyncGenerator<T> {
    const fn = args[0];
    if (typeof fn !== "function") {
        throw new Error("@sort-by: key extractor must be a function");
    }
    const buf: T[] = [];
    for await (const row of stdin) buf.push(row);
    buf.sort((a, b) => compareScalar(fn(a), fn(b)));
    for (const row of buf) yield row;
}
