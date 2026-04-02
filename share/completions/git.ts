// Git tab-completion module.
// Usage in jshrc: import { gitCompletions } from 'jsh/share/completions/git';
//                 gitCompletions(jsh);

interface CompletionCtx { words: string[]; current: string }
interface JshApi {
    complete(cmd: string, fn: (ctx: CompletionCtx) => string[] | Promise<string[]>): void;
    exec(cmd: string): Promise<{ ok: boolean; stdout: string }>;
}

// ---- Stderr suppression wrapper ---------------------------------------------

/** Run a git command with stderr suppressed (2>/dev/null). */
async function git(jsh: JshApi, cmd: string): Promise<{ ok: boolean; stdout: string }> {
    return jsh.exec(cmd + ' 2>/dev/null');
}

/** Run a git command, split stdout into lines. */
async function gitLines(jsh: JshApi, cmd: string): Promise<string[]> {
    const r = await git(jsh, cmd);
    if (!r.ok) return [];
    return r.stdout.split('\n').filter(f => f.length > 0);
}

// ---- Caching ----------------------------------------------------------------

interface Cache<T> {
    value: T;
    ts: number;
}

const CACHE_TTL = 5000; // 5 seconds

const cacheStore = new Map<string, Cache<unknown>>();

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = cacheStore.get(key) as Cache<T> | undefined;
    if (entry && now - entry.ts < CACHE_TTL) {
        return Promise.resolve(entry.value);
    }
    return fn().then(value => {
        cacheStore.set(key, { value, ts: now });
        return value;
    });
}

// ---- Alias resolution -------------------------------------------------------

/** Load git aliases and resolve to their underlying commands.
 *  Returns a map of alias → resolved command name. */
async function loadAliases(jsh: JshApi): Promise<Map<string, string>> {
    return cached('aliases', async () => {
        const lines = await gitLines(jsh, 'git config --get-regexp "^alias\\."');
        const aliases = new Map<string, string>();
        for (const line of lines) {
            // Format: "alias.foo command args..."
            const spaceIdx = line.indexOf(' ');
            if (spaceIdx === -1) continue;
            const aliasName = line.slice(6, spaceIdx); // strip "alias."
            const cmdline = line.slice(spaceIdx + 1).trim();
            // Resolve: skip shell commands (starting with !)
            if (cmdline.startsWith('!')) continue;
            // Take the first word as the aliased command.
            const cmd = cmdline.split(/\s+/)[0] ?? '';
            if (cmd) aliases.set(aliasName, cmd);
        }
        // Resolve alias chains (alias pointing to another alias).
        for (const [name, cmd] of aliases) {
            const seen = new Set([name]);
            let resolved = cmd;
            while (aliases.has(resolved) && !seen.has(resolved)) {
                seen.add(resolved);
                resolved = aliases.get(resolved)!;
            }
            aliases.set(name, resolved);
        }
        return aliases;
    });
}

// ---- Ref helpers ------------------------------------------------------------

/** Local branches via for-each-ref (sorted by recency). */
async function localBranches(jsh: JshApi, prefix: string): Promise<string[]> {
    const lines = await gitLines(jsh, 'git for-each-ref --format="%(refname:strip=2)" --sort=-committerdate refs/heads/');
    return lines.filter(f => f.startsWith(prefix));
}

/** All branches (local + remote) via for-each-ref. */
async function allBranches(jsh: JshApi, prefix: string): Promise<string[]> {
    const [local, remote] = await Promise.all([
        gitLines(jsh, 'git for-each-ref --format="%(refname:strip=2)" --sort=-committerdate refs/heads/'),
        gitLines(jsh, 'git for-each-ref --format="%(refname:strip=2)" refs/remotes/'),
    ]);
    return [...new Set([...local, ...remote])].filter(f => f.startsWith(prefix));
}

/** Unique remote branch names (strip remote prefix, deduplicate). */
async function uniqueRemoteBranches(jsh: JshApi, prefix: string): Promise<string[]> {
    const lines = await gitLines(jsh, 'git for-each-ref --format="%(refname:strip=3)" refs/remotes/');
    return [...new Set(lines)].filter(f => f !== 'HEAD' && f.startsWith(prefix));
}

/** Tags sorted by creation date (newest first). */
async function tagList(jsh: JshApi, prefix: string): Promise<string[]> {
    const lines = await gitLines(jsh, 'git tag --sort=-creatordate');
    return lines.filter(f => f.startsWith(prefix));
}

/** Special heads (HEAD, FETCH_HEAD, ORIG_HEAD, etc.). */
const SPECIAL_HEADS = [
    'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD',
    'REBASE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_HEAD',
];

