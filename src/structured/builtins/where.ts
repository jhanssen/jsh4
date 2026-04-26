// Filter rows by a predicate function. The predicate is the first arg and
// must be a JS function value. Two equivalent forms:
//
//   @ls | @where f => f.size > 1024            (unquoted lambda — schema-driven)
//   @ls | @where @{ f => f.size > 1024 }       (explicit @{...} form)
//
// Word-shaped args (e.g. `@where foo`) are rejected at runtime.

export async function* where<T>(
    args: [(row: T) => unknown],
    stdin: AsyncIterable<T>,
): AsyncGenerator<T> {
    const predicate = args[0];
    if (typeof predicate !== "function") {
        throw new Error("@where: predicate must be a function");
    }
    for await (const row of stdin) {
        if (predicate(row)) yield row;
    }
}
