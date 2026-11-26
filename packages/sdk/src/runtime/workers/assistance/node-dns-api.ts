/*!
 * Portions adapted from Node.js v24.18.1 lib/dns.js, lib/internal/dns/utils.js, lib/internal/dns/callback_resolver.js
 * and lib/internal/dns/promises.js (the Resolver classes, their argument handling and the default-resolver binding).
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
import { formatAddress, ipVersion, parseAddress, parseIPv4, parseIPv6, reverseName } from "./node-dns-address.ts";
import { formatServers, HOSTS, hostsNames, libcChannelOptions, parseHosts, parseResolvConf, parseServerList, RESOLV_CONF, serviceName, SERVICES } from "./node-dns-config.ts";
import { badPort, DnsFailure, dnsException, invalidArgValue, missingArgs, UV_ERRNO } from "./node-dns-errors.ts";
import { QUERY_KINDS, replyStatus, shapeAnswer, type QueryKind } from "./node-dns-records.ts";
import { DnsChannel, type DnsChannelRandom, type DnsTransport } from "./node-dns-resolver.ts";
import { RR_TYPE } from "./node-dns-wire.ts";
import { invalidType, invalidValue, named, validateFunction, validateInteger, validateString } from "./node-util-validators.ts";

/** How an asynchronous call joins the process: a hold on its event loop, its callback queue and its async context. */
export interface DnsScheduling {
  readonly retain: () => () => void;
  readonly dispatch: (callback: () => void) => void;
  readonly context: { capture(): <Result>(callback: () => Result) => Result };
}
export interface DnsPorts { readonly transport: DnsTransport; readonly scheduling: DnsScheduling; readonly random?: DnsChannelRandom }

type Method = (this: unknown, ...args: unknown[]) => unknown;
/** Pins the `name` and `length` a program can read; minification and rest parameters would change both. */
function shaped<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return named(target, name);
}

/** The methods a Resolver has beyond its base class, in the order Node defines them on the prototype. */
const RESOLVE_METHODS = [
  ["resolveAny", "queryAny"], ["resolve4", "queryA"], ["resolve6", "queryAaaa"], ["resolveCaa", "queryCaa"], ["resolveCname", "queryCname"],
  ["resolveMx", "queryMx"], ["resolveNs", "queryNs"], ["resolveTlsa", "queryTlsa"], ["resolveTxt", "queryTxt"], ["resolveSrv", "querySrv"],
  ["resolvePtr", "queryPtr"], ["resolveNaptr", "queryNaptr"], ["resolveSoa", "querySoa"], ["reverse", "getHostByAddr"],
] as const;
/** `resolve(name, rrtype)`'s record types. */
const RRTYPES: ReadonlyMap<string, QueryKind> = new Map([
  ["ANY", "queryAny"], ["A", "queryA"], ["AAAA", "queryAaaa"], ["CAA", "queryCaa"], ["CNAME", "queryCname"], ["MX", "queryMx"], ["NS", "queryNs"],
  ["TXT", "queryTxt"], ["SRV", "querySrv"], ["PTR", "queryPtr"], ["NAPTR", "queryNaptr"], ["SOA", "querySoa"], ["TLSA", "queryTlsa"],
]);
/** The functions `dns` and `dns/promises` bind to the default resolver, in Node's order. */
export type BoundKey = "getServers" | "resolve" | "resolve4" | "resolve6" | "resolveAny" | "resolveCaa" | "resolveCname" | "resolveMx" | "resolveNaptr" | "resolveNs" | "resolvePtr" | "resolveSoa" | "resolveSrv" | "resolveTlsa" | "resolveTxt" | "reverse";
export type BoundResolver = Record<BoundKey, (...args: unknown[]) => unknown>;

/** The request object a callback-style call returns, as Node's `QueryReqWrap` shows it. */
class QueryReqWrap {
  constructor(readonly bindingName: string, readonly callback: unknown, readonly hostname: string, readonly oncomplete: () => void, readonly ttl: boolean) {}
}
named(QueryReqWrap, "QueryReqWrap");
class GetNameInfoReqWrap {
  constructor(readonly callback: unknown, readonly hostname: string, readonly port: number, readonly oncomplete: () => void) {}
}
named(GetNameInfoReqWrap, "GetNameInfoReqWrap");

const INT32_MAX = 2 ** 31 - 1, UINT32_MAX = 2 ** 32 - 1;
function option(options: unknown, key: string, fallback: number, minimum: number, maximum: number): number {
  const value: unknown = options === null || options === undefined ? undefined : Reflect.get(Object(options), key);
  if (value === undefined) return fallback;
  validateInteger(value, `options.${key}`, minimum, maximum);
  return value;
}
const wantsTtl = (options: unknown): boolean => options !== null && options !== undefined && Boolean(Reflect.get(Object(options), "ttl"));

