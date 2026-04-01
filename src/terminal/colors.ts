// Terminal color helpers for .jshrc users.

// ---- ANSI escape builders ---------------------------------------------------

function parseHex(hex: string): [number, number, number] {
    const h = hex.startsWith("#") ? hex.slice(1) : hex;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function makeFgColor(r: number | string, g?: number, b?: number): string {
    if (typeof r === "string") {
        const [rr, gg, bb] = parseHex(r);
        return `\x1b[38;2;${rr};${gg};${bb}m`;
    }
    return `\x1b[38;2;${r};${g};${b}m`;
}

export function makeBgColor(r: number | string, g?: number, b?: number): string {
    if (typeof r === "string") {
        const [rr, gg, bb] = parseHex(r);
        return `\x1b[48;2;${rr};${gg};${bb}m`;
    }
    return `\x1b[48;2;${r};${g};${b}m`;
}

export function makeUlColor(r: number | string, g?: number, b?: number): string {
    if (typeof r === "string") {
        const [rr, gg, bb] = parseHex(r);
        return `\x1b[58;2;${rr};${gg};${bb}m`;
    }
    return `\x1b[58;2;${r};${g};${b}m`;
}

// ---- Built-in color constants -----------------------------------------------

export const colors = {
    // Reset
    reset: "\x1b[0m",

    // Modifiers
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    blink: "\x1b[5m",
    inverse: "\x1b[7m",
    hidden: "\x1b[8m",
    strikethrough: "\x1b[9m",

    // Underline styles
    underlineCurly: "\x1b[4:3m",
    underlineDotted: "\x1b[4:4m",
    underlineDashed: "\x1b[4:5m",
    underlineDouble: "\x1b[4:2m",

    // Foreground
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",

    // Bright foreground
    brightBlack: "\x1b[90m",
    brightRed: "\x1b[91m",
    brightGreen: "\x1b[92m",
    brightYellow: "\x1b[93m",
    brightBlue: "\x1b[94m",
    brightMagenta: "\x1b[95m",
    brightCyan: "\x1b[96m",
    brightWhite: "\x1b[97m",

    // Background
    bgBlack: "\x1b[40m",
    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
    bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m",
    bgCyan: "\x1b[46m",
    bgWhite: "\x1b[47m",

    // Bright background
    bgBrightBlack: "\x1b[100m",
    bgBrightRed: "\x1b[101m",
    bgBrightGreen: "\x1b[102m",
    bgBrightYellow: "\x1b[103m",
    bgBrightBlue: "\x1b[104m",
    bgBrightMagenta: "\x1b[105m",
    bgBrightCyan: "\x1b[106m",
    bgBrightWhite: "\x1b[107m",
};

// ---- Tagged template --------------------------------------------------------

/**
 * Tagged template for styled strings. Auto-appends reset at the end.
 *
 * Usage:
 *   const { bold, green } = jsh.colors;
 *   jsh.style`${bold}${green}hello world`
 *   // → "\x1b[1m\x1b[32mhello world\x1b[0m"
 */
export function style(strings: TemplateStringsArray, ...values: unknown[]): string {
    let result = "";
    for (let i = 0; i < strings.length; i++) {
        result += strings[i];
        if (i < values.length) {
            result += String(values[i]);
        }
    }
    // Auto-append reset if the string contains any escape and doesn't end with reset.
    if (result.includes("\x1b[") && !result.endsWith("\x1b[0m")) {
        result += "\x1b[0m";
    }
    return result;
}
