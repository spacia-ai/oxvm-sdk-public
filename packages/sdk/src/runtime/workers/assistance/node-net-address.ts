/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/socketaddress.js, lib/internal/blocklist.js and
 * src/node_sockaddr.cc (SocketAddress, BlockList and their matching rules), and from libuv's inet_pton/inet_ntop.
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { inspectValue, invalidType, invalidValue, named, outOfRange, validateInteger, validateObject, validateString } from "./node-util-validators.ts";

type Family = "ipv4" | "ipv6";
/** An address as the kernel holds it: 4 or 16 bytes in network order. */
interface Address { readonly family: Family; readonly bytes: readonly number[]; readonly text: string }

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    // inet_pton: decimal only, no sign, no leading zero.
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255) return undefined;
    bytes.push(Number(part));
  }
  return bytes;
}
function groups(text: string): number[] | undefined {
  if (text === "") return [];
  const words: number[] = [], parts = text.split(":");
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1 && part.includes(".")) {
      const tail = parseIPv4(part);
      if (tail === undefined) return undefined;
      const [a = 0, b = 0, c = 0, d = 0] = tail;
      words.push(a << 8 | b, c << 8 | d);
    } else if (/^[0-9a-f]{1,4}$/iu.test(part)) words.push(Number.parseInt(part, 16));
    else return undefined;
  }
  return words;
}
function parseIPv6(input: string): number[] | undefined {
  // uv_ip6_addr reads a zone after `%` as an interface; the address itself is what precedes it.
  const zone = input.indexOf("%"), text = zone === -1 ? input : input.slice(0, zone);
  const gap = text.indexOf("::");
  let words: number[];
  if (gap === -1) {
    const all = groups(text);
    if (all?.length !== 8) return undefined;
    words = all;
  } else {
    if (text.includes("::", gap + 1)) return undefined;
    const head = groups(text.slice(0, gap)), tail = groups(text.slice(gap + 2));
    if (head === undefined || tail === undefined || head.length + tail.length > 7) return undefined;
    words = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  return words.flatMap(word => [word >> 8, word & 0xff]);
}
function formatIPv6(bytes: readonly number[]): string {
  const words = Array.from({ length: 8 }, (_, index) => (bytes[index * 2] ?? 0) << 8 | (bytes[index * 2 + 1] ?? 0));
  let best = { base: -1, length: 0 }, current = { base: -1, length: 0 };
  for (const [index, word] of words.entries()) {
    if (word !== 0) { current = { base: -1, length: 0 }; continue; }
    current = current.base === -1 ? { base: index, length: 1 } : { base: current.base, length: current.length + 1 };
    if (current.length > best.length) best = current;
  }
  if (best.length < 2) best = { base: -1, length: 0 };
  let text = "";
  for (let index = 0; index < 8; index++) {
    if (best.base !== -1 && index >= best.base && index < best.base + best.length) { if (index === best.base) text += ":"; continue; }
    if (index !== 0) text += ":";
    // An IPv4-compatible or IPv4-mapped address ends in dotted form.
    if (index === 6 && best.base === 0 && (best.length === 6 || (best.length === 5 && words[5] === 0xffff))) { text += bytes.slice(12).join("."); break; }
    text += (words[index] ?? 0).toString(16);
  }
  if (best.base !== -1 && best.base + best.length === 8) text += ":";
  return text;
}
function invalidAddress(): Error { return Object.assign(new Error("Invalid socket address"), { code: "ERR_INVALID_ADDRESS" }); }
function parseAddress(text: string, family: Family): Address {
  const bytes = family === "ipv4" ? parseIPv4(text) : parseIPv6(text);
  if (bytes === undefined) throw invalidAddress();
  return { family, bytes, text: family === "ipv4" ? bytes.join(".") : formatIPv6(bytes) };
}
function isMapped(address: Address): boolean {
  return address.family === "ipv6" && address.bytes.slice(0, 10).every(byte => byte === 0) && address.bytes[10] === 0xff && address.bytes[11] === 0xff;
}
function lexical(left: readonly number[], right: readonly number[]): number {
  for (const [index, byte] of left.entries()) { const other = right[index] ?? 0; if (byte !== other) return byte < other ? -1 : 1; }
  return 0;
}
/** Node's `SocketAddress::compare`: two families compare only when the IPv6 one is an IPv4-mapped address. */
function compare(left: Address, right: Address): number | undefined {
  if (left.family === right.family) return lexical(left.bytes, right.bytes);
  const [four, six, sign] = left.family === "ipv4" ? [left, right, 1] : [right, left, -1];
  return isMapped(six) ? sign * lexical(four.bytes, six.bytes.slice(12)) : undefined;
}
function prefixed(address: readonly number[], network: readonly number[], prefix: number): boolean {
  const whole = prefix >> 3, rest = prefix & 7;
  if (lexical(address.slice(0, whole), network.slice(0, whole)) !== 0) return false;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((address[whole] ?? 0) & mask) === ((network[whole] ?? 0) & mask);
}
/** Node's `SocketAddress::is_in_network`. */
function inNetwork(address: Address, network: Address, prefix: number): boolean {
  if (address.family === network.family) return prefixed(address.bytes, network.bytes, prefix);
  if (network.family === "ipv4") return isMapped(address) && prefixed(address.bytes.slice(12), network.bytes, prefix);
  return prefixed([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...address.bytes], network.bytes, prefix);
}

/** 4, 6 or 0, for an address written the way the kernel's parsers take it. */
export function ipVersion(text: string): 0 | 4 | 6 { return parseIPv4(text) !== undefined ? 4 : parseIPv6(text) !== undefined ? 6 : 0; }
/** The one spelling of an address, or `undefined` for text that is not one (c-ares' `canonicalizeIP`). */
export function canonicalIp(text: string): string | undefined {
  const four = parseIPv4(text);
  if (four !== undefined) return four.join(".");
  const six = parseIPv6(text);
  return six === undefined ? undefined : formatIPv6(six);
}

const kHandle = Symbol("kHandle"), kDetail = Symbol("kDetail"), kInspect = Symbol.for("nodejs.util.inspect.custom");
interface Detail { readonly address: Address; readonly port: number; readonly flowlabel: number }
const details = new WeakMap<object, Detail>();
function inspectWith(prefix: string, value: unknown, depth: unknown, options: unknown): string {
  const settings = typeof options === "object" && options !== null ? { ...options } : {}, limit: unknown = Reflect.get(settings, "depth");
  Reflect.set(settings, "depth", limit === null || limit === undefined ? null : typeof limit === "number" ? limit - 1 : limit);
  void depth;
  return `${prefix} ${inspection(value, settings)}`;
}
function inspection(value: unknown, options: object): string {
  const text: unknown = Reflect.apply(inspectValue, undefined, [value, options]);
  return typeof text === "string" ? text : "";
}
function badPort(port: unknown): RangeError {
  const shown = typeof port === "symbol" ? port.toString() : invalidType("p", "t", port).message.slice("The \"p\" argument must be of type t. Received ".length);
  return Object.assign(new RangeError(`options.port should be >= 0 and < 65536. Received ${shown}.`), { code: "ERR_SOCKET_BAD_PORT" });
}
function option(options: object, name: string, fallback: unknown): unknown {
  const value: unknown = Reflect.get(options, name);
  return value === undefined ? fallback : value;
}

/** Node's `net.SocketAddress`. */
export class SocketAddress {
  declare readonly [kHandle]: object;
  declare readonly [kDetail]: object;
  static isSocketAddress(value: unknown): boolean { return detailOf(value) !== undefined; }
  /** `ip:port` through the URL parser, as Node does it; `undefined` when that is not a socket address. */
  static parse(input: unknown): SocketAddress | undefined {
    validateString(input, "input");
    try {
      const url = new URL(`http://${input}`), address = url.hostname, port = Number(url.port) | 0;
      if (address.startsWith("[") && address.endsWith("]")) return new SocketAddress({ address: address.slice(1, -1), port, family: "ipv6" });
      return new SocketAddress({ address, port });
    } catch { return undefined; }
  }
  constructor(options: unknown = {}) {
    validateObject(options, "options");
    const given = option(options, "family", "ipv4");
    const address = option(options, "address", given === "ipv4" ? "127.0.0.1" : "::"), port = option(options, "port", 0), flowlabel = option(options, "flowlabel", 0);
    const lower: unknown = typeof given === "string" ? given.toLowerCase() : given;
    if (lower !== "ipv4" && lower !== "ipv6") throw invalidValue("options.family", Reflect.get(options, "family"));
    validateString(address, "options.address");
    if ((typeof port !== "number" && typeof port !== "string") || (typeof port === "string" && port.trim().length === 0) || Number(port) !== Number(port) >>> 0 || Number(port) > 0xffff) throw badPort(port);
    if (typeof flowlabel !== "number") throw invalidType("options.flowlabel", "number", flowlabel);
    if (!Number.isInteger(flowlabel)) throw outOfRange("options.flowlabel", "an integer", flowlabel);
    if (flowlabel < 0 || flowlabel > 0xffff_ffff) throw outOfRange("options.flowlabel", ">= 0 && <= 4294967295", flowlabel);
    const parsed = parseAddress(address, lower);
    // Node aborts the process for an IPv6 flow label above 20 bits; this refuses the value instead.
    if (lower === "ipv6" && flowlabel > 0xf_ffff) throw outOfRange("options.flowlabel", ">= 0 && <= 1048575", flowlabel);
    const detail: Detail = { address: parsed, port: Number(port) | 0, flowlabel: lower === "ipv6" ? flowlabel : 0 };
    Object.defineProperty(this, kHandle, { value: detail, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(this, kDetail, { value: { address: parsed.text, port: detail.port, family: lower }, enumerable: true, writable: true, configurable: true });
    details.set(this, detail);
  }
  get address(): string { return detailFor(this).address.text; }
  get port(): number { return detailFor(this).port; }
  get family(): Family { return detailFor(this).address.family; }
  get flowlabel(): number { return detailFor(this).flowlabel; }
  [kInspect](depth: unknown, options: unknown): unknown {
    return typeof depth === "number" && depth < 0 ? this : inspectWith("SocketAddress", this.toJSON(), depth, options);
  }
  toJSON(): { address: string; port: number; family: Family; flowlabel: number } {
    return { address: this.address, port: this.port, family: this.family, flowlabel: this.flowlabel };
  }
}
named(SocketAddress, "SocketAddress");
function detailOf(value: unknown): Detail | undefined { return (typeof value === "object" && value !== null) ? details.get(value) : undefined; }
function detailFor(value: object): Detail {
  const detail = details.get(value);
  if (detail === undefined) throw new TypeError("Illegal invocation");
  return detail;
}

type Rule = { readonly kind: "address"; readonly address: Address }
  | { readonly kind: "range"; readonly start: Address; readonly end: Address }
  | { readonly kind: "subnet"; readonly network: Address; readonly prefix: number };
const lists = new WeakMap<object, Rule[]>();
const label = (address: Address): string => address.family === "ipv4" ? "IPv4" : "IPv6";
function rulesFor(list: object): Rule[] {
  const rules = lists.get(list);
  if (rules === undefined) throw new TypeError("Illegal invocation");
  return rules;
}
/** A string with its family, or a SocketAddress, as the address it names. */
function addressOf(value: unknown, name: string, family: unknown): { readonly address: Address; readonly shown: unknown } {
  const known = detailOf(value);
  if (known !== undefined) return { address: known.address, shown: value };
  validateString(value, name);
  validateString(family, "family");
  const created = new SocketAddress({ address: value, family });
  return { address: detailFor(created).address, shown: created };
}

/** Node's `net.BlockList`: rules are kept newest first, and the first that matches blocks. */
export class BlockList {
  declare readonly [kHandle]: object;
  static isBlockList(value: unknown): boolean { return typeof value === "object" && value !== null && lists.has(value); }
  constructor() {
    const rules: Rule[] = [];
    Object.defineProperty(this, kHandle, { value: rules, enumerable: true, writable: true, configurable: true });
    lists.set(this, rules);
  }
  [kInspect](depth: unknown, options: unknown): unknown {
    return typeof depth === "number" && depth < 0 ? this : inspectWith("BlockList", { rules: this.rules }, depth, options);
  }
  addAddress(address: unknown, family: unknown = "ipv4"): void {
    rulesFor(this).unshift({ kind: "address", address: addressOf(address, "address", family).address });
  }
  addRange(start: unknown, end: unknown, family: unknown = "ipv4"): void {
    const rules = rulesFor(this), first = addressOf(start, "start", family), last = addressOf(end, "end", family);
    if ((compare(first.address, last.address) ?? 0) > 0) throw invalidValue("start", first.shown, "must come before end");
    rules.unshift({ kind: "range", start: first.address, end: last.address });
  }
  addSubnet(network: unknown, prefix: unknown, family: unknown = "ipv4"): void {
    const rules = rulesFor(this), net = addressOf(network, "network", family).address;
    validateInteger(prefix, "prefix", 0, net.family === "ipv4" ? 32 : 128);
    rules.unshift({ kind: "subnet", network: net, prefix });
  }
  check(address: unknown, family: unknown = "ipv4"): boolean {
    const rules = rulesFor(this);
    let target = detailOf(address)?.address;
    if (target === undefined) {
      validateString(address, "address");
      validateString(family, "family");
      try { target = addressOf(address, "address", family).address; }
      catch { return false; }
    }
    const candidate = target;
    return rules.some(rule => {
      if (rule.kind === "address") return compare(candidate, rule.address) === 0;
      if (rule.kind === "subnet") return inNetwork(candidate, rule.network, rule.prefix);
      const low = compare(candidate, rule.start), high = compare(candidate, rule.end);
      return low !== undefined && high !== undefined && low >= 0 && high <= 0;
    });
  }
  toJSON(): string[] { return this.rules; }
  fromJSON(data: unknown): void {
    const invalid = (value: unknown): TypeError => invalidType("data", "string or string[]", value);
    let items: unknown = data;
    if (!Array.isArray(data)) {
      if (typeof data !== "string") throw invalid(data);
      items = JSON.parse(data);
    }
    if (!Array.isArray(items)) throw invalid(items);
    const texts: string[] = [];
    for (const item of items) { if (typeof item !== "string") throw invalid(items); texts.push(item); }
    for (const item of texts) this.#parse(item);
  }
  #parse(item: string): void {
    for (const [family, name, pattern] of [["ipv4", "IPv4", String.raw`\d{1,3}(?:\.\d{1,3}){3}`], ["ipv6", "IPv6", "[0-9a-fA-F:]{1,39}"]] as const) {
      if (!item.includes(name)) continue;
      const subnet = new RegExp(`Subnet: ${name} (${pattern})/(${family === "ipv4" ? String.raw`\d{1,2}` : "[0-9]{1,3}"})`, family === "ipv6" ? "i" : "").exec(item);
      if (subnet !== null) { this.addSubnet(subnet[1], Number.parseInt(subnet[2] ?? "", 10), family); return; }
      const address = new RegExp(`Address: ${name} (${pattern})`, family === "ipv6" ? "i" : "").exec(item);
      if (address !== null) { this.addAddress(address[1], family); return; }
      const range = new RegExp(`Range: ${name} (${pattern})-(${pattern})`, family === "ipv6" ? "i" : "").exec(item);
      if (range !== null) { this.addRange(range[1], range[2], family); return; }
    }
  }
  get rules(): string[] {
    return rulesFor(this).map(rule => rule.kind === "address" ? `Address: ${label(rule.address)} ${rule.address.text}`
      : rule.kind === "range" ? `Range: ${label(rule.start)} ${rule.start.text}-${rule.end.text}`
        : `Subnet: ${label(rule.network)} ${rule.network.text}/${String(rule.prefix)}`);
  }
}
named(BlockList, "BlockList");

/** ERR_INVALID_ARG_TYPE for a `blockList` option that is not a BlockList, in Node's wording. */
export function invalidBlockList(value: unknown): TypeError {
  const error = invalidType("options.blockList", "T", value);
  error.message = error.message.replace("must be of type T.", "must be an net.BlockList.");
  return error;
}
export function blockedAddress(address: string): Error {
  return Object.assign(new Error(`IP(${address}) is blocked by net.BlockList`), { code: "ERR_IP_BLOCKED" });
}
