// Buffered sort. Args: zero or more comma-separated key paths.
//
//   @ls | @sort                  natural order (primitives, JSON for objects)
//   @ls | @sort name             ascending by .name
//   @ls | @sort size,name        size first, then name as tiebreaker
//
// For lambda-keyed sort, see @sort-by.

function compareScalar(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return String(a).localeCompare(String(b));
}

export async function* sort(
    args: string[],
    stdin: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
    const buf: unknown[] = [];
    for await (const row of stdin) buf.push(row);

    const keys = args[0]
        ? args[0].split(",").map(s => s.trim()).filter(Boolean)
        : [];

    if (keys.length === 0) {
        buf.sort((a, b) => {
            if (typeof a === "object" || typeof b === "object") {
                return compareScalar(JSON.stringify(a), JSON.stringify(b));
            }
            return compareScalar(a, b);
        });
    } else {
        buf.sort((a, b) => {
            for (const k of keys) {
                const av = (a as Record<string, unknown> | null)?.[k];
                const bv = (b as Record<string, unknown> | null)?.[k];
                const c = compareScalar(av, bv);
                if (c !== 0) return c;
            }
            return 0;
        });
    }

    for (const row of buf) yield row;
}
