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
const HANDSHAKE_TIMEOUT_MS = 5000;

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
    timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): HandshakeListener {
    const nonce = randomBytes(16).toString("hex");
    let resolved = false;

    const resolve = (r: HandshakeResult | null): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        onResult(r);
    };

    const timer = setTimeout(() => resolve(null), timeoutMs);

    // Queries are emitted by the caller once raw mode is active. Writing them
    // in cooked mode would let the kernel echo terminal responses back to the
    // user as visible escape-sequence junk.
    const probeQuery = `\x1bP+q${hexEncode(XTGETTCAP_CAP)}\x1b\\`;
    const announceQuery = `\x1b]${HANDSHAKE_OSC};query;nonce=${nonce}\x1b\\`;
    const queries = probeQuery + announceQuery;

    return {
        queries,
        handle(type: "DCS" | "OSC", payload: string): void {
            if (resolved) return;

            if (type === "DCS") {
                // XTGETTCAP responses: "1+r<hex>[=<hex>]" (supported) or
                // "0+r<hex>" (unknown). Explicit "0+r" for our cap is a
                // definitive "not MB" — resolve null early.
                if (payload.startsWith("0+r")) resolve(null);
                // "1+r" means MB detected. We don't resolve yet — waiting on
                // the OSC 58300 reply with port+token from the applet.
                return;
            }

            if (type === "OSC") {
                // Native parser strips the ESC ] and terminator; payload looks
                // like "58300;port=N;token=T".
                const prefix = `${HANDSHAKE_OSC};`;
                if (!payload.startsWith(prefix)) return;
                const parsed = parseAnnouncePayload(payload.substring(prefix.length));
                if (parsed) resolve({ port: parsed.port, token: parsed.token, nonce });
            }
        },
        cancel(): void {
            resolve(null);
        },
    };
}
