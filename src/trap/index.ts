// Signal/pseudo-signal trap registry.

export interface Trap {
    signal: string;
    action: string;  // command string to execute, "" = ignore, "-" = default
}

const traps = new Map<string, string>();

// Valid signal names.
const VALID_SIGNALS = new Set([
    "EXIT", "INT", "TERM", "HUP", "QUIT",
    "ERR", "DEBUG", "RETURN",
]);

export function setTrap(signal: string, action: string): boolean {
    const sig = signal.toUpperCase().replace(/^SIG/, "");
    if (!VALID_SIGNALS.has(sig)) {
        process.stderr.write(`trap: ${signal}: invalid signal specification\n`);
        return false;
    }
    if (action === "-") {
        traps.delete(sig);
    } else {
        traps.set(sig, action);
    }
    return true;
}

export function getTrap(signal: string): string | undefined {
    return traps.get(signal.toUpperCase().replace(/^SIG/, ""));
}

export function getAllTraps(): Map<string, string> {
    return new Map(traps);
}

export function clearAllTraps(): void {
    traps.clear();
}

// Execute a trap's command string. The caller provides the execute function
// to avoid circular dependencies.
export async function runTrap(signal: string, executeFn: (cmd: string) => Promise<void>): Promise<void> {
    const action = traps.get(signal);
    if (action === undefined || action === "") return; // no trap or ignored
    try {
        await executeFn(action);
    } catch {
        // Trap errors are silently ignored (POSIX behavior).
    }
}
