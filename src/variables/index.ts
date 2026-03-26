const store = new Map<string, unknown>();

// Initialize from process.env
for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
        store.set(key, value);
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