/** All refs: local branches + remote branches + tags + special heads. */
async function allRefs(jsh: JshApi, prefix: string): Promise<string[]> {
    const [branches, tags] = await Promise.all([
        allBranches(jsh, prefix),
        tagList(jsh, prefix),
    ]);
    const heads = SPECIAL_HEADS.filter(h => h.startsWith(prefix));
    return [...new Set([...branches, ...tags, ...heads])];
}

/** Recent commits (abbreviated hash). */
async function recentCommits(jsh: JshApi, prefix: string, max = 50): Promise<string[]> {
    const lines = await gitLines(jsh, `git log --no-show-signature --oneline --max-count=${max}`);
    return lines.map(l => l.split(' ')[0] ?? '').filter(h => h && h.startsWith(prefix));
}

/** Refs + recent commits. */
async function refsAndCommits(jsh: JshApi, prefix: string): Promise<string[]> {
    const [refs, commits] = await Promise.all([
        allRefs(jsh, prefix),
        recentCommits(jsh, prefix),
    ]);
    return [...new Set([...refs, ...commits])];
}

/** Remotes. */
async function remoteList(jsh: JshApi, prefix: string): Promise<string[]> {
    const lines = await gitLines(jsh, 'git remote');
    return lines.filter(f => f.startsWith(prefix));
}

/** Stash entries. */
async function stashList(jsh: JshApi, prefix: string): Promise<string[]> {
    const lines = await gitLines(jsh, 'git stash list --format="%gd"');
    return lines.filter(f => f.startsWith(prefix));
}

/** Reflog entries. */
async function reflogList(jsh: JshApi, prefix: string): Promise<string[]> {
    const lines = await gitLines(jsh, 'git reflog --no-decorate --format="%h %gs"');
    return lines.map(l => l.split(' ')[0] ?? '').filter(h => h && h.startsWith(prefix));
}

// ---- Range completion (main..feature, HEAD~3...main) ------------------------

/** Complete ref ranges with .. or ... operators. */
async function refRanges(jsh: JshApi, prefix: string): Promise<string[]> {
    // Check if prefix contains a range operator.
    const dotIdx = prefix.indexOf('..');
    if (dotIdx === -1) {
        // No range operator yet — complete refs, and also offer refs with .. and ... appended.
        const refs = await allRefs(jsh, prefix);
        // Also return refs with range operators so typing a ref then tab can extend.
        return refs;
    }

    // Has range operator — complete the right side.
    const threeDot = prefix[dotIdx + 2] === '.';
    const op = threeDot ? '...' : '..';
    const leftSide = prefix.slice(0, dotIdx);
    const rightPrefix = prefix.slice(dotIdx + op.length);

    const refs = await allRefs(jsh, rightPrefix);
    return refs.map(r => leftSide + op + r);
}

// ---- File status via git status --porcelain --------------------------------

type FileCategory =
    | 'modified' | 'modified-staged' | 'deleted' | 'deleted-staged'
    | 'untracked' | 'added' | 'renamed' | 'copied' | 'unmerged';

/** Parse `git status --porcelain` into categorized file lists.
 *  Untracked files are fetched separately via `ls-files` to avoid
 *  forcing `-u` (which can be slow in large repos when the user
 *  has disabled `status.showUntrackedFiles`). */
async function statusFiles(jsh: JshApi, prefix: string, ...categories: FileCategory[]): Promise<string[]> {
    const catSet = new Set(categories);
    const wantUntracked = catSet.has('untracked');
    catSet.delete('untracked');

    const promises: Promise<string[]>[] = [];

    // Tracked file status from porcelain (without untracked — fast).
    if (catSet.size > 0) {
        promises.push((async () => {
            const r = await git(jsh, 'git status --porcelain -uno');
            if (!r.ok) return [];

            const files: string[] = [];
            for (const line of r.stdout.split('\n')) {
                if (!line || line.length < 4) continue;
                const x = line[0]!;
                const y = line[1]!;
                const path = line.slice(3);
                const actualPath = (x === 'R' || x === 'C') ? (path.split(' -> ')[1] ?? path) : path;

                if (catSet.has('modified') && y === 'M') files.push(actualPath);
                if (catSet.has('modified-staged') && x === 'M') files.push(actualPath);
                if (catSet.has('deleted') && y === 'D') files.push(actualPath);
                if (catSet.has('deleted-staged') && x === 'D') files.push(actualPath);
                if (catSet.has('added') && x === 'A') files.push(actualPath);
                if (catSet.has('renamed') && x === 'R') files.push(actualPath);
                if (catSet.has('copied') && x === 'C') files.push(actualPath);
                if (catSet.has('unmerged') && (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))) {
                    files.push(actualPath);
                }
            }
            return files;
        })());
    }

    // Untracked files via ls-files (separate, respects config).
    if (wantUntracked) {
        promises.push(gitLines(jsh, 'git ls-files -o --exclude-standard'));
    }

    const results = await Promise.all(promises);
    const all = results.flat();
    return [...new Set(all)].filter(f => f.startsWith(prefix));
}

