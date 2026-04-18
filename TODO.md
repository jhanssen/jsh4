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
- [ ] **Command-line module import** — Today JS module imports are jshrc-only (via the Node loader hooks registered in `src/repl/index.ts`). A command like `import ./completion.jsm` or `@import ./completion.jsm` should do what jshrc's top-of-file `import` does: dynamically load a module, register its exports as `@`-functions, and make any defined builtins / `complete` specs active in the current session. Unblocks users from packaging completion shims and other @-function libraries as reusable modules instead of pasting everything into jshrc.

### Terminal / Input

- [ ] **Keybind system** — C++ action table indexed by key enum, JS sets bindings via `jsh.bindKey("ctrl-a", "move-home")`. Custom JS callbacks for `"custom"` action. Default bindings built-in, user-overridable.
- [ ] **Named internal widgets assignable to zones** — Allow JS to place built-in UI elements (e.g. search indicator, completion menu) into any zone via `jsh.addWidget("search-indicator", "footer")` with a name instead of a render function. The engine looks up "what zone is this element in?" and renders it there. This lets users control where Ctrl-R/Ctrl-S search text, completion candidates, etc. appear in the layout.
- [ ] **Fixed-size headers per editing session** — Lock header widget line count at session start so frame geometry is stable. Widget updates can change content but not add/remove lines. This fixes OSC 133 mark positioning (the input line row is known and doesn't shift) and simplifies the renderer. Dynamic-size content (completion menus, popups) should go in the footer zone.
- [ ] **Dynamic overlay widgets** — Support popup menus (completion candidates, context menus) as overlays that don't affect the primary frame geometry. Needed if widget sizes are locked for OSC 133 compatibility.

### Testing

- [ ] **Interactive terminal test framework** — Use `node-pty` + headless `xterm.js` to spawn jsh in a real PTY, send keystrokes, and assert against the virtual screen buffer. Enables testing widgets, cursor positioning, ghost text, multi-line rendering, Ctrl-R/Ctrl-S search, tab completion cycling, and other UI behavior that can't be verified via `spawnSync` + stdout capture.

### Technical debt

- [ ] **Move remaining builtins to object map** — `read`, `source`, `.`, `eval`, `trap`, `return`, `command`, `break`, `continue`, `fg`, `bg`, `jobs`, `wait`, `select`, `time` are handled as special cases in `executeSimple` instead of the `builtins` map. Causes duplicate builtin name lists (executor `BUILTIN_NAMES` set and completion `BUILTINS_LIST`).
- [ ] **Arithmetic evaluation via `new Function()`** — Currently uses JS semantics, not POSIX arithmetic. Differences include floating-point instead of integer-only, JS operator precedence edge cases, and no integer overflow behavior. Consider a dedicated integer arithmetic evaluator for correctness.
- [ ] **Compound commands mixed with `@`-functions in a pipeline** — Subshells (`(...)`), brace groups (`{...}`), and control flow (`if`/`for`/`while`/`case`) can be pipeline stages alongside externals (via a dup2 trick in `executeMixedPipeline`), but mixing them with `@`-functions deadlocks. The JS-stage loop awaits sequentially, so a JS stage blocked reading from a pipe that a later-scheduled compound is supposed to write to hangs forever. `executeMixedPipeline` detects the `js + compound` combo and returns with an error for now. Root cause: inner commands (builtins especially) write via `process.stdout` → fd 1, and the existing dup2-to-pipe trick can't coexist with concurrent pipeline stages (fd 0/1 are process-global). Proper fix: thread stdin/stdout fds through every write path via an `AsyncLocalStorage` pipeline context, so builtins call `writeStdout(...)` which consults the context and uses `writeSync(fd, ...)` for raw pipes or `process.stdout.write` when fd === 1. Then run compound stages concurrently via `Promise.all` inside the context. Scope: ~150-250 lines across ~30 builtins + infrastructure. See chat history 2026-04-17 for the design discussion.
- [ ] **Async builtin writes (unblock 64KB deadlock)** — Once compound pipeline stages are re-enabled via the fd-aware abstraction, they'll still share the current "builtin in pipeline deadlocks if output > pipe buffer" ceiling — because `writeSync` blocks the main thread when the pipe is full, preventing the downstream stage's coroutine from draining it. Fix: switch builtin output paths to async writes (`fs.write` callbacks or `createWriteStream` per fd), so each yield gives other pipeline coroutines a chance to run. Larger change (~500+ lines across all ~30 builtins) and only worth doing after the fd-aware refactor lands.
- [ ] **Prompt widgets can block the REPL** — `TerminalUI.start()` awaits `refreshZone(prompt/rprompt/header/footer)` sequentially before `inputStart`. Any slow async widget stalls the prompt's reappearance. Fix: render widgets with cached/stale content immediately, schedule refresh in the background, and rely on the existing `updateWidget` → `repaintFn` path to redraw when new content arrives. Also parallelize the four `refreshZone` calls (trivial — they're independent).
- [ ] **Stopped forkExec'd pid leaks** — Edge case in `src/native/executor.cc`: if a pid returned by `forkExec` gets SIGTSTP'd before the caller invokes `waitForPids`, the SIGCHLD handler parks `WIFSTOPPED` in `g_orphans` and `waitForPids` picks it up (marking ctx stopped). But the pid is still alive; subsequent state changes (SIGCONT→exit) fire SIGCHLD for a pid that's in neither `g_pending` nor `g_orphans`, and the zombie isn't reaped. Window is microseconds wide (Ctrl-Z between `forkExec` returning and the matching `waitForPids` call), so unlikely in practice — but a long-lived leak when it hits. Fix: in `handleStopped` (or equivalent), also record stopped forkExec-origin pids in a separate "stopped orphans" map so a later SIGCHLD for them can re-dispatch or be absorbed.
- [ ] **`jsh.exec` stderr iteration** — `ExecHandle.readStderr` (src/exec/index.ts) accumulates stderr for the buffered `.stderr` return value but doesn't feed it to `_pushLine`. So `for await (const line of exec("cmd", { stderr: "pipe" }))` only yields stdout lines, silently dropping stderr. Either document this as intentional (the iterator is stdout-only; stderr is only available via await) or add an iteration mode / second iterator for stderr.


