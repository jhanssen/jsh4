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

export class WidgetManager {
    private widgets = new Map<string, WidgetDef>();
    private cache = new Map<string, string[]>();
    private repaintFn: (() => void) | null = null;

    setRepaintFn(fn: () => void): void {
        this.repaintFn = fn;
    }

    add(widget: WidgetDef): WidgetHandle {
        this.widgets.set(widget.id, widget);
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
        this.widgets.delete(id);
        this.cache.delete(id);
    }

    /** Get cached lines for a multi-line zone (header/footer), sorted by order. */
    getZoneLines(zone: "header" | "footer"): string[] {
        const lines: string[] = [];
        const sorted = [...this.widgets.values()]
            .filter(w => w.zone === zone)
            .sort((a, b) => a.order - b.order);
        for (const w of sorted) {
            const cached = this.cache.get(w.id);
            if (cached) lines.push(...cached);
        }
        return lines;
    }

    /** Get cached string for a single-line zone (prompt/rprompt/ps2).
     *  Multiple widgets in the same zone are concatenated in order. */
    getZoneString(zone: "prompt" | "rprompt" | "ps2"): string {
        const sorted = [...this.widgets.values()]
            .filter(w => w.zone === zone)
            .sort((a, b) => a.order - b.order);
        let result = "";
        for (const w of sorted) {
            const cached = this.cache.get(w.id);
            if (cached) result += cached[0] ?? "";
        }
        return result;
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
                    if (this.repaintFn && JSON.stringify(old) !== JSON.stringify(lines)) {
                        this.repaintFn();
                    }
                }).catch(() => {});
            } else {
                const lines = Array.isArray(result) ? result : [result];
                const old = this.cache.get(id);
                this.cache.set(id, lines);
                if (this.repaintFn && JSON.stringify(old) !== JSON.stringify(lines)) {
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
    }

    /** Sync evaluation — try to get result immediately, kick off async if needed. */
    private _evalSync(widget: WidgetDef): void {
        try {
            const result = widget.render();
            if (result instanceof Promise) {
                result.then(r => {
                    const lines = Array.isArray(r) ? r : [r];
                    this.cache.set(widget.id, lines);
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
