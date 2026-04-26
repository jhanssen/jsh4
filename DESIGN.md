# jsh — A JavaScript Shell

A POSIX-compatible interactive shell with JavaScript as the extension language.

## Goals

- Bourne-compatible syntax (POSIX sh base, selective bash/zsh extensions)
- JS as the scripting and configuration language (replaces `.zshrc`/`.bashrc` with `.jshrc`)
- JS functions callable inline in pipelines via `@` syntax
- Job control (ctrl-z, bg, fg, &)
- Quality line editing with programmable completion
- In-process: shell logic runs in the Node.js process, child commands fork/exec as usual

## Non-Goals

- Full zsh/bash compatibility (no attempt to run arbitrary `.zshrc`/`.bashrc`)
- POSIX sh certification
- Windows support (initially)

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Node.js                     │
│                                              │
│  .jshrc (JS)    timers    @js functions      │
│       │            │            │            │
│       ▼            ▼            ▼            │
│  ┌──────────── event loop ───────────────┐  │
│  │                                       │  │
│  │  REPL ◄──► Parser ──► Executor ──►┐  │  │
│  │   ▲                               │  │  │
│  │   │         ┌─────────────────┐   │  │  │
│  │   │         │  Executor thread│   │  │  │
│  │   │         │  fork/exec      │   │  │  │
│  │   └─────────│  waitpid        │◄──┘  │  │
│  │             └─────────────────┘       │  │
│  └───────────────────────────────────────┘  │
│                                              │
│  InputEngine (raw termios, uv_poll on stdin) │
└──────────────────────────────────────────────┘
```

### Components

**1. Parser (TypeScript)**

Recursive descent parser for POSIX shell grammar with extensions. Produces a clean AST.

Supported syntax:
- Simple commands with assignments and arguments
- Pipelines (`|`, `|&`)
- Redirections (`>`, `>>`, `<`, `>&`, `<&`, `&>`, `&>>`)
- Here-docs (`<<`, `<<-`) and here-strings (`<<<`)
- Quoting (single, double, backslash, `$'...'`)
- Variable expansion (`$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR%%pattern}`, `${ARR[n]}`, etc.)
- Command substitution (`$(...)`, backticks)
- Arithmetic expansion (`$((...))`) with `++`/`--`, `+=`/`-=`/`*=`/`/=`/`%=`, `=`
- Globbing (`*`, `?`, `[...]`, `**` recursive)
- Brace expansion (`{a,b,c}`, `{1..5}`, `{a..z}`, nested)
- Control flow: `for`/`do`/`done`, `while`/`until`, `if`/`then`/`elif`/`else`/`fi`, `case`/`esac`
- Subshells `(...)`, brace groups `{ ...; }`
- Functions: `name() { ...; }`
- Logical operators: `&&`, `||`
- Background: `&`
- `@` syntax for JS interop (first-class, not preprocessed)
- Multi-line input detection via `IncompleteInputError`

**2. Executor (TypeScript + C++ via N-API)**

TypeScript layer walks the AST, expands words, and dispatches to either:
- **Native executor thread** (C++): fork/exec for external commands, waitpid, pipe management
- **In-process execution**: builtins, shell functions, JS `@` functions

The native `spawnPipeline` and `captureOutput` functions handle pure-external pipelines. Mixed pipelines (containing JS function stages) use `forkExec` + `waitForPids` with the JS stages running on the main thread.

**3. Expander (TypeScript)**

Handles word expansion before command execution:
1. Tilde expansion (`~` → home dir)
2. Parameter expansion (`$VAR`, `${VAR:-default}`, `${ARR[n]}`, etc.)
3. Command substitution (`$(...)` → fork + pipe capture, supports arbitrary ASTs)
4. Arithmetic expansion (`$((...))` → JS `Function()` eval, with `++`/`--`/`+=`/etc.)
5. Brace expansion (`{a,b,c}`, `{1..5}`, `{a..z}`, nested)
6. IFS word splitting (fragment-based: unquoted `$VAR`/`$()` are split; quoted forms preserved; `"$@"` produces separate words)
7. Glob/pathname expansion (via Node.js `fs.glob`)
8. Quote removal

Returns `string[]` per word to support brace, glob, and IFS expansion producing multiple results.

**4. Terminal UI (Custom InputEngine + TS Renderer)**

A custom C++ input engine (`src/native/input-engine.cc`) handles raw terminal I/O, keystroke reading, buffer editing, and history. A TypeScript rendering layer (`src/terminal/`) owns the screen layout, widget system, and synchronized rendering.

Architecture:
- **C++ InputEngine**: raw mode (termios), non-blocking keystroke reading via `uv_poll_t`, input buffer editing, multi-line cursor navigation (Up/Down between lines, line-aware Home/End), history navigation (falls through to history at first/last line), completion dispatch. Calls a TS `onRender` callback after each buffer mutation.
- **TS Renderer**: assembles frames from header widgets + frozen lines + input lines + footer widgets. Writes the full frame as one synchronized batch (`CSI ?2026 h/l`). Handles cursor positioning across regions and multi-line input.
- **Widget System**: unified zone-based system — prompt, rprompt, PS2, header, and footer are all widgets. `addWidget` returns a handle with `update()` and `remove()`. Widgets in the same zone concatenate; multi-element arrays add line breaks. Intervals are userland (`setInterval` + `handle.update()`).

`inputRenderLine()` in C++ is a pure function: takes prompt, colorized text, raw buffer, and cursor position as arguments. Computes horizontal scroll, cursor math, ANSI-aware width. Called once per line for multi-line buffers.

Features:
- Syntax highlighting via colorize callback (lexer-based, true color RGB)
- Multi-line syntax highlighting — context from previous lines passed to colorizer
- Command-exists detection (green for valid, red+curly underline for invalid)
- Multi-line editing — history recall of multi-line entries, cursor navigation between lines
- Frozen lines — PS1 + previous PS2 lines stay visible during continuation
- Flicker-free continuation — renderer overwrites old frame in place
- Multi-line history persistence — entries with `\n` saved with `\` continuation markers
- OSC 133 shell integration marks (prompt/command/output boundaries)
- OSC 7 working directory reporting
- Color helpers (`jsh.colors`, `jsh.makeFgColor()`, `jsh.style` tagged template)

**5. JS Runtime / .jshrc**

The rc file is an ES module loaded at startup via dynamic `import()`. Exported functions are automatically registered as `@` pipeline functions. The `jsh` global object provides the shell API.

Lookup order (first match wins):
1. `jsh --jshrc /path/to/file` — explicit override
2. `~/.jshrc.ts` — Node 22.7+ with `--experimental-strip-types`, unflagged on 23.6+/24
3. `~/.jshrc.js`
4. `~/.jshrc`

Bare imports from the rc file resolve first via Node's default walk-up from the rc file's directory, then fall back to `$XDG_DATA_HOME/jsh/node_modules/` (default `~/.local/share/jsh/node_modules/`). This lets users install rc dependencies in an XDG data dir without polluting `~/node_modules`.

```js
// ~/.jshrc
const { bold, green, cyan, yellow, red, reset } = jsh.colors;
const orange = jsh.makeFgColor(255, 165, 0);

