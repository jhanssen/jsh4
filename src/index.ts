import { parse } from "./parser/index.js";
import { execute } from "./executor/index.js";
import { expandWord } from "./expander/index.js";
import { startRepl } from "./repl/index.js";
import { $ } from "./variables/index.js";

async function main(): Promise<void> {
    // TODO: load .jshrc, initialize native addon, start REPL
    startRepl();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

export { parse, execute, expandWord, startRepl, $ };
