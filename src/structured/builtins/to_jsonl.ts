// Serialize each upstream object as a single JSON line (NDJSON / JSONL).
// Yields strings — the executor's drain writes string rows raw to the
// downstream byte fd, so this works as the boundary between an object
// pipeline and a byte-mode consumer (grep, file redirection, etc.).
//
//   @ls | @to-jsonl > files.jsonl
//   @ps | @to-jsonl | grep firefox

export async function* toJsonl(
    _args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<string> {
    for await (const row of stdin) {
        yield JSON.stringify(row) + "\n";
    }
}