// Environment
jsh.$.PATH = `/usr/local/bin:${jsh.$.PATH}`;
jsh.$.EDITOR = 'nvim';

// Aliases
jsh.alias('ll', 'ls -la');
jsh.alias('gs', 'git status');

// Prompt — a widget in the "prompt" zone, re-evaluated each new line
jsh.addWidget("ps1", "prompt", async () => {
    const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
    const branch = await jsh.exec('git branch --show-current 2>/dev/null');
    return jsh.style`${bold}${yellow}${cwd} ${cyan}${branch.ok ? branch.stdout : ''}${reset}$ `;
});

// Continuation prompt
jsh.addWidget("ps2", "ps2", () => "> ");

// Theme
jsh.setTheme({
    command:         [130, 224, 170],
    commandNotFound: [255, 85, 85],
    keyword:         [255, 203, 107],
    string:          [195, 232, 141],
    variable:        [137, 221, 255],
});

// Header — git info + clock, concatenated on one line
jsh.addWidget("git", "header", async () => {
    const branch = await jsh.exec('git branch --show-current 2>/dev/null');
    return branch.ok ? jsh.style`  ${cyan}${branch.stdout}` : '';
});

const clock = jsh.addWidget("clock", "header", () => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    return jsh.style`  ${orange}${time}`;
}, 10);
setInterval(() => clock.update(), 1000);

// Footer
const footerClock = jsh.addWidget("footer-clock", "footer", () => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    return jsh.style`  ${orange}${time}`;
});
setInterval(() => footerClock.update(), 1000);

// Custom pipeline functions (auto-registered from exports)
export async function* filter(args, stdin) {
    const pattern = new RegExp(args[0] ?? '.');
    for await (const line of stdin) {
        if (pattern.test(line)) yield line;
    }
}

