// Protocol shared between jsh (WS client) and this applet (WS server).
// Kept in sync with src/mb/protocol.ts on the shell side.

export const HANDSHAKE_OSC = 58300;

export interface MbCommandRecord {
    id: number;
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
    startMs: number;
    endMs: number;
}

export type ClipboardSource = "clipboard" | "primary";

// Shell → Applet
export type ClientMessage =
    | { type: "hello"; nonce: string }
    | { type: "createPopup"; reqId: number; x: number; y: number; w: number; h: number }
    | { type: "writePopup"; id: string; data: string }
    | { type: "closePopup"; id: string }
    | { type: "getSelectedCommand"; reqId: number }
    | { type: "selectCommand"; id: number | null }
    | { type: "getSelection"; reqId: number }
    | { type: "getClipboard"; reqId: number; source?: ClipboardSource }
    | { type: "setClipboard"; reqId: number; text: string; source?: ClipboardSource };

// Applet → Shell
export type ServerMessage =
    | { type: "ready" }
    | { type: "error"; reqId?: number; message: string }
    | { type: "createPopupResult"; reqId: number; id: string }
    | { type: "popupClosed"; id: string }
    | { type: "selectedCommandResult"; reqId: number; command: MbCommandRecord | null }
    | { type: "selectionResult"; reqId: number; text: string | null }
    | { type: "clipboardResult"; reqId: number; text: string }
    | { type: "setClipboardResult"; reqId: number };
