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

// ---- Prompt (widget) -------------------------------------------------------

// The prompt is a widget in the "prompt" zone. Multiple widgets concatenate.
// Call handle.update() to refresh, or the engine re-evaluates on each new line.

const promptWidget = jsh.addWidget("prompt", "prompt", async () => {
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

// ---- PS2 (continuation prompt) ---------------------------------------------

jsh.addWidget("ps2", "ps2", () => `${softGray}> ${reset}`);

// ---- Header Widgets --------------------------------------------------------

// Git info — left-aligned on header line 0 (closest to input).
jsh.addWidget("gitinfo", "header", async () => {
    const branch = await jsh.exec('git branch --show-current 2>/dev/null');
    const status = await jsh.exec('git status --porcelain 2>/dev/null');
    if (!branch.ok || !branch.stdout) return '';
    const dirty = status.ok && status.stdout ? `${red}*${reset}` : `${green}✓${reset}`;
    const count = status.ok && status.stdout ? status.stdout.split('\n').filter(l => l.trim()).length : 0;
    return `${cyan}${branch.stdout}${reset} ${dirty}${count ? ` ${yellow}${count} changed${reset}` : ''}`;
});

// Clock in header — right-aligned on the same line 0.
const headerClock = jsh.addWidget("header-clock", "header", () => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${softGray}${time}${reset}`;
}, { line: -1, align: "right" });

setInterval(() => headerClock.update(), 1000);

// ---- Footer Widget ---------------------------------------------------------

const footerClock = jsh.addWidget("footer-clock", "footer", () => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${softGray}${time}${reset}`;
});

setInterval(() => footerClock.update(), 1000);

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

// ---- Suggestions (fish-style ghost text) -----------------------------------

// History-based suggestions: finds the most recent history entry matching the current input.
jsh.setSuggestion(async (input) => {
    // Search history by running a command — in a real setup you'd search in-memory.
    // For demo purposes, just return a static suggestion for "foo".
    if (input === "foo") return "foobar";

    // Search for the most recent history entry starting with the current input.
    const result = await jsh.exec(`grep -m1 "^${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" ~/.jsh_history 2>/dev/null`);
    if (result.ok && result.stdout && result.stdout !== input) {
        return result.stdout;
    }
    return null;
});

// ---- Tab Completion --------------------------------------------------------

import { gitCompletions } from 'jsh/completions/git';
import { npmCompletions } from 'jsh/completions/npm';
gitCompletions(jsh);
npmCompletions(jsh);

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
