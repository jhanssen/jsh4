# jsh — A JavaScript Shell

A POSIX-compatible interactive shell with JavaScript as the extension language.

## Goals

- Bourne-compatible syntax (POSIX sh base, selective bash/zsh extensions)
- JS as the scripting and configuration language (replaces .zshrc/.bashrc with .jshrc)
- JS functions callable inline in pipelines via `@` syntax
- Job control (ctrl-z, bg, fg, &)
- Quality line editing with programmable completion
- In-process: shell logic runs in the Node.js process, child commands fork/exec as usual

## Non-Goals

- Full zsh/bash compatibility (no attempt to run arbitrary .zshrc/.bashrc)
- POSIX sh certification
- Windows support (initially)

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Node.js                     │
│                                              │
│  .jshrc (JS)    timers    @js functions      │
│       │            │            │             │
│       ▼            ▼            ▼             │
│  ┌──────────── event loop ───────────────┐   │
│  │                                       │   │
│  │  REPL ◄──► Parser ──► Executor ──►┐   │   │
│  │   ▲                               │   │   │
│  │   │         ┌─────────────────┐   │   │   │
│  │   │         │  Job Table      │   │   │   │
│  │   │         │  Process Groups │   │   │   │
│  │   └─────────│  Signal Handler │◄──┘   │   │
│  │             └─────────────────┘       │   │
│  └───────────────────────────────────────┘   │
│                                              │
│  Line Editor (native, N-API)                 │
└─────────────────────────────────────────────┘
```

### Components

**1. Parser (JS or C++)**

Recursive descent parser for POSIX shell grammar with extensions. Produces a clean AST.

Input:
```sh
cat /tmp/data | @filter line => line.includes("error") | head -20
```

AST output:
```json
{
  "type": "Pipeline",
  "commands": [
    { "type": "SimpleCommand", "words": ["cat", "/tmp/data"] },
    { "type": "JsFunction", "name": "filter", "args": "line => line.includes(\"error\")" },
    { "type": "SimpleCommand", "words": ["head", "-20"] }
  ]
}
```

Supported syntax:
- Simple commands with arguments
- Pipelines (`|`, `|&`)
- Redirections (`>`, `>>`, `<`, `2>&1`, `&>`, here-docs `<<`, here-strings `<<<`)
- Quoting (single, double, backslash, `$'...'`)
- Variable expansion (`$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR%%pattern}`)
- Command substitution (`$(...)`, backticks)
- Arithmetic expansion (`$((...))`)
- Globbing (`*`, `?`, `[...]`, `**` recursive)
- Control flow: `for`/`do`/`done`, `while`/`until`, `if`/`then`/`elif`/`else`/`fi`, `case`/`esac`
- Subshells `(...)`, brace groups `{ ...; }`
- Functions: `name() { ...; }`
- Logical operators: `&&`, `||`
- Background: `&`
- Test expressions: `[ ... ]`, `[[ ... ]]`
- `@` syntax for JS interop (first-class, not preprocessed)

**2. Executor (C++ with N-API)**

Walks the AST and executes commands. Handles all POSIX process management.

Responsibilities:
- fork/exec for external commands
- Pipe plumbing between pipeline stages
- File descriptor management for redirections
- Process group management for job control
- Signal handling (SIGCHLD, SIGINT, SIGTSTP, SIGCONT, SIGPIPE)
- Wait/reap for foreground and background jobs
- Builtin command dispatch (cd, export, source, jobs, fg, bg, etc.)

For `@` JS functions in pipelines:
- The executor sets up pipe fds as normal
- Instead of fork/exec, calls into JS with readable/writable streams backed by the pipe fds
- JS function runs on the main thread; if it's async, the executor awaits completion

**3. Expander (JS)**

Handles word expansion before command execution:
1. Tilde expansion (`~` → home dir)
2. Parameter expansion (`$VAR`, `${VAR:-default}`)
3. Command substitution (`$(...)`)
4. Arithmetic expansion (`$((...))`)
5. Word splitting (on IFS)
6. Glob/pathname expansion
7. Quote removal

Implemented in JS so the variable/scope model is natural JS. Shell variables are JS objects. `export` marks variables for child process inheritance.

**4. Line Editor (native C/C++, N-API binding)**

Options under consideration:
- **linenoise-ng**: ~2k lines C, MIT license, history, completion hooks, hints
- **Stripped ZLE**: more capable (vi/emacs modes, sophisticated completion display) but complex to extract
- **Custom**: raw terminal mode, Node tty integration. Most work, most control.

Requirements:
- Basic line editing (cursor movement, insert, delete, home/end, history)
- Programmable completion (tab triggers JS callback)
- Syntax highlighting (optional, via JS callback on keystroke)
- Multi-line editing for control structures
- vi and emacs modes (stretch goal)

The line editor must integrate with Node's event loop — it cannot block. Either:
- Event-driven: libuv watches stdin, feeds characters to the editor
- Threaded: editor runs on its own thread, communicates via napi_threadsafe_function

**5. JS Runtime / .jshrc**

`.jshrc` is a JS (or TS) file loaded at startup via `require()` or `import()`.

```js
// ~/.jshrc

