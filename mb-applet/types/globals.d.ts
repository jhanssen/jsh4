declare const console: {
    log(...a: unknown[]): void;
    info(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    error(...a: unknown[]): void;
};

declare function setTimeout(fn: () => void, ms: number): number;
declare function setInterval(fn: () => void, ms: number): number;
declare function clearTimeout(id: number): void;
declare function clearInterval(id: number): void;

interface JSON {
    parse(text: string): unknown;
    stringify(value: unknown): string;
}
declare const JSON: JSON;