// ---- Flag maps --------------------------------------------------------------

const flagMap: Record<string, string[]> = {
    add: [
        '-A', '--all', '-p', '--patch', '-n', '--dry-run', '-f', '--force',
        '-v', '--verbose', '-i', '--interactive', '-e', '--edit',
        '-u', '--update', '-N', '--intent-to-add', '--refresh',
        '--chmod', '--ignore-errors', '--ignore-missing',
        '--pathspec-from-file', '--pathspec-file-nul',
    ],
    bisect: [],
    blame: [
        '-L', '-l', '-t', '-S', '--reverse', '-p', '--porcelain',
        '--line-porcelain', '--incremental', '--encoding',
        '-M', '-C', '--score-debug', '--show-stats', '--show-name',
        '--show-number', '-e', '--show-email', '-w', '--color-lines',
        '--color-by-age', '--abbrev', '--no-abbrev',
    ],
    branch: [
        '-a', '--all', '-d', '--delete', '-D', '-f', '--force',
        '-m', '--move', '-M', '-c', '--copy', '-C',
        '-r', '--remotes', '-v', '--verbose', '-t', '--track',
        '--no-track', '--set-upstream-to', '--unset-upstream',
        '--merged', '--no-merged', '--contains', '--no-contains',
        '--edit-description', '--list', '--sort', '--points-at',
        '--format', '--color', '--no-color',
    ],
    checkout: [
        '-b', '-B', '-t', '--track', '--no-track', '-f', '--force',
        '-q', '--quiet', '--detach', '--guess', '--no-guess',
        '--recurse-submodules', '--no-recurse-submodules',
        '--progress', '--no-progress', '--theirs', '--ours',
        '--overlay', '--no-overlay', '--pathspec-from-file',
        '--pathspec-file-nul', '--ignore-skip-worktree-bits',
    ],
    cherry: [
        '--no-commit', '-x', '-e', '--edit', '--ff',
        '-S', '--gpg-sign', '-s', '--signoff', '--strategy',
        '-X', '--strategy-option',
    ],
    clean: [
        '-d', '-f', '--force', '-n', '--dry-run', '-q', '--quiet',
        '-e', '--exclude', '-x', '-X', '-i', '--interactive',
    ],
    clone: [
        '--bare', '--mirror', '--depth', '--single-branch',
        '--no-single-branch', '--branch', '--no-tags',
        '--recurse-submodules', '--shallow-submodules',
        '-j', '--jobs', '--filter', '--sparse', '--progress',
        '-q', '--quiet', '-v', '--verbose',
    ],
    commit: [
        '-m', '--message', '-a', '--all', '--amend', '--no-edit',
        '-v', '--verbose', '-s', '--signoff', '-S', '--gpg-sign',
        '-e', '--edit', '-p', '--patch', '--fixup', '--squash',
        '--reset-author', '--author', '--cleanup', '--date',
        '-C', '--reuse-message', '-c', '--reedit-message',
        '--dry-run', '--short', '--porcelain', '--long',
        '--status', '--no-status', '-i', '--include', '-o', '--only',
        '--trailer', '-t', '--template', '--pathspec-from-file',
        '--allow-empty', '--allow-empty-message', '--no-verify',
    ],
    config: [
        '--global', '--system', '--local', '--worktree', '--file',
        '--blob', '-l', '--list', '--get', '--get-all',
        '--get-regexp', '--replace-all', '--add', '--unset',
        '--unset-all', '--rename-section', '--remove-section',
        '-e', '--edit', '--type', '--no-type', '--null',
        '--name-only', '--show-origin', '--show-scope',
        '--default', '--fixed-value',
    ],
    describe: [
        '--all', '--tags', '--contains', '--abbrev', '--candidates',
        '--exact-match', '--debug', '--long', '--match',
        '--exclude', '--always', '--first-parent', '--dirty',
        '--broken',
    ],
    diff: [
        '--staged', '--cached', '--stat', '--name-only',
        '--name-status', '--no-index', '--check', '--abbrev',
        '--binary', '--color', '--no-color', '--color-words',
        '--color-moved', '--compact-summary', '--full-index',
        '--histogram', '--patience', '--minimal', '--ignore-space-change',
        '-b', '--ignore-all-space', '-w', '--ignore-blank-lines',
        '--inter-hunk-context', '--word-diff', '--word-diff-regex',
        '--diff-filter', '--relative', '--submodule', '-p', '--patch',
        '-u', '--unified', '-s', '--no-patch', '--output',
        '--raw', '--numstat', '--shortstat', '--dirstat',
        '--summary', '--find-renames', '-M', '--find-copies', '-C',
    ],
    difftool: [
        '-d', '--dir-diff', '-y', '--no-prompt', '--prompt',
        '-t', '--tool', '--tool-help', '--no-symlinks',
        '-x', '--extcmd', '-g', '--gui', '--no-gui',
        '--trust-exit-code', '--no-trust-exit-code',
    ],
    fetch: [
        '-q', '--quiet', '-v', '--verbose', '-a', '--append',
        '-f', '--force', '-p', '--prune', '-P', '--prune-tags',
        '--all', '--atomic', '-m', '--multiple', '-t', '--tags',
        '-j', '--jobs', '--dry-run', '--depth', '--deepen',
        '--shallow-since', '--shallow-exclude', '--unshallow',
        '--refetch', '--filter', '-4', '--ipv4', '-6', '--ipv6',
        '--write-fetch-head', '--no-write-fetch-head',
        '--progress', '--no-progress', '--recurse-submodules',
        '--no-recurse-submodules', '--set-upstream',
    ],
    'format-patch': [
        '-o', '--output-directory', '--no-stat', '-p', '--no-patch',
        '--minimal', '--patience', '--histogram',
        '-s', '--signoff', '--stdout', '--cover-letter',
        '--numbered', '-N', '--no-numbered', '--start-number',
        '--cover-from-description', '--subject-prefix',
        '--rfc', '--from', '--to', '--cc', '--in-reply-to',
        '--thread', '--no-thread', '-v', '--reroll-count',
        '--base', '--notes', '--no-notes', '--signature',
        '--no-signature', '--signature-file', '--quiet',
        '--progress', '--interdiff', '--range-diff',
    ],
    grep: [
        '-i', '--ignore-case', '-w', '--word-regexp',
        '-v', '--invert-match', '-E', '--extended-regexp',
        '-P', '--perl-regexp', '-F', '--fixed-strings',
        '-n', '--line-number', '-l', '--files-with-matches',
        '-L', '--files-without-match', '-c', '--count',
        '--all-match', '-q', '--quiet', '--max-depth',
        '-e', '-f', '--and', '--or', '--not', '--break',
        '--heading', '--show-function', '-p',
        '--untracked', '--no-index', '--recurse-submodules',
    ],
    help: [
        '-a', '--all', '-g', '--guides', '-i', '--info',
        '-m', '--man', '-w', '--web',
    ],
    init: [
        '--bare', '--template', '--shared', '--initial-branch',
        '-b', '-q', '--quiet',
    ],
    log: [
        '--oneline', '--graph', '--all', '--stat', '--pretty',
        '--format', '--abbrev-commit', '--no-abbrev-commit',
        '--decorate', '--no-decorate', '--source',
        '-n', '--max-count', '--skip',
        '--since', '--until', '--after', '--before',
        '--author', '--committer', '--grep', '--all-match',
        '--invert-grep', '-i', '--regexp-ignore-case',
        '-E', '--extended-regexp', '-F', '--fixed-strings',
        '-P', '--perl-regexp', '--merges', '--no-merges',
        '--min-parents', '--max-parents', '--first-parent',
        '--branches', '--tags', '--remotes', '--glob', '--exclude',
        '--reflog', '--walk-reflogs', '--topo-order',
        '--author-date-order', '--date-order', '--reverse',
        '--follow', '--full-diff', '--log-size',
        '-p', '--patch', '--raw', '--numstat', '--shortstat',
        '--name-only', '--name-status', '--diff-filter',
        '--date', '--relative-date',
        '--show-signature', '--show-notes', '--no-notes',
        '-S', '-G', '-L',
    ],
    merge: [
        '--commit', '--no-commit', '-e', '--edit', '--no-edit',
        '--ff', '--no-ff', '--ff-only',
        '-S', '--gpg-sign', '--no-gpg-sign',
        '--log', '--no-log', '--signoff', '--no-signoff',
        '--stat', '-n', '--no-stat',
        '--squash', '--no-squash',
        '-s', '--strategy', '-X', '--strategy-option',
        '--verify-signatures', '--no-verify-signatures',
        '--abort', '--continue', '--quit',
        '-q', '--quiet', '-v', '--verbose',
        '--allow-unrelated-histories', '--progress', '--no-progress',
    ],
    mergetool: [
        '-t', '--tool', '--tool-help',
        '-y', '--no-prompt', '--prompt',
        '-g', '--gui', '--no-gui',
    ],
    mv: [
        '-f', '--force', '-k', '-n', '--dry-run', '-v', '--verbose',
    ],
    pull: [
        '-q', '--quiet', '-v', '--verbose',
        '--all', '-a', '--append', '-f', '--force', '-p', '--prune',
        '--progress', '--no-progress',
        '--commit', '--no-commit', '-e', '--edit', '--no-edit',
        '--ff', '--no-ff', '--ff-only',
        '-S', '--gpg-sign', '--no-gpg-sign',
        '--log', '--no-log', '--signoff', '--no-signoff',
        '--stat', '-n', '--no-stat',
        '--squash', '--no-squash',
        '-s', '--strategy', '-X', '--strategy-option',
        '--verify-signatures', '--no-verify-signatures',
        '--allow-unrelated-histories',
        '-r', '--rebase', '--no-rebase', '--autostash',
        '--verify', '--no-verify',
        '--depth', '--deepen', '--shallow-since', '--shallow-exclude',
        '--unshallow', '--update-shallow',
        '-j', '--jobs', '--upload-pack',
    ],
    push: [
        '-f', '--force', '--force-with-lease', '--force-if-includes',
        '-u', '--set-upstream', '--tags', '--follow-tags',
        '--dry-run', '--no-verify', '--delete',
        '--all', '--mirror', '--prune',
        '-q', '--quiet', '-v', '--verbose',
        '--progress', '--no-progress',
        '--atomic', '--signed', '--no-signed',
        '--recurse-submodules', '--no-recurse-submodules',
        '-4', '--ipv4', '-6', '--ipv6',
    ],
    rebase: [
        '-i', '--interactive', '--abort', '--continue', '--skip',
        '--onto', '--keep-empty', '--no-keep-empty',
        '--autosquash', '--no-autosquash',
        '--autostash', '--no-autostash',
        '-S', '--gpg-sign', '--no-gpg-sign',
        '-q', '--quiet', '-v', '--verbose',
        '--stat', '--no-stat',
        '-s', '--strategy', '-X', '--strategy-option',
        '--verify', '--no-verify',
        '--force-rebase', '-f',
        '--fork-point', '--no-fork-point',
        '--root', '--reschedule-failed-exec',
        '--rebase-merges', '--no-rebase-merges',
        '--update-refs', '--no-update-refs',
    ],
    reflog: [],
    remote: [],
    reset: [
        '--soft', '--mixed', '--hard', '--keep', '--merge',
        '-q', '--quiet', '-p', '--patch',
        '--pathspec-from-file', '--pathspec-file-nul',
    ],
    restore: [
        '-s', '--source', '-p', '--patch',
        '-W', '--worktree', '-S', '--staged',
        '--ours', '--theirs', '-m', '--merge',
        '--ignore-unmerged', '--ignore-skip-worktree-bits',
        '--overlay', '--no-overlay',
        '--pathspec-from-file', '--pathspec-file-nul',
    ],
    revert: [
        '--no-commit', '-n', '-e', '--edit', '--no-edit',
        '-S', '--gpg-sign', '--no-gpg-sign',
        '-s', '--signoff', '--no-signoff',
        '--abort', '--continue', '--skip', '--quit',
        '-m', '--mainline', '--strategy', '-X', '--strategy-option',
    ],
    rm: [
        '-f', '--force', '-r', '--cached', '-n', '--dry-run',
        '-q', '--quiet', '--pathspec-from-file', '--pathspec-file-nul',
    ],
    shortlog: [
        '-n', '--numbered', '-s', '--summary', '-e', '--email',
        '-w', '--group', '--format', '--date', '--no-merges',
    ],
    show: [
        '--format', '--pretty', '--abbrev-commit', '--no-abbrev-commit',
        '--oneline', '--encoding', '--expand-tabs', '--no-expand-tabs',
        '--notes', '--no-notes', '-s', '--no-patch',
        '--show-signature', '--stat', '--name-only', '--name-status',
        '--color', '--no-color', '-p', '--patch',
    ],
    stash: [
        '--keep-index', '--no-keep-index',
        '-u', '--include-untracked', '-S', '--staged',
        '-a', '--all', '-p', '--patch',
        '-m', '--message', '-q', '--quiet',
    ],
    status: [
        '-s', '--short', '-b', '--branch', '--porcelain',
        '-z', '-u', '--untracked-files', '--ignore-submodules',
        '-v', '--verbose', '--no-ahead-behind', '--ahead-behind',
        '--renames', '--no-renames', '--long', '--show-stash',
        '--column', '--no-column',
        '--pathspec-from-file', '--pathspec-file-nul',
    ],
    submodule: [],
    switch: [
        '-c', '--create', '-C', '--force-create',
        '-d', '--detach', '--guess', '--no-guess',
        '-f', '--force', '-m', '--merge',
        '-t', '--track', '--no-track',
        '--orphan', '--ignore-other-worktrees',
        '--recurse-submodules', '--no-recurse-submodules',
        '-q', '--quiet', '--progress', '--no-progress',
        '--conflict',
    ],
    tag: [
        '-a', '--annotate', '-s', '--sign', '-d', '--delete',
        '-v', '--verify', '-f', '--force', '-l', '--list',
        '--contains', '--no-contains', '-m', '--message',
        '-F', '--file', '-u', '--local-user', '--cleanup',
        '--create-reflog', '--no-create-reflog',
        '--color', '--no-color', '--column', '--no-column',
        '--sort', '--merged', '--no-merged', '--points-at',
    ],
    worktree: [],
};

