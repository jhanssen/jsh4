/**
 * jsh global API — available in ~/.jshrc without any imports.
 *
 * @example
 * // ~/.jshrc
 * const { bold, green, cyan, reset } = jsh.colors;
 * const orange = jsh.makeFgColor(255, 165, 0);
 *
 * jsh.$.EDITOR = 'nvim';
 * jsh.alias('ll', 'ls -la');
 *
 * // Prompt is a widget — re-evaluated on each new line or on handle.update().
 * const prompt = jsh.addWidget("ps1", "prompt", async () => {
 *     const branch = await jsh.exec('git branch --show-current');
 *     const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
 *     return jsh.style`${green}${bold}${cwd} ${cyan}${branch.ok ? branch.stdout : ''}${reset}$ `;
 * });
 *
 * // Footer with a clock — interval is userland.
 * const clock = jsh.addWidget("clock", "footer", () => {
 *     return jsh.style`${orange}${new Date().toLocaleTimeString()}`;
 * });
 * setInterval(() => clock.update(), 1000);
 *
 * // Exported functions are auto-registered as @name pipeline functions.
 * export async function* upper(args: string[], stdin: AsyncIterable<string>) {
 *     for await (const line of stdin) yield line.toUpperCase();
 * }
 */

// ---- Pipeline functions -----------------------------------------------------

type JsPipelineFunction = (
    args: string[],
    stdin: AsyncIterable<string> | string | null
) => unknown;

// ---- Exec -------------------------------------------------------------------

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    ok: boolean;
}

interface ExecOptions {
    stdin?: string | AsyncIterable<string>;
    stderr?: "inherit" | "pipe" | "merge";
}

interface ExecHandle extends PromiseLike<ExecResult>, AsyncIterable<string> {}

// ---- Completion -------------------------------------------------------------

interface CompletionCtx {
    words: string[];
    current: string;
}

// ---- Theme ------------------------------------------------------------------

type Color = [number, number, number] | `#${string}` | string;

interface Theme {
    command?: Color;
    commandNotFound?: Color;
    keyword?: Color;
    operator?: Color;
    redirect?: Color;
    string?: Color;
    variable?: Color;
    comment?: Color;
    argument?: Color;
    paren?: Color;
    jsInline?: Color;
    /** Color for fish-style suggestion ghost text (default: "dim"). */
    suggestion?: Color;
}

// ---- Widgets ----------------------------------------------------------------

/**
 * Widget zones control where content renders in the terminal layout:
 *
 * - `"header"` — above the input line
 * - `"prompt"` — left side of input line
 * - `"rprompt"` — right side of input line
 * - `"ps2"` — left side of continuation lines
 * - `"footer"` — below the input line
 *
 * Multiple widgets in the same zone concatenate on one line (sorted by order).
 * Return a multi-element array from the render function to add explicit line breaks.
 */
type WidgetZone = "header" | "footer" | "prompt" | "rprompt" | "ps2";

/**
 * Handle returned by addWidget. Use update() to re-evaluate the render function
 * and repaint the screen, or remove() to unregister the widget.
 */
interface WidgetHandle {
    /** Re-evaluate the render function and repaint if content changed. */
    update(): void;
    /** Remove the widget from the layout. */
    remove(): void;
    /** The widget's unique id. */
    readonly id: string;
}

// ---- Color constants --------------------------------------------------------

interface Colors {
    // Reset
    readonly reset: string;
    // Modifiers
    readonly bold: string;
    readonly dim: string;
    readonly italic: string;
    readonly underline: string;
    readonly blink: string;
    readonly inverse: string;
    readonly hidden: string;
    readonly strikethrough: string;
    // Underline styles
    readonly underlineCurly: string;
    readonly underlineDotted: string;
    readonly underlineDashed: string;
    readonly underlineDouble: string;
    // Foreground
    readonly black: string;
    readonly red: string;
    readonly green: string;
    readonly yellow: string;
    readonly blue: string;
    readonly magenta: string;
    readonly cyan: string;
    readonly white: string;
    // Bright foreground
    readonly brightBlack: string;
    readonly brightRed: string;
    readonly brightGreen: string;
    readonly brightYellow: string;
    readonly brightBlue: string;
    readonly brightMagenta: string;
    readonly brightCyan: string;
    readonly brightWhite: string;
    // Background
    readonly bgBlack: string;
    readonly bgRed: string;
    readonly bgGreen: string;
    readonly bgYellow: string;
    readonly bgBlue: string;
    readonly bgMagenta: string;
    readonly bgCyan: string;
    readonly bgWhite: string;
    // Bright background
    readonly bgBrightBlack: string;
    readonly bgBrightRed: string;
    readonly bgBrightGreen: string;
    readonly bgBrightYellow: string;
    readonly bgBrightBlue: string;
    readonly bgBrightMagenta: string;
    readonly bgBrightCyan: string;
    readonly bgBrightWhite: string;
}

// ---- jsh global object ------------------------------------------------------

