// Transform each row through a lambda. Counterpart to @where.
//
//   @ls | @map f => f.name
//   @ps | @map p => ({ pid: p.pid, cmd: p.command })

export async function* map<T, U>(
    args: [(row: T) => U],
    stdin: AsyncIterable<T>,
): AsyncGenerator<U> {
    const fn = args[0];
    if (typeof fn !== "function") {
        throw new Error("@map: transform must be a function");
    }
    for await (const row of stdin) yield fn(row);
}
