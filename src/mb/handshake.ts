// Async MasterBandit handshake. Fires XTGETTCAP and OSC 58300 announce queries
// immediately at startup and returns a listener that consumes DCS/OSC responses
// fed to it by the native input-engine parser during raw-mode edit sessions.
// `onResult` fires exactly once with either a HandshakeResult (we're under MB
// and the applet replied) or null (not MB / applet absent / timeout).

import { randomBytes } from "node:crypto";
import { HANDSHAKE_OSC } from "./protocol.js";

export interface HandshakeResult {
    port: number;
    token: string;
    nonce: string;
}

export interface HandshakeOptions {
    /**
     * If set, emit an OSC 58237 to load this applet file before firing the
     * XTGETTCAP / OSC 58300 handshake. The shell proceeds to the handshake
     * only after an ack with `status=loaded` arrives. Ack with denied/error,
     * or no ack within the timeout, resolves null.
     */
    loadApplet?: { path: string; permissions: string };
    /**
     * Called when the handshake needs to emit follow-up bytes mid-stream
     * (e.g. after the OSC 58237 load ack, the XTGETTCAP + OSC 58300 queries).
     * Must write to stdout in raw mode — kernel echo must be off.
     */
    emit?: (bytes: string) => void;
}

export interface HandshakeListener {
    /** Feed a DCS or OSC payload from the native parser. */
    handle(type: "DCS" | "OSC", payload: string): void;
    /** Cancel (stop waiting for responses). */
    cancel(): void;
    /**
     * Bytes the caller must emit to stdout *after* raw mode is active, so the
     * terminal's response doesn't get kernel-echoed to the user. Write once at
     * the start of the first edit session.
     */
    readonly queries: string;
}

const XTGETTCAP_CAP = "mb-query-applet";
const APPLET_LOAD_OSC = 58237;
const HANDSHAKE_TIMEOUT_MS = 30000; // user may be at a permission prompt

function hexEncode(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        out += s.charCodeAt(i).toString(16).padStart(2, "0").toUpperCase();
    }
    return out;
}

function parseAnnouncePayload(payload: string): { port: number; token: string } | null {
    const parts = payload.split(";");
    const kv: Record<string, string> = {};
    for (const p of parts) {
        const eq = p.indexOf("=");
        if (eq < 0) continue;
        kv[p.substring(0, eq)] = p.substring(eq + 1);
    }
    const port = Number(kv.port);
    const token = kv.token;
    if (!Number.isFinite(port) || port <= 0 || !token) return null;
    return { port, token };
}

/**
 * Start a handshake. Emits both queries to stdout immediately. The caller is
 * responsible for wiring `handle()` to the input-engine's onEscResponse.
 *
 * `onResult` fires once:
 *   - HandshakeResult → we're under MB, applet replied with port+token.
 *   - null            → explicit "not supported" from DCS, or timeout.
 */
export function startHandshake(
    onResult: (result: HandshakeResult | null) => void,
    options: HandshakeOptions = {},
    timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): HandshakeListener {
    const nonce = randomBytes(16).toString("hex");
    let resolved = false;
    let stage: "load" | "handshake" = options.loadApplet ? "load" : "handshake";

    const resolveOnce = (r: HandshakeResult | null): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        onResult(r);
    };

    const timer = setTimeout(() => resolveOnce(null), timeoutMs);

    // XTGETTCAP + OSC 58300 queries — fire atomically once we know the applet
    // is loaded (or immediately if no load step is requested).
    const probeQuery = `\x1bP+q${hexEncode(XTGETTCAP_CAP)}\x1b\\`;
    const announceQuery = `\x1b]${HANDSHAKE_OSC};query;nonce=${nonce}\x1b\\`;
    const handshakeQueries = probeQuery + announceQuery;

    // Initial queries: either the OSC 58237 load request (and we wait for the
    // ack before continuing), or the handshake queries directly.
    const initialQueries = options.loadApplet
        ? `\x1b]${APPLET_LOAD_OSC};applet;path=${options.loadApplet.path};permissions=${options.loadApplet.permissions}\x1b\\`
        : handshakeQueries;

    return {
        queries: initialQueries,
        handle(type: "DCS" | "OSC", payload: string): void {
            if (resolved) return;

            if (type === "OSC") {
                // OSC 58237 result ack: "58237;result;status=loaded|denied|error;..."
                const loadPrefix = `${APPLET_LOAD_OSC};result;`;
                if (stage === "load" && payload.startsWith(loadPrefix)) {
                    const body = payload.substring(loadPrefix.length);
                    const status = /status=([^;]+)/.exec(body)?.[1];
                    if (status === "loaded") {
                        stage = "handshake";
                        options.emit?.(handshakeQueries);
                        return;
                    }
                    if (status === "denied") {
                        process.stderr.write("jsh: mb applet load denied (see MB allowlist)\n");
                        resolveOnce(null);
                        return;
                    }
                    if (status === "error") {
                        const encoded = /error=([^;]*)/.exec(body)?.[1] ?? "";
                        let msg = encoded;
                        try { msg = decodeURIComponent(encoded); } catch { /* keep raw */ }
                        process.stderr.write(`jsh: mb applet load error: ${msg || "(no detail)"}\n`);
                        resolveOnce(null);
                    }
                    return;
                }

                // OSC 58300 handshake reply: "58300;port=N;token=T"
                const hsPrefix = `${HANDSHAKE_OSC};`;
                if (payload.startsWith(hsPrefix)) {
                    const parsed = parseAnnouncePayload(payload.substring(hsPrefix.length));
                    if (parsed) resolveOnce({ port: parsed.port, token: parsed.token, nonce });
                }
                return;
            }

            if (type === "DCS") {
                // XTGETTCAP responses: "1+r<hex>[=<hex>]" (supported) or
                // "0+r<hex>" (unknown). Explicit "0+r" → definitively not MB.
                if (payload.startsWith("0+r")) resolveOnce(null);
                // "1+r" → MB detected; we still wait for the OSC 58300 reply.
            }
        },
        cancel(): void {
            resolveOnce(null);
        },
    };
}
