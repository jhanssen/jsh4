// Widget registry — unified system for all rendered regions.
// Each widget has a render function and a handle with update()/remove().

export type WidgetZone = "header" | "footer" | "prompt" | "rprompt" | "ps2";
export type WidgetAlign = "left" | "right" | "center";

export interface WidgetHandle {
    /** Re-evaluate the render function and repaint if content changed. */
    update(): void;
    /** Remove the widget entirely. */
    remove(): void;
    /** The widget's unique id. */
    readonly id: string;
}

export interface WidgetOptions {
    /** Starting line number. Header: 0 = closest to input, -1 above. Footer: 0 = closest, 1 below. */
    line?: number;
    /** Horizontal alignment on the line. Default: "left". */
    align?: WidgetAlign;
}

export interface WidgetDef {
    id: string;
    zone: WidgetZone;
    line: number;
    align: WidgetAlign;
    render: () => string | string[] | Promise<string | string[]>;
}

function arraysEqual(a: string[] | undefined, b: string[]): boolean {
    if (!a) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class WidgetManager {
    private widgets = new Map<string, WidgetDef>();
    private cache = new Map<string, string[]>(); // per-widget cached render result
    private repaintFn: (() => void) | null = null;

    // Per-zone assembled line cache.
    private zoneCache = new Map<WidgetZone, string[]>();
    private zoneDirty = new Set<WidgetZone>();

    setRepaintFn(fn: () => void): void {
        this.repaintFn = fn;
    }

    add(widget: WidgetDef): WidgetHandle {
        this.widgets.set(widget.id, widget);
        this.invalidateZone(widget.zone);
        this._evalSync(widget);

        const handle: WidgetHandle = {
            id: widget.id,
            update: () => this.updateWidget(widget.id),
            remove: () => this.remove(widget.id),
        };
        return handle;
    }

    remove(id: string): void {
        const widget = this.widgets.get(id);
        if (widget) this.invalidateZone(widget.zone);
        this.widgets.delete(id);
        this.cache.delete(id);
    }

    private invalidateZone(zone: WidgetZone): void {
        this.zoneDirty.add(zone);
        this.zoneCache.delete(zone);
    }

    /**
     * Get assembled lines for a multi-line zone (header/footer).
     * Each line is composed from widgets at that line number,
     * with left/center/right alignment groups.
     */
    getZoneContent(zone: WidgetZone, cols?: number): string[] {
        if (zone === "prompt" || zone === "rprompt" || zone === "ps2") {
            return this._getInlineZoneContent(zone);
        }

        // Don't cache header/footer — composition depends on terminal width
        // which can change. Widget render results are cached separately.

        // Collect all widgets in this zone with their rendered lines.
        const entries: Array<{ widget: WidgetDef; lines: string[] }> = [];
        for (const w of this.widgets.values()) {
            if (w.zone !== zone) continue;
            const wLines = this.cache.get(w.id);
            if (!wLines || wLines.length === 0) continue;
            // Skip empty single-line widgets.
            if (wLines.length === 1 && wLines[0] === "") continue;
            entries.push({ widget: w, lines: wLines });
        }

        if (entries.length === 0) return [];

        // Determine the line range.
        // Header: line numbers are <= 0 (0 closest to input, -1 above, etc.)
        //   Widget at line -1 with 2 rendered lines occupies lines -1 and 0.
        // Footer: line numbers are >= 0 (0 closest to input, 1 below, etc.)
        //   Widget at line 0 with 2 rendered lines occupies lines 0 and 1.
        let minLine = Infinity;
        let maxLine = -Infinity;

        for (const { widget, lines } of entries) {
            const start = widget.line;
            const end = start + lines.length - 1;
            if (start < minLine) minLine = start;
            if (end > maxLine) maxLine = end;
        }

        // Build each output line by composing widgets at that line number.
        const result: string[] = [];
        for (let lineNum = minLine; lineNum <= maxLine; lineNum++) {
            let left = "";
            let center = "";
            let right = "";

            for (const { widget, lines } of entries) {
                const offset = lineNum - widget.line;
                if (offset < 0 || offset >= lines.length) continue;
                const content = lines[offset]!;
                switch (widget.align) {
                    case "left": left += content; break;
                    case "right": right += content; break;
                    case "center": center += content; break;
                }
            }

            result.push(this._composeLine(left, center, right, cols ?? 80));
        }

        return result;
    }

    /** Compose a line from left/center/right segments using terminal width. */
    private _composeLine(left: string, center: string, right: string, cols: number): string {
        // Common case: only left content.
        if (!center && !right) return left;
        if (!left && !right && !center) return "";

        const leftW = this._displayWidth(left);
        const centerW = this._displayWidth(center);
        const rightW = this._displayWidth(right);

        if (!center) {
            // Left + right: pad between them.
            const pad = Math.max(0, cols - leftW - rightW);
            return left + " ".repeat(pad) + right;
        }
        if (!left && !right) {
            // Center only.
            const pad = Math.max(0, Math.floor((cols - centerW) / 2));
            return " ".repeat(pad) + center;
        }
        // All three: left, center in middle, right at edge.
        const centerPos = Math.max(leftW, Math.floor((cols - centerW) / 2));
        const rightPos = Math.max(centerPos + centerW, cols - rightW);
        const padLeft = Math.max(0, centerPos - leftW);
        const padRight = Math.max(0, rightPos - centerPos - centerW);
        return left + " ".repeat(padLeft) + center + " ".repeat(padRight) + right;
    }

    /** ANSI-aware display width. */
    private _displayWidth(s: string): number {
        let width = 0;
        let i = 0;
        while (i < s.length) {
            if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "[") {
                i += 2;
                while (i < s.length && s.charCodeAt(i) < 0x40) i++;
                if (i < s.length) i++;
                continue;
            }
            if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "]") {
                i += 2;
                while (i < s.length) {
                    if (s.charCodeAt(i) === 0x07) { i++; break; }
                    if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "\\") { i += 2; break; }
                    i++;
                }
                continue;
            }
            width++;
            i++;
        }
        return width;
    }

    /** Get content for inline zones (prompt/rprompt/ps2) — simple concatenation. */
    private _getInlineZoneContent(zone: WidgetZone): string[] {
        const cached = this.zoneCache.get(zone);
        if (cached && !this.zoneDirty.has(zone)) return cached;

        const sorted = [...this.widgets.values()]
            .filter(w => w.zone === zone)
            .sort((a, b) => a.line - b.line);

        let result = "";
        for (const w of sorted) {
            const wCache = this.cache.get(w.id);
            if (wCache && wCache.length > 0) result += wCache[0] ?? "";
        }

        const lines = result ? [result] : [];
        this.zoneCache.set(zone, lines);
        this.zoneDirty.delete(zone);
        return lines;
    }

    /** Check if a zone has any widgets registered. */
    hasZone(zone: WidgetZone): boolean {
        for (const w of this.widgets.values()) {
            if (w.zone === zone) return true;
        }
        return false;
    }

    /** Re-evaluate a widget and repaint if changed. */
    updateWidget(id: string): void {
        const widget = this.widgets.get(id);
        if (!widget) return;
        try {
            const result = widget.render();
            if (result instanceof Promise) {
                result.then(r => {
                    const lines = Array.isArray(r) ? r : [r];
                    const old = this.cache.get(id);
                    this.cache.set(id, lines);
                    this.invalidateZone(widget.zone);
                    if (this.repaintFn && !arraysEqual(old, lines)) {
                        this.repaintFn();
                    }
                }).catch(() => {});
            } else {
                const lines = Array.isArray(result) ? result : [result];
                const old = this.cache.get(id);
                this.cache.set(id, lines);
                this.invalidateZone(widget.zone);
                if (this.repaintFn && !arraysEqual(old, lines)) {
                    this.repaintFn();
                }
            }
        } catch {}
    }

    /** Re-evaluate all widgets in a zone. */
    async refreshZone(zone: WidgetZone): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const w of this.widgets.values()) {
            if (w.zone !== zone) continue;
            promises.push(this._evalAsync(w));
        }
        await Promise.all(promises);
        this.invalidateZone(zone);
    }

    private _evalSync(widget: WidgetDef): void {
        try {
            const result = widget.render();
            if (result instanceof Promise) {
                result.then(r => {
                    const lines = Array.isArray(r) ? r : [r];
                    this.cache.set(widget.id, lines);
                    this.invalidateZone(widget.zone);
                    if (this.repaintFn) this.repaintFn();
                }).catch(() => {});
            } else {
                const lines = Array.isArray(result) ? result : [result];
                this.cache.set(widget.id, lines);
            }
        } catch {}
    }

    private async _evalAsync(widget: WidgetDef): Promise<void> {
        try {
            const result = await widget.render();
            const lines = Array.isArray(result) ? result : [result];
            this.cache.set(widget.id, lines);
        } catch {}
    }
}
