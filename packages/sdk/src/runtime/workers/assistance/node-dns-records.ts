import { DnsFailure, type DnsStatus } from "./node-dns-errors.ts";
import { RR_TYPE, type DnsMessage, type DnsRecord, type DnsRecordData } from "./node-dns-wire.ts";

/**
 * The results of `dns.resolve*` as Node 24 builds them from a reply (src/cares_wrap.cc over c-ares' `ares_parse_*_reply`
 * functions), recorded from Node 24.18.1 against a scripted server. The parsers take records by type wherever they
 * stand in the answer section, whatever name owns them, and differ in what an answer without their type means: an
 * empty list, ENODATA, or for SOA EBADRESP.
 */
export const QUERY_KINDS = {
  queryAny: RR_TYPE.ANY, queryA: RR_TYPE.A, queryAaaa: RR_TYPE.AAAA, queryCaa: RR_TYPE.CAA, queryCname: RR_TYPE.CNAME,
  queryMx: RR_TYPE.MX, queryNs: RR_TYPE.NS, queryTlsa: RR_TYPE.TLSA, queryTxt: RR_TYPE.TXT, querySrv: RR_TYPE.SRV,
  queryPtr: RR_TYPE.PTR, queryNaptr: RR_TYPE.NAPTR, querySoa: RR_TYPE.SOA, getHostByAddr: RR_TYPE.PTR,
} as const;
export type QueryKind = keyof typeof QUERY_KINDS;

type Data<Type extends DnsRecordData["type"]> = Extract<DnsRecordData, { readonly type: Type }>;
function of<Type extends DnsRecordData["type"]>(answers: readonly DnsRecord[], type: Type): { readonly record: DnsRecord; readonly data: Data<Type>; readonly index: number }[] {
  const found: { readonly record: DnsRecord; readonly data: Data<Type>; readonly index: number }[] = [];
  for (const [index, record] of answers.entries()) {
    const data = record.data;
    if (isType(data, type)) found.push({ record, data, index });
  }
  return found;
}
function isType<Type extends DnsRecordData["type"]>(data: DnsRecordData, type: Type): data is Data<Type> { return data.type === type; }

const RCODE_STATUS: ReadonlyMap<number, DnsStatus> = new Map([[1, "EFORMERR"], [2, "ESERVFAIL"], [3, "ENOTFOUND"], [4, "ENOTIMP"], [5, "EREFUSED"]]);
/** The status of a reply that carries no usable answer section, or undefined for one that does. */
export function replyStatus(message: DnsMessage): DnsStatus | undefined {
  if (message.rcode !== 0) return RCODE_STATUS.get(message.rcode) ?? "ENODATA";
  return message.answers.length === 0 ? "ENODATA" : undefined;
}

/** c-ares reports at most this many addresses. */
const MAX_ADDRESSES = 256;
/** A and AAAA: the addresses of the family, each with the smaller of its own TTL and the CNAME chain's. */
function addresses(message: DnsMessage, type: "A" | "AAAA"): { address: string; ttl: number }[] {
  const cnames = of(message.answers, "CNAME"), wanted = of(message.answers, type);
  // An alias without an address of the family is an empty answer; neither is no data.
  if (cnames.length === 0 && wanted.length === 0) throw new DnsFailure("ENODATA");
  const chain = Math.min(...cnames.map(entry => entry.record.ttl));
  return wanted.slice(0, MAX_ADDRESSES).map(entry => ({ address: entry.data.address, ttl: Math.min(entry.record.ttl, chain) }));
}
/** NS and PTR: the names, or ENODATA when the answer holds none. */
function names(message: DnsMessage, type: "NS" | "PTR"): string[] {
  const found = of(message.answers, type).map(entry => entry.data.value);
  if (found.length === 0) throw new DnsFailure("ENODATA");
  return found;
}
/** What c-ares calls the host's name: the first CNAME's target, else the name asked for. */
function canonical(message: DnsMessage): string {
  if (of(message.answers, "CNAME").length + of(message.answers, "A").length + of(message.answers, "AAAA").length === 0) throw new DnsFailure("ENODATA");
  return of(message.answers, "CNAME")[0]?.data.value ?? message.question.name;
}
const mx = (data: Data<"MX">) => ({ exchange: data.exchange, priority: data.priority, type: "MX" });
const srv = (data: Data<"SRV">) => ({ name: data.name, port: data.port, priority: data.priority, weight: data.weight, type: "SRV" });
const naptr = (data: Data<"NAPTR">) => ({ flags: data.flags, service: data.service, regexp: data.regexp, replacement: data.replacement, order: data.order, preference: data.preference });
const soa = (data: Data<"SOA">) => ({ nsname: data.nsname, hostmaster: data.hostmaster, serial: data.serial, refresh: data.refresh, retry: data.retry, expire: data.expire, minttl: data.minttl });
const caa = (data: Data<"CAA">) => ({ critical: data.critical, type: "CAA", [data.tag]: data.value });
/**
 * TLSA records land at their position in the answer section, counted from `base`: Node 24 leaves a hole for every
 * record of another type before them, and gives them no `type` even in an ANY result.
 */
