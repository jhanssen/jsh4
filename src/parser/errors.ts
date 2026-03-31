export class LexerError extends Error {
    constructor(message: string, public position: number) {
        super(message);
        this.name = "LexerError";
    }
}

export class ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParseError";
    }
}

export class IncompleteInputError extends ParseError {
    constructor(message: string = "incomplete input") {
        super(message);
        this.name = "IncompleteInputError";
    }
}
