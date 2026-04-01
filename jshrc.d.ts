/**
 * jsh global API — available in ~/.jshrc without any imports.
 *
 * @example
 * // ~/.jshrc
 * jsh.$.EDITOR = 'nvim';
 * jsh.alias('ll', 'ls -la');
 * jsh.setPrompt(async () => {
 *     const branch = await jsh.exec('git branch --show-current');
 *     const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
 *     return `${cwd} ${branch.ok ? branch.stdout : ''} $ `;
 * });
 *
 * // Exported functions are auto-registered as @name pipeline functions.
 * export async function* upper(args: string[], stdin: AsyncIterable<string>) {
 *     for await (const line of stdin) yield line.toUpperCase();
 * }
 */

/**
 * Calling convention for @ pipeline functions.
 *
 * Streaming (default): receives lines one at a time via stdin iterable.
 * Buffered (@!name):   receives the full stdin as a single string.
 *
 * Return types handled by the executor:
 *   string | Buffer             → written to stdout
 *   AsyncGenerator<string>      → each yielded value written to stdout
 *   Generator<string>           → same
 *   Promise<...>                → awaited, then above rules applied
 *   { exitCode: number }        → exits with the given code
 *   void / undefined            → nothing written, exit 0
 *   throw / reject              → exit 1, error message to stderr
 */
type JsPipelineFunction = (
    args: string[],
    stdin: AsyncIterable<string> | string | null
) => unknown;

/**
 * Shell variable store. Reading or writing any property accesses the
 * shell's variable namespace, which is also used for environment
 * variables after `export`.
 *
 * @example
 * jsh.$.PATH = `/usr/local/bin:${jsh.$.PATH}`;
 * jsh.$.MY_VAR = 'hello';
 */
declare const $: Record<string, unknown>;

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    ok: boolean;
}

interface ExecOptions {
    /** Feed data to the command's stdin. */
    stdin?: string | AsyncIterable<string>;
    /**
     * What to do with stderr:
     *   "inherit" (default) — stderr goes to the shell's stderr
     *   "pipe"              — capture stderr separately (available in ExecResult.stderr)
     *   "merge"             — merge stderr into stdout (2>&1)
     */
    stderr?: "inherit" | "pipe" | "merge";
}

/**
 * Returned by jsh.exec(). Usable as both a Promise and an AsyncIterable.
 *
 * @example
 * // Await for buffered result:
 * const { stdout, exitCode } = await jsh.exec('git log --oneline -5');
 *
 * // Iterate for streaming:
 * for await (const line of jsh.exec('tail -f /var/log/syslog')) {
 *     if (line.includes('ERROR')) yield line;
 * }
 */
interface ExecHandle extends PromiseLike<ExecResult>, AsyncIterable<string> {}

/** Completion context passed to completion handlers. */
interface CompletionCtx {
    /** All words on the current line, split by whitespace. */
    words: string[];
    /** The word currently being completed. */
    current: string;
}

/**
 * Color specification for theme colors.
 *
 * Supported formats:
 *   [r, g, b]     — RGB tuple (0-255 each), renders as true color
 *   "#rrggbb"     — hex color, renders as true color
 *   "bold green"  — named color with optional modifiers (bold, italic, underline)
 *
 * Named colors: black, red, green, yellow, blue, magenta, cyan, white.
 */
type Color = [number, number, number] | `#${string}` | string;

/**
 * Syntax highlighting theme.
 *
 * All fields are optional — unset fields use the default theme colors.
 *
 * @example
 * jsh.setTheme({
 *     command:         [130, 224, 170],  // green
 *     commandNotFound: [255, 85, 85],    // red
 *     keyword:         "#ffcb6b",
 *     string:          "green",
 *     variable:        "bold cyan",
 * });
 */
interface Theme {
    /** Valid command (builtin, PATH executable, alias, function). Default: green. */
    command?: Color;
    /** Invalid/not-found command. Default: red with curly underline. */
    commandNotFound?: Color;
    /** Shell keywords (if, then, fi, for, while, do, done, case, esac). Default: yellow. */
    keyword?: Color;
    /** Operators (|, &&, ||, ;, &, !). Default: purple. */
    operator?: Color;
    /** Redirections (>, >>, <, <<, etc.). Default: purple. */
    redirect?: Color;
    /** Quoted strings (single and double). Default: light green. */
    string?: Color;
    /** Variable expansions ($VAR, ${VAR}). Default: cyan. */
    variable?: Color;
    /** Comments (# ...). Default: grey. */
    comment?: Color;
    /** Regular arguments (non-command words). Default: uncolored. */
    argument?: Color;
    /** Parentheses and braces ((), {}). Default: yellow. */
    paren?: Color;
    /** Inline JS blocks (@{ }, @!{ }). Default: yellow. */
    jsInline?: Color;
}

