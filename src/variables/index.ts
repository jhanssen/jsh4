const store = new Map<string, unknown>();

// Initialize from process.env
for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
        store.set(key, value);
    }
}

// ---- local variable scoping -------------------------------------------------
// Each frame records the original values of variables declared `local`.
// On scope exit, these are restored (or deleted if they didn't exist).

const UNSET = Symbol("unset");
type SavedFrame = Map<string, unknown>; // value or UNSET
const scopeStack: SavedFrame[] = [];

export function pushScope(): void {
    scopeStack.push(new Map());
}

export function popScope(): void {
    const frame = scopeStack.pop();
    if (!frame) return;
    for (const [name, prev] of frame) {
        if (prev === UNSET) {
            store.delete(name);
        } else {
            store.set(name, prev);
        }
    }
}

// ---- subshell snapshot/restore ------------------------------------------------
// Snapshots the entire variable store so subshells get an isolated copy.
// On popSnapshot the store is completely replaced with the saved state.

const snapshotStack: Map<string, unknown>[] = [];

export function pushSnapshot(): void {
    snapshotStack.push(new Map(store));
}

export function popSnapshot(): void {
    const saved = snapshotStack.pop();
    if (!saved) return;
    store.clear();
    for (const [k, v] of saved) {
        store.set(k, v);
    }
}

export function declareLocal(name: string): void {
    const frame = scopeStack[scopeStack.length - 1];
    if (!frame) {
        // Not inside a function — local is a no-op (bash prints a warning; we match that)
        process.stderr.write(`local: can only be used in a function\n`);
        return;
    }
    // Only save the first time this name is declared local in this scope
    if (!frame.has(name)) {
        frame.set(name, store.has(name) ? store.get(name) : UNSET);
    }
}

export const $: Record<string, unknown> = new Proxy(
    {} as Record<string, unknown>,
    {
        get(_target, prop: string): unknown {
            return store.get(prop);
        },
        set(_target, prop: string, value: unknown): boolean {
            store.set(prop, value);
            return true;
        },
        deleteProperty(_target, prop: string): boolean {
            store.delete(prop);
            delete process.env[prop];
            return true;
        },
        has(_target, prop: string): boolean {
            return store.has(prop);
        },
        ownKeys(): string[] {
            return [...store.keys()];
        },
        getOwnPropertyDescriptor(_target, prop: string) {
            if (store.has(prop)) {
                return {
                    value: store.get(prop),
                    writable: true,
                    enumerable: true,
                    configurable: true,
                };
            }
            return undefined;
        },
    }
);
