/**
 * The opening handshake of the fast path's `WebSocket` (RFC 6455 section 4), written on the process's own socket.
 *
 * The request carries what undici's does in Node.js v24.18.1, except `Sec-WebSocket-Extensions`: no extension is
 * implemented here, so none is offered and a server that names one is refused. The answer is checked in undici's
 * order (`lib/web/websocket/connection.js`): status 101, a subprotocol when some were offered, `Upgrade`,
 * `Connection`, `Sec-WebSocket-Accept`, extensions, and that the subprotocol is one of those offered. A redirect is
 * not followed: any status but 101 fails the connection, as in Node.
 */
import { sha1 } from "@noble/hashes/legacy.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The longest response head read before the connection is given up. */
export const MAX_HEAD_BYTES = 16_384;
/** The headers undici's fetch adds to a WebSocket request, in the absence of the program's own. */
const DEFAULTS: readonly (readonly [string, string])[] = [["accept", "*/*"], ["accept-language", "*"], ["sec-fetch-mode", "websocket"], ["user-agent", "node"], ["pragma", "no-cache"], ["cache-control", "no-cache"], ["accept-encoding", "gzip, deflate"]];
/** The handshake's own headers: a program's value for one of these is not sent. */
const OWNED = new Set(["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "content-length", "transfer-encoding"]);
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }

/** A fresh `Sec-WebSocket-Key`: 16 random bytes. */
export function createKey(): string { return base64(crypto.getRandomValues(new Uint8Array(16))); }
/** The `Sec-WebSocket-Accept` a server must answer `key` with. */
export function acceptFor(key: string): string { return base64(sha1(encoder.encode(`${key}${GUID}`))); }

/** The request head of the upgrade. `headers` are the program's, with lower-case names. */
export function encodeUpgrade(url: URL, key: string, protocols: readonly string[], headers: ReadonlyMap<string, string>): Uint8Array {
  const fields: [string, string][] = [["host", url.host], ["connection", "upgrade"], ["upgrade", "websocket"]];
  for (const [name, value] of headers) if (!OWNED.has(name)) fields.push([name, value]);
  for (const [name, value] of DEFAULTS) if (!headers.has(name)) fields.push([name, value]);
  fields.push(["sec-websocket-key", key], ["sec-websocket-version", "13"]);
  if (protocols.length > 0) fields.push(["sec-websocket-protocol", protocols.join(", ")]);
  return encoder.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\n${fields.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
}

/** The status and headers of a response head; `undefined` when the bytes are not an HTTP/1.1 response. */
function parseHead(text: string): { readonly status: number; readonly headers: Map<string, string> } | undefined {
  const lines = text.split("\r\n"), status = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(lines[0] ?? "");
  if (status === null) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim(), previous = headers.get(name);
    headers.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }
  return { status: Number(status[1]), headers };
}

/** How the server answered: the chosen subprotocol, or why the connection fails. */
export type Answer = { readonly protocol: string } | { readonly failure: string };

/** Checks a complete response head against the request that was sent. */
export function checkAnswer(head: Uint8Array, key: string, protocols: readonly string[]): Answer {
  const parsed = parseHead(new TextDecoder("latin1").decode(head));
  if (parsed?.status !== 101) return { failure: "Received network error or non-101 status code." };
  const { headers } = parsed, protocol = headers.get("sec-websocket-protocol");
  if (protocols.length !== 0 && (protocol === undefined || protocol === "")) return { failure: "Server did not respond with sent protocols." };
  if (headers.get("upgrade")?.toLowerCase() !== "websocket") return { failure: 'Server did not set Upgrade header to "websocket".' };
  if (headers.get("connection")?.toLowerCase() !== "upgrade") return { failure: 'Server did not set Connection header to "upgrade".' };
  if (headers.get("sec-websocket-accept") !== acceptFor(key)) return { failure: "Incorrect hash received in Sec-WebSocket-Accept header." };
  if (headers.has("sec-websocket-extensions")) return { failure: "Sec-WebSocket-Extensions header does not match." };
  // Node 24.18.1 throws an uncaught TypeError when a server names a subprotocol and none was offered; here it fails the connection.
  if (protocol !== undefined && !protocols.includes(protocol)) return { failure: "Protocol was not set in the opening handshake." };
  return { protocol: protocol ?? "" };
}

/** Where the response head ends in `bytes` (after the blank line), or -1. */
export function headEnd(bytes: Uint8Array): number {
  for (let index = 3; index < bytes.length; index++) if (bytes[index] === 10 && bytes[index - 1] === 13 && bytes[index - 2] === 10 && bytes[index - 3] === 13) return index + 1;
  return -1;
}