declare const jsh: {
    /** Shell variable store. */
    $: Record<string, unknown>;

    // ---- Widgets ----

    /**
     * Register a widget that renders content in a layout zone.
     * Returns a handle for updating or removing the widget.
     *
     * The render function is called:
     * - Once on registration
     * - On each new editing session (prompt/ps2 zones)
     * - When handle.update() is called
     *
     * For prompt/rprompt/ps2 zones, the render function should return a string.
     * For header/footer zones, it can return a string or string[].
     *
     * Multiple widgets in the same zone are ordered by the `order` parameter
     * and concatenate on one line. Return a multi-element array from the render
     * function to add explicit line breaks.
     *
     * @param id      Unique identifier
     * @param zone    Where to render: "header", "footer", "prompt", "rprompt", "ps2"
     * @param render  Function returning content (may be async)
     * @param order   Sort order within the zone (default 0)
     *
     * @example
     * // Prompt — re-evaluated on each new line
     * const ps1 = jsh.addWidget("ps1", "prompt", async () => {
     *     const b = await jsh.exec("git branch --show-current");
     *     return `${b.ok ? b.stdout + " " : ""}$ `;
     * });
     *
     * // Right prompt
     * jsh.addWidget("time", "rprompt", () => new Date().toLocaleTimeString());
     *
     * // Continuation prompt
     * jsh.addWidget("ps2", "ps2", () => "> ");
     *
     * // Footer with live clock — interval is userland
     * const clock = jsh.addWidget("clock", "footer", () => {
     *     return jsh.style`${jsh.colors.dim}${new Date().toLocaleTimeString()}`;
     * });
     * setInterval(() => clock.update(), 1000);
     *
     * // Header updated from event
     * const status = jsh.addWidget("net", "header", () => networkStatus);
     * someEmitter.on("change", () => status.update());
     */
    addWidget(
        id: string,
        zone: WidgetZone,
        render: () => string | string[] | Promise<string | string[]>,
        order?: number,
    ): WidgetHandle;

    /** Remove a previously registered widget by id. */
    removeWidget(id: string): void;

    // ---- Suggestions ----

    /**
     * Set a fish-style suggestion function. Called asynchronously when the user
     * types. The function receives the current input buffer and should return
     * the full suggested command (or null for no suggestion). Ghost text appears
     * dimmed after the cursor. Right arrow at end-of-line accepts.
     *
     * Stale suggestions are automatically discarded if the user types more
     * before the promise resolves.
     *
     * @example
     * jsh.setSuggestion(async (input) => {
     *     // Search history, call an API, etc.
     *     const result = await jsh.exec(`grep -m1 "^${input}" ~/.jsh_history`);
     *     return result.ok ? result.stdout : null;
     * });
     */
    setSuggestion(fn: ((input: string) => Promise<string | null>) | null): void;

    // ---- Syntax highlighting ----

    /** Set the syntax highlighting theme (merges with defaults). */
    setTheme(theme: Partial<Theme>): void;

    /** Override syntax highlighting entirely. Null restores the default. */
    setColorize(fn: ((input: string) => string) | null): void;

    // ---- Colors ----

    /** Pre-built ANSI color/modifier escape strings. */
    colors: Colors;

    /**
     * Create a custom foreground color from RGB values or hex string.
     * Returns an ANSI escape string that can be concatenated or used in templates.
     * @example
     * const orange = jsh.makeFgColor(255, 165, 0);
     * const brand = jsh.makeFgColor("#ff6600");
     */
    makeFgColor(r: number | string, g?: number, b?: number): string;

    /**
     * Create a custom background color from RGB values or hex string.
     * @example
     * const bgOrange = jsh.makeBgColor(255, 165, 0);
     */
    makeBgColor(r: number | string, g?: number, b?: number): string;

    /**
     * Create a custom underline color from RGB values or hex string.
     * @example
     * const ulRed = jsh.makeUlColor(255, 0, 0);
     */
    makeUlColor(r: number | string, g?: number, b?: number): string;

    /**
     * Tagged template for styled strings. Auto-appends reset at the end.
     * @example
     * const { bold, green } = jsh.colors;
     * const line = jsh.style`${bold}${green}hello world`;
     * // → "\x1b[1m\x1b[32mhello world\x1b[0m"
     */
    style(strings: TemplateStringsArray, ...values: unknown[]): string;

    // ---- Aliases ----

    alias(name: string, expansion: string): void;
    unalias(name: string): void;

    // ---- Command execution ----

    /**
     * Run a shell command. Returns an ExecHandle: awaitable or async-iterable.
     * @example
     * const { stdout, ok } = await jsh.exec('git rev-parse HEAD');
     * for await (const line of jsh.exec('tail -f log')) { ... }
     */
    exec(cmd: string, options?: ExecOptions): ExecHandle;

    // ---- Functions ----

    /** Register a JS function as an @ pipeline function. */
    registerJsFunction(name: string, fn: JsPipelineFunction): void;

    // ---- Completion ----

    /**
     * Register a tab completion handler for a command.
     * @example
     * jsh.complete('git', (ctx) => {
     *     if (ctx.words.length === 2)
     *         return ['add','commit','push','pull','status'].filter(s => s.startsWith(ctx.current));
     *     return [];
     * });
     */
    complete(cmd: string, fn: (ctx: CompletionCtx) => string[]): void;
};
