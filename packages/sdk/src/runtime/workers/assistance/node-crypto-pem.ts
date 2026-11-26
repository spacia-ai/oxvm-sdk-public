/**
 * PEM as OpenSSL writes and reads it: 64-column base64 between `-----BEGIN label-----` and `-----END label-----`,
 * optional RFC 1421 headers (the legacy `Proc-Type` / `DEK-Info` key encryption), text before and after a block
 * ignored, CRLF and trailing blanks tolerated.
 */

export type PemLabel = "PUBLIC KEY" | "PRIVATE KEY" | "RSA PUBLIC KEY" | "RSA PRIVATE KEY" | "EC PRIVATE KEY" | "ENCRYPTED PRIVATE KEY" | "CERTIFICATE";

export interface PemHeader { readonly name: string; readonly value: string }
export interface PemBlock { readonly label: string; readonly headers: readonly PemHeader[]; readonly body: Uint8Array }

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Map<string, number>();
for (let index = 0; index < ALPHABET.length; index += 1) VALUES.set(ALPHABET.charAt(index), index);
VALUES.set("-", 62); VALUES.set("_", 63);

/** Standard base64 with padding, or base64url without. */
export function base64Encode(bytes: Uint8Array, url = false): string {
  const alphabet = url ? URL_ALPHABET : ALPHABET;
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0, b = bytes[index + 1], c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    text += alphabet.charAt(triple >> 18) + alphabet.charAt((triple >> 12) & 63);
    text += b === undefined ? (url ? "" : "=") : alphabet.charAt((triple >> 6) & 63);
    text += c === undefined ? (url ? "" : "=") : alphabet.charAt(triple & 63);
  }
  return text;
}

/**
 * Decodes base64 or base64url. Lenient (as Node decodes JWK members): characters outside both alphabets are
 * skipped and padding is optional. Strict (as OpenSSL decodes a PEM body): anything else is refused with `undefined`.
 */
export function base64Decode(text: string, strict = false): Uint8Array | undefined {
  const sextets: number[] = [];
  let padding = 0;
  for (const character of text) {
    if (character === "=") { padding += 1; continue; }
    const value = VALUES.get(character);
    if (value === undefined || (strict && (character === "-" || character === "_"))) { if (strict) return undefined; continue; }
    if (padding > 0) { if (strict) return undefined; break; }
    sextets.push(value);
  }
  if (strict && (padding > 2 || (sextets.length + padding) % 4 !== 0)) return undefined;
  if (sextets.length % 4 === 1) { if (strict) return undefined; sextets.pop(); }
  const bytes = new Uint8Array(Math.floor(sextets.length * 6 / 8));
  let accumulator = 0, bits = 0, offset = 0;
  for (const sextet of sextets) {
    accumulator = ((accumulator << 6) | sextet) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[offset] = (accumulator >> bits) & 0xff; offset += 1; }
  }
  return bytes;
}

/** Encodes one block; headers, when given, are followed by the blank line OpenSSL writes. */
export function pemEncode(label: string, body: Uint8Array, headers: readonly PemHeader[] = []): string {
  const encoded = base64Encode(body);
  let text = `-----BEGIN ${label}-----\n`;
  for (const header of headers) text += `${header.name}: ${header.value}\n`;
  if (headers.length > 0) text += "\n";
  for (let offset = 0; offset < encoded.length; offset += 64) text += `${encoded.slice(offset, offset + 64)}\n`;
  return `${text}-----END ${label}-----\n`;
}

const BEGIN = "-----BEGIN ", END = "-----END ", TAIL = "-----";

/**
 * Every block of a text, in order. Reading stops at the first block that is malformed (no matching end line,
 * a body that is not base64), as OpenSSL's reader stops there; lines outside blocks are ignored.
 */
export function pemBlocks(text: string): PemBlock[] {
  // OpenSSL strips trailing blanks and control characters from every line; leading blanks are significant.
  const lines = text.split("\n").map(line => {
    let end = line.length;
    while (end > 0 && line.charCodeAt(end - 1) <= 0x20) end -= 1;
    return line.slice(0, end);
  });
  const blocks: PemBlock[] = [];
  let index = 0;
  for (;;) {
    let label: string | undefined;
    for (; index < lines.length && label === undefined; index += 1) {
      const line = lines[index] ?? "";
      if (line.startsWith(BEGIN) && line.endsWith(TAIL) && line.length >= BEGIN.length + TAIL.length) label = line.slice(BEGIN.length, -TAIL.length);
    }
    if (label === undefined) return blocks;
    const headers: PemHeader[] = [];
    if ((lines[index] ?? "").includes(":")) {
      for (; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line === "") { index += 1; break; }
        const colon = line.indexOf(":");
        if (colon < 0) break;
        headers.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trim() });
      }
    }
    let body = "", closed = false;
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.startsWith(END)) { closed = line === `${END}${label}${TAIL}`; index += 1; break; }
      body += line.replace(/[ \t\r]/gu, "");
    }
    const decoded = closed ? base64Decode(body, true) : undefined;
    if (decoded === undefined) return blocks;
    blocks.push({ label, headers, body: decoded });
  }
}

/** The first block of a text with one of the given labels (any label when none is given). */
export function pemDecode(text: string, ...labels: readonly string[]): PemBlock | undefined {
  return pemBlocks(text).find(block => labels.length === 0 || labels.includes(block.label));
}
