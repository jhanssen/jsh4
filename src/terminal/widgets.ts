// Widget registry — unified system for all rendered regions (header, footer, prompt, rprompt, ps2).
// Each widget has a render function and a handle with update()/remove().
// The engine calls render on update() or when it needs fresh content (e.g. new editing session).

export type WidgetZone = "header" | "footer" | "prompt" | "rprompt" | "ps2";

export interface WidgetHandle {
    /** Re-evaluate the render function and repaint if content changed. */
    update(): void;
    /** Remove the widget entirely. */
    remove(): void;
    /** The widget's unique id. */
    readonly id: string;
}

export interface WidgetDef {
    id: string;
    zone: WidgetZone;
    order: number;
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
    private cache = new Map<string, string[]>();
    private repaintFn: (() => void) | null = null;

    // Per-zone content cache — invalidated when any widget in the zone changes.
    private zoneCache = new Map<WidgetZone, string[]>();
    private zoneDirty = new Set<WidgetZone>();

    setRepaintFn(fn: () => void): void {
        this.repaintFn = fn;
    }

    add(widget: WidgetDef): WidgetHandle {
        this.widgets.set(widget.id, widget);
        this.invalidateZone(widget.zone);
        // Initial render — try sync first.
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
     * Get cached content for a zone, sorted by widget order.
     * Widgets returning a single string concatenate on the same line.
     * Widgets returning a multi-element array add separate lines.
     * Returns an array of lines.
     */
    getZoneContent(zone: WidgetZone): string[] {
        const cached = this.zoneCache.get(zone);
        if (cached && !this.zoneDirty.has(zone)) return cached;

        const sorted = [...this.widgets.values()]
            .filter(w => w.zone === zone)
            .sort((a, b) => a.order - b.order);

        const lines: string[] = [];
        let currentLine = "";

        for (const w of sorted) {
            const wCache = this.cache.get(w.id);
            if (!wCache || wCache.length === 0) continue;

            if (wCache.length === 1) {
                currentLine += wCache[0]!;
            } else {
                currentLine += wCache[0]!;
                lines.push(currentLine);
                for (let i = 1; i < wCache.length - 1; i++) {
                    lines.push(wCache[i]!);
                }
                currentLine = wCache[wCache.length - 1]!;
            }
        }

        if (currentLine) lines.push(currentLine);
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

    /** Re-evaluate all widgets in a zone. Returns a promise that resolves when all are done. */
    async refreshZone(zone: WidgetZone): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const w of this.widgets.values()) {
            if (w.zone !== zone) continue;
            promises.push(this._evalAsync(w));
        }
        await Promise.all(promises);
        this.invalidateZone(zone);
    }

    /** Sync evaluation — try to get result immediately, kick off async if needed. */
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

    /** Async evaluation — always awaits. */
    private async _evalAsync(widget: WidgetDef): Promise<void> {
        try {
            const result = await widget.render();
            const lines = Array.isArray(result) ? result : [result];
            this.cache.set(widget.id, lines);
        } catch {}
    }
}
