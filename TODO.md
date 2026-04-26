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
- [x] `@{ expr }` as inline-JS argument to other `@`-fns (`@where @{ f => f.size > 1024 }`) — argument is the evaluated value, not a string

### Structured pipelines
- [x] Object-mode `@`-fns with in-process `AsyncIterable<unknown>` channels between adjacent stages (no fd/serialization)
- [x] Mixed bytes/objects pipelines via `@from-jsonl` / `@to-jsonl` adapters with fd boundaries
- [x] Type IR + schema extractor (TypeScript compiler API) extracted at build time for built-ins, on cache miss for user `.ts` jshrcs
- [x] Schema cache under `$XDG_CACHE_HOME/jsh/types/v1/` with atomic-rename writes, content-hash invalidation
- [x] Loader prologue auto-binds module-local `jsh._withSource(import.meta.url)` for `.ts`/`.mts` user files — registrations carry source URL automatically
- [x] `defaultSink` / `isSink` / `hidden` registry plumbing: source operators ship their own preferred formatter (e.g. `@ls` → `@ls-format`), executor auto-inserts when stdout is a tty
- [x] Built-ins shipped: `@ls`/`@ls-format` (BSD `ls -la` parity, NSS-backed uid/gid, LS_COLORS, xattr `@` marker), `@ps`, `@where`, `@select`, `@take`, `@count`, `@table`, `@from-jsonl`, `@to-jsonl`
- [x] Native bindings: `getpwuid_r` / `getgrgid_r` / `listxattr` for the formatter

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
- [x] Pipeline concurrency / deadlock fix tests (large builtin output → @-fn, compound + @-fn)
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

### Structured pipelines

The object-mode `@`-fn pipeline framework is shipped (channel, schema extraction + cache, loader prologue auto-mode for `.ts` rcs, `defaultSink`/`isSink`/`hidden`, `@{...}` as inline-JS arg form, schema-driven unquoted lambdas via `FunctionIR`). Built-ins so far: `@ls`/`@ls-format`, `@ps`, `@where`, `@select`, `@take`, `@count`, `@table`, `@from-jsonl`, `@to-jsonl`. Open work:

#### Ergonomics

- [x] **Path B — schema-driven unquoted lambda args.** `@where f => f.x > 10` without `@{...}`. Parser consults the registry at parse time; if the arg slot's schema declares `FunctionIR`, lexer switches to JS-expr-with-shell-terminators mode for that arg. The same parser-registry hookup unblocks the two items below.
- [ ] **Tab completion against schemas** — Tier 0: chain walk (~100 LOC) for `f.foo.<tab>` against the upstream stage's output schema. Argument-name completion (`@select <tab>` → field names from upstream). Defer nested-expression support (`f => arr.find(x => x.|)`) until TS 7's Go port lands and we can use live `getQuickInfoAtPosition`.
- [ ] **Pipeline construction-time validation** — Catch `@select cput` typos before the pipeline runs. The unifier already has the data; nothing reads it yet. Same parser-registry hookup as Path B.
- [ ] **Synchronous schema extraction on cache miss** — Today extraction is fire-and-forget for user `.ts` rcs; first-run users fall back to word-arg mode for unquoted lambdas until the cache populates. Optional sync path (`JSH_SYNC_SCHEMA_EXTRACT=1`?) at ~1s tsc cold-start cost.

#### Operator stdlib gaps

- [ ] `@sort` (buffered) — by key or lambda
- [ ] `@group` / `@group-by` — buffered aggregation
- [ ] `@uniq` (with optional key)
- [ ] `@map` — generic T→U transform via lambda
- [ ] `@drop`, `@first`, `@last`
- [ ] `@sum` / `@avg` / `@min` / `@max`
- [ ] `@find` — recursive walk
- [ ] `@du`, `@env`, `@hist`, `@stat`

#### Visual / formatter parity

- [ ] **`@ps-format`** — mimic `ps aux` like `@ls-format` mimics `ls -l`.
- [ ] **Per-field display formatters in generic `@table`** — date → relative time, mode → octal/symbolic, big numbers → human-readable. Type-driven, so user objects benefit too.
- [ ] **Wider LS_COLORS coverage** — symlink targets, char/block devices, fifos, sockets.
- [ ] **`@ls-format` short (non-`-l`) form** — currently always shows just the name when `-l` is absent. Match BSD `ls`'s columnar layout (multiple names per line, terminal-width-aware).

