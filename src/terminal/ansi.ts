// ANSI-aware string width calculation (TS port of linenoise C functions).

// East Asian Width: returns 2 for wide chars, 0 for combining/control, 1 otherwise.
function charWidth(cp: number): number {
    if (cp === 0) return 0;
    // Combining characters and zero-width
    if ((cp >= 0x0300 && cp <= 0x036F) ||
        (cp >= 0x1AB0 && cp <= 0x1AFF) ||
        (cp >= 0x1DC0 && cp <= 0x1DFF) ||
        (cp >= 0x20D0 && cp <= 0x20FF) ||
        (cp >= 0xFE00 && cp <= 0xFE0F) ||
        (cp >= 0xFE20 && cp <= 0xFE2F) ||
        (cp >= 0xE0100 && cp <= 0xE01EF) ||
        cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF) {
        return 0;
    }
    // Wide characters (CJK, emoji, etc.)
    if ((cp >= 0x1100 && cp <= 0x115F) ||
        (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3040 && cp <= 0x33BF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x20000 && cp <= 0x2FFFF) ||
        (cp >= 0x30000 && cp <= 0x3FFFF) ||
        (cp >= 0x1F000 && cp <= 0x1FFFF) ||
        (cp >= 0x4E00 && cp <= 0x9FFF) ||
        (cp >= 0x3400 && cp <= 0x4DBF)) {
        return 2;
    }
    if (cp < 0x20) return 0;
    return 1;
}

/** Display width of a string, ignoring ANSI escape sequences. */
export function displayWidth(s: string): number {
    let width = 0;
    let i = 0;
    while (i < s.length) {
        // Skip CSI sequences: ESC [ ... (final byte 0x40-0x7E)
        if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "[") {
            i += 2;
            while (i < s.length && s.charCodeAt(i) < 0x40) i++;
            if (i < s.length) i++;
            continue;
        }
        // Skip OSC sequences: ESC ] ... BEL or ESC ] ... ESC backslash
        if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "]") {
            i += 2;
            while (i < s.length) {
                if (s.charCodeAt(i) === 0x07) { i++; break; }
                if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "\\") { i += 2; break; }
                i++;
            }
            continue;
        }
        const cp = s.codePointAt(i)!;
        width += charWidth(cp);
        i += cp > 0xFFFF ? 2 : 1;
    }
    return width;
}

/** Display width of a plain string (no ANSI sequences). */
export function plainWidth(s: string): number {
    let width = 0;
    for (let i = 0; i < s.length;) {
        const cp = s.codePointAt(i)!;
        width += charWidth(cp);
        i += cp > 0xFFFF ? 2 : 1;
    }
    return width;
}

/**
 * Truncate a string (which may contain ANSI escapes) to fit within
 * a given display column budget. Returns the truncated string.
 */
export function truncateToWidth(s: string, maxWidth: number): string {
    let width = 0;
    let i = 0;
    let lastSafeIdx = 0;
    while (i < s.length) {
        // Skip CSI
        if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "[") {
            i += 2;
            while (i < s.length && s.charCodeAt(i) < 0x40) i++;
            if (i < s.length) i++;
            continue;
        }
        // Skip OSC
        if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "]") {
            i += 2;
            while (i < s.length) {
                if (s.charCodeAt(i) === 0x07) { i++; break; }
                if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "\\") { i += 2; break; }
                i++;
            }
            continue;
        }
        const cp = s.codePointAt(i)!;
        const w = charWidth(cp);
        if (width + w > maxWidth) break;
        width += w;
        i += cp > 0xFFFF ? 2 : 1;
        lastSafeIdx = i;
    }
    return s.slice(0, lastSafeIdx);
}

/**
 * Pad or truncate a string to exactly `targetWidth` display columns.
 * Pads with spaces on the right.
 */
export function fitToWidth(s: string, targetWidth: number): string {
    const w = displayWidth(s);
    if (w >= targetWidth) return truncateToWidth(s, targetWidth);
    return s + " ".repeat(targetWidth - w);
}

/**
 * Get display width of only the last line (after the last \n).
 * Used for multi-line prompts where only the last line matters for cursor math.
 */
export function lastLineWidth(s: string): number {
    const lastNl = s.lastIndexOf("\n");
    const lastLine = lastNl === -1 ? s : s.slice(lastNl + 1);
    return displayWidth(lastLine);
}
