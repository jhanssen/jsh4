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
- [x] Arithmetic `for ((init; cond; step))` loops
- [x] Process substitution `<(cmd)` and `>(cmd)`
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
- [x] `[[ ]]` — extended conditional: `=~` regex, `<`/`>`, `==`/`!=` glob matching, `&&`/`||`/`!`/`()`
- [x] `jobs` — list background/stopped jobs
- [x] `fg` — resume job in foreground (SIGCONT + tcsetpgrp + wait)
- [x] `bg` — resume stopped job in background (SIGCONT)
- [x] `wait` — wait for background jobs
- [x] `eval` — parse and execute string in current context
- [x] `printf` — formatted output (`%s`, `%d`, `%x`, `%b`, `%q`, etc.)
- [x] `trap` — signal/pseudo-signal trapping (EXIT, INT, TERM, etc.)
- [x] `return` — exit from shell function with code
- [x] `command` — `-v` checks existence, bypasses functions/aliases
- [x] `readonly` — mark variables as read-only
- [x] `getopts` — POSIX option parsing
- [x] `break` / `continue` — loop flow control with optional N levels
- [x] `pushd` / `popd` / `dirs` — directory stack
- [x] `basename` / `dirname` — path manipulation builtins
- [x] `select` — interactive menu loop
- [x] `echo -n` / `-e` / `-E` — suppress newline, enable/disable escapes
- [x] `read -s` / `-d` / `-n` / `-a` — silent, delimiter, nchars, array
- [x] Builtins in pipelines — builtin-only commands run in-process with pipe fd redirection
- [x] `kill` — send signals to processes/jobs (`kill [-signal] pid/jobspec`)
- [x] `disown` — remove jobs from table (`-a` all, `-r` running)
- [x] `hash` — command hash table for PATH lookup caching (`-r` to clear)
- [x] `let` — arithmetic evaluation (`let x=5+3`, `let x++`)
- [x] `declare` — variable declarations (`-a` array, `-x` export, `-r` readonly, `-p` print)
- [x] `time` — measure command execution time
- [x] `:` — no-op builtin (POSIX colon command)
- [x] `pwd` — print working directory (`-P` physical, `-L` logical)
- [x] `umask` — get/set file creation mask
- [x] `ulimit` — resource limits (minimal: `-a`, `-n`)
- [x] `set -a` (allexport) — auto-export assigned variables
- [x] `set -C` (noclobber) — prevent `>` from overwriting existing files
- [x] `set --` — set positional parameters directly
- [x] `exec` with redirections only — `exec 3>file` applies permanent fd redirections
- [x] `$PPID` — parent process ID
- [x] `$-` — current shell option flags

### Expansion
- [x] Variable expansion with all operators (`:-`, `:+`, `:=`, `:?`, `#`, `##`, `%`, `%%`, `/`, `//`)
- [x] Case modification `${VAR^^}`, `${VAR,,}`, `${VAR^}`, `${VAR,}`
- [x] Substring extraction `${VAR:offset}`, `${VAR:offset:length}`
- [x] Length `${#VAR}`
- [x] Array literals `name=(word ...)`, append `name+=(word ...)`, index `name[i]=val`
- [x] Array subscript syntax `${VAR[n]}`, `${VAR[@]}`, `${VAR[*]}`
- [x] `"${arr[@]}"` produces separate words; `"${arr[*]}"` joins with IFS
- [x] `${#arr[@]}` — array element count
- [x] String append `name+=value`
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

