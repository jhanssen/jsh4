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
- [x] Brace groups (with redirections)
- [x] Subshells `(...)` with full isolation (variables, cwd, shell options, positional params)
- [x] `if`/`elif`/`else`
- [x] `while`/`until` loops
- [x] `for` loops with glob/word expansion
- [x] `case`/`esac` with glob patterns and `|` alternation
- [x] Shell function definitions and calls
- [x] Positional parameters `$1`/`$2`/`$#`/`$@`/`$*` with scope stack
- [x] `"$@"` produces separate words, `"$*"` joins with IFS
- [x] `$?` exit code tracking
- [x] `$PIPESTATUS` — per-stage exit codes for pipelines
- [x] Background `&` — run pipelines in background without waiting
- [x] Ctrl-Z (SIGTSTP) — stop foreground jobs, add to job table
- [x] Job control: `fg`, `bg`, `jobs`, `wait` builtins
- [x] `$!` — PID of last backgrounded job

### Builtins
- [x] `cd`
- [x] `exit`
- [x] `export`
- [x] `unset`
- [x] `echo`
- [x] `true` / `false`
- [x] Alias expansion
- [x] `test` / `[` — string, integer, file tests, logical operators, negation
- [x] `source` / `.` — execute file in current shell context, optional positional params
- [x] `read` — read line from stdin/here-strings/file redirects, IFS splitting, `-r` flag
- [x] `set` — `-e` (errexit), `-u` (nounset), `-x` (xtrace), `-o pipefail`, `+` to disable
- [x] `local` — function-scoped variables with save/restore
- [x] `shift` — shift positional parameters by N
- [x] `exec` — replace shell process via native `execvp`
- [x] `type` / `which` — command lookup (alias, builtin, function, PATH)
- [x] `[[ ]]` — extended conditional: `=~` regex, `<`/`>` string comparison, `&&`/`||`/`!`/`()`
- [x] `jobs` — list background/stopped jobs
- [x] `fg` — resume job in foreground (SIGCONT + tcsetpgrp + wait)
- [x] `bg` — resume stopped job in background (SIGCONT)
- [x] `wait` — wait for background jobs

### Expansion
- [x] Variable expansion with all operators (`:-`, `:+`, `:=`, `:?`, `#`, `##`, `%`, `%%`)
- [x] Array subscript syntax `${VAR[n]}`, `${VAR[@]}`, `${VAR[*]}`
- [x] Tilde expansion (`~`, `~/path`)
- [x] Command substitution `$()` (fork + pipe capture, supports arbitrary ASTs including control flow)
- [x] Arithmetic expansion `$((...))` via JS `Function()`, with `++`/`--`, `+=`/`-=`/`*=`/`/=`/`%=`, `=`
- [x] Glob expansion via Node.js `fs.glob` (`*`, `**`, `?`, `[...]`)
- [x] Brace expansion (`{a,b,c}`, `{1..5}`, `{a..z}`, step `{1..10..2}`, nested)
- [x] IFS word splitting — fragment-based: unquoted `$VAR`/`$()` split on IFS; quoted forms preserved
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
- [x] Non-interactive stdin mode (script execution via `readFileSync`)
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
- [x] Subshell isolation tests
- [x] Brace group and subshell redirection tests
- [x] IFS word splitting tests
- [x] `$@`/`$*` word splitting tests
- [x] `$PIPESTATUS` and array subscript tests
- [x] Arithmetic `++`/`--` and assignment operator tests
- [x] Job control tests (background, jobs, wait, $!)

---

## Pending

### Shell features

- [ ] **`PS2` customization** — continuation prompt hardcoded as `"> "`
- [ ] **Recursive glob `**` in brace expansion** — e.g. `{src,test}/**/*.ts`
- [ ] **`hash` builtin** — command hash table for PATH lookup caching
- [ ] **Named pipes / coprocesses**
- [ ] **`echo -n`** — suppress trailing newline

### Terminal / UI

- [ ] **Async tab completion** — completion callback returns `Promise<string[]>`, engine pauses editing while awaiting. Enables `command --help` parsing on Tab.
- [ ] **Tab completion: PATH caching invalidation on PATH change**
- [ ] **Kitty keyboard protocol** — progressive enhancement for proper modifier detection
- [ ] **OSC 8 hyperlinks** — clickable file paths and URLs in output
- [ ] **OSC 9/99 notifications** — desktop notification on background job completion
- [ ] **Kitty graphics protocol** — inline image display (`@img` pipeline function)
- [ ] **Terminal capability detection** — auto-detect truecolor, kitty keyboard, graphics support

### `@` JS syntax

- [ ] **`$(@func)`** — command substitution from JS function (in-process, no fork)
- [ ] **AbortSignal on pipe close** — propagate EPIPE to JS generator as cancellation

### Not planned (initial scope)

- Windows support
- Full POSIX sh certification
- `zsh`/`bash` `.rc` compatibility
