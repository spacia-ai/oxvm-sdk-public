import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { pipedChild, type createNativeChildren } from "./node-children.js";
import type { AsyncContext } from "./async-context.js";
import { decodeAssistanceSocketAddress } from "../../protocol/assistance.js";
import { streamError, type Writable } from "./node-streams.js";
import { ipVersion } from "./node-dns-address.ts";
import { createDnsResolvers } from "./node-dns-api.ts";
import { DNS_ERROR_CODES, dnsException, invalidTypes } from "./node-dns-errors.ts";
import { LOOKUP_HINTS, lookupAddresses, ordered } from "./node-dns-lookup.ts";
import type { DnsChannelRandom, DnsTransport } from "./node-dns-resolver.ts";
import type { AddressSources } from "./node-dns-sort.ts";
import { unreachableDnsTransport } from "./node-dns-transport.ts";
import { invalidType, invalidValue, named, validateBoolean, validateFunction, validateNumber } from "./node-util-validators.ts";

type Address = { address: string; family: 4 | 6 };
type Order = "verbatim" | "ipv4first" | "ipv6first";
type Options = { family: 0 | 4 | 6; hints: number; all: boolean; order: Order };
// The managed guest's original Node performs getaddrinfo and owns NSS/hosts,
// resolver configuration and error mapping. This is not an application child
// launcher and does not fetch or resolve anything in the browser worker.
export const nativeLookupSource = `
const input=JSON.parse(process.argv[1]);
require('node:dns').promises.lookup(input.hostname,{...input.options,all:true}).then(
  addresses=>process.stdout.write(JSON.stringify({kind:'addresses',addresses})),
  error=>process.stdout.write(JSON.stringify({kind:'error',message:error.message,code:error.code,errno:error.errno,syscall:error.syscall,hostname:error.hostname}))
);
`;
const MAX_OUTPUT = 65536;

/** What `node:dns` takes from the process beyond the guest's own Node. */
export interface NodeDnsOptions {
  /** The resolver's sockets and configuration files in the VM. Without it `resolve*` and `reverse` reach no server. */
  readonly transport?: DnsTransport;
  /** Holds the process's event loop while a query, or its callback, is pending. */
  readonly retain?: () => () => void;
  /** Answers `dns.lookup` in the process (hosts file, then the VM's nameservers) instead of spawning the guest's Node. */
  readonly fastLookup?: boolean;
  readonly random?: DnsChannelRandom;
  /** The local address a socket connected to a destination reports, for `getaddrinfo`'s ordering; a VM's by default. */
  readonly addressSources?: AddressSources;
}
const ORDERS: readonly unknown[] = ["verbatim", "ipv4first", "ipv6first"];
const ORDER_RULE = "must be one of: 'verbatim', 'ipv4first', 'ipv6first'";
/** The request object `dns.lookup` returns while `getaddrinfo` runs. */
class GetAddrInfoReqWrap {
  constructor(readonly callback: unknown, readonly family: number, readonly hostname: string, readonly oncomplete: () => void) {}
}
named(GetAddrInfoReqWrap, "GetAddrInfoReqWrap");
function shaped<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return named(target, name);
}

