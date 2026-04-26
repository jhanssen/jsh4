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
    args: unknown[],
    stdin: AsyncIterable<string> | AsyncIterable<unknown> | string | null
) => unknown;

interface JsFunctionOptions {
    /**
     * When true, the function is callable only via `@name`. Bare-name
     * resolution skips it, so an alias, shell function, builtin, or PATH
     * command with the same name still wins for unprefixed invocation.
     */
    atOnly?: boolean;
}

/**
 * Schema-driven argument parsing for `@`-functions.
 *
 * When you write a `.ts`/`.mts` jshrc and declare an arg slot with a
 * function type — for example `args: [(row: T) => boolean]` — the schema
 * extractor records that slot as function-typed. The parser consults the
 * registry at parse time and lexes that slot as a JS expression instead
 * of as a shell word, so users can write the unquoted lambda form:
 *
 *     @yourFn r => r.name === "foo"        // unquoted (schema-driven)
 *     @yourFn @{ r => r.name === "foo" }   // explicit form, always works
 *
 * Both produce identical ASTs. The unquoted form is sugar enabled by
 * the slot's declared type. If the schema isn't available (cache miss
 * on first run, or the source is .js with no extractable types), the
 * parser falls back to word-arg mode and users must use `@{ ... }`.
 *
 * Termination of the unquoted JS expression at bracket depth 0:
 *   - `\n`, `;`, `|`, `&`, EOF
 *   - `>>`, `<<` (bare `>` and `<` stay as JS comparisons)
 *   - whitespace-preceded numbered redirections (e.g. ` 2>err.log`)
 *   - `)`, `]`, `}` at depth 0 (outer shell construct boundary)
 *
 * Strings (`'…'`, `"…"`) and template literals (` `…` ` with `${}`)
 * are consumed atomically and respected for bracket tracking.
 */

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
 * - `"header"` — above the input line (line 0 = closest, -1 above, -2 above that...)
 * - `"prompt"` — left side of input line
 * - `"rprompt"` — right side of input line
 * - `"ps2"` — left side of continuation lines
 * - `"footer"` — below the input line (line 0 = closest, 1 below, 2 below that...)
 *
 * Widgets on the same line concatenate. Use `align` to control horizontal position.
 * Multi-line widgets (returning string[]) start at their declared line and grow downward.
 */
type WidgetZone = "header" | "footer" | "prompt" | "rprompt" | "ps2";

/** Horizontal alignment within a line. */
type WidgetAlign = "left" | "right" | "center";

interface WidgetOptions {
    /**
     * Line number within the zone.
     * Header: 0 = closest to input, -1 above that, etc.
     * Footer: 0 = closest to input, 1 below that, etc.
     * Ignored for prompt/rprompt/ps2.
     */
    line?: number;
    /** Horizontal alignment. Default: "left". */
    align?: WidgetAlign;
}

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

// ---- MasterBandit bridge ----------------------------------------------------

interface MbPopupHandle {
    readonly id: string;
    /** Write data to the popup's terminal (ANSI accepted). */
    write(data: string): void;
    /** Close the popup. */
    close(): void;
    /** Register a callback fired when the popup is closed (by us or by the user). */
    onClose(fn: () => void): void;
}

interface MbCommandRecord {
    id: number;
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
    startMs: number;
    endMs: number;
}

