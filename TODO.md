# jsh — Implementation Status

## Done

### Parser
- [x] Lexer: all shell operators, quoting (single, double, backslash, `$'...'`), here-docs
- [x] Variable expansion tokens: `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR:+alt}`, `${VAR:=val}`, `${VAR:?msg}`, `${#VAR}`, `${VAR%%pat}`, `${VAR/pat/rep}`
- [x] Command substitution `$(...)` and backticks
- [x] Arithmetic expansion `$((...))`
- [x] Glob segments `*`, `?`, `[...]`
- [x] Pipelines (`|`, `|&`)
- [x] Redirections (`>`, `>>`, `<`, `>&`, `<&`, `&>`, `&>>`)
- [x] Here-docs (`<<`, `<<-`) and here-strings (`<<<`)
- [x] Logical operators `&&`, `||`
- [x] Lists (`;`, `&`, newline)
- [x] Subshells `(...)`
- [x] Brace groups `{ ...; }`
- [x] `if`/`then`/`elif`/`else`/`fi`
- [x] `while`/`until`/`do`/`done`
- [x] `for`/`in`/`do`/`done`
- [x] `case`/`in`/`;;`/`esac`
- [x] Function definitions `name() { ... }`
- [x] `!` pipeline negation
- [x] `@{ expr }` and `@!{ expr }` inline JS functions
- [x] `@name args` named JS function calls
- [x] Multi-line input detection (`IncompleteInputError`)

### Execution
- [x] External command fork/exec with correct stdio inheritance
- [x] Pipelines (pure external and mixed with JS functions)
- [x] Redirections (`>`, `>>`, `<`, `>&`, `2>&1`, `&>`, `<<`, `<<<`)
- [x] `&&` / `||` short-circuit evaluation
- [x] Command lists (`;`)
- [x] Brace groups
- [x] `if`/`elif`/`else`
- [x] `while`/`until` loops
- [x] `for` loops with glob/word expansion
- [x] `case`/`esac` with glob patterns and `|` alternation
- [x] Shell function definitions and calls
- [x] Positional parameters `$1`/`$2`/`$#`/`$@`/`$*` with scope stack
- [x] `$?` exit code tracking

### Builtins
- [x] `cd`
- [x] `exit`
- [x] `export`
- [x] `unset`
- [x] `echo`
- [x] `true` / `false`
- [x] Alias expansion

### Expansion
- [x] Variable expansion with all operators (`:-`, `:+`, `:=`, `:?`, `#`, `##`, `%`, `%%`)
- [x] Tilde expansion (`~`, `~/path`)
- [x] Command substitution `$()` (fork + pipe capture)
- [x] Arithmetic expansion `$((...))` via JS `Function()`
- [x] Glob expansion via Node.js `fs.glob` (`*`, `**`, `?`, `[...]`)
- [x] Here-doc body variable expansion (`$VAR`, `${VAR}`)

### JS Integration (`@` syntax)
- [x] Inline `@{ expr }` — JS expression in pipeline position
- [x] Buffered `@!{ expr }` — receives full stdin as string
- [x] Named `@func args` — calls registered function
- [x] Mixed pipelines: external commands + JS function stages
- [x] Async generator functions (yield lines to downstream)
- [x] Return type dispatch: string, Buffer, Generator, AsyncGenerator, Promise, `{ exitCode }`, void
- [x] Automatic pipe close on function completion (finally block)

### REPL
- [x] Non-blocking linenoise integration via libuv `uv_poll`
- [x] Multi-line continuation prompt (`> `) for incomplete input
- [x] History (in-memory + persist to `~/.jsh_history`)
- [x] Tab completion: files/dirs, commands, `@` functions, user-defined handlers
- [x] Ctrl-C clears current line/buffer
- [x] Ctrl-D exits