// Completions
jsh.complete('git', (ctx) => {
    if (ctx.words.length === 2) {
        return ['add', 'commit', 'push', 'pull', 'status', 'log', 'diff']
            .filter(s => s.startsWith(ctx.current));
    }
    return [];
});
```

---

## Execution Model

### Foreground Commands

```
user types: cat /tmp/foo | grep bar
  → parser produces Pipeline AST
  → executor (TS):
      1. builds stage array [{cmd:"cat", args:["/tmp/foo"]}, {cmd:"grep", args:["bar"]}]
      2. calls native spawnPipeline(stages, ["|"])
  → native executor thread:
      1. pipe() → [read_fd, write_fd]
      2. fork() child1: dup2(write_fd→stdout), exec("cat", "/tmp/foo")
      3. fork() child2: dup2(read_fd→stdin), exec("grep", "bar")
      4. set child process group as foreground (tcsetpgrp)
      5. waitpid() for all children
      6. return exit status to main thread via TSFN
  → main thread: resolve Promise, update $?
```

### JS Functions in Pipelines

```
user types: cat /tmp/data | @filter error | head -20
  → Pipeline with 3 stages: SimpleCommand + JsFunction + SimpleCommand
  → executeMixedPipeline:
      1. createCloexecPipe() × 2 (cat→filter, filter→head)
      2. forkExec("cat", ..., stdinFd=0, stdoutFd=pipe0[1]) → pid_cat
      3. forkExec("head", ..., stdinFd=pipe1[0], stdoutFd=1) → pid_head
      4. executeJsStageRaw(filter, pipe0[0], pipe1[1])
         — fdLineReader reads from pipe0[0]
         — generator yields lines to pipe1[1]
         — finally: out.end() closes pipe1[1] → head sees EOF
      5. waitForPids([pid_cat, pid_head]) → executor thread waitpid
```

### Command Substitution

```
user types: echo $(git rev-parse HEAD)
  → expander hits CommandSubstitution node
  → captureAst("git rev-parse HEAD"):
      1. native captureOutput([{cmd:"git", args:["rev-parse","HEAD"]}], [])
      2. creates capture pipe, forks git with stdout→capture pipe
      3. reads capture pipe in executor thread until EOF
      4. returns captured string → "$(...)" substituted
```

### jsh.exec()

```js
const result = await jsh.exec('grep pattern', { stdin: 'some text\n', stderr: 'pipe' });
// result.stdout: string (trimmed)
// result.stderr: string
// result.exitCode: number
// result.ok: boolean

// OR iterate for streaming:
for await (const line of jsh.exec('tail -f /var/log/syslog')) {
    if (line.includes('ERROR')) console.log(line);
}
```

`ExecHandle` implements both `PromiseLike<ExecResult>` and `AsyncIterable<string>`. The process is started immediately on construction; both paths share the same line queue.

Options:
- `stdin`: `string | AsyncIterable<string>` — feed data to the command's stdin
- `stderr`: `"inherit"` (default) | `"pipe"` | `"merge"` — stderr handling

---

## Threading Model

```
Main thread (Node event loop):
  - JS execution (.jshrc, @functions, completions, timers)
  - TypeScript executor (AST walking, expansion, builtin dispatch)
  - Custom InputEngine (native, non-blocking via uv_poll on stdin fd)
  - Promise resolution callbacks from executor thread (via TSFN)

Executor thread (C++):
  - fork/exec for external commands
  - waitpid (blocks for foreground jobs)
  - pipe management for capture and mixed pipelines
  - Posts results back to main thread via napi_threadsafe_function

Signals:
  - SIGTTOU, SIGTTIN: ignored (SIG_IGN) — standard for interactive shells
  - SIGCHLD, SIGINT: blocked on main thread so Node doesn't handle them
  - Children reset all signals to SIG_DFL before exec
