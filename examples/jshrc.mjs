// Example .jshrc for jsh
// Load with: jsh --jshrc examples/jshrc.mjs

const { bold, dim, green, cyan, yellow, red, magenta, reset } = jsh.colors;
const orange = jsh.makeFgColor(255, 165, 0);
const softGray = jsh.makeFgColor(120, 120, 120);

// ---- Environment -----------------------------------------------------------

jsh.$.EDITOR = 'nvim';
jsh.$.PAGER = 'less';

// ---- Aliases ---------------------------------------------------------------

jsh.alias('ll', 'ls -la');
jsh.alias('la', 'ls -A');
jsh.alias('gs', 'git status');
jsh.alias('gd', 'git diff');
jsh.alias('gl', 'git log --oneline -20');
jsh.alias('..', 'cd ..');
jsh.alias('...', 'cd ../..');

// ---- Prompt ----------------------------------------------------------------

jsh.setPrompt(async () => {
    const cwd = String(jsh.$.PWD ?? '~').replace(String(jsh.$.HOME ?? ''), '~');
    const branch = await jsh.exec('git branch --show-current 2>/dev/null');
    const dirty = await jsh.exec('git status --porcelain 2>/dev/null');

    let gitInfo = '';
    if (branch.ok && branch.stdout) {
        const indicator = dirty.ok && dirty.stdout ? `${red}*` : `${green}`;
        gitInfo = ` ${cyan}${branch.stdout}${indicator}${reset}`;
    }

    const exitCode = Number(jsh.$['?'] ?? 0);
    const symbol = exitCode === 0 ? `${green}$` : `${red}$`;

    return `${bold}${yellow}${cwd}${reset}${gitInfo} ${symbol}${reset} `;
});

// ---- Header Widget ---------------------------------------------------------

jsh.addWidget("gitinfo", "header", async () => {
    const branch = await jsh.exec('git branch --show-current 2>/dev/null');
    const status = await jsh.exec('git status --porcelain 2>/dev/null');
    if (!branch.ok || !branch.stdout) return '';
    const dirty = status.ok && status.stdout ? `${red}*${reset}` : `${green}✓${reset}`;
    const count = status.ok && status.stdout ? status.stdout.split('\n').filter(l => l.trim()).length : 0;
    return `  ${cyan}${branch.stdout}${reset} ${dirty}${count ? ` ${yellow}${count} changed${reset}` : ''}`;
});

// ---- Footer Widget ---------------------------------------------------------

jsh.addWidget("clock", "footer", () => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `  ${softGray}${time}${reset}`;
}, 0, 1000);

// ---- Theme -----------------------------------------------------------------

jsh.setTheme({
    command:         [130, 224, 170],  // soft green
    commandNotFound: [255, 85, 85],    // red
    keyword:         [255, 203, 107],  // warm yellow
    operator:        [199, 146, 234],  // purple
    redirect:        [199, 146, 234],
    string:          [195, 232, 141],  // light green
    variable:        [137, 221, 255],  // sky blue
    comment:         [105, 105, 105],  // gray
});

// ---- Tab Completion --------------------------------------------------------

jsh.complete('git', (ctx) => {
    const subcmds = [
        'add', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clone',
        'commit', 'diff', 'fetch', 'grep', 'init', 'log', 'merge',
        'mv', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore',
        'rm', 'show', 'stash', 'status', 'switch', 'tag',
    ];
    if (ctx.words.length === 2) {
        return subcmds.filter(s => s.startsWith(ctx.current));
    }
    return [];
});

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

// ---- Pipeline Functions (@name) --------------------------------------------

// Usage: cat data.json | @!json  (buffered — receives full stdin as string)
export function json(args, stdin) {
    return JSON.stringify(JSON.parse(stdin), null, 2);
}

// Usage: ls -la | @grep pattern
export async function* grep(args, stdin) {
    const pattern = new RegExp(args[0] ?? '.');
    for await (const line of stdin) {
        if (pattern.test(line)) yield line;
    }
}

// Usage: cat file.txt | @head 5
export async function* head(args, stdin) {
    const n = parseInt(args[0] ?? '10', 10);
    let count = 0;
    for await (const line of stdin) {
        if (count++ >= n) break;
        yield line;
    }
}

// Usage: cat file.txt | @uniq
export async function* uniq(args, stdin) {
    let prev = null;
    for await (const line of stdin) {
        if (line !== prev) {
            yield line;
            prev = line;
        }
    }
}

// Usage: cat file.txt | @count
export async function count(args, stdin) {
    let n = 0;
    for await (const _ of stdin) n++;
    return String(n);
}

// Usage: echo "hello world" | @upper
export async function* upper(args, stdin) {
    for await (const line of stdin) yield line.toUpperCase();
}

// Usage: echo "HELLO" | @lower
export async function* lower(args, stdin) {
    for await (const line of stdin) yield line.toLowerCase();
}