export function createNodeDns(children: Pick<ReturnType<typeof createNativeChildren>, "spawn">, context: AsyncContext, stderr: Writable, dispatch: (callback: () => void) => void = queueMicrotask, options: NodeDnsOptions = {}) {
  let defaultOrder: Order = "verbatim";
  const transport = options.transport ?? unreachableDnsTransport;
  const resolvers = createDnsResolvers({ transport, scheduling: { retain: options.retain ?? (() => () => undefined), dispatch, context }, ...(options.random === undefined ? {} : { random: options.random }) });
  /** Node's reading of `lookup`'s options (lib/dns.js), in its order of checks. */
  function settings(value: unknown): Options {
    let family: 0 | 4 | 6 = 0, hints = 0, all = false, order = defaultOrder;
    const field = (name: string): unknown => value === null || value === undefined ? undefined : Reflect.get(Object(value), name);
    if (typeof value === "number") {
      if (value !== 0 && value !== 4 && value !== 6) throw invalidValue("family", value, "must be one of: 0, 4, 6");
      return { family: value, hints, all, order };
    }
    const rawHints = field("hints"), rawFamily = field("family"), rawAll = field("all"), verbatim = field("verbatim"), rawOrder = field("order");
    if (rawHints !== undefined && rawHints !== null) {
      validateNumber(rawHints, "options.hints"); hints = rawHints >>> 0;
      if ((hints & ~(LOOKUP_HINTS.ADDRCONFIG | LOOKUP_HINTS.ALL | LOOKUP_HINTS.V4MAPPED)) !== 0) throw invalidValue("hints", hints);
    }
    if (rawFamily !== undefined && rawFamily !== null) {
      if (rawFamily === "IPv4") family = 4;
      else if (rawFamily === "IPv6") family = 6;
      else if (rawFamily === 0 || rawFamily === 4 || rawFamily === 6) family = rawFamily;
      else throw invalidValue("options.family", rawFamily, "must be one of: 0, 4, 6");
    }
    if (rawAll !== undefined && rawAll !== null) { validateBoolean(rawAll, "options.all"); all = rawAll; }
    if (verbatim !== undefined && verbatim !== null) { validateBoolean(verbatim, "options.verbatim"); order = verbatim ? "verbatim" : "ipv4first"; }
    if (rawOrder !== undefined && rawOrder !== null) {
      if (rawOrder !== "verbatim" && rawOrder !== "ipv4first" && rawOrder !== "ipv6first") throw invalidValue("options.order", rawOrder, ORDER_RULE);
      order = rawOrder;
    }
    return { family, hints, all, order };
  }
  /** A name `getaddrinfo` is asked for: without null bytes, and within the bound of the guest helper's argument. */
  function hostname(value: string): string {
    if (value.includes("\0")) throw invalidValue("hostname", value, "must be a string without null bytes");
    if (Buffer.byteLength(value) > 4096) throw new VMError("QUOTA_EXCEEDED", "DNS hostname exceeds its bound");
    return value;
  }
  async function perform(name: string, settings: Options): Promise<Address[]> {
    const child = pipedChild(children.spawn("/usr/bin/node", ["-e", nativeLookupSource, JSON.stringify({ hostname: name, options: settings })]));
    const output: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
    return new Promise((resolve, reject) => {
      child.stdout.on("data", value => {
        if (failure !== undefined) return;
        if (!(value instanceof Uint8Array)) { failure = new VMError("PROTOCOL_ERROR", "Invalid guest resolver output"); child.kill("SIGKILL"); return; }
        bytes += value.length;
        if (bytes > MAX_OUTPUT) { failure = new VMError("QUOTA_EXCEEDED", "Guest DNS response exceeds its bound"); child.kill("SIGKILL"); return; }
        output.push(Buffer.from(value));
      });
      child.stderr.pipe(stderr, { end: false });
      child.stdin.on("error", error => { failure = streamError(error); });
      child.on("error", error => { failure = streamError(error); });
      child.on("close", (code, signal) => {
        if (failure !== undefined) { reject(failure); return; }
        if (code !== 0 || signal !== null) { reject(new VMError("GUEST_CRASH", "Guest DNS resolver exited before completion")); return; }
        try { resolve(decodeNativeLookupResult(JSON.parse(Buffer.concat(output).toString()), name)); }
        catch (error) { reject(streamError(error)); }
      });
      child.stdin.end();
    });
  }
  /** What Node answers before it asks `getaddrinfo`: nothing for no name, the literal for an address. */
  function immediate(name: unknown): Address[] | undefined {
    if (typeof name !== "string" || name === "") return [];
    const family = ipVersion(name);
    return family === 0 ? undefined : [{ address: name, family }];
  }
  /** `getaddrinfo`: in the process when it may and can, else by the guest's own Node. */
  async function addresses(name: string, wanted: Options): Promise<Address[]> {
    if (options.fastLookup === true && options.transport !== undefined) {
      const answer = await lookupAddresses(options.transport, { hostname: name, family: wanted.family, hints: wanted.hints }, options.random, options.addressSources);
      if (answer.kind === "addresses") return ordered(answer.addresses, wanted.order);
      if (answer.kind === "error") throw dnsException(answer.errno, "getaddrinfo", name);
    }
    return perform(name, wanted);
  }
  const lookup = shaped((...args: unknown[]): object => {
    const [name, second, third] = args;
    if (Boolean(name) && typeof name !== "string") throw invalidType("hostname", "string", name);
    let callback = third, wanted: Options;
    if (typeof second === "function") { callback = second; wanted = settings(undefined); }
    else if (second !== undefined && typeof second !== "object" && typeof second !== "number") {
      validateFunction(args.length === 2 ? second : third, "callback");
      throw invalidTypes("options", "of type object or integer", second);
    } else { validateFunction(third, "callback"); wanted = settings(second); }
    validateFunction(callback, "callback");
    const done = callback, known = immediate(name), host = typeof name === "string" ? name : "";
    const work = known !== undefined ? Promise.resolve(known) : addresses(hostname(host), wanted);
    resolvers.deliver(work, (error, found) => {
      if (found === undefined) Reflect.apply(done, undefined, [streamError(error)]);
      else if (wanted.all) Reflect.apply(done, undefined, [null, found]);
      else Reflect.apply(done, undefined, [null, found[0]?.address ?? null, found[0]?.family ?? (wanted.family === 6 ? 6 : 4)]);
    });
    return known !== undefined ? {} : new GetAddrInfoReqWrap(done, wanted.family, host, () => undefined);
  }, "lookup", 3);
  const lookupPromise = shaped((name?: unknown, value?: unknown): Promise<{ address: string | null; family: 4 | 6 } | Address[]> => {
    if (Boolean(name) && typeof name !== "string") throw invalidType("hostname", "string", name);
    if (value !== undefined && typeof value !== "object" && typeof value !== "number") throw invalidTypes("options", "of type object or integer", value);
    const wanted = settings(value), known = immediate(name), host = typeof name === "string" ? name : "";
    return resolvers.tracked(async () => {
      const found = known ?? await addresses(hostname(host), wanted);
      if (wanted.all) return found;
      return found[0] ?? { address: null, family: wanted.family === 6 ? 6 : 4 };
    });
  }, "lookup", 2);
  const getDefaultResultOrder = shaped((): Order => defaultOrder, "getDefaultResultOrder", 0);
  const setDefaultResultOrder = shaped((value?: unknown): void => {
    if (!ORDERS.includes(value) || (value !== "verbatim" && value !== "ipv4first" && value !== "ipv6first")) throw invalidValue("dnsOrder", value, ORDER_RULE);
    defaultOrder = value;
  }, "setDefaultResultOrder", 1);
  /** `dns.setServers`: a new default resolver, and the module functions bound to it anew. */
  const setServers = shaped((servers?: unknown): void => {
    resolvers.setDefaultServers(servers);
    Object.assign(module, resolvers.bound("callback"));
    Object.assign(promises, resolvers.bound("promises"));
  }, "defaultResolverSetServers", 1);
  const promises = {
    lookup: lookupPromise, lookupService: resolvers.lookupServicePromise, Resolver: resolvers.PromisesResolver, getDefaultResultOrder, setDefaultResultOrder, setServers,
    ...DNS_ERROR_CODES, ...resolvers.bound("promises"),
  };
  const module = {
    lookup, lookupService: resolvers.lookupService, Resolver: resolvers.Resolver, getDefaultResultOrder, setDefaultResultOrder, setServers,
    ADDRCONFIG: LOOKUP_HINTS.ADDRCONFIG, ALL: LOOKUP_HINTS.ALL, V4MAPPED: LOOKUP_HINTS.V4MAPPED,
    ...DNS_ERROR_CODES, ...resolvers.bound("callback"),
    get promises() { return promises; },
  };
  return module;
}
export class NativeDNSLookupError extends Error {
  readonly syscall = "getaddrinfo";
  constructor(message: string, readonly code: string, readonly errno: number, readonly hostname: string) { super(message); }
}

