// Resolve/install the MB applet shipped with jsh.
//
// Strategy: copy the compiled mb-applet/dist/applet.js (sibling to this
// install) to $XDG_CACHE_HOME/jsh/shell-popup.js (stable path so MB's
// hash-allowlist entry persists across jsh restarts). Only rewrite when
// the source has changed.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);

/** Permissions the shipped applet requests. Kept narrow. */
export const APPLET_PERMISSIONS = "ui,io.inject,shell,net.listen.local";

/** Override the shipped applet-load flow via env var. */
export function appletLoadDisabled(): boolean {
    return process.env.JSH_MB_NO_APPLET_LOAD === "1";
}

/**
 * Copy the bundled applet and its sibling .js modules to a stable cache
 * directory. MB scopes relative imports (`./protocol.js`) to the script's
 * own directory, so we ship the whole dist/ tree, not just the entry file.
 * Returns the path to the main applet file, or null on any error.
 */
export function ensureAppletOnDisk(): string | null {
    try {
        const srcFile = resolveShippedApplet();
        const srcDir = dirname(srcFile);
        const dstFile = resolveCachePath();
        const dstDir = dirname(dstFile);
        mkdirSync(dstDir, { recursive: true });

        // Copy every .js file from the applet's dist dir. Overwrite only when
        // content differs so the allowlist hash stays stable across launches.
        for (const name of readdirSync(srcDir)) {
            if (!name.endsWith(".js")) continue;
            const srcPath = join(srcDir, name);
            const dstPath = name === "applet.js" ? dstFile : join(dstDir, name);
            const content = readFileSync(srcPath);
            let needWrite = true;
            try {
                needWrite = !readFileSync(dstPath).equals(content);
            } catch {
                /* missing */
            }
            if (needWrite) writeFileSync(dstPath, content, { mode: 0o600 });
        }
        return dstFile;
    } catch (e) {
        process.stderr.write(`jsh: mb applet install failed: ${e instanceof Error ? e.message : e}\n`);
        return null;
    }
}

function resolveShippedApplet(): string {
    // At runtime this file lives at dist/mb/applet.js. Repo root is two
    // levels up; the applet build output is at mb-applet/dist/applet.js.
    const selfUrl = new URL("./", import.meta.url);
    const selfPath = selfUrl.pathname;
    const candidate = resolve(selfPath, "..", "..", "mb-applet", "dist", "applet.js");
    statSync(candidate); // throws if missing
    return candidate;
}

function resolveCachePath(): string {
    const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(xdgCache, "jsh", "shell-popup.js");
}

// Silence unused-import lint on environments that tree-shake; keeping the
// require handle available in case we later want require.resolve fallbacks
// for npm-installed jsh.
void require;
