// WebSocket client to the MasterBandit applet. Sends popup commands, receives
// results and popup-closed notifications. Initialised from the REPL after a
// successful handshake().

import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, MbCommandRecord, ClipboardSource } from "./protocol.js";
import type { HandshakeResult } from "./handshake.js";

/**
 * Produces fresh credentials for a new WS connection. Each call fires a fresh
 * OSC 58300 handshake, returning new port+token+nonce when the applet replies,
 * or null on timeout / MB gone. A cached nonce cannot be reused — the applet
 * consumes it on the first `hello`.
 */
export type CredentialProvider = () => Promise<HandshakeResult | null>;

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
    getSelectedCommand(): Promise<MbCommandRecord | null>;
    selectCommand(id: number | null): void;
    getSelection(): Promise<string | null>;
    getClipboard(source?: ClipboardSource): Promise<string>;
    setClipboard(text: string, source?: ClipboardSource): Promise<void>;
    readonly connected: boolean;
    addEventListener(event: "stateChanged", fn: MbStateListener): void;
    removeEventListener(event: "stateChanged", fn: MbStateListener): void;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8000;

class MbClient implements MbApi {
    private ws: WebSocket | null = null;
    private ready = false;
    private nextReqId = 1;
    private pending = new Map<number, PendingRequest>();
    private popups = new Map<string, PopupImpl>();
    private readyPromise: Promise<void>;
    private readyResolve!: () => void;
    private readyReject!: (err: Error) => void;
    private stateListeners = new Set<MbStateListener>();
    private getCreds: CredentialProvider;
    private shuttingDown = false;
    private reconnectAttempts = 0;
    private givenUp = false;

    constructor(initial: HandshakeResult, getCreds: CredentialProvider) {
        this.getCreds = getCreds;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        this.connect(initial);
    }

    private connect(creds: HandshakeResult): void {
        if (this.shuttingDown) return;
        const { port, token, nonce } = creds;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, [`mb-shell.${token}`]);
        this.ws = ws;

        ws.once("open", () => this.send({ type: "hello", nonce }));

        ws.once("error", (err) => {
            // Initial attempt only: propagate to readyPromise if we're not ready
            // and have never been. After the first successful connect, errors
            // feed into the reconnect path via the close handler.
            if (!this.ready && this.reconnectAttempts === 0) this.readyReject(err);
        });

        ws.on("message", (data) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            let msg: ServerMessage;
            try {
                msg = JSON.parse(text) as ServerMessage;
            } catch {
                return;
            }
            if (msg.type === "ready") {
                this.reconnectAttempts = 0;
                this.setReady(true);
                this.readyResolve();
                return;
            }
            this.handleMessage(msg);
        });

        ws.on("close", () => {
            this.setReady(false);
            // Drop in-flight request promises; callers can retry.
            for (const p of this.pending.values()) p.reject(new Error("ws closed"));
            this.pending.clear();
            // Popups were owned by the previous connection; mark them closed.
            for (const popup of this.popups.values()) popup._markClosed();
            this.popups.clear();
            this.ws = null;
            if (!this.shuttingDown && !this.givenUp) this.scheduleReconnect();
        });
    }

    private async scheduleReconnect(): Promise<void> {
        if (this.shuttingDown || this.givenUp) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        await new Promise((r) => setTimeout(r, delay));
        if (this.shuttingDown || this.givenUp) return;

        // Always re-handshake: the applet consumed the previous nonce on its
        // first `hello`. A stale cached nonce would be rejected.
        const fresh = await this.getCreds();
        if (this.shuttingDown) return;
        if (!fresh) {
            // Handshake timed out — MB gone. Stop retrying.
            this.givenUp = true;
            return;
        }
        this.connect(fresh);
    }

    close(): void {
        this.shuttingDown = true;
        if (this.ws) this.ws.close();
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

    /**
     * Wait until the WS is ready, or fail. Returns immediately if already
     * connected. Rejects if we've given up, or if `timeoutMs` elapses.
     */
    private async awaitReady(timeoutMs: number = 10000): Promise<void> {
        if (this.ready) return;
        if (this.givenUp) throw new Error("mb: connection permanently unavailable");
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.stateListeners.delete(listener);
                reject(new Error("mb: timeout waiting for connection"));
            }, timeoutMs);
            const listener: MbStateListener = (connected) => {
                if (connected) {
                    clearTimeout(timer);
                    this.stateListeners.delete(listener);
                    resolve();
                }
            };
            this.stateListeners.add(listener);
        });
    }

    private send(msg: ClientMessage): void {
        if (!this.ws) return;
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
        if (msg.type === "selectedCommandResult") {
            const p = this.pending.get(msg.reqId);
            if (p) {
                this.pending.delete(msg.reqId);
                p.resolve(msg.command);
            }
            return;
        }
        if (msg.type === "selectionResult") {
            const p = this.pending.get(msg.reqId);
            if (p) {
                this.pending.delete(msg.reqId);
                p.resolve(msg.text);
            }
            return;
        }
        if (msg.type === "clipboardResult") {
            const p = this.pending.get(msg.reqId);
            if (p) {
                this.pending.delete(msg.reqId);
                p.resolve(msg.text);
            }
            return;
        }
        if (msg.type === "setClipboardResult") {
            const p = this.pending.get(msg.reqId);
            if (p) {
                this.pending.delete(msg.reqId);
                p.resolve(undefined);
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
        await this.awaitReady();
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

    async getSelectedCommand(): Promise<MbCommandRecord | null> {
        await this.awaitReady();
        const reqId = this.nextReqId++;
        const p = new Promise<MbCommandRecord | null>((resolve, reject) => {
            this.pending.set(reqId, {
                resolve: (v) => resolve(v as MbCommandRecord | null),
                reject,
            });
        });
        this.send({ type: "getSelectedCommand", reqId });
        return p;
    }

    selectCommand(id: number | null): void {
        if (!this.ready) return;
        this.send({ type: "selectCommand", id });
    }

    async getSelection(): Promise<string | null> {
        await this.awaitReady();
        const reqId = this.nextReqId++;
        const p = new Promise<string | null>((resolve, reject) => {
            this.pending.set(reqId, {
                resolve: (v) => resolve(v as string | null),
                reject,
            });
        });
        this.send({ type: "getSelection", reqId });
        return p;
    }

    async getClipboard(source?: ClipboardSource): Promise<string> {
        await this.awaitReady();
        const reqId = this.nextReqId++;
        const p = new Promise<string>((resolve, reject) => {
            this.pending.set(reqId, {
                resolve: (v) => resolve(v as string),
                reject,
            });
        });
        this.send({ type: "getClipboard", reqId, source });
        return p;
    }

    async setClipboard(text: string, source?: ClipboardSource): Promise<void> {
        await this.awaitReady();
        const reqId = this.nextReqId++;
        const p = new Promise<void>((resolve, reject) => {
            this.pending.set(reqId, {
                resolve: () => resolve(),
                reject,
            });
        });
        this.send({ type: "setClipboard", reqId, text, source });
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

export async function connectMb(
    initial: HandshakeResult,
    getCreds: CredentialProvider,
): Promise<MbApi | null> {
    try {
        const client = new MbClient(initial, getCreds);
        await client.waitReady();
        return client;
    } catch (e) {
        process.stderr.write(`jsh.mb: connect failed: ${e instanceof Error ? e.message : e}\n`);
        return null;
    }
}
