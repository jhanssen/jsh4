// Parse line-delimited JSON (NDJSON / JSONL) from upstream bytes into objects.
//
// Stdin is treated as `AsyncIterable<string>` of lines (the executor wires
// `fdLineReader(fd)` when this stage follows a byte-mode stage). Blank
// lines are skipped. Parse errors throw, terminating the pipeline.
//
//   cat events.json | @from-jsonl | @where @{ e => e.level === "error" } | @table

export async function* fromJsonl(
    _args: unknown[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    for await (const raw of stdin) {
        const line = typeof raw === "string" ? raw : String(raw);
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield JSON.parse(trimmed);
    }
}
