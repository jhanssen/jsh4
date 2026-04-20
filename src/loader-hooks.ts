// ESM loader hooks:
//   1. resolve(): maps `jsh` / `jsh/...` specifiers to this install's dist
//      tree; falls back to `$XDG_DATA_HOME/jsh/node_modules/` when a bare
//      specifier can't be found via the default walk-up.
//   2. load(): for user-side `.ts`/`.mts` modules, prepends a one-line
//      prologue that binds the module's `jsh` to a wrapped variant carrying
//      `import.meta.url` as the `source` for any `registerJsFunction` call.
//      This lets the registry default to object-mode and look up the schema
//      cache without per-call ceremony. Modules under the jsh install dir
//      (dist/) and inside node_modules are skipped.

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

interface LoadContext {
    format?: string | null;
    importAttributes?: Record<string, string>;
    conditions: string[];
}
interface LoadResult {
    format: string;
    source?: string | ArrayBuffer | NodeJS.ArrayBufferView;
    shortCircuit?: boolean;
}
type NextLoad = (url: string, context: LoadContext) => LoadResult | Promise<LoadResult>;

const PROLOGUE = `const jsh = (globalThis.jsh && globalThis.jsh._withSource) ? globalThis.jsh._withSource(import.meta.url) : globalThis.jsh;\n`;

function shouldInjectPrologue(url: string): boolean {
    if (!url.startsWith('file://')) return false;
    if (!url.endsWith('.ts') && !url.endsWith('.mts')) return false;
    if (url.startsWith(jshRoot)) return false;
    if (url.includes('/node_modules/')) return false;
    return true;
}

export async function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> {
    if (!shouldInjectPrologue(url)) return nextLoad(url, context);

    // Force module-typescript: jshrc + user-imported .ts files are always
    // ESM. Without this hint, Node falls back to nearest package.json which
    // for a stray /tmp/foo.ts means commonjs-typescript and breaks import.meta.
    const result = await nextLoad(url, { ...context, format: 'module-typescript' });
    let src: string;
    if (typeof result.source === 'string') {
        src = result.source;
    } else if (result.source) {
        src = Buffer.from(result.source as Uint8Array).toString('utf8');
    } else {
        return result;
    }
    return { ...result, format: 'module-typescript', source: PROLOGUE + src, shortCircuit: true };
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
