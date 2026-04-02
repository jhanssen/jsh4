// npm tab-completion module.
// Usage in jshrc: import { npmCompletions } from 'jsh/completions/npm';
//                 npmCompletions(jsh);

interface CompletionCtx { words: string[]; current: string }
interface JshApi {
    complete(cmd: string, fn: (ctx: CompletionCtx) => string[] | Promise<string[]>): void;
}

export function npmCompletions(jsh: JshApi): void {
    jsh.complete('npm', (ctx) => {
        const subcmds = [
            'install', 'run', 'test', 'start', 'build', 'publish',
            'init', 'exec', 'ls', 'outdated', 'update', 'audit',
        ];
        if (ctx.words.length === 2) {
            return subcmds.filter(s => s.startsWith(ctx.current));
        }
        return [];
    });
}