#### Cross-format adapters

- [ ] `@csv` / `@to-csv`
- [ ] `@yaml` / `@to-yaml`
- [ ] **Auto-adapter insertion** — `cat foo.json | @where ...` automatically inserts `@from-jsonl` at the bytes/objects boundary. Today rejected with an error. Use `defaultSink`-shaped declaration on common shapes, or a `from`/`to` registry per format.

#### Robustness / control

- [ ] **AbortSignal for cancellation** — Plumb through the IO context so buffered ops (`@sort`, `@group`) bail mid-run on Ctrl-C instead of running to completion before honoring it.
- [ ] **Per-row error policy** — `--on-error=fail|skip` flag on operators. Today a lambda throw kills the stage.

#### Polish

- [ ] **Tests for the `@{...}` arg form** — Migrated existing tests when adding it; needs explicit coverage for the new feature itself (mixing word + js args, errors on bad expressions, JS scope, etc.).
- [ ] **`jshrc.d.ts` updates** — Document the new contracts: `mode`, `isSink`, `hidden`, `defaultSink`, `JsArg`, the unknown-args signature.
- [ ] **DESIGN.md** — Document the object channel architecture, schema cache layout, sink/formatter pattern.
- [ ] **`@xattr`** — User-level access to extended attributes (read/list/set), mirroring the macOS `xattr` command. Native bindings already include `hasXattr`; add `listxattr` + `getxattr`.

#### MasterBandit applet host (jsh `@table` as first applet)

Generalize MB into an **applet host**: any program can ship a JS applet bundle that renders interactive UI inline at scrollback anchor points. jsh's `@table` is the first applet; future ones (htop replacement, db client, jq UI, image viewer, etc.) follow the same protocol. The `mb-applet/` package skeleton already exists (`src/applet.ts`, `src/protocol.ts`) — this work formalizes its contract.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────┐
│ MB host                                                      │
│   ├─ Applet registry (loaded JS bundles per OSC namespace)   │
│   ├─ Per-anchor widget surface (TerminalEmulator-like)       │
│   └─ WS multiplexer (data channels keyed by UUID)            │
└──────────────────────────────────────────────────────────────┘
        ▲                         ▲
        │ OSC anchors             │ data channels
        │ (PTY)                   │ (WS)
