// Object-mode channel between adjacent in-process @-function stages.
//
// The "channel" is just an AsyncIterable<unknown> the upstream stage's
// function returns. The downstream stage receives it as its `stdin`
// parameter. No queue, no fd, no serialization — pull-based with natural
// backpressure (the consumer's `for await` drives the producer).

export type ObjectIterable = AsyncIterable<unknown>;

// Empty iterable — used as `stdin` for the first stage in an object-mode
// pipeline (no upstream).
export const EMPTY_OBJECT_ITERABLE: ObjectIterable = {
    [Symbol.asyncIterator]: async function* () {},
};

// Detect whether a returned value is an iterable suitable to serve as the
// channel for the next stage. Accepts AsyncIterable and Iterable; promotes
// sync iterables to async.
export function toObjectIterable(value: unknown): ObjectIterable | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number"
        || typeof value === "boolean" || typeof value === "bigint") return null;
    const v = value as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
                        [Symbol.iterator]?:      () => Iterator<unknown> };
    if (typeof v[Symbol.asyncIterator] === "function") {
        return value as ObjectIterable;
    }
    if (typeof v[Symbol.iterator] === "function") {
        const sync = value as Iterable<unknown>;
        return { [Symbol.asyncIterator]: async function* () { for (const x of sync) yield x; } };
    }
    return null;
}
