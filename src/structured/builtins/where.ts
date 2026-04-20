// Filter rows by a predicate function. The predicate is the first arg and
// is expected to be a JS function value — typically supplied via the inline
// JS arg form `@{...}`:
//
//   @ls | @where @{ f => f.size > 1024 }
//   @ps | @where @{ p => p.user === "root" }
//
// Word-shaped args (e.g. `@where foo`) arrive as strings and are rejected.

export async function* where(
    args: unknown[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    if (args.length === 0) throw new Error("@where: predicate required (use @{ row => ... })");
    const predicate = args[0];
    if (typeof predicate !== "function") {
        throw new Error("@where: predicate must be a function — wrap the lambda in @{ ... }");
    }
    for await (const row of stdin) {
        if ((predicate as (r: unknown) => unknown)(row)) yield row;
    }
}