┌───────┴────────┐        ┌───────┴──────────┐
│ jsh            │        │ Other host app   │
│  emits @table  │        │  emits its OSC   │
│  ships its     │        │  ships its       │
│  applet bundle │        │  applet bundle   │
└────────────────┘        └──────────────────┘
```

**Applet contract (running on the MB side):**
```ts
// Shipped by each host program; loaded by MB at startup.
export interface Applet {
    namespace: string;                                     // e.g. "jsh-table"
    onAnchor(anchor: Anchor, channel: WsChannel): Lifecycle;
}
export interface Anchor {
    surface: TerminalEmulator;     // bounded virtual terminal at the row
    onResize(cb: (cols: number, rows: number) => void): void;
    onFocus(cb: () => void): void;
    onBlur(cb: () => void): void;
    onClose(cb: () => void): void;
    setHeight(rows: number): void; // applet-driven sizing
}
export interface Lifecycle { dispose(): void; }
```

The applet writes TUI escapes to the surface as if it's a small terminal. Same model as ncurses, but rendered inline at a fixed scrollback row instead of full-screen. Navigation, search, filter, sort — all standard TUI patterns. Applets can use existing TUI libraries (blessed, ink, etc.) if desired.

**Wire format (PTY OSC anchor + WS data channel):**
```
\e]7777;<namespace>;<uuid>;begin\x07
... applet runs ...
\e]7777;<namespace>;<uuid>;end\x07
```
- `<namespace>` selects the applet (`jsh-table`, `jsh-chart`, `othervendor-foo`, ...).
- `<uuid>` keys the WS data channel for this anchor.
- MB looks up the applet by namespace, instantiates it at the anchor, and routes a WS channel to it.
- `cancel` instead of `end` invalidates the anchor on failure.

**Capability detection.** New `supports-applets` bit in the existing MB handshake (cached). Each emission also re-checks `mb.connected`. Without the cap or with WS down, the host emits its plain text fallback.

**Applet discovery / loading.** Three options to settle:
- **Filesystem**: `~/.config/mb/applets/<namespace>/dist/applet.js` — discovered at MB startup.
- **Per-app advertise**: at handshake the connected app sends `applets: [{namespace, bundleUrl}]`; MB fetches.
- **Hybrid**: filesystem-installed for trusted/preinstalled, advertise for ephemeral.

Security note: loading JS from an attached program is dangerous. Probably default to filesystem-only; advertise mode requires explicit user opt-in.

**jsh's `@table` applet (the first concrete instance):**
- Lives in `mb-applet/src/` (skeleton already there).
- Namespace: `jsh-table`.
- Renders the table grid in a bounded TerminalEmulator surface. Arrow / `j`/`k` to scroll, `/` for incremental fuzzy filter, `s` to sort by column, Enter to copy a cell value back to the shell prompt.
- Schema-aware rendering: numbers right-align, dates as relative time, booleans as ✓/✗, file modes symbolic.
- Rows streamed in over the WS channel, applet renders incrementally.

**Failure path (mid-stream WS drop)** — same as before:
- **Default (buffered)** `@table`: keeps a row buffer; on cancel, jsh emits the full text fallback inline. No data loss. Bound = total table size; fine for `@ls`/`@ps`/finite results.
- **`@table --stream`**: opt-in for unbounded sources (`tail -f | @from-jsonl | @table`). Rows go straight to WS, no buffer. On cancel: emit a one-line notice; pushed data is lost.

**Open questions to settle on the protocol:**
- OSC namespace number (pick something safe / unassigned, vendor-prefix like `\e]7777;jsh-table` or split: `\e]7777;<vendor>;<applet>`).
- UUID provenance — pure client-random, or salted with a per-session secret exchanged at handshake (defends against external programs spoofing anchors).
- Anchor sizing model — applet-driven `setHeight(n)`, or MB allocates a fixed window and applet must fit?
- Anchor lifecycle when scrolled out of viewport — keep alive (memory cost), unmount + replay from cached data on scroll-back, or freeze rendered text only?
- Versioning — `\e]7777;v1;table;...` vs cap bits per version.
- Applet sandboxing — full WebView, isolated JS realm, vm context? Trade-off between expressivity and trust.

**User interaction model.** Reuses the existing OSC 133 navigation primitive in MB — widget anchors fold into the same "previous/next block" list as command-output blocks, no parallel selection model. Three states:

```
NORMAL         scrollback nav (Tab / arrow / mouse), no widget special
   │ select an anchor (existing OSC 133 nav)
   ▼
SELECTED       anchor highlighted, keys still go to host shell
   │ Enter (or dedicated keybind) to focus
   ▼
FOCUSED        keystrokes routed to the applet's TerminalEmulator surface;
               applet handles its own UI (arrows, /, expand/collapse, etc.)
   │ Esc / Ctrl-Esc / dedicated MB key
   ▼
