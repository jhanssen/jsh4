# jsh — A JavaScript Shell

A POSIX-compatible interactive shell with JavaScript as the extension language.

## Goals

- Bourne-compatible syntax (POSIX sh base, selective bash/zsh extensions)
- JS as the scripting and configuration language (replaces `.zshrc`/`.bashrc` with `.jshrc`)
- JS functions callable inline in pipelines via `@` syntax
- Job control (ctrl-z, bg, fg, &) *(job control partially implemented)*
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
│  linenoise (non-blocking, uv_poll on stdin)  │
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
- Variable expansion (`$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR%%pattern}`, etc.)
- Command substitution (`$(...)`, backticks)
- Arithmetic expansion (`$((...))`)
- Globbing (`*`, `?`, `[...]`, `**` recursive)
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
2. Parameter expansion (`$VAR`, `${VAR:-default}`, etc.)
3. Command substitution (`$(...)` → fork + pipe capture)
4. Arithmetic expansion (`$((...))` → JS `Function()` eval)
5. Word splitting (on IFS — currently space/tab/newline)
6. Glob/pathname expansion (via Node.js `fs.glob`)
7. Quote removal

Returns `string[]` per word to support glob expansion producing multiple results.

**4. Line Editor (linenoise, N-API binding)**

[antirez/linenoise](https://github.com/jhanssen/linenoise) (forked at jhanssen/linenoise) via N-API.

The non-blocking multiplexed API is used:
- `linenoiseEditStart` initializes state and sets raw mode
- `linenoiseEditFeed` is called each time stdin is readable (via `uv_poll_t`)
- `linenoiseEditStop` restores the terminal when a line is complete

This keeps the Node.js event loop running while the user is typing, so timers and background tasks fire normally.

**5. JS Runtime / .jshrc**

`.jshrc` is an ES module loaded at startup via dynamic `import()`. Exported functions are automatically registered as `@` pipeline functions. The `jsh` global object provides the shell API.

```js
// ~/.jshrc

// Environment
jsh.$.PATH = `/usr/local/bin:${jsh.$.PATH}`;
jsh.$.EDITOR = 'nvim';

// Aliases
jsh.alias('ll', 'ls -la');
jsh.alias('gs', 'git status');

// Prompt
jsh.setPrompt(() => {
    const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
    return `${cwd} $ `;
});

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
  - linenoise (non-blocking, fed by uv_poll on stdin fd)
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
| `echo` | ✅ | Output (builtin for performance) |
| `true` / `false` | ✅ | Exit status |
| `alias` / `unalias` | ✅ | Define/remove aliases |
| `source` / `.` | ❌ | Execute file in current context |
| `eval` | ❌ | Parse and execute string |
| `exec` | ❌ | Replace shell with command |
| `jobs` | ❌ | List jobs |
| `fg` | ❌ | Foreground a job |
| `bg` | ❌ | Background a job |
| `set` | ❌ | Set shell options |
| `shift` | ❌ | Shift positional params |
| `read` | ❌ | Read line from stdin |
| `printf` | ❌ | Formatted output |
| `test` / `[` | ❌ | Conditional expression |
| `type` / `which` | ❌ | Command lookup |
| `hash` | ❌ | Command hash table |
| `trap` | ❌ | Signal trapping |

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
```

### Calling convention

- `args`: `string[]` — shell words after the function name
- `stdin`: `AsyncIterable<string>` (streaming) or `string` (buffered `@!`) or `null` (standalone)
- Lines yielded/returned are written to stdout

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

### Subshells

`(commands)` and `$(commands)` currently run in-process (variable mutations leak back to the parent shell). **TODO**: implement clone-and-restore of the variable store and cwd for proper subshell isolation.

### Function scoping

Shell function variables are global by default (POSIX behavior). Positional parameters (`$1`, `$2`, `$#`, `$@`, `$*`) use a scope stack — pushed on function entry, popped on exit.

---

## Error Handling

Every command returns an integer exit code. `$?` holds the last exit code.

JS functions map to exit codes as follows:
- Normal return/resolve → exit 0
- `throw`/`reject` → exit 1, error stringified to stderr
- `return { exitCode: N }` → exit N

`set -e` and `set -o pipefail` are not yet implemented.
