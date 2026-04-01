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
 * jsh.setPrompt(async () => {
 *     const branch = await jsh.exec('git branch --show-current');
 *     const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
 *     return jsh.style`${green}${bold}${cwd} ${cyan}${branch.ok ? branch.stdout : ''}${reset}$ `;
 * });
 *
 * jsh.addWidget("clock", "footer", () => {
 *     return jsh.style`${orange}${new Date().toLocaleTimeString()}`;
 * }, 0, 1000);
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

// ---- Shell variables --------------------------------------------------------

declare const $: Record<string, unknown>;

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
    $: typeof $;

    // ---- Prompt ----

    /**
     * Set the interactive prompt. Supports async (e.g., for git branch).
     * @example
     * jsh.setPrompt(() => `$ `);
     * jsh.setPrompt(async () => {
     *     const b = await jsh.exec('git branch --show-current');
     *     return `${b.ok ? b.stdout + ' ' : ''}$ `;
     * });
     */
    setPrompt(fn: () => string | Promise<string>): void;

    /**
     * Set a right-aligned prompt. Supports async.
     * Disappears if the input line would overlap it.
     * @example
     * jsh.setRightPrompt(() => new Date().toLocaleTimeString());
     */
    setRightPrompt(fn: (() => string | Promise<string>) | null): void;

    // ---- Syntax highlighting ----

    /** Set the syntax highlighting theme (merges with defaults). */
    setTheme(theme: Partial<Theme>): void;

    /** Override syntax highlighting entirely. Null restores the default. */
    setColorize(fn: ((input: string) => string) | null): void;

    // ---- Layout regions ----

    /**
     * Set header content (lines rendered above the input line).
     * @example
     * jsh.setHeader(() => ["  git: main ●3 ↑1"]);
     */
    setHeader(fn: (() => string[] | Promise<string[]>) | null): void;

    /**
     * Set footer content (lines rendered below the input line).
     * @example
     * jsh.setFooter(() => ["  12:34 PM"]);
     */
    setFooter(fn: (() => string[] | Promise<string[]>) | null): void;

    // ---- Widgets ----

    /**
     * Register a widget that renders content in a header or footer zone.
     * Widgets with an interval auto-refresh while the user is typing.
     *
     * @param id      Unique identifier (used for removeWidget)
     * @param zone    "header" or "footer"
     * @param render  Function returning a line or lines (may be async)
     * @param order   Sort order within the zone (default 0)
     * @param interval Auto-refresh interval in ms (omit for static)
     *
     * @example
     * jsh.addWidget("clock", "footer", () => {
     *     return jsh.style`${jsh.colors.dim}${new Date().toLocaleTimeString()}`;
     * }, 0, 1000);
     *
     * jsh.addWidget("git", "header", async () => {
     *     const b = await jsh.exec("git branch --show-current");
     *     return b.ok ? jsh.style`${jsh.colors.cyan}${b.stdout}` : "";
     * });
     */
    addWidget(
        id: string,
        zone: "header" | "footer",
        render: () => string | string[] | Promise<string | string[]>,
        order?: number,
        interval?: number,
    ): void;

    /** Remove a previously registered widget. */
    removeWidget(id: string): void;

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