export function decodeNativeLookupResult(value: unknown, hostname: string): Address[] {
  const result = record(value, "guest DNS result");
  if (result["kind"] === "addresses") {
    exactKeys(result, ["kind", "addresses"]);
    const values = result["addresses"];
    if (!Array.isArray(values) || values.length > 256) throw new VMError("PROTOCOL_ERROR", "Invalid DNS result count");
    return values.map((value: unknown) => {
      const address = record(value, "DNS address"); exactKeys(address, ["address", "family"]);
      const family = address["family"];
      if (family !== 4 && family !== 6) throw new VMError("PROTOCOL_ERROR", "Invalid DNS address family");
      const text = string(address["address"], "DNS address");
      decodeAssistanceSocketAddress({ address: text, port: 1 });
      if ((text.includes(":") ? 6 : 4) !== family) throw new VMError("PROTOCOL_ERROR", "Wrong DNS address family");
      return { address: text, family };
    });
  }
  if (result["kind"] === "error") {
    exactKeys(result, ["kind", "message", "code", "errno", "syscall", "hostname"]);
    if (result["hostname"] !== hostname || result["syscall"] !== "getaddrinfo") throw new VMError("PROTOCOL_ERROR", "Wrong DNS error identity");
    const code = string(result["code"], "DNS error code"); const message = string(result["message"], "DNS error message");
    if (code.length > 64 || message.length > 8192) throw new VMError("PROTOCOL_ERROR", "Invalid DNS error size");
    throw new NativeDNSLookupError(message, code, integer(result["errno"], "DNS errno", -0x8000_0000, -1), hostname);
  }
  throw new VMError("PROTOCOL_ERROR", "Unknown DNS result");
}
