// Widget registry for header/footer regions with optional timer-based updates.

export interface WidgetDef {
    id: string;
    zone: "header" | "footer";
    order: number;
    render: () => string | string[] | Promise<string | string[]>;
    interval?: number;  // ms, 0 or undefined = no auto-refresh
}

export class WidgetManager {
    private widgets = new Map<string, WidgetDef>();
    private timers = new Map<string, ReturnType<typeof setInterval>>();
    private cache = new Map<string, string[]>();
    private repaintFn: (() => void) | null = null;

    setRepaintFn(fn: () => void): void {
        this.repaintFn = fn;
    }

    add(widget: WidgetDef): void {
        this.widgets.set(widget.id, widget);
        // Render immediately and cache.
        this.updateWidget(widget.id);
        // Start timer if interval set.
        if (widget.interval && widget.interval > 0) {
            this.startTimer(widget.id, widget.interval);
        }
    }

    remove(id: string): void {
        this.widgets.delete(id);
        this.cache.delete(id);
        const timer = this.timers.get(id);
        if (timer) { clearInterval(timer); this.timers.delete(id); }
    }

    /** Get cached lines for a zone, sorted by widget order. */
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

    async updateWidget(id: string): Promise<void> {
        const widget = this.widgets.get(id);
        if (!widget) return;
        try {
            const result = await widget.render();
            const lines = Array.isArray(result) ? result : [result];
            const old = this.cache.get(id);
            this.cache.set(id, lines);
            // Trigger repaint if content changed.
            if (this.repaintFn && JSON.stringify(old) !== JSON.stringify(lines)) {
                this.repaintFn();
            }
        } catch {
            // Widget errors silently ignored.
        }
    }

    startTimers(): void {
        for (const [id, widget] of this.widgets) {
            if (widget.interval && widget.interval > 0 && !this.timers.has(id)) {
                this.startTimer(id, widget.interval);
            }
        }
    }

    stopTimers(): void {
        for (const [id, timer] of this.timers) {
            clearInterval(timer);
        }
        this.timers.clear();
    }

    private startTimer(id: string, interval: number): void {
        const timer = setInterval(() => this.updateWidget(id), interval);
        // Unref so the timer doesn't keep the process alive.
        if (timer.unref) timer.unref();
        this.timers.set(id, timer);
    }
}
