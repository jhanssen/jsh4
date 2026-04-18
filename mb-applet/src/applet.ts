/// <reference path="../types/mb.d.ts" />
/// <reference path="../types/globals.d.ts" />

// jsh ↔ MasterBandit bridge applet.
//
// Flow:
//   1. Applet starts a local WS server with a shared token.
//   2. Registers osc:58300 on every pane (present + future).
//   3. Shell sends OSC 58300 "query;nonce=<hex>" on startup.
//      Applet maps nonce → pane, replies via pane.write() with
//      "port=N;token=T". Token is shared; nonce proves pane identity.
//   4. Shell opens WS with Sec-WebSocket-Protocol: mb-shell.<token>,
//      sends {type:"hello", nonce} as its first frame.
//      Applet associates connection → pane, replies {type:"ready"}.
//   5. Shell drives popups via createPopup / writePopup / closePopup.

import ws from "mb:ws";
import type { MbWsServer, MbWsConnection } from "mb:ws";
import type { ClientMessage, ServerMessage, MbCommandRecord } from "./protocol.js";
import { HANDSHAKE_OSC } from "./protocol.js";

function wireCommand(cmd: MbCommand): MbCommandRecord {
    return {
        id: cmd.id,
        command: cmd.command,
        output: cmd.output,
        cwd: cmd.cwd,
        exitCode: cmd.exitCode,
        startMs: cmd.startMs,
        endMs: cmd.endMs,
    };
}

const TAG = "jsh-mb-applet:";

// Keep protocol name ("mb-shell." + token) under lws's 63-char limit.
// 24 bytes = 48 hex chars → total 57 chars. 192 bits of entropy.
const token = mb.createSecureToken(24);
let server: MbWsServer;
try {
    server = ws.createServer({ host: "127.0.0.1", port: 0, token });
} catch (e) {
    console.error(TAG, "createServer failed:", e);
    throw e;
}
console.log(TAG, "listening on 127.0.0.1:" + server.port);

// nonce → pane, consumed by the first WS "hello" that presents it.
const pendingPanes = new Map<string, MbPane>();

// Connection state
interface ConnState {
    pane: MbPane | null;
    popups: Map<string, MbPopup>;
    popupCounter: number;
}
const conns = new Map<MbWsConnection, ConnState>();

function send(conn: MbWsConnection, msg: ServerMessage): void {
    try {
        conn.send(JSON.stringify(msg));
    } catch (e) {
        console.warn(TAG, "send failed:", e);
    }
}

function handleMessage(conn: MbWsConnection, state: ConnState, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") {
        send(conn, { type: "error", message: "binary frames not supported" });
        return;
    }
    let msg: ClientMessage;
    try {
        msg = JSON.parse(raw) as ClientMessage;
    } catch {
        send(conn, { type: "error", message: "invalid JSON" });
        return;
    }

    if (msg.type === "hello") {
        const pane = pendingPanes.get(msg.nonce);
        if (!pane) {
            send(conn, { type: "error", message: "unknown or expired nonce" });
            conn.close();
            return;
        }
        pendingPanes.delete(msg.nonce);
        state.pane = pane;
        send(conn, { type: "ready" });
        return;
    }

    if (!state.pane) {
        send(conn, { type: "error", message: "not authenticated" });
        return;
    }

    switch (msg.type) {
        case "createPopup": {
            const id = "jsh_" + (++state.popupCounter);
            const popup = state.pane.createPopup({ id, x: msg.x, y: msg.y, w: msg.w, h: msg.h });
            if (!popup) {
                send(conn, { type: "error", reqId: msg.reqId, message: "createPopup failed" });
                return;
            }
            state.popups.set(id, popup);
            popup.addEventListener("destroyed", () => {
                state.popups.delete(id);
                send(conn, { type: "popupClosed", id });
            });
            send(conn, { type: "createPopupResult", reqId: msg.reqId, id });
            break;
        }
        case "writePopup": {
            const popup = state.popups.get(msg.id);
            if (!popup) {
                send(conn, { type: "error", message: "no such popup: " + msg.id });
                return;
            }
            popup.inject(msg.data);
            break;
        }
        case "closePopup": {
            const popup = state.popups.get(msg.id);
            if (popup) popup.close();
            break;
        }
        case "getSelectedCommand": {
            const cmd = state.pane.selectedCommand;
            send(conn, {
                type: "selectedCommandResult",
                reqId: msg.reqId,
                command: cmd ? wireCommand(cmd) : null,
            });
            break;
        }
        case "selectCommand": {
            state.pane.selectCommand(msg.id);
            break;
        }
        case "getSelection": {
            const sel = state.pane.selection;
            if (!sel) {
                send(conn, { type: "selectionResult", reqId: msg.reqId, text: null });
                break;
            }
            const text = state.pane.getTextFromRows(sel.startRowId, sel.startCol, sel.endRowId, sel.endCol);
            send(conn, { type: "selectionResult", reqId: msg.reqId, text });
            break;
        }
        case "getClipboard": {
            try {
                const text = mb.getClipboard(msg.source);
                send(conn, { type: "clipboardResult", reqId: msg.reqId, text });
            } catch (e) {
                send(conn, { type: "error", reqId: msg.reqId,
                    message: `getClipboard failed: ${e instanceof Error ? e.message : String(e)}` });
            }
            break;
        }
        case "setClipboard": {
            try {
                mb.setClipboard(msg.text, msg.source);
                send(conn, { type: "setClipboardResult", reqId: msg.reqId });
            } catch (e) {
                send(conn, { type: "error", reqId: msg.reqId,
                    message: `setClipboard failed: ${e instanceof Error ? e.message : String(e)}` });
            }
            break;
        }
    }
}

server.addEventListener("connection", (conn) => {
    const state: ConnState = { pane: null, popups: new Map(), popupCounter: 0 };
    conns.set(conn, state);
    conn.addEventListener("message", (data) => handleMessage(conn, state, data));
    conn.addEventListener("close", () => {
        for (const popup of state.popups.values()) popup.close();
        conns.delete(conn);
    });
});

server.addEventListener("error", (err) => {
    console.error(TAG, "server error:", err.message);
});

function registerPane(pane: MbPane): void {
    pane.addEventListener(`osc:${HANDSHAKE_OSC}`, (payload: string) => {
        // Payload format: "query;nonce=<hex>"
        const parts = payload.split(";");
        if (parts[0] !== "query") return;
        let nonce: string | null = null;
        for (let i = 1; i < parts.length; i++) {
            const eq = parts[i].indexOf("=");
            if (eq < 0) continue;
            const k = parts[i].substring(0, eq);
            const v = parts[i].substring(eq + 1);
            if (k === "nonce") nonce = v;
        }
        if (!nonce) {
            console.warn(TAG, "handshake without nonce");
            return;
        }
        pendingPanes.set(nonce, pane);
        // Expire unclaimed nonces.
        setTimeout(() => pendingPanes.delete(nonce!), 10000);
        const reply = `\x1b]${HANDSHAKE_OSC};port=${server.port};token=${token}\x1b\\`;
        try {
            pane.write(reply);
        } catch (e) {
            console.warn(TAG, "pane.write failed:", e);
        }
    });
}

mb.addEventListener("paneCreated", registerPane);
for (const tab of mb.tabs) for (const pane of tab.panes) registerPane(pane);

console.log(TAG, "ready");
