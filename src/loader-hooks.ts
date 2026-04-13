// ESM loader hook:
//   1. Resolves `jsh` / `jsh/...` specifiers to this install's dist tree.
//   2. Falls back to `$XDG_DATA_HOME/jsh/node_modules/` when a bare specifier
//      can't be found via the default walk-up. This lets ~/.jshrc[.ts|.js]
//      import packages that aren't installed next to the home dir.

import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

interface ResolveContext {
    conditions: string[];
    parentURL?: string;
}

interface ResolveResult {
    url: string;
    shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult | Promise<ResolveResult>;

// From dist/ up to project root.
const jshRoot = new URL('../', import.meta.url).href;

// XDG data dir for user-installed rc dependencies.
// Default: ~/.local/share/jsh/node_modules/
const xdgDataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const rcModulesRoot = join(xdgDataHome, 'jsh');
// parentURL for resolution must look like a file IN the deps root so the
// walk-up sees `<root>/node_modules` as its first candidate.
const rcModulesParentURL = pathToFileURL(join(rcModulesRoot, 'jshrc-deps.js')).href;

function isBareSpecifier(spec: string): boolean {
    if (!spec) return false;
    if (spec.startsWith('.')) return false;
    if (spec.startsWith('/')) return false;
    if (spec.startsWith('node:')) return false;
    if (spec.startsWith('file:')) return false;
    if (/^[a-z]+:/i.test(spec)) return false;
    return true;
}

export async function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): Promise<ResolveResult> {
    if (specifier === 'jsh' || specifier.startsWith('jsh/')) {
        const subpath = specifier === 'jsh' ? 'dist/api/index.js' : `dist/${specifier.slice(4)}.js`;
        return { url: new URL(subpath, jshRoot).href, shortCircuit: true };
    }

    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ERR_MODULE_NOT_FOUND' && isBareSpecifier(specifier)) {
            // Retry with parentURL pointing into the XDG deps root.
            return await nextResolve(specifier, { ...context, parentURL: rcModulesParentURL });
        }
        throw err;
    }
}
