const store = new Map<string, unknown>();

// Initialize from process.env
for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
        store.set(key, value);
    }
}

// Set PPID (parent PID).
store.set("PPID", String(process.ppid));

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

// ---- readonly variables -----------------------------------------------------
const readonlySet = new Set<string>(["PPID"]);

export function declareReadonly(name: string, value?: unknown): void {
    if (value !== undefined) store.set(name, value);
    readonlySet.add(name);
}

export function isReadonly(name: string): boolean {
    return readonlySet.has(name);
}

export function getReadonlyVars(): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const name of readonlySet) {
        result.set(name, store.get(name));
    }
    return result;
}

export const $: Record<string, unknown> = new Proxy(
    {} as Record<string, unknown>,
    {
        get(_target, prop: string): unknown {
            return store.get(prop);
        },
        set(_target, prop: string, value: unknown): boolean {
            if (readonlySet.has(prop)) {
                process.stderr.write(`jsh: ${prop}: readonly variable\n`);
                return true;
            }
            store.set(prop, value);
            return true;
        },
        deleteProperty(_target, prop: string): boolean {
            if (readonlySet.has(prop)) {
                process.stderr.write(`jsh: ${prop}: readonly variable\n`);
                return true;
            }
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