interface MbApi {
    /** Create a popup on the shell's pane. Resolves once MB confirms creation. */
    createPopup(opts: { x: number; y: number; w: number; h: number }): Promise<MbPopupHandle>;
    /**
     * Fetch the currently-highlighted OSC 133 command on this pane (set by
     * click, keyboard nav, or `selectCommand`). Resolves with `null` when
     * nothing is selected. Requires the mb-applet to have been loaded with
     * the `shell.commands` permission.
     */
    getSelectedCommand(): Promise<MbCommandRecord | null>;
    /**
     * Set (or clear with `null`) the OSC 133 command selection highlight on
     * this pane. Unknown ids are silently treated as `null`. Fire-and-forget;
     * no-op while the WS is not connected.
     */
    selectCommand(id: number | null): void;
    /**
     * Fetch the Nth most recently completed OSC 133 command on this pane.
     * `index` 0 is the most recent, 1 the previous, and so on. Resolves with
     * `null` if `index` is out of range. Requires the mb-applet to have been
     * loaded with the `shell.commands` permission.
     */
    getCommand(index: number): Promise<MbCommandRecord | null>;
    /**
     * Number of completed commands currently retained in the pane's bounded
     * ring (the upper bound for `getCommand`). Requires `shell.commands`.
     */
    numCommands(): Promise<number>;
    /** True while the WS connection to the applet is live. */
    readonly connected: boolean;
    /**
     * Subscribe to connection state changes. Fires whenever `connected` flips,
     * with the new value. Use this to refresh prompt/status widgets on drop or
     * reconnect without polling.
     */
    addEventListener(event: "stateChanged", fn: (connected: boolean) => void): void;
    removeEventListener(event: "stateChanged", fn: (connected: boolean) => void): void;
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

    /**
     * MasterBandit bridge. `null` if jsh is not running under MasterBandit or
     * the mb-applet isn't loaded. Present → connection to the applet is live.
     */
    mb: MbApi | null;

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
     * Widgets on the same line concatenate. Use `align` for horizontal positioning.
     * Multi-line widgets (returning string[]) start at their declared line and grow downward.
     *
     * @param id      Unique identifier
     * @param zone    Where to render: "header", "footer", "prompt", "rprompt", "ps2"
     * @param render  Function returning content (may be async)
     * @param opts    Options: { line?, align? } or just a line number
     *
     * @example
     * // Prompt
     * jsh.addWidget("ps1", "prompt", async () => {
     *     const b = await jsh.exec("git branch --show-current");
     *     return `${b.ok ? b.stdout + " " : ""}$ `;
     * });
     *
     * // Header: git left, clock right, same line
     * jsh.addWidget("git", "header", () => `  ${branch}`);
     * jsh.addWidget("clock", "header", () => `${time}  `, { align: "right" });
     *
     * // Footer with live clock
     * const clock = jsh.addWidget("clock", "footer", () => {
     *     return jsh.style`${jsh.colors.dim}${new Date().toLocaleTimeString()}`;
     * });
     * setInterval(() => clock.update(), 1000);
     *
     * // Multi-line footer starting at line 1 (below line 0)
     * jsh.addWidget("menu", "footer", () => ["option 1", "option 2"], { line: 1 });
     */
    addWidget(
        id: string,
        zone: WidgetZone,
        render: () => string | string[] | Promise<string | string[]>,
        opts?: WidgetOptions | number,
    ): WidgetHandle;

    /** Remove a previously registered widget by id. */
    removeWidget(id: string): void;

    // ---- Suggestions ----

    /**
     * Set a fish-style suggestion function. Called when the user types. The
     * function receives the current input buffer and returns the full suggested
     * command (or null for no suggestion). May return sync or Promise. Ghost
     * text appears dimmed after the cursor. Right arrow at end-of-line accepts.
     *
     * Stale suggestions are automatically discarded if the user types more
     * before the promise resolves.
     *
     * @example
     * jsh.setSuggestion((input) => {
     *     const hist = jsh.history();
     *     for (let i = hist.length - 1; i >= 0; i--) {
     *         if (hist[i].startsWith(input) && hist[i] !== input) return hist[i];
     *     }
     *     return null;
     * });
     */
    setSuggestion(fn: ((input: string) => string | null | Promise<string | null>) | null): void;

    // ---- History ----

    /** Return a snapshot of the in-memory command history (oldest first). */
    history(): string[];

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

    // ---- Terminal info ----

    /** Current terminal width in columns. */
    readonly columns: number;

    // ---- Input buffer ----

    /**
     * Replace the entire input buffer and move cursor to end.
     * Only works during an active editing session.
     * @example
     * jsh.setInput("git commit -m 'fix bug'");
     */
    setInput(text: string): void;

    /**
     * Insert text at the current cursor position.
     * Only works during an active editing session.
     * @example
     * jsh.insertAtCursor(" --force");
     */
    insertAtCursor(text: string): void;

