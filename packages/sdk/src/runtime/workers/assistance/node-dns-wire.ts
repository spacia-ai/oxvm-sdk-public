import { formatIPv4, formatIPv6 } from "./node-dns-address.ts";

/**
 * DNS messages on the wire (RFC 1035) as `node:dns` needs them: the query Node 24's c-ares sends (recursion desired, one
 * question, no EDNS record — recorded from Node 24.18.1) and a strict decoder for every record type `dns.resolve*`
 * reports. A reply is hostile input: every read is bounded by the message, a compression pointer may only point
 * backwards, and anything else is a `DnsWireError`, which the resolver reports as `EBADRESP`.
 */
export const RR_TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, OPT: 41, TLSA: 52, ANY: 255, CAA: 257 } as const;
export type QueryType = Exclude<keyof typeof RR_TYPE, "OPT">;

export type DnsRecordData =
  | { readonly type: "A"; readonly address: string }
  | { readonly type: "AAAA"; readonly address: string }
  | { readonly type: "CNAME"; readonly value: string }
  | { readonly type: "NS"; readonly value: string }
  | { readonly type: "PTR"; readonly value: string }
  | { readonly type: "MX"; readonly priority: number; readonly exchange: string }
  | { readonly type: "TXT"; readonly entries: readonly string[] }
  | { readonly type: "SRV"; readonly priority: number; readonly weight: number; readonly port: number; readonly name: string }
  | { readonly type: "SOA"; readonly nsname: string; readonly hostmaster: string; readonly serial: number; readonly refresh: number; readonly retry: number; readonly expire: number; readonly minttl: number }
  | { readonly type: "NAPTR"; readonly order: number; readonly preference: number; readonly flags: string; readonly service: string; readonly regexp: string; readonly replacement: string }
  | { readonly type: "CAA"; readonly critical: number; readonly tag: string; readonly value: string }
  | { readonly type: "TLSA"; readonly certUsage: number; readonly selector: number; readonly match: number; readonly data: Uint8Array }
  /** A record type `dns` does not report; its bytes are kept as they came. */
  | { readonly type: "OTHER"; readonly code: number; readonly data: Uint8Array };

export interface DnsRecord { readonly name: string; readonly class: number; readonly ttl: number; readonly data: DnsRecordData }
export interface DnsQuestion { readonly name: string; readonly type: number; readonly class: number }
export interface DnsMessage {
  readonly id: number;
  readonly response: boolean;
  readonly truncated: boolean;
  readonly rcode: number;
  readonly question: DnsQuestion;
  readonly answers: readonly DnsRecord[];
  readonly authorities: readonly DnsRecord[];
  readonly additionals: readonly DnsRecord[];
}

/** A reply that is not a well-formed DNS message. */
export class DnsWireError extends Error {}
/** A name that cannot be asked for (c-ares `EBADNAME`). */
export class DnsNameError extends Error {}

const MAX_NAME_BYTES = 255, MAX_LABEL_BYTES = 63;
function malformed(message: string): never { throw new DnsWireError(message); }

/**
 * The labels of a name to ask for, as c-ares checks them: letters, digits, `-`, `_`, `/` and `*`, each label 1 to 63
 * bytes, 255 bytes on the wire in all. The empty name and `.` are the root.
 */
export function nameLabels(name: string): readonly string[] {
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  if (trimmed === "") return [];
  const labels = trimmed.split(".");
  let wire = 1;
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_BYTES || !/^[\w\-/*]+$/u.test(label)) throw new DnsNameError(`"${name}" is not a DNS name`);
    wire += label.length + 1;
  }
  if (wire > MAX_NAME_BYTES) throw new DnsNameError(`"${name}" is longer than a DNS name`);
  return labels;
}

/** A recursive query for one name and type: the 12-byte header, then the question. */
export function encodeQuery(id: number, name: string, type: number): Uint8Array<ArrayBuffer> {
  const labels = nameLabels(name), length = labels.reduce((total, label) => total + label.length + 1, 1);
  const bytes = new Uint8Array(12 + length + 4), view = new DataView(bytes.buffer);
  view.setUint16(0, id & 0xffff); view.setUint16(2, 0x0100); view.setUint16(4, 1);
  let at = 12;
  for (const label of labels) {
    bytes[at] = label.length;
    for (let index = 0; index < label.length; index += 1) bytes[at + 1 + index] = label.charCodeAt(index);
    at += label.length + 1;
  }
  view.setUint16(at + 1, type); view.setUint16(at + 3, 1);
  return bytes;
}

/** A cursor over the message; every read checks the bytes are there. */
class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  need(count: number): void { if (count < 0 || this.at + count > this.bytes.length) malformed("Truncated DNS message"); }
  u8(): number { this.need(1); const value = this.bytes[this.at] ?? 0; this.at += 1; return value; }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return this.u16() * 0x1_0000 + this.u16(); }
  take(count: number): Uint8Array { this.need(count); const value = this.bytes.subarray(this.at, this.at + count); this.at += count; return value; }
  /** A `<character-string>`: a length byte and that many bytes, read as Latin-1 like Node does. */
  text(): string { return latin1(this.take(this.u8())); }
  /**
   * A possibly compressed name in c-ares' presentation form: bytes outside printable ASCII become `\DDD`, and the
   * characters `" . ; \ ( ) @ $` are escaped with a backslash. A pointer must point before the label it replaces.
   */
  name(): string {
    const labels: string[] = [];
    let at = this.at, resume: number | undefined, wire = 1;
    for (;;) {
      const length = this.bytes[at];
      if (length === undefined) malformed("Truncated DNS name");
      if (length === 0) { at += 1; break; }
      if ((length & 0xc0) === 0xc0) {
        const low = this.bytes[at + 1];
        if (low === undefined) malformed("Truncated DNS name pointer");
        const target = ((length & 0x3f) << 8) | low;
        if (target >= at) malformed("A DNS name pointer must point backwards");
        resume ??= at + 2;
        at = target;
        continue;
      }
      if ((length & 0xc0) !== 0 || at + 1 + length > this.bytes.length) malformed("Invalid DNS label");
      wire += length + 1;
      if (wire > MAX_NAME_BYTES) malformed("DNS name too long");
      labels.push(presentation(this.bytes.subarray(at + 1, at + 1 + length)));
      at += length + 1;
    }
    this.at = resume ?? at;
    return labels.join(".");
  }
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}
const RESERVED = new Set(["\"", ".", ";", "\\", "(", ")", "@", "$"]);
function presentation(label: Uint8Array): string {
  let text = "";
  for (const byte of label) {
    const character = String.fromCharCode(byte);
    if (byte < 0x20 || byte > 0x7e) text += `\\${String(byte).padStart(3, "0")}`;
    else text += RESERVED.has(character) ? `\\${character}` : character;
  }
  return text;
}

