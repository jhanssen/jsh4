// Git tab-completion module.
// Usage in jshrc: import { gitCompletions } from 'jsh/completions/git';
//                 gitCompletions(jsh);

interface CompletionCtx { words: string[]; current: string }
interface JshApi {
    complete(cmd: string, fn: (ctx: CompletionCtx) => string[] | Promise<string[]>): void;
    exec(cmd: string): Promise<{ ok: boolean; stdout: string }>;
}

export function gitCompletions(jsh: JshApi): void {
    jsh.complete('git', async (ctx) => {
        const subcmds = [
            'add', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clone',
            'commit', 'diff', 'fetch', 'grep', 'init', 'log', 'merge',
            'mv', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore',
            'rm', 'show', 'stash', 'status', 'switch', 'tag',
        ];
        if (ctx.words.length === 2) {
            return subcmds.filter(s => s.startsWith(ctx.current));
        }

        const sub = ctx.words[1];
        const alreadyUsed = new Set(ctx.words.slice(2, -1));
        const prefix = ctx.current;

        async function gitLines(...cmds: string[]): Promise<string[]> {
            const results = await Promise.all(cmds.map(c => jsh.exec(c)));
            const lines = results.flatMap(r => r.ok ? r.stdout.split('\n') : []);
            return lines.filter(f => f && !alreadyUsed.has(f) && f.startsWith(prefix));
        }

        async function branches(): Promise<string[]> {
            return gitLines('git branch --format="%(refname:short)"');
        }

        async function allBranches(): Promise<string[]> {
            return gitLines('git branch -a --format="%(refname:short)"');
        }

        async function tags(): Promise<string[]> {
            return gitLines('git tag --list');
        }

        async function refs(): Promise<string[]> {
            const [b, t] = await Promise.all([allBranches(), tags()]);
            return [...new Set([...b, ...t])];
        }

        if (prefix.startsWith('-')) {
            const flagMap: Record<string, string[]> = {
                add:      ['-A', '--all', '-p', '--patch', '-n', '--dry-run', '-f', '--force', '-v', '--verbose'],
                commit:   ['-m', '--message', '-a', '--all', '--amend', '--no-edit', '-v', '--verbose', '-s', '--signoff'],
                diff:     ['--staged', '--cached', '--stat', '--name-only', '--name-status', '--no-index'],
                log:      ['--oneline', '--graph', '--all', '--stat', '-n', '--author', '--since', '--until', '--pretty'],
                branch:   ['-a', '--all', '-d', '--delete', '-D', '-m', '--move', '-r', '--remotes', '-v', '--verbose'],
                checkout: ['-b', '-B', '--track', '--no-track', '-f', '--force'],
                switch:   ['-c', '--create', '-C', '--force-create', '--detach', '--no-track'],
                push:     ['-f', '--force', '--force-with-lease', '-u', '--set-upstream', '--tags', '--dry-run', '--no-verify'],
                pull:     ['--rebase', '--no-rebase', '--ff-only', '--no-ff'],
                fetch:    ['--all', '--prune', '-p', '--tags', '--dry-run'],
                merge:    ['--no-ff', '--ff-only', '--squash', '--abort', '--continue', '--no-commit'],
                rebase:   ['-i', '--interactive', '--abort', '--continue', '--skip', '--onto'],
                reset:    ['--soft', '--mixed', '--hard', '--keep'],
                stash:    ['--keep-index', '-u', '--include-untracked', '-m', '--message'],
                rm:       ['-f', '--force', '-r', '--cached', '-n', '--dry-run'],
                restore:  ['--staged', '--worktree', '-s', '--source'],
                show:     ['--stat', '--name-only', '--name-status', '--pretty'],
                tag:      ['-a', '--annotate', '-d', '--delete', '-f', '--force', '-m', '--message', '-l', '--list'],
                cherry:   ['--no-commit', '-x', '-e', '--edit', '--ff'],
            };
            const key = sub === 'cherry-pick' ? 'cherry' : sub;
            const flags = flagMap[key] ?? [];
            return flags.filter(f => f.startsWith(prefix));
        }

        switch (sub) {
            case 'add': {
                return gitLines('git diff --name-only', 'git ls-files --others --exclude-standard');
            }
            case 'checkout':
            case 'switch': {
                const prev = ctx.words[ctx.words.length - 2];
                if (prev === '-b' || prev === '-B' || prev === '-c' || prev === '-C') return [];
                return branches();
            }
            case 'merge':
            case 'rebase':
            case 'cherry-pick': {
                return refs();
            }
            case 'branch': {
                const prev = ctx.words[ctx.words.length - 2];
                if (prev === '-d' || prev === '-D') return branches();
                return [];
            }
            case 'diff': {
                return gitLines('git diff --name-only', 'git diff --staged --name-only');
            }
            case 'restore': {
                const hasStaged = ctx.words.includes('--staged');
                if (hasStaged) {
                    return gitLines('git diff --staged --name-only');
                }
                return gitLines('git diff --name-only');
            }
            case 'rm': {
                return gitLines('git ls-files');
            }
            case 'show':
            case 'log': {
                return refs();
            }
            case 'reset': {
                if (ctx.words.some(w => w === '--soft' || w === '--mixed' || w === '--hard')) {
                    return refs();
                }
                const [r, f] = await Promise.all([refs(), gitLines('git diff --staged --name-only')]);
                return [...new Set([...r, ...f])];
            }
            case 'push':
            case 'pull':
            case 'fetch': {
                const argPos = ctx.words.filter(w => !w.startsWith('-')).length;
                if (argPos === 3) {
                    return gitLines('git remote');
                }
                if (argPos === 4) {
                    return branches();
                }
                return [];
            }
            case 'stash': {
                const stashSub = ctx.words[2];
                const stashCmds = ['push', 'pop', 'apply', 'drop', 'show', 'list', 'clear'];
                if (ctx.words.length === 3) {
                    return stashCmds.filter(s => s.startsWith(prefix));
                }
                if (stashSub === 'pop' || stashSub === 'apply' || stashSub === 'drop' || stashSub === 'show') {
                    return gitLines('git stash list --format="%gd"');
                }
                return [];
            }
            case 'remote': {
                const remoteSub = ctx.words[2];
                const remoteCmds = ['add', 'remove', 'rename', 'show', 'prune', 'get-url', 'set-url'];
                if (ctx.words.length === 3) {
                    return remoteCmds.filter(s => s.startsWith(prefix));
                }
                if (remoteSub === 'remove' || remoteSub === 'rename' || remoteSub === 'show' ||
                    remoteSub === 'prune' || remoteSub === 'get-url' || remoteSub === 'set-url') {
                    return gitLines('git remote');
                }
                return [];
            }
            case 'tag': {
                return tags();
            }
        }

        return [];
    });
}
