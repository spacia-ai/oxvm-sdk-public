import { parseIPv4, parseIPv6 } from "./node-dns-address.ts";
import { RR_TYPE, type DnsRecordData } from "./node-dns-wire.ts";

/**
 * The reply side of the DNS codec: builds response messages from records. The resolver itself only asks questions; this
 * serves its tests and any in-memory answerer. Names are written in full except an owner equal to the question, which
 * is the usual compression pointer to offset 12.
 */
export interface EncodedRecord { readonly name?: string; readonly ttl?: number; readonly data: DnsRecordData }
export interface EncodedResponse {
  readonly id: number;
  readonly name: string;
  readonly type: number;
  readonly rcode?: number;
  readonly truncated?: boolean;
  readonly answers?: readonly EncodedRecord[];
  readonly authorities?: readonly EncodedRecord[];
}

class Bytes {
  readonly #bytes: number[] = [];
  get length(): number { return this.#bytes.length; }
  u8(value: number): this { this.#bytes.push(value & 0xff); return this; }
  u16(value: number): this { return this.u8(value >> 8).u8(value); }
  u32(value: number): this { return this.u16(Math.floor(value / 0x1_0000)).u16(value % 0x1_0000); }
  raw(values: Iterable<number>): this { for (const value of values) this.u8(value); return this; }
  text(value: string): this { this.u8(value.length); for (let index = 0; index < value.length; index += 1) this.u8(value.charCodeAt(index)); return this; }
  name(value: string): this {
    for (const label of value.split(".")) if (label !== "") this.text(label);
    return this.u8(0);
  }
  finish(): Uint8Array<ArrayBuffer> { return Uint8Array.from(this.#bytes); }
}

const TYPE_CODES: Readonly<Record<Exclude<DnsRecordData["type"], "OTHER">, number>> = RR_TYPE;

function rdata(data: DnsRecordData): Uint8Array {
  const out = new Bytes();
  switch (data.type) {
    case "A": out.raw(parseIPv4(data.address) ?? []); break;
    case "AAAA": out.raw(parseIPv6(data.address) ?? []); break;
    case "CNAME": case "NS": case "PTR": out.name(data.value); break;
    case "MX": out.u16(data.priority).name(data.exchange); break;
    case "TXT": for (const entry of data.entries) out.text(entry); break;
    case "SRV": out.u16(data.priority).u16(data.weight).u16(data.port).name(data.name); break;
    case "SOA": out.name(data.nsname).name(data.hostmaster).u32(data.serial).u32(data.refresh).u32(data.retry).u32(data.expire).u32(data.minttl); break;
    case "NAPTR": out.u16(data.order).u16(data.preference).text(data.flags).text(data.service).text(data.regexp).name(data.replacement); break;
    case "CAA": out.u8(data.critical).text(data.tag); for (let index = 0; index < data.value.length; index += 1) out.u8(data.value.charCodeAt(index)); break;
    case "TLSA": out.u8(data.certUsage).u8(data.selector).u8(data.match).raw(data.data); break;
    case "OTHER": out.raw(data.data); break;
  }
  return out.finish();
}

function record(out: Bytes, question: string, entry: EncodedRecord): void {
  if (entry.name === undefined || entry.name.toLowerCase() === question.toLowerCase()) out.u16(0xc00c);
  else out.name(entry.name);
  const bytes = rdata(entry.data);
  out.u16(entry.data.type === "OTHER" ? entry.data.code : TYPE_CODES[entry.data.type]).u16(1).u32(entry.ttl ?? 0).u16(bytes.length).raw(bytes);
}

/** A response to the question `name`/`type` with the given ID: recursion desired and available, as a resolver answers. */
export function encodeResponse(response: EncodedResponse): Uint8Array<ArrayBuffer> {
  const out = new Bytes(), answers = response.answers ?? [], authorities = response.authorities ?? [];
  out.u16(response.id).u16(0x8180 | (response.truncated === true ? 0x0200 : 0) | ((response.rcode ?? 0) & 0xf));
  out.u16(1).u16(answers.length).u16(authorities.length).u16(0);
  out.name(response.name).u16(response.type).u16(1);
  for (const entry of answers) record(out, response.name, entry);
  for (const entry of authorities) record(out, response.name, entry);
  return out.finish();
}
