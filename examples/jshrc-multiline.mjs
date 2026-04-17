// Example .jshrc with a multi-line prompt.
// Load with: jsh --jshrc examples/jshrc-multiline.mjs
//
// Renders:
//
//   ╭─ ~/dev/jsh on main ● [1]
//   ╰─❯ <cursor>
//
// The prompt widget returns a string containing "\n". The terminal splits on
// the newline and renders the earlier lines as plain inputLines above the
// actual input. Only the last prompt line participates in native cursor/width
// math.
//
// PS2 (continuation prompt) can also span multiple lines if you return a
// string containing "\n".

const { bold, reset } = jsh.colors;
const accent  = jsh.makeFgColor(137, 180, 250);
const accent2 = jsh.makeFgColor(203, 166, 247);
const ok      = jsh.makeFgColor(166, 227, 161);
const err     = jsh.makeFgColor(243, 139, 168);
const muted   = jsh.makeFgColor(127, 132, 156);
const gitCol  = jsh.makeFgColor(250, 179, 135);

// ---- Shared git info cache -------------------------------------------------

let gitCache = { cwd: "", branch: "", dirty: false, stamp: 0 };
const GIT_TTL_MS = 1500;

async function gitInfo() {
    const cwd = String(jsh.$.PWD ?? "");
    const now = Date.now();
    if (gitCache.cwd === cwd && (now - gitCache.stamp) < GIT_TTL_MS) return gitCache;
    const branch = await jsh.exec("git branch --show-current 2>/dev/null");
    if (!branch.ok || !branch.stdout) {
        gitCache = { cwd, branch: "", dirty: false, stamp: now };
        return gitCache;
    }
    const porcelain = await jsh.exec("git status --porcelain 2>/dev/null");
    gitCache = {
        cwd,
        branch: branch.stdout.trim(),
        dirty:  !!(porcelain.ok && porcelain.stdout.trim()),
        stamp:  now,
    };
    return gitCache;
}

function shortPath() {
    const home = String(jsh.$.HOME ?? "");
    let cwd = String(jsh.$.PWD ?? "");
    if (home && (cwd === home || cwd.startsWith(home + "/"))) {
        cwd = "~" + cwd.slice(home.length);
    }
    const parts = cwd.split("/");
    if (parts.length > 4) {
        return [parts[0] || "/", "…", parts[parts.length - 2], parts[parts.length - 1]]
            .filter(Boolean).join("/");
    }
    return cwd;
}

// ---- Multi-line prompt -----------------------------------------------------

jsh.addWidget("prompt", "prompt", async () => {
    const path = shortPath();
    const { branch, dirty } = await gitInfo();
    const exitCode = Number(jsh.$["?"] ?? 0);

    const gitSeg = branch
        ? ` ${muted}on ${gitCol}${branch}${reset}${dirty ? ` ${err}●` : ` ${ok}✓`}${reset}`
        : "";
    const exitSeg = exitCode === 0 ? "" : ` ${err}[${exitCode}]${reset}`;
    const arrowCol = exitCode === 0 ? accent2 : err;

    // Two-line prompt — newline separates the "context" row from the arrow.
    return `${muted}╭─${reset} ${bold}${accent}${path}${reset}${gitSeg}${exitSeg}\n`
         + `${muted}╰─${reset}${bold}${arrowCol}❯${reset} `;
});

// Multi-line ps2 is also supported.
jsh.addWidget("ps2", "ps2", () => `${muted}╰─${reset}${accent2}❯${reset} `);