// Environment
$.PATH = `/usr/local/bin:${$.PATH}`;
$.EDITOR = 'nvim';

// Aliases (just JS functions)
alias('ll', 'ls -la');
alias('gs', 'git status');

// Prompt
setPrompt(() => {
    const cwd = $.PWD.replace($.HOME, '~');
    const branch = exec('git branch --show-current 2>/dev/null').trim();
    return `${cwd}${branch ? ` (${branch})` : ''} $ `;
});

// Custom pipeline functions
export function filter(predicate) {
    // receives stdin as a stream, returns filtered stream
    return transform(line => predicate(line) ? line : null);
}

// Completions
complete('git', async (ctx) => {
    if (ctx.words.length === 2) {
        return ['add', 'commit', 'push', 'pull', 'status', 'log', 'diff'];
    }
    return [];
});

// Startup tasks
setInterval(() => checkForUpdates(), 3600000);
```

## Execution Model

### Foreground Commands

```
user types: cat /tmp/foo | grep bar
  → parser produces Pipeline AST
  → executor:
      1. pipe() → [read_fd, write_fd]
      2. fork() child1: dup2(write_fd→stdout), exec("cat", "/tmp/foo")
      3. fork() child2: dup2(read_fd→stdin), exec("grep", "bar")
      4. set child process group as foreground (tcsetpgrp)
      5. waitpid() for all children
      6. return exit status to REPL
```

### Background Commands

```
user types: make -j8 &
  → executor:
      1. fork() child in new process group
      2. do NOT set as foreground group
      3. add to job table
      4. print [1] <pid>
      5. return immediately to REPL
  → SIGCHLD handler reaps when done, prints [1]+ Done
```

### Job Control

```
user types: long_running_thing
  → running as foreground...
  → user hits ctrl-z
  → SIGTSTP delivered to foreground process group (not to jsh)
  → waitpid returns WIFSTOPPED
  → executor marks job as stopped, prints [1]+ Stopped
  → returns to REPL

user types: bg
  → send SIGCONT to stopped job's process group
  → mark job as running/background

user types: fg
  → set job's process group as foreground (tcsetpgrp)
  → send SIGCONT
  → waitpid() again
```

### JS Functions in Pipelines

```
user types: cat /tmp/data | @filter line => line.startsWith('#')
  → Pipeline with 2 stages: SimpleCommand + JsFunction
  → executor:
      1. pipe() → [read_fd, write_fd]
      2. fork() child: dup2(write_fd→stdout), exec("cat", "/tmp/data")
      3. JS stage: wrap read_fd as ReadableStream, stdout as WritableStream
      4. call filter() with the stream
      5. await completion
      6. return exit status
```

JS functions in pipelines run in-process on the main thread. They're not forked.
This means they can access all JS state, but a misbehaving function can block the shell.

## Threading Model

```
Main thread (Node event loop):
  - JS execution (.jshrc, @functions, completions, timers)
  - Parser (fast, non-blocking)
  - Variable expansion
  - Prompt rendering

Execution thread:
  - fork/exec
  - waitpid (blocks for foreground jobs)
  - signal handling for job control
  - Posts results back to main thread via napi_threadsafe_function

Line editor:
  - Option A: on main thread, event-driven via libuv stdin watching
  - Option B: on dedicated thread, communicates via napi_threadsafe_function
  - TBD based on line editor choice