```

---

## Builtins

Builtins execute in-process (no fork):

| Builtin | Status | Purpose |
|---------|--------|---------|
| `cd` | ✅ | Change directory, updates `$PWD` |
| `exit` | ✅ | Exit shell |
| `export` | ✅ | Mark variable for child env |
| `unset` | ✅ | Remove variable |
| `echo` | ✅ | Output with `-n`, `-e`, `-E` flags |
| `true` / `false` | ✅ | Exit status |
| `alias` / `unalias` | ✅ | Define/remove aliases |
| `test` / `[` | ✅ | Conditional expressions (string, integer, file tests, logical ops) |
| `source` / `.` | ✅ | Execute file in current shell context |
| `read` | ✅ | Read line with `-r`, `-p`, `-s`, `-n`, `-d`, `-a` flags |
| `set` | ✅ | Shell options: `-e`, `-u`, `-x`, `-o pipefail` |
| `local` | ✅ | Function-scoped variables with save/restore |
| `shift` | ✅ | Shift positional parameters |
| `exec` | ✅ | Replace shell with command (native `execvp`) |
| `type` / `which` | ✅ | Command lookup (alias, builtin, function, PATH) |
| `[[ ]]` | ✅ | Extended conditional (`=~` regex, `==`/`!=` glob, `<`/`>`, `&&`/`||`) |
| `jobs` | ✅ | List background/stopped jobs |
| `fg` | ✅ | Resume job in foreground |
| `bg` | ✅ | Resume stopped job in background |
| `wait` | ✅ | Wait for background jobs |
| `eval` | ✅ | Parse and execute string |
| `printf` | ✅ | Formatted output (`%s`, `%d`, `%x`, `%b`, `%q`, etc.) |
| `trap` | ✅ | Signal/pseudo-signal trapping (EXIT, INT, TERM, etc.) |
| `return` | ✅ | Exit from shell function with code |
| `command` | ✅ | `-v` check existence, bypass functions/aliases |
| `readonly` | ✅ | Mark variables as read-only |
| `getopts` | ✅ | POSIX option parsing |
| `break` / `continue` | ✅ | Loop flow control with optional N levels |
| `pushd` / `popd` / `dirs` | ✅ | Directory stack |
| `basename` / `dirname` | ✅ | Path manipulation |
| `select` | ✅ | Interactive menu loop |
| `kill` | ✅ | Send signals to processes/jobs (`-l` to list, `-SIGNAL`, `%jobspec`) |
| `disown` | ✅ | Remove jobs from table (`-a` all, `-r` running) |
| `hash` | ✅ | Command hash table for PATH caching (`-r` to clear) |
| `let` | ✅ | Arithmetic evaluation (`let x=5+3`, `let x++`) |
| `declare` | ✅ | Variable declarations (`-a` array, `-x` export, `-r` readonly) |
| `time` | ✅ | Measure command execution time |
| `:` | ✅ | No-op command (POSIX colon) |

---

## `@` Syntax

### What `@` means

`@` introduces a JS function in a position where a shell command would normally go. It is part of the grammar — the parser produces a `JsFunction` AST node.

### Forms

```sh
# Named function call — calls filter() registered via .jshrc or registerJsFunction
cat data.json | @filter item.active | head

# Inline expression — evaluated as a JS arrow function or generator
ls -la | @{ async function*(args, stdin) { for await (const l of stdin) if (l.includes('src')) yield l; } }

# Buffered — receives all stdin as a single string
cat data.json | @!{ (args, text) => JSON.stringify(JSON.parse(text), null, 2) }

# Unquoted lambda — when the @-fn declares an arg slot as a function type
@ls | @where f => f.size > 1024
@ls | @where @{ f => f.size > 1024 }    # equivalent
```

### Calling convention

- `args`: `unknown[]` — mixed array. Word args arrive as strings; `@{...}` and unquoted-lambda args arrive as their evaluated JS values.
- `stdin`: `AsyncIterable<string>` (streaming bytes) or `AsyncIterable<unknown>` (object mode) or `string` (buffered `@!`) or `null` (standalone)
- Lines yielded/returned are written to stdout (byte mode) or piped as objects (object mode)

### Schema-driven unquoted lambdas

When an `@`-function declares an arg slot with a function type in its
TypeScript signature — e.g. `args: [(row: T) => boolean]` — the schema
extractor records that slot as `FunctionIR` and the parser consults the
registry at parse time. If the upcoming arg slot is function-typed, the
lexer switches to JS-expression mode for that arg only, so users can
write `@where f => f.x > 10` without the explicit `@{...}` wrapper.

This is the one place in the parser where parsing is context-dependent:
the AST for `@somefn x => y` depends on whether `@somefn` is registered
with a function-typed slot 0. The `@{...}` form always works regardless
and is the safe fallback when schemas aren't yet extracted (e.g. first
run on a `.ts` jshrc before the cache populates).

**Termination rules** (at bracket depth 0, outside string/template state):
- `\n`, `;`, `|`, `&`, EOF
- `>>`, `<<` redirections
- Whitespace-preceded numbered fd redirections (` 2>err`, ` 1<x`)
- `)`, `]`, `}` at depth 0 — closing of an outer shell construct

Bare `>` and `<` do **not** terminate; they stay as JS comparisons inside
the lambda. To stdout-redirect a `@`-fn that takes a lambda, use a numbered
fd (`1>file`) or wrap the lambda in `@{...}`.

The same parser-registry hookup is the foundation for two adjacent
roadmap items: schema-aware tab completion (`@select <Tab>` → upstream
field names) and pipeline construction-time validation (`@select cput`
typo caught before execution).

### Return type dispatch

| Return type | Behavior |
|---|---|
| `string` | Written to stdout |
| `Buffer` / `Uint8Array` | Written to stdout (binary) |
| `{ exitCode: N }` | Exit with code N |
| `AsyncGenerator` | Async iterate, write each yielded value |
| `Generator` | Iterate, write each yielded value |
| `Promise` | Await, then apply above rules |
| `void` / `undefined` | Exit 0, no output |
| `throw` / `reject` | Exit 1, error to stderr |

### Why JS functions are not forked

Fork+exec is safe because `exec` immediately replaces the process image. Running arbitrary JS in a post-fork V8 is unsafe — GC threads, the JIT compiler, libuv workers, and OpenSSL all have background threads that die on fork, leaving mutexes in undefined states. Node's `child_process.fork()` is `fork+exec(node)` — a fresh process with no shared JS state.

JS functions therefore always run **in-process on the main thread**. The framework handles pipe setup and teardown; functions don't need to manage their stdio.

---

## Scope Model

There is no distinction between shell variables and JS variables. The `$` object is a Proxy-backed store:

```sh
name="world"          # $.name = "world"
echo $name            # reads $.name → "world"
```

```js
// .jshrc — same store
jsh.$.PATH = `/opt/homebrew/bin:${jsh.$.PATH}`;
jsh.$.items = ['a', 'b', 'c'];   // JS can store any type
```

`export VAR` syncs to `process.env` so child processes inherit it.

### Arrays

Arrays are stored as JS arrays in the variable store. Assignment syntax:

```sh
arr=(a b c)          # create array
arr+=(d e)           # append elements
arr[1]=X             # assign by index
declare -a myarr     # declare empty array
```

Expansion:
- `${arr[0]}` — single element
- `${arr[@]}` — all elements (separate words when quoted)
- `${arr[*]}` — all elements (joined with IFS when quoted)
- `${#arr[@]}` — element count
- `$arr` — first element (bash compat)

String append: `x+=val` concatenates to existing value. If the variable is an array, `+=` appends elements.

### Subshells

`(commands)` runs in-process with full isolation — the variable store, working directory, shell options, and positional parameters are snapshotted before execution and restored afterward. Subshells also support redirections: `(cmd) > file`.

### Function scoping

Shell function variables are global by default (POSIX behavior). The `local` builtin declares function-scoped variables — on function entry a scope is pushed, `local VAR` saves the current value, and on function exit all saved values are restored.

Positional parameters (`$1`, `$2`, `$#`, `$@`, `$*`) use a separate scope stack — pushed on function entry, popped on exit. `shift` mutates the current frame.

---

## Error Handling

Every command returns an integer exit code. `$?` holds the last exit code.

JS functions map to exit codes as follows:
- Normal return/resolve → exit 0
- `throw`/`reject` → exit 1, error stringified to stderr
- `return { exitCode: N }` → exit N

`set -e` (errexit), `set -u` (nounset), `set -x` (xtrace), and `set -o pipefail` are implemented. `pipefail` uses the rightmost non-zero exit code from `$PIPESTATUS`; `errexit` aborts on non-zero exit in list context.

`$PIPESTATUS` is an array holding the exit code of each stage in the most recent pipeline. Access elements with `${PIPESTATUS[n]}` or all with `${PIPESTATUS[@]}`.

---

## MasterBandit Integration

When jsh runs inside [MasterBandit](https://github.com/jhanssen/MasterBandit), the `jsh.mb` API exposes popup creation, captured command records (OSC 133), and other MB-hosted features. Bridging uses a WebSocket to an applet loaded into MB's script engine.

### Architecture

```
┌─ jsh (TypeScript + native) ─┐         ┌─ MB (C++) ─────────────────┐
│                              │   OSC   │                             │
│  XTGETTCAP / OSC 58300 ─────────query──▶  terminal emulator          │
│                                ─reply──   ↓                          │
│                              │         │  script engine              │
│                              │         │   ↓                         │
│                              │         │  mb-applet.js ─┐            │
│                              │   WS    │                │            │
│  jsh.mb.* API  ◀────────────────mb-shell.<token>─ applet WS server   │
│                              │         │                             │
└──────────────────────────────┘         └─────────────────────────────┘
```

Two sides maintained in this repo:

- `src/mb/` — shell-side client: capability probe, WS client, `jsh.mb` surface.
- `mb-applet/` — the applet loaded into MB. Creates the WS server, serves popup/command-record requests, pushes async events.

MB's scripting types are tracked at `mb-applet/types/mb.d.ts` (copied from the MB repo; sync manually when the API changes).

### Handshake

All PTY escape-sequence traffic is shell-initiated; the applet only writes to the PTY in direct response to an OSC query. This removes every race involving foreground children.

1. **Capability probe** — `DCS + q <hex("mb-query-applet")> ST`. If the terminal replies `1+r...`, we're inside an MB instance that advertises applet support.
2. **Announce query** — `OSC 58300 ; query ; nonce=<hex> ST`. The applet records `nonce → pane`, replies on the pane's PTY with `OSC 58300 ; port=N ; token=T ST`. Token is shared across shells; the nonce is the per-connection pane proof.
3. **WS connect** — `ws://127.0.0.1:<port>` with `Sec-WebSocket-Protocol: mb-shell.<token>`. First frame: `{type:"hello", nonce}`. Applet binds connection → pane, replies `{type:"ready"}`.

The probe is non-blocking: jsh fires the DCS and OSC queries at startup and proceeds straight to the prompt. Responses arrive on stdin and are consumed by the native input engine's OSC/DCS parser during the first edit session. When both responses have landed and the WS is open, `jsh.mb` transitions from its initial pending state to live.

### Transport rules

- **Applet → shell, via PTY**: only inside `pane.addEventListener("osc:58300", ...)` handlers. Never elsewhere. Enforced by convention in `mb-applet/src/applet.ts`.
- **Applet → shell, via WS**: any time the WS is open. `popupClosed`, `commandComplete`, resize events, applet-shutdown notifications, etc.
- **Shell → applet, via PTY**: only `OSC 58300` queries, emitted while raw mode is active (edit session).
- **Shell → applet, via WS**: all request/response API calls (`createPopup`, `getSelectedCommand`, `quiet`, etc.).

The constraint keeps the PTY race-free: escape sequences only flow when jsh is actively reading stdin, never when a foreground child owns the TTY.

### Reconnect

If the WS drops (applet reload, MB restart), jsh attempts reconnect with exponential backoff (250ms → 8s). If the cached port+token is stale, the reconnect fails; jsh schedules a fresh `OSC 58300` query for the next edit session. When the response arrives, WS is re-established with the new credentials.

Two mechanisms interact during reconnect:

1. **Fork gate** — on Enter, if any external command is about to be forked and WS is reconnecting, jsh waits briefly (sub-10ms typical) for either WS live or a timeout verdict before calling `fork+exec`. This is a PTY-race defense only: it ensures unsolicited WS events from the applet don't arrive while a non-shell foreground child owns the TTY. Builtins, shell functions, and `@` functions run in-process — they don't take the foreground, so the gate is skipped for AST nodes that contain no externals.
2. **Per-call await** — every `jsh.mb.*` method internally awaits WS readiness. `@` functions that call `jsh.mb.getSelectedCommand()` or `jsh.mb.createPopup()` still block on the live connection; they just don't trigger the fork gate. If the reconnect attempt times out, the method rejects with a typed error, which the caller can catch.

### API shape

```ts
interface MbApi {
    readonly connected: boolean;
    createPopup(opts: {x, y, w, h}): Promise<PopupHandle>;
    getSelectedCommand(): Promise<MbCommandRecord | null>;
    selectCommand(id: number | null): void;
    // ...
}

declare const jsh: {
    mb: MbApi | null;  // null iff not under MB (probe negative). Stable per session.
};
```

- `jsh.mb === null` → not under MB. Final verdict for the session.
- `jsh.mb` exists → we're under MB. WS may or may not currently be connected; API methods internally await reconnect, reject with a typed error if the current attempt times out.
- `jsh.mb.connected` → synchronous fast-check for UI (prompt widgets, status indicators).

No separate `ready` promise; failure surfaces through the method calls themselves.

### Non-interactive mode

The MB bridge is an interactive-mode feature. When jsh runs a script (stdin is not a TTY), no probe fires, no applet is queried, and `jsh.mb` is `null`. Scripts pay zero MB overhead.
