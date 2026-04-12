// Protocol shared between jsh (WS client) and this applet (WS server).
// Kept in sync with src/mb/protocol.ts on the shell side.

export const HANDSHAKE_OSC = 58300;

// Shell → Applet
export type ClientMessage =
    | { type: "hello"; nonce: string }
    | { type: "createPopup"; reqId: number; x: number; y: number; w: number; h: number }
    | { type: "writePopup"; id: string; data: string }
    | { type: "closePopup"; id: string };

// Applet → Shell
export type ServerMessage =
    | { type: "ready" }
    | { type: "error"; reqId?: number; message: string }
    | { type: "createPopupResult"; reqId: number; id: string }
    | { type: "popupClosed"; id: string };
