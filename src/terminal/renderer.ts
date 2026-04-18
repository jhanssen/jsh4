// Terminal renderer: assembles frames from regions and writes to stdout.

export interface Frame {
    headerLines: string[];
    frozenLines: string[];  // previous prompt/continuation lines (read-only, above input)
    inputLines: string[];   // current input (may span multiple lines for multi-line buffers)
    cursorCol: number;      // column on the last input line
    footerLines: string[];
}

export class Renderer {
    private lastTotalRows = 0;
    private lastCursorRow = 0;
    private writeRaw: (data: string) => void;

    constructor(writeRaw: (data: string) => void) {
        this.writeRaw = writeRaw;
    }

    render(frame: Frame, cursorLineOffset?: number): void {
        const lines = [
            ...frame.headerLines,
            ...frame.frozenLines,
            ...frame.inputLines,
            ...frame.footerLines,
        ];
        const totalRows = lines.length;
        // Cursor row: header + frozen + offset within input lines.
        const inputOffset = cursorLineOffset ?? (frame.inputLines.length - 1);
        const cursorRow = frame.headerLines.length + frame.frozenLines.length + inputOffset;

        let buf = "";

        // Begin synchronized rendering.
        buf += "\x1b[?2026h";

        // Ensure enough room for the frame by scrolling the terminal.
        // Emit \n to create space, then move back up.
        if (this.lastTotalRows === 0 && totalRows > 1) {
            // First render with multi-row frame: reserve space.
            const extra = totalRows - 1;
            for (let i = 0; i < extra; i++) buf += "\n";
            buf += `\x1b[${extra}A`;
        } else if (totalRows > this.lastTotalRows && this.lastTotalRows > 0) {
            // Frame grew: reserve additional space.
            const extra = totalRows - this.lastTotalRows;
            // Move to bottom of current frame first.
            const toBottom = this.lastTotalRows - 1 - this.lastCursorRow;
            if (toBottom > 0) buf += `\x1b[${toBottom}B`;
            for (let i = 0; i < extra; i++) buf += "\n";
            // Move back to cursor row.
            buf += `\x1b[${extra + toBottom}A`;
        }

        // Move to top of previous frame.
        if (this.lastTotalRows > 0 && this.lastCursorRow > 0) {
            buf += `\x1b[${this.lastCursorRow}A`;
        }
        buf += "\r";

        // Write each line, clearing to end of line.
        // Use \r\n between lines since OPOST is off in raw mode (\n alone doesn't CR).
        for (let i = 0; i < totalRows; i++) {
            buf += lines[i]! + "\x1b[0K";
            if (i < totalRows - 1) buf += "\r\n";
        }

        // Clear any leftover lines from previous (taller) frame. Use \r\n to
        // return to column 0 (OPOST is off — \n alone only moves down) and
        // \x1b[2K to erase the full row; \x1b[0K would leave stale content to
        // the left of the cursor, which on shrink from a wider previous frame
        // shows up as leftover text from the old render.
        if (this.lastTotalRows > totalRows) {
            const extra = this.lastTotalRows - totalRows;
            for (let i = 0; i < extra; i++) {
                buf += "\r\n\x1b[2K";
            }
            buf += `\x1b[${extra}A`;
        }

        // Position cursor at the input line.
        const linesFromBottom = totalRows - 1 - cursorRow;
        if (linesFromBottom > 0) {
            buf += `\x1b[${linesFromBottom}A`;
        }
        buf += "\r";
        if (frame.cursorCol > 0) {
            buf += `\x1b[${frame.cursorCol}C`;
        }

        // End synchronized rendering.
        buf += "\x1b[?2026l";

        this.writeRaw(buf);

        this.lastTotalRows = totalRows;
        this.lastCursorRow = cursorRow;
    }

    /** Erase the entire frame (for hide / before async output). */
    clear(): void {
        if (this.lastTotalRows === 0) return;
        let buf = "";
        // Move to top of frame.
        if (this.lastCursorRow > 0) {
            buf += `\x1b[${this.lastCursorRow}A`;
        }
        buf += "\r";
        // Clear each line.
        for (let i = 0; i < this.lastTotalRows; i++) {
            buf += "\x1b[0K";
            if (i < this.lastTotalRows - 1) buf += "\n";
        }
        // Move back to top.
        if (this.lastTotalRows > 1) {
            buf += `\x1b[${this.lastTotalRows - 1}A`;
        }
        buf += "\r";
        this.writeRaw(buf);
    }

    getLastHeaderRows(): number {
        return this.lastCursorRow;
    }

    getLastFooterRows(): number {
        return this.lastTotalRows - 1 - this.lastCursorRow;
    }

    getLastTotalRows(): number {
        return this.lastTotalRows;
    }

    /** Reset state (after line accepted, before next prompt). */
    reset(): void {
        this.lastTotalRows = 0;
        this.lastCursorRow = 0;
    }
}