NORMAL
```

Per-applet UX (illustrative; applets choose their own bindings inside FOCUSED state):
- `@table`: arrows scroll, `/` fuzzy-filter, `s` sort by column, Enter copy cell back to prompt.
- `@to-jsonl` JSON tree: arrows navigate, Tab/Enter expand/collapse, `/` key+value search, `n`/`N` next/prev match, `y` copy value, `p` copy path (`.users[3].email`) back to prompt.

**Open interaction questions to settle:**
- Focus-leave keybind — `Esc` is conventional but heavily overloaded; `Ctrl-Esc`, a dedicated MB key (`F12`?), or tmux-prefix style.
- Output arriving while focused — keep focus on current widget, queue new output below, don't auto-steal focus.
- Visual differentiation — border color for SELECTED, mode-line indicator (`-- WIDGET --` vim-style) for FOCUSED, ideally both.
- Mouse model — click anchor = select, double-click = focus, click outside = blur. Optional but expected.
- Modal-key conflicts when focused — applet wins for everything inside the surface; MB wins outside. Same model as tmux pane.

**Selection / clipboard ownership** — model C (hybrid):
- **Default (NORMAL / SELECTED state):** host owns mouse selection across pre-widget text → through widget cells → post-widget text. Cross-boundary drag-select works for free. Copy reads the visible rendered text from each region.
- **FOCUSED state:** applet can opt in to handle mouse + copy itself. Lets `@to-jsonl` select a JSON subtree, `@table` select a row, image viewer select a region. Applet exposes `getClipboardContent()` returning multi-format (`{plain, json, path, ...}`); host picks the best format the destination accepts.
- Selection ownership flips at the same boundary as keyboard ownership — applets opt in once, get both.

**Open clipboard / search questions:**
- Multi-format clipboard contract (`{plain, json, path, ...}`) and which platforms / native clipboards / OSC 52 paths support which formats.
- Selection rendering inside widget cells when host owns it — host inverts pixels uniformly, vs ask the applet to draw its own highlight (lets applets show semantic-shaped highlights).
- Cross-widget search (host-level Cmd-F) — does it dive into widget contents via an applet `searchableText()` hook, or stop at widget boundaries? Probably dive in.
- OSC 52 fallback — multi-format doesn't survive; remote sessions degrade to plain text only.

**Nested sub-TerminalEmulators.** Surfaces are recursive: an applet can host its own applet anchors inside its surface (a JSON tree applet embeds `@table` for array nodes; a chart applet embeds a data-preview table). State machine generalizes to a stack: each Esc pops one level (`NORMAL → SELECTED A → FOCUSED A → SELECTED B (inside A) → FOCUSED B → ...`). Selection / clipboard ownership applies recursively at the focused level (Model C, scoped per surface).

**Bounds on nesting (to keep it tractable):**
- **Depth cap** — e.g. max 4 levels. Each surface costs state + reflowable buffer; cap prevents runaway and buggy cycles.
- **Cycle detection** — *stack-scoped* on UUID. Each anchor's instantiation walks its own ancestor chain (parent → grandparent → ...); if its UUID matches one already on that chain, refuse and render an error placeholder ("cycle detected: anchor `<uuid>`"). Two cases that look superficially similar but are fine:
  - **Sibling same-UUID anchors** (two anchors with the same UUID, neither inside the other) — legitimate: the same data set rendered in two places in scrollback, or two applets sharing one dataset (cross-applet data sharing). They aren't on each other's stack, so the check passes.
  - **Same-namespace nesting** (e.g. a JSON tree containing another JSON tree for a subtree) — legitimate: different instances, different UUIDs, different stacks. Namespace-only detection would wrongly reject this.
  Only stack-self-recursion (same UUID literally appearing inside itself) is the real cycle.

  GC implication: when sibling same-UUID is allowed, MB's data store must refcount UUIDs by live-anchor count — single-owner GC would drop data while a sibling anchor still references it.
- **Resource budget** — per-surface memory / CPU quota; nested surfaces inherit a fraction or a flat per-surface cap.
- **Hosting API for applets** — outer applet calls `surface.spawnSub(namespace, uuid, channel)`; same loader machinery MB uses for top-level applets, exposed as a sub-API. Trust model is recursive: outer applet chose to host inner, so it's responsible for it.
- **UUIDs stay globally unique** (no nesting in ID structure); each parent surface tracks its child anchors so MB keeps a flat GC list.
- **Cross-level selection** — stays scoped to the currently-focused level; can't drag-select from outer through inner. Same logic as host↔widget, recursive. Fewer edge cases than allowing cross-level selection.

**Per-anchor offscreen textures (rendering optimization).** Render each anchor's surface into its own offscreen texture (GPU texture or bitmap). Scrollback paint becomes "walk anchors in viewport, blit each one's texture." Useful properties:
- **Sibling same-UUID = blit, not re-render.** Render once, blit anywhere the UUID appears; cost of duplicates approaches zero. Pairs naturally with the refcount-by-anchor-count GC for shared data sets.
- **Dirty tracking per-anchor.** Static widgets (e.g. an `@ls` output sitting in scrollback) don't repaint when nothing changed; host just re-blits cached texture. Only widgets with new data, focus transitions, or selection updates pay re-render cost.
- **Animation is localized.** Live `@chart` updates touch only its own texture; rest of scrollback is unaffected.
- **Selection overlays composited at blit time** (separate alpha layer) so the cached widget texture stays reusable across selection states.

Texture-model details to settle:
- Visible-portion + overscan for tall widgets (don't render 10,000 rows to a giant texture; GPU max is ~8k × 8k — tile or window).
- LRU cache eviction bounded by VRAM / RAM budget; re-render on next paint after eviction.
- Damage regions inside a texture (re-render only changed rows/cells, not the whole surface) for cheap animation.
- Texture-cache keying when sibling anchors differ in size — `(UUID, size)` variants, or one canonical texture scaled at blit (loses text crispness — likely use the variant cache).

**Per-anchor scroll capability (three flavors, applet-declared):**
1. **Bounded, no scroll** *(default)* — applet declares its size and handles its own navigation (table jumps row-to-row, tree expands/collapses). User scroll-wheel inside the widget routes to the applet's keymap, not to a built-in scroll. Right default for the common structured-data case.
2. **Scrollable surface** — applet writes to a buffer; surface clips to a fixed window with built-in scroll. User scroll-wheel inside the widget moves the view. Opt-in via `{ scrollable: true, maxHeight: N }`. Right for log tails, man pages, file previews — "stream of text" applets.
3. **Auto-grow surface** — surface grows to fit content. Functionally identical to "no widget at all"; if you want this, don't use a widget. Don't ship as a mode.

Interaction model with the pane refactor: NORMAL state scroll-wheel = host scrollback as today (moves past widgets like normal text); FOCUSED state with scrollable surface = surface's internal scroll; FOCUSED state with bounded surface = applet's keymap. Nested: focused level wins, same as keyboard.

**Prerequisite (MB side): pane / overlay refactor — DONE.** Applets can now create a subterminal in the scrollback of another terminal; the unified pane component provides scroll, focus, and sizing as built-in capabilities. Side benefit: popups (completion menu, search results, help overlay, command palette, etc.) inherit independent scroll for free, with uniform focus/selection/clipboard semantics.

**Sequencing:**
1. Settle the protocol (OSC shape, applet contract, WS framing, interaction state machine).
2. Build the MB-side applet host + loader + per-anchor TerminalEmulator surface + selection/focus integration with existing OSC 133 nav.
3. Build jsh's `@table` applet against the contract (the existing `mb-applet/` package).
4. Wire jsh's `@table` operator to emit the OSC + push data over WS when the cap is set.
5. Add a second applet (`@to-jsonl` JSON tree, or `@chart`) to validate the contract is genuinely reusable across very different UIs.

### Terminal / Input

- [ ] **Keybind system** — C++ action table indexed by key enum, JS sets bindings via `jsh.bindKey("ctrl-a", "move-home")`. Custom JS callbacks for `"custom"` action. Default bindings built-in, user-overridable.
- [ ] **Kill ring size default / configurability.** Hardcoded at 8 today (matches zsh `KRINGCTDEF`). Worth revisiting: bumping the default to ~20–30 costs nothing memory-wise and better matches how people actually use Alt-Y. Ideally expose `jsh.setKillRingSize(n)` so jshrc can override.
- [ ] **History file path + max length from jshrc.** Both are hardcoded in `startRepl` (`~/.jsh_history`, 1000 entries). Expose `jsh.history.setPath(p)` / `jsh.history.setMaxLen(n)` (or `jsh.$.HISTFILE` / `jsh.$.HISTSIZE` if we want bash/zsh-style env-var driven config).
- [ ] **History dedup / ignore rules.** zsh has `HISTIGNORE`, `HISTCONTROL` (`ignoredups`, `ignorespace`, `erasedups`). jsh currently stores every accepted line unconditionally. Add jshrc-settable filters — ignore consecutive duplicates, ignore space-prefixed, ignore matching patterns.
- [ ] **Shell options (`set -o`) from jshrc.** The shell-option table exists (`errexit`, `nounset`, `xtrace`, `pipefail`, etc.) but there's no clean API to set them from `.jshrc` — user has to `exec("set -o errexit")`. Expose `jsh.setOption(name, value)` or `jsh.options.errexit = true`.
- [ ] **Named internal widgets assignable to zones** — Allow JS to place built-in UI elements (e.g. search indicator, completion menu) into any zone via `jsh.addWidget("search-indicator", "footer")` with a name instead of a render function. The engine looks up "what zone is this element in?" and renders it there. This lets users control where Ctrl-R/Ctrl-S search text, completion candidates, etc. appear in the layout.
- [ ] **Fixed-size headers per editing session** — Lock header widget line count at session start so frame geometry is stable. Widget updates can change content but not add/remove lines. This fixes OSC 133 mark positioning (the input line row is known and doesn't shift) and simplifies the renderer. Dynamic-size content (completion menus, popups) should go in the footer zone.
- [ ] **Dynamic overlay widgets** — Support popup menus (completion candidates, context menus) as overlays that don't affect the primary frame geometry. Needed if widget sizes are locked for OSC 133 compatibility.

### Testing

- [ ] **Interactive terminal test framework** — Use `node-pty` + headless `xterm.js` to spawn jsh in a real PTY, send keystrokes, and assert against the virtual screen buffer. Enables testing widgets, cursor positioning, ghost text, multi-line rendering, Ctrl-R/Ctrl-S search, tab completion cycling, and other UI behavior that can't be verified via `spawnSync` + stdout capture.
- [ ] **Completion coverage gaps.** `test/completion.test.ts` exercises the TS `getCompletions` layer only. Nothing tests:
  - **Native menu state machine** — state 1 (grid shown) → 2 (tentative insert) transitions on Tab / Shift-Tab, arrow nav (`menuNavigate`), viewport scrolling, Enter/Esc/other-key exit paths, `menuClose` with and without restore, the `/`-swallow after a directory match, single-match auto-space.
  - **Splice logic** (`spliceCompletion`) — `completion_pre` + entry + `completion_tail` composition; buflen truncation ordering; cursor placement; cycle-mode "past-end restores original".
  - **Object-return bridge** — `replaceStart`/`replaceEnd`, `displays`, `types`, `ambiguous` all round-tripping from TS through the N-API boundary correctly, both sync and async (`inputSetCompletions`) paths.
  - **Menu rendering** — `menuLayout` column width from widest display, `menuRenderLines` row/col dispatch, LS_COLORS SGR wrapping, inverse-video selection covering padding, viewport windowing.
  - **LCP extension** behavior — the `ambiguous` flag correctly suppresses auto-space; next Tab after an LCP extension recomputes and either extends further or shows the real list.
  - Most of this needs the interactive terminal test framework above to do it properly — but isolated unit tests for `spliceCompletion` and `menuLayout`/`menuRenderLines` could cover a lot of the splice + layout math without a PTY.

### Technical debt

- [ ] **Arithmetic evaluation via `new Function()`** — Currently uses JS semantics, not POSIX arithmetic. Differences include floating-point instead of integer-only, JS operator precedence edge cases, and no integer overflow behavior. Consider a dedicated integer arithmetic evaluator for correctness.
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
- [x] **Per-call `jsh.mb.*` auto-await.** Request/response methods (`createPopup`, `getSelectedCommand`, etc.) internally await ready state with a 10s timeout and reject on timeout or give-up.
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
- [ ] **Context-aware completion inside quotes / `$(…)` / `${…}`** — the lexer-driven `getCompletions` currently bails on a Word token whose cursor falls inside a nested segment (quoted string, command substitution, parameter expansion, arithmetic). Should descend into the segment: lex the inner text for command-sub, adjust replacement range to stay inside the quotes, complete variable names for `${…:-default<cursor>`, etc. Mirrors zsh's `zle_tricky.c:1480+` dispatch. ~200 LOC, 1 day.
- [ ] **Quote auto-close on completion** — completing `"/et<Tab>` inside an unterminated double-quoted string should close the quote and append a space (zsh's `m->autoq` logic). Needs `CompletionEntry` to carry quote context.
- [ ] **Dangling-symlink auto-space suppression** — zsh's `CMF_FILE && !sr` logic skips the auto-space after a single file match when `stat` fails (dangling symlink, stale result, broken completer). jsh currently auto-spaces for any non-directory single match regardless of whether the path resolves. Fix: carry an `exists`/`type` hint on `CompletionEntry` from the source and read it in the native splice path. Rare edge (dangling symlinks), low priority.
- [ ] **Per-match "no space" flag** — zsh completers use `CMF_NOSPACE` / `compadd -n` to say "don't auto-space this particular match" (e.g., git aliases ending in `!`, subcommands that take immediate args). Expose via `{ text, noSpace: true }` on `CompletionEntry`.
- [ ] **Auto-remove-space** — zsh's `AUTOREMOVESLASH` / `autoparamkeys`: if the user types `|`, `;`, `&`, `)`, etc. immediately after the auto-added space, zsh pulls the space back so the line looks clean. jsh leaves `cmd foo |` with the stray space. Mirror by tracking "just auto-appended a space" state, consume it on those trigger keys.
- [ ] **Custom per-match suffixes** (`compadd -S`) — zsh completers can register arbitrary closing text per match (e.g., closing parens, URL query delimiters). No equivalent hook on jsh's `CompletionEntry` today. Low priority.
- [ ] **Description column in menu-complete grid** — descriptions are already plumbed native-side (`completion_descriptions`); `menuRenderLines` doesn't use them. zsh renders descriptions in a right-aligned column next to the entry name. Moderate effort, ~100 LOC.
- [ ] **Empty-handler fallback to file completion** — when a per-command handler (e.g. `git`) returns zero candidates, jsh currently shows nothing; zsh's multi-completer chain (`_complete _match _approximate`, configured via zstyle) falls through to generic file completion, which is why `git add <Tab>` in a clean tree still lists files/dirs. Simple fix: if the handler returns `[]`, fall through to `completeFileOrGlob(current)` in `getCompletions`. Bigger fix: a proper completer chain users can configure. Unclear how often this matters in practice beyond the `git add` case.
- [x] **LS_COLORS colorization** in the menu-complete grid. Implemented via `jsh.setListColors(process.env.LS_COLORS ?? "")`. GNU format only (zsh itself doesn't parse BSD `LSCOLORS`). `CompletionEntry.type` carries `"file"|"dir"|"exec"|"link"`; `completeFile`/`completeFileOrGlob` set it via `lstat`+`stat`. Native parses colon-separated `key=SGR` rules (two-letter codes + `*.ext`) and wraps each grid cell's display text in the matching SGR. Inverse-video selection overrides the color.

### Daemon + CLI client

- [ ] **`jshd` daemon + `jshcli` client** — avoid Node cold-start (~80-120ms) for scripting use cases (scripts, CI, Makefiles invoking jsh). Strictly non-interactive — does NOT target running interactive jsh sessions (too many state-isolation hazards: cwd, `$?`, shell options, history, tcsetpgrp, concurrent clients — not worth the complexity).
  - **`jshd`**: long-running jsh started with `jsh --daemon` or equivalent. Loads jshrc, stays warm with full state (Anthropic SDK, secrets, `@`-function handlers, aliases). Listens on a Unix socket at `$XDG_RUNTIME_DIR/jshd.sock` (or `/tmp/jshd-$UID.sock` on macOS).
  - **`jshcli`**: tiny C program. Connects to the socket, sends the command (read from argv `-c` or stdin), forwards stdout/stderr streams back, returns the exit code. No TTY, no line editor, no readline.
  - **Autospawn**: if `jshcli` fails to connect, optionally fork+exec `jshd` in the background, wait briefly for the socket, then retry. Opt-out via flag / env var.
  - **Wire protocol**: WebSocket over Unix socket. `ws` dep already in the project (MB bridge). **Hybrid framing** so streaming large stdin/stdout doesn't pay base64 overhead:
    - **Text frames** (JSON) for control:
      - Client → daemon: `{type:"exec", cmd, cwd, env}` (handshake), `{type:"stdin-end"}` (EOF), `{type:"signal", sig:"INT"}` (SIGINT forwarding).
      - Daemon → client: `{type:"exit", code}` (command done).
    - **Binary frames** for data chunks. First byte = stream ID (`0x00`=stdin, `0x01`=stdout, `0x02`=stderr), rest = raw bytes. Supports `cat /tmp/largefile | jshcli @claude | grep …` without base64 tax.
    - **Backpressure**: writer pauses when `ws.bufferedAmount` > 1 MiB, resumes on drain. `stream.pipeline` wrappers make this automatic on the Node side.
  - **C client**: hand-roll a minimal WS client over Unix socket (~200 LOC) or link against libwebsockets (MB build vendors it; could share).
  - **Concurrency**: the daemon's *state* is single-threaded (Node event loop), but multiple in-flight RPCs are fine as long as each command runs in its own subshell `( ... )` to keep cwd/vars/opts isolated. That's the only isolation layer needed for a dedicated daemon; no foreign user to protect from.
  - Scope: ~300 LOC C client + ~200 LOC in jsh (socket listener, subshell-wrap request handler, protocol framing). A couple of days.
  - **Not in scope**: interactive TTY forwarding (tmux-style attach — a different, bigger feature); serving RPCs from inside a running interactive jsh (rejected — state-mutation risk).

### Long-term exploration

- [ ] **Terminal emulator with overlay API** — A terminal app (separate project) that exposes an IPC/protocol API for client programs to create/manage visual regions: overlays, floating panels, positioned widgets, z-ordering. jsh would talk to it directly instead of relying on escape sequences. Would solve OSC 133 mark issues with header widgets and enable true popup menus, completion panels, inline documentation, etc. Useful beyond jsh for any TUI application.

### Not planned (initial scope)

- Windows support
- Full POSIX sh certification
- `zsh`/`bash` `.rc` compatibility
