import type { ASTNode } from "../parser/index.js";

export interface ExecResult {
    exitCode: number;
    stdout?: string;
    stderr?: string;
}

export async function execute(node: ASTNode): Promise<ExecResult> {
    // TODO: walk AST, fork/exec via native addon
    return { exitCode: 0 };
}