### MasterBandit bridge

The bridge lives in `src/mb/` and `mb-applet/`. `@last` and `@claude` reference implementations live in user `~/.jshrc.js`.

#### Done

- [x] **Native OSC/DCS parser in the input-engine.** `ESC P … ST|BEL` and `ESC ] … ST|BEL` during raw mode are collected in `readEscPayload` and dispatched to `onEscResponse`.
- [x] **Async handshake (fire-and-continue).** `src/mb/handshake.ts` emits queries after raw mode engages and returns; responses land via the native parser during the first edit session. No startup block, no keystrokes lost.
- [x] **Shell-carries-applet.** `src/mb/applet.ts` installs the applet tree to `$XDG_CACHE_HOME/jsh/` on startup, emits OSC 58237, awaits the `status=loaded` ack, then proceeds to the OSC 58300 handshake. Opt out with `JSH_MB_NO_APPLET_LOAD=1`. Denied/error acks surface to stderr.
- [x] **WS reconnect with backoff.** 250ms → 8s exponential. Every reconnect triggers a fresh OSC 58300 handshake (applet consumes the nonce on first hello). Permanent failure sets `givenUp`; `mbApi` reference stays stable so `stateChanged` listeners keep working.
- [x] **Per-call `jsh.mb.*` auto-await.** `createPopup` and `getLastCommand` internally await ready state with a 10s timeout and reject on timeout or give-up.
- [x] **`stateChanged` event** on `MbApi` for prompt-widget reactivity.
- [x] **Token-length validation** in MB's `createServer` (`mb-shell.<token>` must fit lws's 63-char protocol-name buffer).

#### Next

- [ ] **Fork gate during reconnect.** Before `fork+exec`, if a handshake is in flight, wait briefly (500ms default) for either ready or give-up. Narrow race — OSC 58300 response could land on a child's stdin if the user submits an external command between `connect()` and the response arriving. Skip for AST nodes that contain no externals.
- [ ] **Popup lifecycle.** Fire-and-forget popups accumulate. Auto-close on next prompt / after N seconds / on focus-out; let the user opt out per-popup.
- [ ] **Status indicator widget.** A built-in header/footer widget users can add that reflects `jsh.mb.connected`, reacting to `stateChanged`. Snippet exists in `.jshrc` examples; ship a first-class version.
- [ ] **Types sync.** `mb-applet/types/mb.d.ts` is a manual copy. Publish `@masterbandit/types` from the MB repo (or script a sync), so `npm install` pulls the latest and breakage is caught at build time.
- [ ] **Permission narrowing.** Applet currently requests `ui,io.inject,shell,net.listen.local`. Drop `shell` → `shell.write,shell.commands`. Audit any future additions.
- [ ] **Bridge tests.** No coverage today for the handshake, protocol, or WS client. A `node-pty` + spawned-MB integration test would catch regressions; non-trivial to set up but essential for ship.
- [ ] **`@last` / `@claude` ergonomics.** Flags (`@last 3`, `@last err`, `@last --json`); `@claude` model/system/max_tokens as jshrc config rather than hardcoded; Keychain helper for secrets (`jsh.env.ANTHROPIC_API_KEY` wiring to `security find-generic-password` on macOS).
- [ ] **`jsh.export(name, value)` / `jsh.env.X` sugar** — write to both the shell variable store and `process.env` in one call. Most jshrc env-setting is one-shot at startup, but the ergonomics matter.

### Completion

- [ ] **Bash completion compat shim** — Implement `compgen`, `complete`, `compopt` builtins and `COMP_WORDS`/`COMP_CWORD`/`COMP_LINE`/`COMP_POINT`/`COMPREPLY` variables so bash completion scripts (e.g. `git-completion.bash`) can be sourced directly, similar to zsh's `bashcompinit`. Full design and scope in [BASH-COMPLETION.md](./BASH-COMPLETION.md). ~800 LOC, 2-3 days.

### Long-term exploration

- [ ] **Terminal emulator with overlay API** — A terminal app (separate project) that exposes an IPC/protocol API for client programs to create/manage visual regions: overlays, floating panels, positioned widgets, z-ordering. jsh would talk to it directly instead of relying on escape sequences. Would solve OSC 133 mark issues with header widgets and enable true popup menus, completion panels, inline documentation, etc. Useful beyond jsh for any TUI application.

### Not planned (initial scope)

- Windows support
- Full POSIX sh certification
- `zsh`/`bash` `.rc` compatibility