// ---- Subcommand list --------------------------------------------------------

const SUBCMDS = [
    'add', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick',
    'clean', 'clone', 'commit', 'config', 'describe', 'diff',
    'difftool', 'fetch', 'format-patch', 'grep', 'help', 'init',
    'log', 'merge', 'mergetool', 'mv', 'pull', 'push', 'rebase',
    'reflog', 'remote', 'reset', 'restore', 'revert', 'rm',
    'shortlog', 'show', 'stash', 'status', 'submodule', 'switch',
    'tag', 'worktree',
];

const MERGE_STRATEGIES = ['resolve', 'recursive', 'octopus', 'ours', 'subtree', 'ort'];

// ---- Main handler -----------------------------------------------------------

export function gitCompletions(jsh: JshApi): void {
    jsh.complete('git', async (ctx) => {
        const results = await completeGit(jsh, ctx);

        // Filter out args already present on the command line.
        if (ctx.words.length > 2) {
            const alreadyUsed = new Set(ctx.words.slice(2, -1));
            return results.filter(r => !alreadyUsed.has(r));
        }
        return results;
    });
}

async function completeGit(jsh: JshApi, ctx: CompletionCtx): Promise<string[]> {
    // ---- Subcommand completion ------------------------------------------

    if (ctx.words.length === 2) {
        const prefix = ctx.current;
        // Include aliases alongside built-in subcommands.
        const aliases = await loadAliases(jsh);
        const aliasNames = [...aliases.keys()].filter(a => a.startsWith(prefix));
        const builtins = SUBCMDS.filter(s => s.startsWith(prefix));
        return [...new Set([...builtins, ...aliasNames])];
    }

    // ---- Resolve alias to real subcommand -------------------------------

    let sub = ctx.words[1]!;
    const aliases = await loadAliases(jsh);
    const resolved = aliases.get(sub);
    if (resolved) sub = resolved;

    const prefix = ctx.current;
    const prev = ctx.words[ctx.words.length - 2] ?? '';

    // ---- `--` separator: after --, only complete files, never flags -----

    const dashDashIdx = ctx.words.indexOf('--');
    const afterDashDash = dashDashIdx !== -1 && dashDashIdx < ctx.words.length - 1;

    if (afterDashDash) {
        switch (sub) {
            case 'add':
                return statusFiles(jsh, prefix, 'modified', 'deleted', 'untracked', 'unmerged');
            case 'checkout':
            case 'restore':
                return statusFiles(jsh, prefix, 'modified', 'deleted');
            case 'diff':
                return statusFiles(jsh, prefix, 'modified', 'modified-staged', 'deleted');
            case 'reset':
                return statusFiles(jsh, prefix, 'modified-staged', 'added', 'deleted-staged', 'renamed');
            case 'commit':
                return statusFiles(jsh, prefix, 'modified', 'modified-staged', 'deleted', 'untracked', 'added');
            case 'rm':
                return gitLines(jsh, 'git ls-files');
            default:
                return [];
        }
    }

    // ---- Flag completion ------------------------------------------------

    if (prefix.startsWith('-')) {
        const key = sub === 'cherry-pick' ? 'cherry' : sub;
        const flags = flagMap[key] ?? [];
        return flags.filter(f => f.startsWith(prefix));
    }

    // ---- Argument completion per subcommand -----------------------------

    switch (sub) {
        case 'add':
            return statusFiles(jsh, prefix, 'modified', 'deleted', 'untracked', 'unmerged');

        case 'bisect': {
            const bisectSub = ctx.words[2];
            const bisectCmds = ['start', 'bad', 'good', 'new', 'old', 'skip', 'reset', 'log', 'replay', 'run', 'visualize', 'view', 'help', 'terms'];
            if (ctx.words.length === 3) {
                return bisectCmds.filter(s => s.startsWith(prefix));
            }
            if (bisectSub === 'bad' || bisectSub === 'good' || bisectSub === 'new' || bisectSub === 'old' || bisectSub === 'skip') {
                return refsAndCommits(jsh, prefix);
            }
            if (bisectSub === 'reset') {
                return localBranches(jsh, prefix);
            }
            return [];
        }

        case 'blame':
            return gitLines(jsh, 'git ls-files');

        case 'branch': {
            if (prev === '-d' || prev === '-D' || prev === '--delete') {
                return localBranches(jsh, prefix);
            }
            if (prev === '--set-upstream-to') {
                return allBranches(jsh, prefix);
            }
            if (prev === '--contains' || prev === '--no-contains' || prev === '--merged' || prev === '--no-merged' || prev === '--points-at') {
                return refsAndCommits(jsh, prefix);
            }
            return localBranches(jsh, prefix);
        }

        case 'checkout': {
            if (prev === '-b' || prev === '-B') return [];
            const [branches, remote, files] = await Promise.all([
                localBranches(jsh, prefix),
                uniqueRemoteBranches(jsh, prefix),
                statusFiles(jsh, prefix, 'modified', 'deleted'),
            ]);
            return [...new Set([...branches, ...remote, ...files])];
        }

        case 'cherry-pick':
            return refRanges(jsh, prefix);

        case 'clean':
            return statusFiles(jsh, prefix, 'untracked');

        case 'clone':
            return [];

        case 'commit':
            return statusFiles(jsh, prefix, 'modified', 'modified-staged', 'deleted', 'untracked', 'added');

        case 'config': {
            const r = await git(jsh, 'git help --config-for-completion');
            if (r.ok) {
                return r.stdout.split('\n').filter(k => k && k.startsWith(prefix));
            }
            const r2 = await git(jsh, 'git config --name-only --list');
            if (r2.ok) {
                return [...new Set(r2.stdout.split('\n'))].filter(k => k && k.startsWith(prefix));
            }
            return [];
        }

        case 'describe':
            return refsAndCommits(jsh, prefix);

        case 'diff': {
            if (prefix.includes('..')) {
                return refRanges(jsh, prefix);
            }
            const positionals = ctx.words.slice(2).filter(w => !w.startsWith('-'));
            if (positionals.length <= 1 && !prefix.startsWith('.') && !prefix.includes('/')) {
                const [refs, files] = await Promise.all([
                    allRefs(jsh, prefix),
                    statusFiles(jsh, prefix, 'modified', 'modified-staged', 'deleted'),
                ]);
                return [...new Set([...refs, ...files])];
            }
            return statusFiles(jsh, prefix, 'modified', 'modified-staged', 'deleted');
        }

        case 'difftool': {
            if (prefix.includes('..')) return refRanges(jsh, prefix);
            return allRefs(jsh, prefix);
        }

        case 'fetch': {
            const argPos = ctx.words.filter(w => !w.startsWith('-')).length;
            if (argPos === 3) return remoteList(jsh, prefix);
            if (argPos === 4) return allBranches(jsh, prefix);
            return [];
        }

        case 'format-patch':
            if (prefix.includes('..')) return refRanges(jsh, prefix);
            return refsAndCommits(jsh, prefix);

        case 'grep':
            return [];

        case 'help':
            return SUBCMDS.filter(s => s.startsWith(prefix));

        case 'init':
            return [];

        case 'log':
            if (prefix.includes('..')) return refRanges(jsh, prefix);
            return refsAndCommits(jsh, prefix);

        case 'merge': {
            if (prev === '-s' || prev === '--strategy') {
                return MERGE_STRATEGIES.filter(s => s.startsWith(prefix));
            }
            return allRefs(jsh, prefix);
        }

        case 'mergetool':
            return statusFiles(jsh, prefix, 'unmerged');

        case 'mv':
            return gitLines(jsh, 'git ls-files');

        case 'pull': {
            if (prev === '-s' || prev === '--strategy') {
                return MERGE_STRATEGIES.filter(s => s.startsWith(prefix));
            }
            const argPos = ctx.words.filter(w => !w.startsWith('-')).length;
            if (argPos === 3) return remoteList(jsh, prefix);
            if (argPos === 4) return allBranches(jsh, prefix);
            return [];
        }

        case 'push': {
            const argPos = ctx.words.filter(w => !w.startsWith('-')).length;
            if (argPos === 3) return remoteList(jsh, prefix);
            if (argPos === 4) {
                const branches = await localBranches(jsh, prefix.replace(/^\+/, ''));
                const normal = branches.filter(b => b.startsWith(prefix));
                const force = prefix.startsWith('+')
                    ? branches.map(b => '+' + b).filter(b => b.startsWith(prefix))
                    : [];
                return [...new Set([...normal, ...force])];
            }
            return [];
        }

        case 'rebase': {
            if (prev === '--onto') return allRefs(jsh, prefix);
            if (prev === '-s' || prev === '--strategy') {
                return MERGE_STRATEGIES.filter(s => s.startsWith(prefix));
            }
            return allRefs(jsh, prefix);
        }

        case 'reflog': {
            const reflogSub = ctx.words[2];
            const reflogCmds = ['show', 'expire', 'delete', 'exists'];
            if (ctx.words.length === 3) {
                return reflogCmds.filter(s => s.startsWith(prefix));
            }
            if (reflogSub === 'show' || reflogSub === 'delete') {
                return reflogList(jsh, prefix);
            }
            return [];
        }

        case 'remote': {
            const remoteSub = ctx.words[2];
            const remoteCmds = ['add', 'remove', 'rename', 'show', 'prune',
                'get-url', 'set-url', 'set-head', 'set-branches', 'update'];
            if (ctx.words.length === 3) {
                return remoteCmds.filter(s => s.startsWith(prefix));
            }
            if (remoteSub === 'remove' || remoteSub === 'rm' || remoteSub === 'rename' ||
                remoteSub === 'show' || remoteSub === 'prune' || remoteSub === 'get-url' ||
                remoteSub === 'set-url' || remoteSub === 'set-head' || remoteSub === 'set-branches' ||
                remoteSub === 'update') {
                return remoteList(jsh, prefix);
            }
            return [];
        }

        case 'reset': {
            if (prev === '--soft' || prev === '--mixed' || prev === '--hard' || prev === '--keep' || prev === '--merge') {
                return refsAndCommits(jsh, prefix);
            }
            const [refs, files] = await Promise.all([
                refsAndCommits(jsh, prefix),
                statusFiles(jsh, prefix, 'modified-staged', 'added', 'deleted-staged', 'renamed'),
            ]);
            return [...new Set([...refs, ...files])];
        }

        case 'restore': {
            if (prev === '-s' || prev === '--source') {
                return allRefs(jsh, prefix);
            }
            const hasStaged = ctx.words.includes('--staged') || ctx.words.includes('-S');
            if (hasStaged) {
                return statusFiles(jsh, prefix, 'modified-staged', 'added', 'deleted-staged', 'renamed');
            }
            return statusFiles(jsh, prefix, 'modified', 'deleted');
        }

        case 'revert':
            return refsAndCommits(jsh, prefix);

        case 'rm':
            return gitLines(jsh, 'git ls-files');

        case 'shortlog':
            if (prefix.includes('..')) return refRanges(jsh, prefix);
            return refsAndCommits(jsh, prefix);

        case 'show':
            return refsAndCommits(jsh, prefix);

        case 'stash': {
            const stashSub = ctx.words[2];
            const stashCmds = ['push', 'pop', 'apply', 'drop', 'show', 'list', 'clear', 'branch', 'create', 'save'];
            if (ctx.words.length === 3) {
                return stashCmds.filter(s => s.startsWith(prefix));
            }
            if (stashSub === 'pop' || stashSub === 'apply' || stashSub === 'drop' || stashSub === 'show') {
                return stashList(jsh, prefix);
            }
            if (stashSub === 'branch') {
                if (ctx.words.length >= 5) return stashList(jsh, prefix);
                return [];
            }
            if (stashSub === 'push') {
                return statusFiles(jsh, prefix, 'modified', 'deleted', 'untracked');
            }
            return [];
        }

        case 'status':
            return [];

        case 'submodule': {
            const subSub = ctx.words[2];
            const subCmds = ['add', 'status', 'init', 'deinit', 'update', 'set-branch', 'set-url', 'summary', 'foreach', 'sync', 'absorbgitdirs'];
            if (ctx.words.length === 3) {
                return subCmds.filter(s => s.startsWith(prefix));
            }
            return [];
        }

        case 'switch': {
            if (prev === '-c' || prev === '-C' || prev === '--create' || prev === '--force-create') return [];
            if (ctx.words.includes('-d') || ctx.words.includes('--detach')) {
                return refsAndCommits(jsh, prefix);
            }
            const [branches, remote] = await Promise.all([
                localBranches(jsh, prefix),
                uniqueRemoteBranches(jsh, prefix),
            ]);
            return [...new Set([...branches, ...remote])];
        }

        case 'tag': {
            if (prev === '-d' || prev === '--delete' || prev === '-v' || prev === '--verify') {
                return tagList(jsh, prefix);
            }
            if (prev === '--contains' || prev === '--no-contains' || prev === '--merged' || prev === '--no-merged' || prev === '--points-at') {
                return refsAndCommits(jsh, prefix);
            }
            return tagList(jsh, prefix);
        }

        case 'worktree': {
            const wtSub = ctx.words[2];
            const wtCmds = ['add', 'list', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock'];
            if (ctx.words.length === 3) {
                return wtCmds.filter(s => s.startsWith(prefix));
            }
            if (wtSub === 'add') {
                if (ctx.words.length >= 5) return allBranches(jsh, prefix);
                return [];
            }
            return [];
        }
    }

    return [];
}
