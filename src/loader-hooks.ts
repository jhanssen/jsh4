// ESM loader hook — allows `import ... from 'jsh/...'` in jshrc files
// located outside the jsh install directory.

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

export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult | Promise<ResolveResult> {
    if (specifier === 'jsh' || specifier.startsWith('jsh/')) {
        const subpath = specifier === 'jsh' ? 'dist/api/index.js' : `dist/${specifier.slice(4)}.js`;
        return { url: new URL(subpath, jshRoot).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