function data(cursor: Cursor, type: number, length: number): DnsRecordData {
  const end = cursor.at + length;
  switch (type) {
    case RR_TYPE.A: return { type: "A", address: formatIPv4(cursor.take(4)) };
    case RR_TYPE.AAAA: return { type: "AAAA", address: formatIPv6(cursor.take(16)) };
    case RR_TYPE.CNAME: return { type: "CNAME", value: cursor.name() };
    case RR_TYPE.NS: return { type: "NS", value: cursor.name() };
    case RR_TYPE.PTR: return { type: "PTR", value: cursor.name() };
    case RR_TYPE.MX: return { type: "MX", priority: cursor.u16(), exchange: cursor.name() };
    case RR_TYPE.TXT: {
      const entries: string[] = [];
      while (cursor.at < end) entries.push(cursor.text());
      return { type: "TXT", entries };
    }
    case RR_TYPE.SRV: return { type: "SRV", priority: cursor.u16(), weight: cursor.u16(), port: cursor.u16(), name: cursor.name() };
    case RR_TYPE.SOA: return { type: "SOA", nsname: cursor.name(), hostmaster: cursor.name(), serial: cursor.u32(), refresh: cursor.u32(), retry: cursor.u32(), expire: cursor.u32(), minttl: cursor.u32() };
    case RR_TYPE.NAPTR: return { type: "NAPTR", order: cursor.u16(), preference: cursor.u16(), flags: cursor.text(), service: cursor.text(), regexp: cursor.text(), replacement: cursor.name() };
    case RR_TYPE.CAA: {
      const critical = cursor.u8(), tag = cursor.text();
      if (cursor.at > end) malformed("A CAA tag overruns its record");
      return { type: "CAA", critical, tag, value: latin1(cursor.take(end - cursor.at)) };
    }
    case RR_TYPE.TLSA: {
      const certUsage = cursor.u8(), selector = cursor.u8(), match = cursor.u8();
      if (cursor.at >= end) malformed("A TLSA record carries no certificate data");
      return { type: "TLSA", certUsage, selector, match, data: cursor.take(end - cursor.at).slice() };
    }
    default: return { type: "OTHER", code: type, data: cursor.take(length).slice() };
  }
}

function records(cursor: Cursor, count: number): DnsRecord[] {
  const list: DnsRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = cursor.name(), type = cursor.u16(), recordClass = cursor.u16(), ttl = cursor.u32(), length = cursor.u16();
    cursor.need(length);
    const end = cursor.at + length, parsed = data(cursor, type, length);
    // A record may carry more than its type defines, never less than it read.
    if (cursor.at > end) malformed("DNS record data overruns its length");
    cursor.at = end;
    list.push({ name, class: recordClass, ttl, data: parsed });
  }
  return list;
}

/** Decodes a whole message: the header, its one question, and the three record sections. */
export function decodeMessage(bytes: Uint8Array): DnsMessage {
  const cursor = new Cursor(bytes);
  const id = cursor.u16(), flags = cursor.u16(), questions = cursor.u16(), answers = cursor.u16(), authorities = cursor.u16(), additionals = cursor.u16();
  if (questions !== 1) malformed("A DNS message carries exactly one question");
  const question = { name: cursor.name(), type: cursor.u16(), class: cursor.u16() };
  return {
    id, response: (flags & 0x8000) !== 0, truncated: (flags & 0x0200) !== 0, rcode: flags & 0x000f, question,
    answers: records(cursor, answers), authorities: records(cursor, authorities), additionals: records(cursor, additionals),
  };
}

/** The ID and question of a reply, or undefined when even those cannot be read. */
export function peekQuestion(bytes: Uint8Array): { readonly id: number; readonly response: boolean; readonly question: DnsQuestion } | undefined {
  try {
    const cursor = new Cursor(bytes), id = cursor.u16(), flags = cursor.u16();
    if (cursor.u16() !== 1) return undefined;
    cursor.at = 12;
    return { id, response: (flags & 0x8000) !== 0, question: { name: cursor.name(), type: cursor.u16(), class: cursor.u16() } };
  } catch (error) {
    if (error instanceof DnsWireError) return undefined;
    throw error;
  }
}
