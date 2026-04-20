// Parse NDJSON (one JSON value per line) from upstream into objects.
//
// Stdin is treated as `AsyncIterable<string>` of lines (the executor wires
// `fdLineReader(fd)` when @jsonl follows a byte-mode stage). Empty/whitespace
// lines are skipped. Parse errors throw, terminating the pipeline.
//
//   cat events.json | @jsonl | @where 'e => e.level === "error"' | @table

export async function* jsonl(
    _args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    for await (const raw of stdin) {
        const line = typeof raw === "string" ? raw : String(raw);
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield JSON.parse(trimmed);
    }
}