    /**
     * Set the punctuation characters that count as word-interior for
     * Alt-B / Alt-F / Alt-D / Alt-Backspace / Ctrl-W. Mirrors zsh's
     * WORDCHARS parameter. Letters and digits are always word chars; only
     * pass the *additional* punctuation you want included. Non-ASCII bytes
     * are always treated as word chars.
     *
     * Default is zsh's default: *?_-.[]~=/&;!#$%^(){}<>
     *
     * @example
     * // Tighter word boundaries — only letters, digits, underscore count.
     * jsh.setWordChars("_");
     */
    setWordChars(chars: string): void;

    /**
     * Completion-on-Tab behavior.
     *  - `"cycle"` (default): repeated Tab inserts each candidate in turn.
     *  - `"menu"`: zsh-style — first Tab shows a grid of matches below the
     *    input; second Tab enters navigation mode (Tab / arrow keys move the
     *    selection, Enter accepts, Esc cancels).
     */
    setCompletionStyle(style: "cycle" | "menu"): void;

    /**
     * Colorize file entries in the menu-complete grid via a GNU-format
     * LS_COLORS string (colon-separated `key=SGR` rules, same as GNU `ls`).
     * Recognized keys: `di` (dir), `ex` (exec), `ln` (link), `fi` (file),
     * and `*.ext` extension rules. Pass "" to clear.
     *
     * Typical usage (forward your shell's LS_COLORS, same as zsh's
     * `zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"`):
     *
     * @example
     * jsh.setListColors(process.env.LS_COLORS ?? "");
     */
    setListColors(value: string): void;

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
    registerJsFunction(name: string, fn: JsPipelineFunction, opts?: JsFunctionOptions): void;

    // ---- Completion ----

    /**
     * Register a tab completion handler for a command.
     * Can return results synchronously or as a promise (async completions
     * freeze the input briefly until results arrive).
     *
     * @example
     * // Sync completions
     * jsh.complete('git', (ctx) => {
     *     if (ctx.words.length === 2)
     *         return ['add','commit','push','pull','status'].filter(s => s.startsWith(ctx.current));
     *     return [];
     * });
     *
     * // Async completions (e.g., parsing --help output)
     * jsh.complete('docker', async (ctx) => {
     *     const { stdout } = await jsh.exec('docker --help 2>&1');
     *     const cmds = stdout.match(/^\s+(\w+)/gm)?.map(s => s.trim()) ?? [];
     *     return cmds.filter(c => c.startsWith(ctx.current));
     * });
     */
    complete(cmd: string, fn: (ctx: CompletionCtx) => string[] | Promise<string[]>): void;

    // ---- IO ----

    /**
     * Stream-shaped handles tied to the *current* IO context. Outside any
     * pipeline (jshrc top-level, widget callbacks, timers), they target the
     * terminal. Inside an `@`-pipeline stage, they target the stage's pipe.
     * Code can use them uniformly without checking which context it's in.
     *
     * Concurrent writes to the same fd are serialized by a per-fd queue, so
     * order is preserved even across independent callers.
     *
     * Note on `console.*`: jsh patches `console.log` / `info` / `debug` to
     * route through `jsh.stdout` and `console.error` / `warn` through
     * `jsh.stderr`. Use console for ergonomic logging; use these handles
     * directly when you need `await`, binary output, or stream piping.
     *
     * @example
     * // Inside an @-function
     * export async function* tee(args, stdin) {
     *     for await (const line of stdin) {
     *         await jsh.stderr.write(`[${args[0]}] ${line}\n`);
     *         yield line + "\n";
     *     }
     * }
     *
     * // Read stdin without an explicit param (e.g., in a buffered helper)
     * for await (const line of jsh.stdin) { ... }
     */
    readonly stdin: {
        readonly fd: number;
        read(n: number): Promise<string>;
        [Symbol.asyncIterator](): AsyncIterator<string>;
    };
    readonly stdout: {
        readonly fd: number;
        write(data: string | Buffer | Uint8Array): Promise<void>;
    };
    readonly stderr: {
        readonly fd: number;
        write(data: string | Buffer | Uint8Array): Promise<void>;
    };
};
