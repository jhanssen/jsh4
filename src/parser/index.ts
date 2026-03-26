export interface ASTNode {
    type: string;
}

export interface SimpleCommand extends ASTNode {
    type: "SimpleCommand";
    words: string[];
}

export interface Pipeline extends ASTNode {
    type: "Pipeline";
    commands: ASTNode[];
}

export function parse(input: string): ASTNode {
    // TODO: recursive descent parser for POSIX shell grammar
    const words = input.split(/\s+/).filter(Boolean);
    return { type: "SimpleCommand", words } as SimpleCommand;
}
