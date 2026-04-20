// Count rows from upstream and emit a single { count: N } row.
//
//   @ls | @count                          → { count: 42 }
//   @ls | @where 'f => f.isDir' | @count  → { count: 7 }

export async function* count(
    _args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<{ count: number }> {
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stdin) n++;
    yield { count: n };
}
