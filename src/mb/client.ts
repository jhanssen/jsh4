// WebSocket client to the MasterBandit applet. Sends popup commands, receives
// results and popup-closed notifications. Initialised from the REPL after a
// successful handshake().

import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { HandshakeResult } from "./handshake.js";

export interface CreatePopupOptions {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PopupHandle {
    readonly id: string;
    write(data: string): void;
    close(): void;
    onClose(fn: () => void): void;
}

export interface MbApi {
    createPopup(opts: CreatePopupOptions): Promise<PopupHandle>;
    readonly connected: boolean;
}

interface PendingRequest {
    resolve: (id: string) => void;
    reject: (err: Error) => void;
}

class MbClient implements MbApi {
    private ws: WebSocket;
    private ready = false;
    private nextReqId = 1;
    private pending = new Map<number, PendingRequest>();
    private popups = new Map<string, PopupImpl>();
    private readyPromise: Promise<void>;

    constructor(handshakeResult: HandshakeResult) {
        const { port, token, nonce } = handshakeResult;
        this.ws = new WebSocket(`ws://127.0.0.1:${port}`, [`mb-shell.${token}`]);

        this.readyPromise = new Promise((resolve, reject) => {
            this.ws.once("open", () => {
                this.send({ type: "hello", nonce });
            });
            this.ws.once("error", (err) => {
                if (!this.ready) reject(err);
            });
            this.ws.on("message", (data) => {
                const text = typeof data === "string" ? data : data.toString("utf8");
                let msg: ServerMessage;
                try {
                    msg = JSON.parse(text) as ServerMessage;
                } catch {
                    return;
                }
                if (msg.type === "ready") {
                    this.ready = true;
                    resolve();
                    return;
                }
                this.handleMessage(msg);
            });
            this.ws.on("close", () => {
                this.ready = false;
                for (const p of this.pending.values()) p.reject(new Error("ws closed"));
                this.pending.clear();
                for (const popup of this.popups.values()) popup._markClosed();
                this.popups.clear();
            });
        });
    }

    get connected(): boolean {
        return this.ready;
    }

    waitReady(): Promise<void> {
        return this.readyPromise;
    }

    private send(msg: ClientMessage): void {
        this.ws.send(JSON.stringify(msg));
    }

    private handleMessage(msg: ServerMessage): void {
        if (msg.type === "createPopupResult") {
            const p = this.pending.get(msg.reqId);
            if (p) {
                this.pending.delete(msg.reqId);
                p.resolve(msg.id);
            }
            return;
        }
        if (msg.type === "popupClosed") {
            const popup = this.popups.get(msg.id);
            if (popup) {
                this.popups.delete(msg.id);
                popup._markClosed();
            }
            return;
        }
        if (msg.type === "error") {
            if (msg.reqId !== undefined) {
                const p = this.pending.get(msg.reqId);
                if (p) {
                    this.pending.delete(msg.reqId);
                    p.reject(new Error(msg.message));
                }
            } else {
                process.stderr.write(`jsh.mb: ${msg.message}\n`);
            }
        }
    }

    async createPopup(opts: CreatePopupOptions): Promise<PopupHandle> {
        if (!this.ready) throw new Error("mb client not ready");
        const reqId = this.nextReqId++;
        const idPromise = new Promise<string>((resolve, reject) => {
            this.pending.set(reqId, { resolve, reject });
        });
        this.send({ type: "createPopup", reqId, ...opts });
        const id = await idPromise;
        const popup = new PopupImpl(this, id);
        this.popups.set(id, popup);
        return popup;
    }

    _writePopup(id: string, data: string): void {
        if (!this.ready) return;
        this.send({ type: "writePopup", id, data });
    }

    _closePopup(id: string): void {
        if (!this.ready) return;
        this.send({ type: "closePopup", id });
    }
}

class PopupImpl implements PopupHandle {
    readonly id: string;
    private client: MbClient;
    private closed = false;
    private onCloseFns: Array<() => void> = [];

    constructor(client: MbClient, id: string) {
        this.client = client;
        this.id = id;
    }

    write(data: string): void {
        if (this.closed) return;
        this.client._writePopup(this.id, data);
    }

    close(): void {
        if (this.closed) return;
        this.client._closePopup(this.id);
    }

    onClose(fn: () => void): void {
        if (this.closed) fn();
        else this.onCloseFns.push(fn);
    }

    _markClosed(): void {
        if (this.closed) return;
        this.closed = true;
        for (const fn of this.onCloseFns) {
            try { fn(); } catch { /* ignore */ }
        }
        this.onCloseFns.length = 0;
    }
}

export async function connectMb(handshakeResult: HandshakeResult): Promise<MbApi | null> {
    try {
        const client = new MbClient(handshakeResult);
        await client.waitReady();
        return client;
    } catch (e) {
        process.stderr.write(`jsh.mb: connect failed: ${e instanceof Error ? e.message : e}\n`);
        return null;
    }
}
