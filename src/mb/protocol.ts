// Mirror of mb-applet/src/protocol.ts. Keep in sync.

export const HANDSHAKE_OSC = 58300;

export type ClientMessage =
    | { type: "hello"; nonce: string }
    | { type: "createPopup"; reqId: number; x: number; y: number; w: number; h: number }
    | { type: "writePopup"; id: string; data: string }
    | { type: "closePopup"; id: string };

export type ServerMessage =
    | { type: "ready" }
    | { type: "error"; reqId?: number; message: string }
    | { type: "createPopupResult"; reqId: number; id: string }
    | { type: "popupClosed"; id: string };
