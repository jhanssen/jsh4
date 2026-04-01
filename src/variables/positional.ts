// Stack of positional parameter arrays.
// The bottom frame is the top-level shell (empty by default).
// Each function call pushes its args and pops on return.
const stack: string[][] = [[]];

export function pushParams(args: string[]): void {
    stack.push(args);
}

export function popParams(): void {
    if (stack.length > 1) stack.pop();
}

export function getParam(n: number): string | undefined {
    // $1 = index 0, $2 = index 1, etc.
    return stack[stack.length - 1]![n - 1];
}

export function getAllParams(): string[] {
    return stack[stack.length - 1]!;
}

export function getParamCount(): number {
    return stack[stack.length - 1]!.length;
}

// Snapshot/restore the entire positional parameter stack for subshell isolation.
export function snapshotParams(): string[][] {
    return stack.map(frame => [...frame]);
}

export function restoreParams(saved: string[][]): void {
    stack.length = 0;
    for (const frame of saved) stack.push(frame);
}

export function shiftParams(n: number): boolean {
    const frame = stack[stack.length - 1]!;
    if (n > frame.length) return false;
    frame.splice(0, n);
    return true;
}
