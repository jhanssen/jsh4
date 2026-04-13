// WebSocket client to the MasterBandit applet. Sends popup commands, receives
// results and popup-closed notifications. Initialised from the REPL after a
// successful handshake().

import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, LastCommand } from "./protocol.js";
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

export type MbStateListener = (connected: boolean) => void;

export interface MbApi {
    createPopup(opts: CreatePopupOptions): Promise<PopupHandle>;
    getLastCommand(): Promise<LastCommand | null>;
    readonly connected: boolean;
    addEventListener(event: "stateChanged", fn: MbStateListener): void;
    removeEventListener(event: "stateChanged", fn: MbStateListener): void;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

class MbClient implements MbApi {
    private ws: WebSocket;
    private ready = false;
    private nextReqId = 1;
    private pending = new Map<number, PendingRequest>();
    private popups = new Map<string, PopupImpl>();
    private readyPromise: Promise<void>;
    private stateListeners = new Set<MbStateListener>();

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
                    this.setReady(true);
                    resolve();
                    return;
                }
                this.handleMessage(msg);
            });
            this.ws.on("close", () => {
                this.setReady(false);
                for (const p of this.pending.values()) p.reject(new Error("ws closed"));
                this.pending.clear();
                for (const popup of this.popups.values()) popup._markClosed();
                this.popups.clear();
            });
        });
    }

    private setReady(value: boolean): void {
        if (this.ready === value) return;
        this.ready = value;
        for (const fn of this.stateListeners) {
            try { fn(value); } catch { /* ignore listener errors */ }
        }
    }

    get connected(): boolean {
        return this.ready;
    }

    addEventListener(event: "stateChanged", fn: MbStateListener): void {
        if (event !== "stateChanged") return;
        this.stateListeners.add(fn);
    }

    removeEventListener(event: "stateChanged", fn: MbStateListener): void {
        if (event !== "stateChanged") return;
        this.stateListeners.delete(fn);
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
        if (msg.type === "lastCommandResult") {
            const p = this.pending.get(msg.reqId);
            if (p) {
                this.pending.delete(msg.reqId);
                p.resolve(msg.command);
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
            this.pending.set(reqId, {
                resolve: (v) => resolve(v as string),
                reject,
            });
        });
        this.send({ type: "createPopup", reqId, ...opts });
        const id = await idPromise;
        const popup = new PopupImpl(this, id);
        this.popups.set(id, popup);
        return popup;
    }

    async getLastCommand(): Promise<LastCommand | null> {
        if (!this.ready) throw new Error("mb client not ready");
        const reqId = this.nextReqId++;
        const p = new Promise<LastCommand | null>((resolve, reject) => {
            this.pending.set(reqId, {
                resolve: (v) => resolve(v as LastCommand | null),
                reject,
            });
        });
        this.send({ type: "getLastCommand", reqId });
        return p;
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
