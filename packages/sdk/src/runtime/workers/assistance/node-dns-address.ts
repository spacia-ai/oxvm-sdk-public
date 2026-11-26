/**
 * IP address text for `node:dns`: what Node accepts as an address (`net.isIP`, which is `inet_pton`), the text it
 * prints (`inet_ntop` as c-ares and libuv implement it), and the reverse-lookup names of RFC 1035 and RFC 3596.
 */

/** A dotted quad as `inet_pton` reads it: four decimal parts, none with a leading zero. */
export function parseIPv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255) return undefined;
    bytes[index] = Number(part);
  }
  return bytes;
}

function groups(part: string): number[] | undefined {
  if (part === "") return [];
  const words: number[] = [], pieces = part.split(":");
  for (const [index, piece] of pieces.entries()) {
    if (index === pieces.length - 1 && piece.includes(".")) {
      const quad = parseIPv4(piece);
      if (quad === undefined) return undefined;
      words.push(((quad[0] ?? 0) << 8) | (quad[1] ?? 0), ((quad[2] ?? 0) << 8) | (quad[3] ?? 0));
    } else if (/^[\da-f]{1,4}$/iu.test(piece)) words.push(Number.parseInt(piece, 16));
    else return undefined;
  }
  return words;
}

/** An IPv6 address as Node reads it: `inet_pton` after a `%zone` suffix is dropped. */
export function parseIPv6(text: string): Uint8Array | undefined {
  const zone = text.indexOf("%");
  if (zone === 0 || zone === text.length - 1) return undefined;
  const address = zone < 0 ? text : text.slice(0, zone), halves = address.split("::");
  if (halves.length > 2 || address === "") return undefined;
  const left = groups(halves[0] ?? ""), right = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (left === undefined || right === undefined) return undefined;
  // A dotted quad may only end the address.
  if (halves.length === 2 && (halves[0] ?? "").includes(".")) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const words = [...left, ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => 0), ...right], bytes = new Uint8Array(16);
  for (const [index, word] of words.entries()) { bytes[index * 2] = word >> 8; bytes[index * 2 + 1] = word & 0xff; }
  return bytes;
}

/** `net.isIP`. */
export function ipVersion(text: string): 0 | 4 | 6 {
  if (parseIPv4(text) !== undefined) return 4;
  return parseIPv6(text) === undefined ? 0 : 6;
}

export function parseAddress(text: string): { readonly family: 4 | 6; readonly bytes: Uint8Array } | undefined {
  const four = parseIPv4(text);
  if (four !== undefined) return { family: 4, bytes: four };
  const six = parseIPv6(text);
  return six === undefined ? undefined : { family: 6, bytes: six };
}

export function formatIPv4(bytes: Uint8Array): string { return Array.from(bytes.subarray(0, 4)).join("."); }

/**
 * `inet_ntop(AF_INET6)` in the BIND form c-ares and libuv share: the first longest run of two or more zero groups
 * becomes `::`, and an address whose leading 96 bits are an IPv4 prefix ends in a dotted quad.
 */
export function formatIPv6(bytes: Uint8Array): string {
  const words = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0));
  let bestBase = -1, bestLength = 0;
  for (let index = 0; index < 8;) {
    if (words[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < 8 && words[end] === 0) end += 1;
    if (end - index > bestLength) { bestBase = index; bestLength = end - index; }
    index = end;
  }
  if (bestLength < 2) bestBase = -1;
  let text = "";
  for (let index = 0; index < 8; index += 1) {
    if (bestBase >= 0 && index >= bestBase && index < bestBase + bestLength) { if (index === bestBase) text += ":"; continue; }
    if (index !== 0) text += ":";
    if (index === 6 && bestBase === 0 && (bestLength === 6 || (bestLength === 7 && words[7] !== 1) || (bestLength === 5 && words[5] === 0xffff))) {
      return text + formatIPv4(bytes.subarray(12, 16));
    }
    text += (words[index] ?? 0).toString(16);
  }
  if (bestBase >= 0 && bestBase + bestLength === 8) text += ":";
  return text;
}

export function formatAddress(family: 4 | 6, bytes: Uint8Array): string { return family === 4 ? formatIPv4(bytes) : formatIPv6(bytes); }

/** The IPv4-mapped IPv6 form of an IPv4 address (`::ffff:a.b.c.d`). */
export function mappedIPv6(four: Uint8Array): string {
  const bytes = new Uint8Array(16);
  bytes[10] = 0xff; bytes[11] = 0xff; bytes.set(four.subarray(0, 4), 12);
  return formatIPv6(bytes);
}

/** The name a PTR query asks for: `4.3.2.1.in-addr.arpa`, or the 32 nibbles of an IPv6 address under `ip6.arpa`. */
export function reverseName(family: 4 | 6, bytes: Uint8Array): string {
  if (family === 4) return `${Array.from(bytes.subarray(0, 4)).reverse().join(".")}.in-addr.arpa`;
  const nibbles: string[] = [];
  for (let index = 15; index >= 0; index -= 1) { const byte = bytes[index] ?? 0; nibbles.push((byte & 0xf).toString(16), (byte >> 4).toString(16)); }
  return `${nibbles.join(".")}.ip6.arpa`;
}

/**
 * `inet_aton`, which `getaddrinfo` applies before any lookup: one to four parts in decimal, octal (`0…`) or
 * hexadecimal (`0x…`), the last part filling the remaining bytes.
 */
export function parseLegacyIPv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    const value = /^0x[\da-f]+$/iu.test(part) ? Number.parseInt(part.slice(2), 16) : /^0[0-7]*$/u.test(part) ? Number.parseInt(part, 8) : /^[1-9]\d*$/u.test(part) ? Number(part) : Number.NaN;
    if (!Number.isFinite(value)) return undefined;
    values.push(value);
  }
  const last = values.pop() ?? 0, bytes = new Uint8Array(4);
  if (values.some(value => value > 255) || last >= 2 ** (8 * (4 - values.length))) return undefined;
  bytes.set(values, 0);
  for (let index = 3, rest = last; index >= values.length; index -= 1) { bytes[index] = rest % 256; rest = Math.floor(rest / 256); }
  return bytes;
}
