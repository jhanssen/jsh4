import { parse } from "./parser/index.js";
import { execute } from "./executor/index.js";
import { expandWord } from "./expander/index.js";
import { startRepl } from "./repl/index.js";
import { $ } from "./variables/index.js";

function parseArgs(): { jshrc?: string } {
    const args = process.argv.slice(2);
    const opts: { jshrc?: string } = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--jshrc" && i + 1 < args.length) {
            opts.jshrc = args[++i];
        }
    }
    return opts;
}

async function main(): Promise<void> {
    const opts = parseArgs();
    await startRepl({ jshrc: opts.jshrc });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

export { parse, execute, expandWord, startRepl, $ };
