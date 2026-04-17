// Protocol shared between jsh (WS client) and this applet (WS server).
// Kept in sync with src/mb/protocol.ts on the shell side.

export const HANDSHAKE_OSC = 58300;

export interface LastCommand {
    id: number;
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
    startMs: number;
    endMs: number;
}

// Shell → Applet
export type ClientMessage =
    | { type: "hello"; nonce: string }
    | { type: "createPopup"; reqId: number; x: number; y: number; w: number; h: number }
    | { type: "writePopup"; id: string; data: string }
    | { type: "closePopup"; id: string }
    | { type: "getLastCommand"; reqId: number }
    | { type: "getSelection"; reqId: number };

// Applet → Shell
export type ServerMessage =
    | { type: "ready" }
    | { type: "error"; reqId?: number; message: string }
    | { type: "createPopupResult"; reqId: number; id: string }
    | { type: "popupClosed"; id: string }
    | { type: "lastCommandResult"; reqId: number; command: LastCommand | null }
    | { type: "selectionResult"; reqId: number; text: string | null };
