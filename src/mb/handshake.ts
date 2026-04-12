// Startup-time handshake with MasterBandit. Runs in cooked mode, before the
// line editor takes over stdin. Any keystrokes typed during this window are
// discarded — the window is sub-second, and terminals don't usually deliver
// input before the shell is ready.
//
// Sequence:
//   1. XTGETTCAP probe for `mb-query-applet` → confirms we're under MB.
//   2. OSC 58300 "query;nonce=<hex>" → applet replies with port+token.
//
// Returns null if either step fails (not under MB, or applet not present).

import { randomBytes } from "node:crypto";
import { HANDSHAKE_OSC } from "./protocol.js";

export interface HandshakeResult {
    port: number;
    token: string;
    nonce: string;
}

const XTGETTCAP_CAP = "mb-query-applet";
const PROBE_TIMEOUT_MS = 300;
const ANNOUNCE_TIMEOUT_MS = 500;

function hexEncode(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        out += s.charCodeAt(i).toString(16).padStart(2, "0").toUpperCase();
    }
    return out;
}

/**
 * Raw-mode read from stdin until `matcher` returns a payload or `timeoutMs`
 * elapses. Writes `query` after raw mode is engaged. Returns the matched
 * payload or null on timeout.
 *
 * Leaves stdin in the same rawMode state it found it.
 */
function queryEscapeSeq(
    query: string,
    matcher: (buf: string) => string | null,
    timeoutMs: number,
): Promise<string | null> {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            resolve(null);
            return;
        }

        const wasRaw = process.stdin.isRaw;
        let buf = "";
        let finished = false;

        const cleanup = (result: string | null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            process.stdin.off("data", onData);
            process.stdin.pause();
            if (!wasRaw) process.stdin.setRawMode(false);
            resolve(result);
        };

        const onData = (chunk: Buffer): void => {
            buf += chunk.toString("binary");
            const payload = matcher(buf);
            if (payload !== null) cleanup(payload);
        };

        const timer = setTimeout(() => cleanup(null), timeoutMs);

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
        process.stdout.write(query);
    });
}

/**
 * Match a DCS response for the mb-query-applet cap.
 * Success reply: `ESC P 1 + r <hex-name>=<hex-value> ESC \`
 * Invalid reply: `ESC P 0 + r <hex-name> ESC \`
 */
function matchDcsResponse(buf: string): string | null {
    const start = buf.indexOf("\x1bP");
    if (start < 0) return null;
    // Look for terminator (ESC \) or BEL.
    const afterStart = buf.substring(start + 2);
    let endIdx = afterStart.indexOf("\x1b\\");
    if (endIdx < 0) endIdx = afterStart.indexOf("\x07");
    if (endIdx < 0) return null;
    const body = afterStart.substring(0, endIdx);
    // body is e.g. "1+r<hex>=<hex>" or "0+r<hex>"
    if (body.startsWith("1+r")) return body.substring(3);
    return ""; // empty string → explicit "not supported", distinct from null (still waiting)
}

/**
 * Match OSC 58300 announce reply: `ESC ] 58300 ; port=N;token=T ESC \`
 */
function matchAnnounceResponse(buf: string): string | null {
    const prefix = `\x1b]${HANDSHAKE_OSC};`;
    const start = buf.indexOf(prefix);
    if (start < 0) return null;
    const afterStart = buf.substring(start + prefix.length);
    let endIdx = afterStart.indexOf("\x1b\\");
    let termLen = 2;
    if (endIdx < 0) {
        endIdx = afterStart.indexOf("\x07");
        termLen = 1;
    }
    if (endIdx < 0) return null;
    void termLen;
    return afterStart.substring(0, endIdx);
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

export async function handshake(): Promise<HandshakeResult | null> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

    // Step 1: XTGETTCAP probe.
    const probeQuery = `\x1bP+q${hexEncode(XTGETTCAP_CAP)}\x1b\\`;
    const probeResult = await queryEscapeSeq(probeQuery, matchDcsResponse, PROBE_TIMEOUT_MS);
    if (!probeResult) return null; // not MB, or terminal didn't respond

    // Step 2: OSC announce query.
    const nonce = randomBytes(16).toString("hex");
    const announceQuery = `\x1b]${HANDSHAKE_OSC};query;nonce=${nonce}\x1b\\`;
    const announcePayload = await queryEscapeSeq(announceQuery, matchAnnounceResponse, ANNOUNCE_TIMEOUT_MS);
    if (!announcePayload) return null; // applet not loaded

    const parsed = parseAnnouncePayload(announcePayload);
    if (!parsed) return null;

    return { port: parsed.port, token: parsed.token, nonce };
}