function tlsa(message: DnsMessage, into: unknown[], base: number): void {
  for (const { data, index } of of(message.answers, "TLSA")) into[base + index] = { certUsage: data.certUsage, selector: data.selector, match: data.match, data: Uint8Array.from(data.data).buffer };
}

/** `resolveAny`: each parser of Node's AnyTraits in turn, appending to one list. */
function any(message: DnsMessage): unknown[] {
  const result: unknown[] = [], answers = message.answers, cname = of(answers, "CNAME")[0];
  // An answer with a CNAME reports that alone here, not the A records beside it.
  if (cname !== undefined) result.push({ value: cname.data.value, type: "CNAME" });
  else for (const { record, data } of of(answers, "A").slice(0, MAX_ADDRESSES)) result.push({ address: data.address, ttl: record.ttl, type: "A" });
  if (of(answers, "AAAA").length > 0) for (const entry of addresses(message, "AAAA")) result.push({ ...entry, type: "AAAA" });
  for (const { data } of of(answers, "MX")) result.push(mx(data));
  for (const { data } of of(answers, "NS")) result.push({ value: data.value, type: "NS" });
  for (const { data } of of(answers, "TXT")) result.push({ entries: [...data.entries], type: "TXT" });
  for (const { data } of of(answers, "SRV")) result.push(srv(data));
  for (const { data } of of(answers, "PTR")) result.push({ value: data.value, type: "PTR" });
  for (const { data } of of(answers, "NAPTR")) result.push({ ...naptr(data), type: "NAPTR" });
  const authority = of(answers, "SOA")[0];
  if (authority !== undefined) result.push({ ...soa(authority.data), type: "SOA" });
  tlsa(message, result, result.length);
  for (const { data } of of(answers, "CAA")) result.push(caa(data));
  return result;
}

/** The value a `resolve*` call reports for a reply that `replyStatus` let through; throws a `DnsFailure` otherwise. */
export function shapeAnswer(kind: QueryKind, message: DnsMessage, ttl: boolean): unknown {
  switch (kind) {
    case "queryA": case "queryAaaa": {
      const found = addresses(message, kind === "queryA" ? "A" : "AAAA");
      return ttl ? found : found.map(entry => entry.address);
    }
    case "queryAny": return any(message);
    case "queryCname": return [canonical(message)];
    case "queryNs": return names(message, "NS");
    case "queryPtr": case "getHostByAddr": return names(message, "PTR");
    case "queryMx": return of(message.answers, "MX").map(entry => mx(entry.data));
    case "queryTxt": return of(message.answers, "TXT").map(entry => [...entry.data.entries]);
    case "querySrv": return of(message.answers, "SRV").map(entry => srv(entry.data));
    case "queryNaptr": return of(message.answers, "NAPTR").map(entry => naptr(entry.data));
    case "queryCaa": return of(message.answers, "CAA").map(entry => caa(entry.data));
    case "queryTlsa": { const result: unknown[] = []; tlsa(message, result, 0); return result; }
    case "querySoa": {
      const first = of(message.answers, "SOA")[0];
      if (first === undefined) throw new DnsFailure("EBADRESP");
      return soa(first.data);
    }
  }
}
