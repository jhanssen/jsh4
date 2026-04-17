// Mirror of mb-applet/src/protocol.ts. Keep in sync.

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

export type ClipboardSource = "clipboard" | "primary";

export type ClientMessage =
    | { type: "hello"; nonce: string }
    | { type: "createPopup"; reqId: number; x: number; y: number; w: number; h: number }
    | { type: "writePopup"; id: string; data: string }
    | { type: "closePopup"; id: string }
    | { type: "getLastCommand"; reqId: number }
    | { type: "getSelection"; reqId: number }
    | { type: "getClipboard"; reqId: number; source?: ClipboardSource }
    | { type: "setClipboard"; reqId: number; text: string; source?: ClipboardSource };

export type ServerMessage =
    | { type: "ready" }
    | { type: "error"; reqId?: number; message: string }
    | { type: "createPopupResult"; reqId: number; id: string }
    | { type: "popupClosed"; id: string }
    | { type: "lastCommandResult"; reqId: number; command: LastCommand | null }
    | { type: "selectionResult"; reqId: number; text: string | null }
    | { type: "clipboardResult"; reqId: number; text: string }
    | { type: "setClipboardResult"; reqId: number };
