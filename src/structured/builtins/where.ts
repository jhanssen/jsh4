// Filter rows by a predicate. The predicate is supplied as a JS expression
// in args[0..] (joined by spaces) and evaluated to a function once at stage
// start. Each row that returns truthy passes through.
//
//   @ls | @where 'f => f.size > 1024'
//   @ps | @where 'p => p.user === "root"'

export async function* where(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    if (args.length === 0) throw new Error("@where: predicate required");
    const src = args.join(" ");
    let predicate: (row: unknown) => unknown;
    try {
        // eslint-disable-next-line no-new-func
        predicate = new Function(`"use strict"; return (${src})`)() as (row: unknown) => unknown;
    } catch (e) {
        throw new Error(`@where: bad predicate: ${e instanceof Error ? e.message : e}`);
    }
    if (typeof predicate !== "function") {
        throw new Error(`@where: predicate is not a function: ${src}`);
    }
    for await (const row of stdin) {
        if (predicate(row)) yield row;
    }
}
