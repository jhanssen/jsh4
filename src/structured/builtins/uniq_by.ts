// Streaming dedup by computed key. Lambda-only.
//
//   @ls | @uniq-by f => f.name.toLowerCase()

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalize(obj[k]);
    return out;
}

function keyOf(value: unknown): string {
    if (value === undefined) return "__undef__";
    if (value === null) return "__null__";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return typeof value + ":" + String(value);
    }
    return "json:" + JSON.stringify(canonicalize(value));
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