### `.jshrc` / API
- [x] `.jshrc` loading (ESM dynamic import from `~/.jshrc`)
- [x] Exported functions auto-registered as `@` pipeline functions
- [x] `jsh` global object with full API
- [x] `jsh.$` — variable store proxy
- [x] `jsh.alias(name, expansion)` / `jsh.unalias(name)`
- [x] `jsh.setPrompt(fn)` — sync prompt function
- [x] `jsh.registerJsFunction(name, fn)`
- [x] `jsh.complete(cmd, fn)` — sync completion handler
- [x] `jsh.exec(cmd, opts?)` — dual-mode: await (buffered) or iterate (streaming)
- [x] `jshrc.d.ts` type declarations
- [x] Signals: `SIGTTOU`/`SIGTTIN` ignored, `SIGCHLD`/`SIGINT` blocked on main thread
- [x] Terminal ownership (`tcsetpgrp`) for interactive mode

### Tests
- [x] Lexer tests (90 cases)
- [x] Parser tests
- [x] linenoise binding tests
- [x] Executor integration tests (via jsh subprocess)
- [x] `@` syntax tests
- [x] `jsh.exec()` tests
- [x] jsh API tests (alias, setPrompt, registerJsFunction)
- [x] Tab completion tests
- [x] `case`/`esac` and here-doc tests

---

## Pending

### High priority (needed for real scripts)

- [ ] **`test` / `[` / `[[`** — conditional expressions; `if [ -f foo ]`, `[ $x -eq 1 ]`, string/file tests
- [ ] **`source` / `.`** — execute a file in the current shell context
- [ ] **`read` builtin** — read a line from stdin into a variable
- [ ] **`set` builtin** — `set -e`, `set -o pipefail`, `set -x` (trace), `set -u` (unbound vars)
- [ ] **`local` builtin** — function-scoped variables; without this, shell functions clobber globals

### Medium priority

- [ ] **Subshells `(...)`** — currently run in-process (variable mutations leak); needs clone-and-restore of variable store + cwd
- [ ] **`$@` / `$*` proper word splitting** — currently joins with space; should produce separate words in `for i in "$@"`
- [ ] **Background `&` / job control** — job table, `jobs`, `fg`, `bg`, `SIGCHLD` tracking, `SIGTSTP`
- [ ] **`shift` builtin** — shift positional parameters
- [ ] **`exec` builtin** — replace shell with command
- [ ] **`$PIPESTATUS`** — exit codes of each pipeline stage
- [ ] **Brace expansion** — `{a,b,c}`, `{1..5}`
- [ ] **`type` / `which` builtins** — command lookup; common for checking if commands exist
- [ ] **Arithmetic in `$((...))`: `++`/`--`** — currently only basic JS arithmetic; shell-specific operators

### Lower priority / quality of life

- [ ] **Async `setPrompt`** — allow async functions (e.g. git branch); currently sync only
- [ ] **`PS2` customization** — continuation prompt hardcoded as `"> "`
- [ ] **Here-doc full expansion** — `$()` and `$((...))` inside here-doc bodies
- [ ] **Glob in directory components** — `src/*/index.ts` (currently only last component)
- [ ] **Recursive glob `**` in brace expansion** — e.g. `{src,test}/**/*.ts`
- [ ] **`hash` builtin** — command hash table for PATH lookup caching
- [ ] **`printf` builtin**
- [ ] **`trap`** — signal trapping
- [ ] **Process substitution** `<(cmd)` and `>(cmd)`
- [ ] **`[[` extended test** — regex matching `=~`, `<`/`>` string comparison
- [ ] **Named pipes / coprocesses**
- [ ] **History expansion** `!!`, `!$`, `!n`
- [ ] **Tab completion: async handlers** — currently sync only
- [ ] **Tab completion: PATH caching invalidation on PATH change**
- [ ] **Syntax highlighting** — via linenoise hints callback

### `@` JS syntax

- [ ] **`$(@func)`** — command substitution from JS function (in-process, no fork)
- [ ] **AbortSignal on pipe close** — propagate EPIPE to JS generator as cancellation
- [ ] **`jsh.complete()` async support** — currently synchronous callbacks only

### Not planned (initial scope)

- Windows support
- Full POSIX sh certification
- `zsh`/`bash` `.rc` compatibility
