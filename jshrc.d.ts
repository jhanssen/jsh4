/**
 * jsh global API — available in ~/.jshrc without any imports.
 *
 * @example
 * // ~/.jshrc
 * jsh.$.EDITOR = 'nvim';
 * jsh.alias('ll', 'ls -la');
 * jsh.setPrompt(() => `${jsh.$.PWD} $ `);
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

declare const jsh: {
    /** Shell variable store — same object as the bare `$` in shell. */
    $: typeof $;

    /**
     * Define or redefine the interactive prompt.
     * The function is called before each new input line.
     *
     * @example
     * jsh.setPrompt(() => {
     *     const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
     *     return `${cwd} $ `;
     * });
     */
    setPrompt(fn: () => string): void;

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
};