declare const jsh: {
    /** Shell variable store — same object as the bare `$` in shell. */
    $: typeof $;

    /**
     * Define or redefine the interactive prompt.
     * The function is called before each new input line.
     * Supports async functions for dynamic content (e.g., git branch).
     *
     * @example
     * jsh.setPrompt(() => `${jsh.$.PWD} $ `);
     *
     * // Async prompt with git branch:
     * jsh.setPrompt(async () => {
     *     const branch = await jsh.exec('git branch --show-current');
     *     return `${branch.ok ? branch.stdout + ' ' : ''}$ `;
     * });
     */
    setPrompt(fn: () => string | Promise<string>): void;

    /**
     * Define a right-aligned prompt.
     * Rendered on the right edge of the terminal, disappears if the
     * input line would overlap it. Supports async functions.
     *
     * @example
     * jsh.setRightPrompt(() => new Date().toLocaleTimeString());
     *
     * jsh.setRightPrompt(async () => {
     *     const branch = await jsh.exec('git branch --show-current');
     *     return branch.ok ? branch.stdout : '';
     * });
     */
    setRightPrompt(fn: (() => string | Promise<string>) | null): void;

    /**
     * Set the syntax highlighting theme.
     * Merges with the default theme — only provided fields are overridden.
     *
     * @example
     * jsh.setTheme({
     *     keyword: [255, 203, 107],
     *     string:  "#c3e88d",
     *     command: "bold green",
     * });
     */
    setTheme(theme: Partial<Theme>): void;

    /**
     * Override the syntax highlighting function entirely.
     * The function receives the raw input line and must return an
     * ANSI-colored string. Set to null to restore the default colorizer.
     *
     * @example
     * jsh.setColorize((input) => `\x1b[31m${input}\x1b[0m`);  // all red
     * jsh.setColorize(null);  // restore default
     */
    setColorize(fn: ((input: string) => string) | null): void;

    /**
     * Define a shell alias. When `name` is used as a command, it is
     * replaced with `expansion` before execution.
     *
     * @example
     * jsh.alias('ll', 'ls -la');
     * jsh.alias('gs', 'git status');
     */
    alias(name: string, expansion: string): void;

    /** Remove a previously defined alias. */
    unalias(name: string): void;

    /**
     * Run a shell command string and return an ExecHandle that is both
     * awaitable (buffered result) and async-iterable (streaming lines).
     *
     * @example
     * // Buffered
     * const { stdout, ok } = await jsh.exec('git rev-parse HEAD');
     *
     * // Streaming inside a @function
     * export async function* errors(args, stdin) {
     *     for await (const line of jsh.exec('journalctl -n 100')) {
     *         if (line.includes('ERROR')) yield line;
     *     }
     * }
     *
     * // With options
     * const r = await jsh.exec('grep pattern', {
     *     stdin: 'line one\nline two\n',
     *     stderr: 'pipe',
     * });
     */
    exec(cmd: string, options?: ExecOptions): ExecHandle;

    /**
     * Register a JavaScript function as an @ pipeline function.
     * After registration, `@name` can be used in pipelines.
     *
     * Alternatively, simply export the function from .jshrc — exported
     * functions are auto-registered under their export name.
     *
     * @example
     * jsh.registerJsFunction('filter', async function*(args, stdin) {
     *     const pattern = new RegExp(args[0] ?? '');
     *     for await (const line of stdin) {
     *         if (pattern.test(line)) yield line;
     *     }
     * });
     */
    registerJsFunction(name: string, fn: JsPipelineFunction): void;

    /**
     * Register a tab completion handler for a specific command.
     * The handler is called when the user presses Tab after typing the
     * command name. Must return an array of completion strings synchronously.
     *
     * @example
     * jsh.complete('git', (ctx) => {
     *     if (ctx.words.length === 2) {
     *         return ['add', 'commit', 'push', 'pull', 'status', 'log']
     *             .filter(s => s.startsWith(ctx.current));
     *     }
     *     return [];
     * });
     */
    complete(cmd: string, fn: (ctx: CompletionCtx) => string[]): void;
};