### REPL / Terminal UI
- [x] Custom InputEngine (replaced linenoise) with non-blocking uv_poll
- [x] Multi-line continuation prompt (`> `) for incomplete input
- [x] History (in-memory + persist to `~/.jsh_history`, multi-line entries with `\` continuation)
- [x] Non-interactive stdin mode (script execution via `readFileSync`)
- [x] Tab completion: files/dirs, commands, `@` functions, user-defined handlers
- [x] Ctrl-C clears current line/buffer
- [x] Ctrl-D exits
- [x] Ctrl-R reverse history search
- [x] Syntax highlighting (lexer-based, true color RGB, command-exists green/red)
- [x] Multi-line syntax highlighting — continuation and multi-line buffer lines colorized with context
- [x] Multi-line editing — Up/Down navigate between lines, Home/End are line-aware, history fallback at edges
- [x] Unified widget system — prompt, rprompt, PS2, header, footer are all widgets in zones
- [x] Widget handles with `update()` / `remove()` — intervals are userland, not baked in
- [x] Frozen lines — PS1 + previous PS2 lines stay visible during continuation, header renders above all
- [x] Flicker-free continuation — renderer overwrites old frame in place, no clear/redraw gap
- [x] OSC 133 shell integration marks
- [x] OSC 7 cwd reporting
- [x] Synchronized rendering (CSI 2026)
- [x] History expansion (`!!`, `!$`, `!^`, `!n`, `!-n`, `!string`)

### `.jshrc` / API
- [x] `.jshrc` loading (ESM dynamic import from `~/.jshrc`)
- [x] Exported functions auto-registered as `@` pipeline functions
- [x] `jsh` global object with full API
- [x] `jsh.$` — variable store proxy
- [x] `jsh.alias(name, expansion)` / `jsh.unalias(name)`
- [x] `jsh.addWidget(id, zone, render, order)` — unified widget system for all zones (prompt, rprompt, ps2, header, footer)
- [x] Widget handles: `update()` re-evaluates render, `remove()` unregisters
- [x] `jsh.setColorize(fn)` — custom syntax highlighting override
- [x] `jsh.setTheme(theme)` — syntax highlighting theme with RGB/hex/named colors
- [x] `jsh.colors` — ANSI color constants
- [x] `jsh.makeFgColor()` / `jsh.makeBgColor()` / `jsh.makeUlColor()` — RGB color builders
- [x] `jsh.style` — tagged template for styled strings with auto-reset
- [x] `jsh.registerJsFunction(name, fn)`
- [x] `jsh.complete(cmd, fn)` — sync completion handler
- [x] `jsh.exec(cmd, opts?)` — dual-mode: await (buffered) or iterate (streaming)
- [x] `jshrc.d.ts` type declarations
- [x] Signals: `SIGTTOU`/`SIGTTIN` ignored, `SIGCHLD`/`SIGINT` blocked on main thread
- [x] Terminal ownership (`tcsetpgrp`) for interactive mode

### Tests
- [x] Lexer tests (90 cases)
- [x] Parser tests
- [x] Input engine binding tests
- [x] Executor integration tests (via jsh subprocess)
- [x] `@` syntax tests
- [x] `jsh.exec()` tests
- [x] jsh API tests (alias, registerJsFunction)
- [x] Tab completion tests
- [x] `case`/`esac` and here-doc tests
- [x] Subshell isolation tests
- [x] Brace group and subshell redirection tests
- [x] IFS word splitting tests
- [x] `$@`/`$*` word splitting tests
- [x] `$PIPESTATUS` and array subscript tests
- [x] Arithmetic `++`/`--` and assignment operator tests
- [x] Job control tests (background, jobs, wait, $!)
- [x] eval, printf, trap tests
- [x] return, command -v, readonly tests
- [x] break/continue tests
- [x] String operations tests (`^^`, `,,`, `:offset:length`, `#`, `##`, `%`, `%%`, `/`, `//`)
- [x] pushd/popd/dirs, basename/dirname tests
- [x] echo -n/-e tests
- [x] Colorizer tests
- [x] History expansion tests
- [x] Input engine binding tests
- [x] Process substitution tests
- [x] `[[ ]]` glob matching tests
- [x] Arithmetic for loop tests
- [x] Builtins in pipelines tests
- [x] Here-doc `$()` and `$(())` expansion tests
- [x] Array tests (assign, append, index, `[@]`/`[*]`, `${#arr[@]}`, quoted expansion)
- [x] kill, disown, hash, let, declare, time, colon tests
- [x] $PPID, pwd, umask, set -a, set -C, $-, set --, exec redirections, ulimit tests

---

## Pending

### Shell features

- [ ] **`$RANDOM`** — random number variable (0–32767)
- [ ] **`$LINENO`** — current line number in script/function
- [ ] **`$FUNCNAME`** — name of current function
- [ ] **`(( ))` as a command** — arithmetic evaluation returning exit code (0 if non-zero, 1 if zero)
- [ ] **`mapfile` / `readarray`** — read lines from stdin into an array
- [ ] **`export -n`** — un-export a variable (remove from environment, keep in shell)
- [ ] **`unset -f`** — remove shell functions
- [ ] **`shopt` / shell options** — `nullglob`, `dotglob`, `nocaseglob`, `extglob`
- [ ] **`${!prefix*}` / `${!name}`** — variable name expansion, indirect expansion
- [ ] **`builtin` keyword** — force builtin execution over function
- [ ] **`command -p`** — use default PATH
- [ ] **Signal forwarding** — forward SIGINT/SIGTERM to foreground process group on shell exit
- [ ] **Recursive glob `**` in brace expansion** — e.g. `{src,test}/**/*.ts`
- [ ] **Named pipes / coprocesses**
- [ ] **`read -t`** — timeout flag (requires async I/O changes)
- [ ] **`TMOUT`** — auto-logout after idle timeout

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

### Terminal / Input

- [ ] **Keybind system** — C++ action table indexed by key enum, JS sets bindings via `jsh.bindKey("ctrl-a", "move-home")`. Custom JS callbacks for `"custom"` action. Default bindings built-in, user-overridable.
- [ ] **Named internal widgets assignable to zones** — Allow JS to place built-in UI elements (e.g. search indicator, completion menu) into any zone via `jsh.addWidget("search-indicator", "footer")` with a name instead of a render function. The engine looks up "what zone is this element in?" and renders it there. This lets users control where Ctrl-R/Ctrl-S search text, completion candidates, etc. appear in the layout.

### Testing

- [ ] **Interactive terminal test framework** — Use `node-pty` + headless `xterm.js` to spawn jsh in a real PTY, send keystrokes, and assert against the virtual screen buffer. Enables testing widgets, cursor positioning, ghost text, multi-line rendering, Ctrl-R/Ctrl-S search, tab completion cycling, and other UI behavior that can't be verified via `spawnSync` + stdout capture.

### Technical debt

- [ ] **Move remaining builtins to object map** — `read`, `source`, `.`, `eval`, `trap`, `return`, `command`, `break`, `continue`, `fg`, `bg`, `jobs`, `wait`, `select`, `time` are handled as special cases in `executeSimple` instead of the `builtins` map. Causes duplicate builtin name lists (executor `BUILTIN_NAMES` set and completion `BUILTINS_LIST`).

### Not planned (initial scope)

- Windows support
- Full POSIX sh certification
- `zsh`/`bash` `.rc` compatibility