export interface ResolverConstructor { new (options?: unknown): object; readonly prototype: object }
export interface DnsResolvers {
  readonly Resolver: ResolverConstructor;
  readonly PromisesResolver: ResolverConstructor;
  /** The module-level functions of `dns`, bound to the current default resolver. */
  bound(flavour: "callback" | "promises"): BoundResolver;
  /** `dns.setServers`: a new default resolver with these servers; callers re-read `bound`. */
  setDefaultServers(servers: unknown): void;
  lookupService: (...args: unknown[]) => object;
  lookupServicePromise: (...args: unknown[]) => Promise<{ hostname: string; service: string }>;
  /** Runs `work` while holding the process, then hands its outcome to `done` through the process's callback queue. */
  deliver<Value>(work: Promise<Value>, done: (error: unknown, value?: Value) => void): void;
  /** Holds the process until `work` settles. */
  tracked<Value>(work: () => Promise<Value>): Promise<Value>;
}

export function createDnsResolvers(ports: DnsPorts): DnsResolvers {
  const { transport, scheduling } = ports, channels = new WeakMap<object, DnsChannel>();
  const channelOf = (resolver: unknown): DnsChannel => {
    const channel = typeof resolver === "object" && resolver !== null ? channels.get(resolver) : undefined;
    if (channel === undefined) throw new TypeError("Cannot read properties of undefined (reading '_handle')");
    return channel;
  };
  /**
   * One hold on the process for all of this module's pending calls. A process has a bounded number of holds (256), and
   * a program may start more lookups than that at once: measured in the VM, 500 parallel lookups failed with
   * QUOTA_EXCEEDED from the 257th on when each call took its own.
   */
  let pending = 0, releaseProcess: (() => void) | undefined;
  const hold = (): (() => void) => {
    if (pending === 0) releaseProcess = scheduling.retain();
    pending += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false; pending -= 1;
      if (pending === 0) { const release = releaseProcess; releaseProcess = undefined; release?.(); }
    };
  };
  const tracked = async <Value>(work: () => Promise<Value>): Promise<Value> => {
    const release = hold();
    try { return await work(); } finally { release(); }
  };
  const deliver = <Value>(work: Promise<Value>, done: (error: unknown, value?: Value) => void): void => {
    const run = scheduling.context.capture(), release = hold();
    const finish = (call: () => void): void => { scheduling.dispatch(() => { try { run(call); } finally { release(); } }); };
    work.then(value => { finish(() => { done(null, value); }); }, (error: unknown) => { finish(() => { done(error); }); });
  };

  class ResolverBase {
    readonly _handle: object;
    /** Node's constructor declares a defaulted parameter, so its `length` is 0. */
    constructor(...args: unknown[]) {
      const options = args[0];
      const timeout = option(options, "timeout", -1, -1, INT32_MAX), tries = option(options, "tries", 4, 1, INT32_MAX), maxTimeout = option(options, "maxTimeout", 0, 0, UINT32_MAX);
      this._handle = {};
      channels.set(this, new DnsChannel(transport, { timeout, tries, maxTimeout }, ports.random));
    }
  }
  const cancel = shaped(function (this: unknown): void { channelOf(this).cancel(); }, "cancel", 0);
  const getServers = shaped(function (this: unknown): string[] { return formatServers(channelOf(this).servers); }, "getServers", 0);
  const setServers = shaped(function (this: unknown, servers?: unknown): void { const channel = channelOf(this); channel.servers = parseServerList(servers); }, "setServers", 1);
  const setLocalAddress = shaped(function (this: unknown, ipv4?: unknown, ipv6?: unknown): void {
    validateString(ipv4, "ipv4");
    if (ipv6 !== undefined) validateString(ipv6, "ipv6");
    const first = parseIPv4(ipv4) !== undefined ? 4 : parseIPv6(ipv4) !== undefined ? 6 : 0;
    if (first === 0) throw invalidArgValue("Invalid IP address.");
    const second = ipv6 === undefined ? undefined : parseIPv4(ipv6) !== undefined ? 4 : parseIPv6(ipv6) !== undefined ? 6 : 0;
    if (second === 0) throw invalidArgValue("Invalid IP address.");
    if (second === first) throw invalidArgValue(`Cannot specify two IPv${String(first)} addresses.`);
    const four = first === 4 ? ipv4 : second === 4 ? ipv6 : undefined, six = first === 6 ? ipv4 : second === 6 ? ipv6 : undefined;
    channelOf(this).localAddress = { ...(four === undefined ? {} : { ipv4: four }), ...(six === undefined ? {} : { ipv6: six }) };
  }, "setLocalAddress", 2);
  // Class methods in Node: writable, configurable, not enumerable.
  for (const [key, value] of [["cancel", cancel], ["getServers", getServers], ["setServers", setServers], ["setLocalAddress", setLocalAddress]] as const) {
    Object.defineProperty(ResolverBase.prototype, key, { value, writable: true, enumerable: false, configurable: true });
  }
  named(ResolverBase, "ResolverBase");
  class Resolver extends ResolverBase {}
  class PromisesResolver extends ResolverBase {}
  named(Resolver, "Resolver"); named(PromisesResolver, "Resolver");

  /** One question through a resolver's channel, as the value its `resolve*` method reports. */
  async function answer(channel: DnsChannel, kind: QueryKind, name: string, ttl: boolean): Promise<unknown> {
    try {
      let asked = name;
      if (kind === "getHostByAddr") {
        const address = parseAddress(name);
        if (address === undefined) throw new DnsFailure("ENOTFOUND");
        // c-ares looks in the hosts file first, and Node reports the aliases there, not the first name.
        const known = hostsNames(parseHosts(transport.readFile(HOSTS) ?? ""), formatAddress(address.family, address.bytes));
        if (known !== undefined) return known.slice(1);
        asked = reverseName(address.family, address.bytes);
      }
      const message = await channel.query(asked, QUERY_KINDS[kind]), status = replyStatus(message);
      if (status !== undefined) throw new DnsFailure(status);
      return shapeAnswer(kind, message, ttl);
    } catch (error) {
      throw error instanceof DnsFailure ? dnsException(error.status, kind, name) : error;
    }
  }
  /** The native layer refuses a reverse lookup of something that is no address before it starts. */
  function admit(kind: QueryKind, name: string): void {
    if (kind === "getHostByAddr" && parseAddress(name) === undefined) throw dnsException(UV_ERRNO.EINVAL, kind, name);
  }

  function callbackQuery(kind: QueryKind): Method {
    return shaped(function (this: unknown, ...args: unknown[]): object {
      const name = args[0];
      let options: unknown, callback = args[1];
      if (args.length > 2) { options = callback; callback = args[2]; }
      validateString(name, "name"); validateFunction(callback, "callback");
      const done = callback, ttl = wantsTtl(options), channel = channelOf(this);
      admit(kind, name);
      const request = new QueryReqWrap(kind, done, name, () => undefined, ttl);
      deliver(answer(channel, kind, name, ttl), (error, value) => { Reflect.apply(done, request, error === null ? [null, value] : [error]); });
      return request;
    }, kind, 2);
  }
  function promiseQuery(kind: QueryKind): Method {
    return shaped(function (this: unknown, name?: unknown, options?: unknown): Promise<unknown> {
      validateString(name, "name");
      const channel = channelOf(this), ttl = wantsTtl(options);
      return tracked(async () => { admit(kind, name); return answer(channel, kind, name, ttl); });
    }, kind, 2);
  }
  const callbackMethods = new Map<string, Method>(), promiseMethods = new Map<string, Method>();
  const callbackKinds = new Map<QueryKind, Method>(), promiseKinds = new Map<QueryKind, Method>();
  const define = (target: object, key: string, value: Method): void => { Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true }); };
  for (const [key, kind] of RESOLVE_METHODS) {
    const viaCallback = callbackQuery(kind), viaPromise = promiseQuery(kind);
    callbackMethods.set(key, viaCallback); promiseMethods.set(key, viaPromise); callbackKinds.set(kind, viaCallback); promiseKinds.set(kind, viaPromise);
    define(Resolver.prototype, key, viaCallback); define(PromisesResolver.prototype, key, viaPromise);
  }
  const resolve = shaped(function (this: unknown, hostname?: unknown, rrtype?: unknown, callback?: unknown): unknown {
    let done = callback, kind: QueryKind | undefined;
    if (typeof rrtype === "string") kind = RRTYPES.get(rrtype);
    else if (typeof rrtype === "function") { kind = "queryA"; done = rrtype; }
    else throw invalidType("rrtype", "string", rrtype);
    const method = kind === undefined ? undefined : callbackKinds.get(kind);
    if (method === undefined) throw invalidValue("rrtype", rrtype);
    return Reflect.apply(method, this, [hostname, done]);
  }, "resolve", 3);
  const resolvePromise = shaped(function (this: unknown, hostname?: unknown, rrtype?: unknown): unknown {
    let kind: QueryKind | undefined = "queryA";
    if (rrtype !== undefined) { validateString(rrtype, "rrtype"); kind = RRTYPES.get(rrtype); }
    const method = kind === undefined ? undefined : promiseKinds.get(kind);
    if (method === undefined) throw invalidValue("rrtype", rrtype);
    return Reflect.apply(method, this, [hostname]);
  }, "resolve", 2);
  callbackMethods.set("resolve", resolve); promiseMethods.set("resolve", resolvePromise);
  define(Resolver.prototype, "resolve", resolve); define(PromisesResolver.prototype, "resolve", resolvePromise);

  let defaultResolver: object = new Resolver();
  const bound = (flavour: "callback" | "promises"): BoundResolver => {
    const methods = flavour === "callback" ? callbackMethods : promiseMethods;
    const bind = (key: BoundKey): (...args: unknown[]) => unknown => {
      const method = key === "getServers" ? getServers : methods.get(key);
      if (method === undefined) throw new TypeError(`Missing resolver method ${key}`);
      return method.bind(defaultResolver);
    };
    return {
      getServers: bind("getServers"), resolve: bind("resolve"), resolve4: bind("resolve4"), resolve6: bind("resolve6"), resolveAny: bind("resolveAny"),
      resolveCaa: bind("resolveCaa"), resolveCname: bind("resolveCname"), resolveMx: bind("resolveMx"), resolveNaptr: bind("resolveNaptr"), resolveNs: bind("resolveNs"),
      resolvePtr: bind("resolvePtr"), resolveSoa: bind("resolveSoa"), resolveSrv: bind("resolveSrv"), resolveTlsa: bind("resolveTlsa"), resolveTxt: bind("resolveTxt"), reverse: bind("reverse"),
    };
  };
  const setDefaultServers = (servers: unknown): void => {
    const next = new Resolver();
    Reflect.apply(setServers, next, [servers]);
    defaultResolver = next;
  };

  /** `getnameinfo` with NI_NAMEREQD: the hosts file's first name for the address, else a PTR answer; and the TCP service. */
  async function nameInfo(address: string, port: number): Promise<{ hostname: string; service: string }> {
    const parsed = parseAddress(address);
    if (parsed === undefined) throw new DnsFailure("ENOTFOUND");
    const canonical = formatAddress(parsed.family, parsed.bytes);
    let hostname = parseHosts(transport.readFile(HOSTS) ?? "").find(line => line.address === canonical)?.names[0];
    if (hostname === undefined) {
      const conf = parseResolvConf(transport.readFile(RESOLV_CONF) ?? "");
      if (conf.nameservers.length === 0) throw new DnsFailure("ENOTFOUND");
      const channel = new DnsChannel(transport, libcChannelOptions(conf), ports.random);
      channel.servers = conf.nameservers.slice(0, 3);
      const message = await channel.query(reverseName(parsed.family, parsed.bytes), RR_TYPE.PTR);
      for (const record of message.rcode === 0 ? message.answers : []) if (record.data.type === "PTR") { hostname = record.data.value; break; }
      if (hostname === undefined) throw new DnsFailure("ENOTFOUND");
    }
    return { hostname, service: serviceName(transport.readFile(SERVICES) ?? "", port) ?? String(port) };
  }
  function servicePort(port: unknown): number {
    if ((typeof port !== "number" && typeof port !== "string") || (typeof port === "string" && port.trim().length === 0) || Number(port) !== (Number(port) >>> 0) || Number(port) > 0xffff) throw badPort(port);
    return Number(port);
  }
  const failed = (error: unknown, hostname?: string): unknown => error instanceof DnsFailure ? dnsException(UV_ERRNO.EAI_NONAME, "getnameinfo", hostname) : error;
  const lookupService = shaped((...args: unknown[]): object => {
    if (args.length !== 3) throw missingArgs("address", "port", "callback");
    const [address, port, callback] = args;
    if (typeof address !== "string" || ipVersion(address) === 0) throw invalidValue("address", address);
    const number = servicePort(port);
    validateFunction(callback, "callback");
    const done = callback, request = new GetNameInfoReqWrap(done, address, number, () => undefined);
    deliver(nameInfo(address, number), (error, value) => { Reflect.apply(done, request, value === undefined ? [failed(error, address)] : [null, value.hostname, value.service]); });
    return request;
  }, "lookupService", 3);
  const lookupServicePromise = shaped((...args: unknown[]): Promise<{ hostname: string; service: string }> => {
    if (args.length !== 2) throw missingArgs("address", "port");
    const [address, port] = args;
    if (typeof address !== "string" || ipVersion(address) === 0) throw invalidValue("address", address);
    const number = servicePort(port);
    return tracked(() => nameInfo(address, number).catch((error: unknown) => { throw failed(error); }));
  }, "lookupService", 2);

  return { Resolver, PromisesResolver, bound, setDefaultServers, lookupService, lookupServicePromise, deliver, tracked };
}