```

## Builtins

Builtins execute in-process (no fork). Minimum set:

| Builtin | Purpose |
|---------|---------|
| `cd` | Change directory |
| `exit` | Exit shell |
| `export` | Mark variable for child env |
| `unset` | Remove variable |
| `source` / `.` | Execute file in current context |
| `eval` | Parse and execute string |
| `exec` | Replace shell with command |
| `jobs` | List jobs |
| `fg` | Foreground a job |
| `bg` | Background a job |
| `alias` | Define alias |
| `unalias` | Remove alias |
| `set` | Set shell options |
| `shift` | Shift positional params |
| `read` | Read line from stdin |
| `echo` / `printf` | Output (builtin for performance) |
| `test` / `[` | Conditional expression |
| `true` / `false` | Exit status |
| `type` / `which` | Command lookup |
| `hash` | Command hash table |

## Decisions

- **Parser**: JS (recursive descent). Can move to C++ later behind the same AST interface if perf matters.
- **Line editor**: [antirez/linenoise](https://github.com/antirez/linenoise) via N-API. BSD license, ~850 lines, actively maintained, has multiplexing mode for libuv integration.
- **Async**: Executor returns promises. `await` works in .jshrc and interactive use.

## Design Discussion: `@` Syntax

### What `@` means

`@` introduces a JS function in a position where a shell command would normally go.
It is part of the grammar, not a preprocessor — the parser produces a `JsFunction` AST node.

### Forms

**Named function call:**
```sh
cat data.json | @parseJson | @filter item => item.active | head
```
`@parseJson` calls the JS function `parseJson` registered via .jshrc or `export function`.
Arguments after the name are passed to the function.

**Inline expression:**
```sh
ls -la | @{ lines => lines.filter(l => l.startsWith('d')) }
```
`@{ expr }` evaluates an inline JS expression. The expression receives input as the first argument.

### Streaming vs buffered

By default, `@` functions receive a line-at-a-time readable stream (like a Transform stream).
This is the common case for filters:

```sh
cat log.txt | @filter line => line.includes('ERROR')
```

Some functions need all input at once (sorting, JSON parsing). The `@!` prefix switches to
buffered mode — all stdin is collected into a string/buffer, then passed to the function:

```sh
cat data.json | @!parseJson
cat names.txt | @!{ text => text.split('\n').sort().join('\n') }
```

### How functions are defined

In `.jshrc`:
```js
// Streaming — called once per line, return truthy to keep, falsy to drop
export function filter(predicate) {
    return line => predicate(line) ? line + '\n' : '';
}

// Buffered — receives full input as string
export function parseJson(input) {
    return JSON.stringify(JSON.parse(input), null, 2);
}

// Async is fine
export async function fetch_and_filter(url) {
    const resp = await fetch(url);
    return await resp.text();
}
```

### Generators and async generators

JS generator functions are a natural fit for producing output over time.
The executor detects when a `@` function returns a generator/async-generator
and pipes yielded values to stdout.

```js
// .jshrc — async generator as a long-running source
export async function* watchEndpoint(url, interval = 5000) {
    while (true) {
        const resp = await fetch(url);
        yield `${resp.status} ${url}\n`;
        await sleep(interval);
    }
}

// sync generator for computed output
export function* range(start, end) {
    for (let i = Number(start); i <= Number(end); i++) {
        yield `${i}\n`;
    }
}
```

Usage:
```sh
@watchEndpoint https://api.example.com/health 10000 | @filter line => line.startsWith('5')
@range 1 100 | grep -E '7$'
```

When the downstream pipeline stage closes (e.g., `head` exits, causing SIGPIPE on the
write end), the generator's `.return()` is called for cleanup.

**Function type detection and behavior:**

| Return type | Behavior |
|---|---|
| `string` | Write to stdout, exit 0 |
| `Buffer` / `Uint8Array` | Write to stdout (binary), exit 0 |
| `{ exitCode: N }` | Exit with code N |
| `ReadableStream` / `Readable` | Pipe to stdout |
| `Generator` | Iterate, write each yielded value to stdout |
| `AsyncGenerator` | Async iterate, write each yielded value to stdout |
| `Promise` | Await, then apply above rules to resolved value |
| `void` / `undefined` | Exit 0, no output |
| `throw` / `reject` | Exit 1. If thrown value is non-null/non-undefined, stringify and write to stderr |

### Resolved: `@` syntax decisions

- `@func arg1 arg2` passes args as JS function arguments: `func("arg1", "arg2")`.
  Arguments are always strings (shell is stringly-typed). The function coerces if needed.
- `@func` works anywhere a command works — standalone, in pipelines, in if conditions, etc.
  No parens needed. `@doSomething` calls `doSomething()`.
- Exit codes: see return type table above. Functions return `{ exitCode: N }` for explicit
  codes, throw for failure (exit 1), or return normally for success (exit 0).

---

## Design Discussion: Scope Model

### The problem

Shell has variables (`$VAR`), environment variables (inherited by children), and local
variables (function scope). JS has its own scoping. These need to coexist.

### Unified variable model

There is no distinction between shell variables and JS variables. They are the same store.

The `$` object is a Proxy-backed store accessible from both shell syntax and JS:

```sh
name="world"          # $.name = "world"
echo $name            # reads $.name → "world"
count=5               # $.count = "5" (shell assignment is always string)
```

```js
// .jshrc — same store
$.PATH = `/opt/homebrew/bin:${$.PATH}`;
$.EDITOR = 'nvim';
$.items = ['a', 'b', 'c'];   // JS can store any type
$.config = { port: 8080 };
```

`export VAR` additionally syncs to `process.env` so child processes inherit it.
`unset VAR` deletes from both `$` and `process.env`.

### Stringification

When a JS value is used in shell context (command arguments, string interpolation),
it is stringified:

| Type | Shell stringification |
|---|---|
| `string` | As-is |
| `number`, `boolean` | `String(value)` |
| `null`, `undefined` | Empty string |
| `Array` | Elements joined with space (shell convention) |
| `Object` | `JSON.stringify(value)` |
| `Buffer` / `Uint8Array` | Raw bytes (for binary pipelines) |

```sh
$.items = ["a", "b", "c"]
echo $items               # "a b c"
echo ${#items}            # 3 (array length)

$.config = { port: 8080 }
echo $config              # {"port":8080}
```

### Parameter expansion

POSIX parameter expansion syntax is supported as sugar over JS operations on the
value in `$`:

| Syntax | JS equivalent |
|---|---|
| `$VAR` | `String($.VAR)` |
| `${VAR:-default}` | `$.VAR ?? "default"` |
| `${VAR:=default}` | `$.VAR ??= "default"` |
| `${VAR:+alt}` | `$.VAR != null ? "alt" : ""` |
| `${VAR:?msg}` | `$.VAR ?? throw msg` |
| `${#VAR}` | `String($.VAR).length` (or `.length` for arrays) |
| `${VAR%%pattern}` | Pattern strip on `String($.VAR)` |
| `${VAR##pattern}` | Pattern strip on `String($.VAR)` |
| `${VAR/pat/rep}` | Replace on `String($.VAR)` |

### Command lookup order

When the executor encounters a simple command:

1. Aliases
2. Shell functions (defined with `name() { ... }` in shell syntax)
3. JS functions (exported from .jshrc or registered)
4. Builtins (cd, export, jobs, fg, bg, etc.)
5. External commands ($PATH search)

Shell functions can call `@jsfunc` — they naturally coexist since both use the same
variable store and execution context.

### Subshells

`(commands)` and `$(commands)` always fork. The child inherits a copy of the variable store.
Changes in the subshell don't affect the parent — standard POSIX behavior.

The child process loses JS runtime state (closures, timers, module state). This is the same
limitation every shell has with its extension language. `$(@jsfunc)` won't work — JS
functions must run in the parent. Users restructure to keep JS in the parent pipeline.

### Scoping in functions

Shell function variables are global by default (POSIX behavior). `local VAR` creates
a function-scoped variable (bash/zsh extension) implemented as a scope stack on the
`$` Proxy — push on function entry, pop on exit.

---

## Design Discussion: Error Handling

### Shell model

Every command returns an integer exit code. 0 = success, nonzero = failure.
`$?` holds the last exit code. Pipelines return the last command's exit code
(or, with `set -o pipefail`, the rightmost nonzero).

`set -e` makes the shell exit on any nonzero exit code (with exceptions for
conditions in `if`/`while`/`&&`/`||`).

### JS model

Functions throw exceptions or reject promises. There's no exit code convention.

### Proposed bridge

**Shell → JS direction:**
Exit codes are available as `$?` and as the return value of an `exec()` API:
```js
const result = exec('grep pattern file.txt');
// result.exitCode: number
// result.stdout: string
// result.stderr: string
// result.ok: boolean (exitCode === 0)
```

**JS → Shell direction (JS functions in pipelines):**
- A JS function that returns/resolves normally → exit code 0
- A JS function that throws/rejects → exit code 1, error message printed to stderr
- A JS function can explicitly return an exit code:
  ```js
  export function check(line) {
      if (!line.includes('expected')) {
          return { exitCode: 1 };
      }
      return line;
  }
  ```

**`set -e` / `set -o pipefail`:**
These work as in POSIX. If `set -e` is active and a command (or `@` function) fails,
execution stops. Standard exceptions: commands in `if`/`while` conditions, left side of
`&&`/`||`.

**No `try`/`catch` in shell syntax.** Shell has `&&`/`||`/`if cmd; then` for branching
on exit codes. Complex error handling belongs in JS.

**Async `@` functions:** async functions that reject are treated the same as sync throws —
exit code 1, error stringified to stderr (if non-null/non-undefined).

**`$?`** is available as `$?` in shell and `$['?']` in JS. Contains the last command's
exit code as a number.

**`$PIPESTATUS`** — array of exit codes from each stage of the last pipeline (bash
compatible). Available as `$.PIPESTATUS` in JS.

**`set -e`** works as in POSIX: exit on any nonzero exit code, with standard exceptions
for `if`/`while`/`&&`/`||` conditions. When a `@` function throws under `set -e`, the
error is printed to stderr and the shell exits.

**`set -o pipefail`** — pipeline returns the rightmost nonzero exit code instead of
the last command's exit code.
