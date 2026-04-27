// Streaming dedup by computed key. Lambda-only.
//
//   @ls | @uniq-by f => f.name.toLowerCase()

function keyOf(value: unknown): string {
    if (value === undefined) return "__undef__";
    if (value === null) return "__null__";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return typeof value + ":" + String(value);
    }
    return "json:" + JSON.stringify(value);
}

export async function* uniqBy<T>(
    args: [(row: T) => unknown],
    stdin: AsyncIterable<T>,
): AsyncGenerator<T> {
    const fn = args[0];
    if (typeof fn !== "function") {
        throw new Error("@uniq-by: key extractor must be a function");
    }
    const seen = new Set<string>();
    for await (const row of stdin) {
        const k = keyOf(fn(row));
        if (seen.has(k)) continue;
        seen.add(k);
        yield row;
    }
}
