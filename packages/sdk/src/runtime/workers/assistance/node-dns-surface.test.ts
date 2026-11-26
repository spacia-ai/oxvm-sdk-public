import { PassThrough } from "readable-stream";
import { describe, expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeDns } from "./node-dns.js";
import { DnsTransportError, type DnsTransport } from "./node-dns-resolver.ts";
import { encodeResponse } from "./node-dns-wire-encode.ts";
import { peekQuestion } from "./node-dns-wire.ts";
import { apply, controls, errorShape, nameOf, object, printed, prototypeOf, text, thrownShape } from "./node-dns-replay.test-support.ts";

const recorded = controls("node-dns-surface"), surface = object(recorded["surface"]), validate = object(recorded["validate"]);
const FILES: Readonly<Record<string, string>> = {
  "/etc/resolv.conf": "nameserver 185.12.64.2\nnameserver 185.12.64.1\n",
  "/etc/hosts": "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n",
  "/etc/services": "# services\nssh\t\t22/tcp\nssh\t\t22/udp\nhttp\t\t80/tcp\t\twww\nhttps\t\t443/tcp\n",
};
/** A VM whose nameservers know no name. */
const transport: DnsTransport = {
  readFile: path => FILES[path],
  udp: (_server, query) => { const asked = peekQuestion(query); return asked === undefined ? Promise.reject(new DnsTransportError("failed", "unreadable query")) : Promise.resolve(encodeResponse({ id: asked.id, name: asked.question.name, type: asked.question.type, rcode: 3 })); },
  tcp: () => Promise.reject(new DnsTransportError("failed", "unused")),
};
function dns() {
  const stderr = new PassThrough(); stderr.resume();
  return createNodeDns({ spawn: () => { throw new Error("The guest's Node is not asked here"); } }, createAsyncContext(), stderr, queueMicrotask, { transport, fastLookup: true });
}

/** The recorder's `desc`: each own property's type, attributes, and for a function its name and length. */
function describeObject(target: object): Record<string, unknown> {
  return Object.fromEntries(Reflect.ownKeys(target).map(key => {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key), value: unknown = descriptor?.value;
    const shape = typeof value === "function" ? { n: value.name, l: value.length } : typeof value === "object" ? {} : { v: value };
    return [String(key), { t: typeof value, e: descriptor?.enumerable, w: descriptor?.writable, c: descriptor?.configurable, g: descriptor?.get !== undefined, ...shape }];
  }));
}
function proto(value: unknown): object {
  const prototype: unknown = Reflect.get(Object(value), "prototype");
  if (typeof prototype !== "object" || prototype === null) throw new TypeError("Expected a class");
  return prototype;
}

describe("the shape of node:dns as a program sees it (recorded from Node 24.18.1)", () => {
  const module = dns(), promises = module.promises;
  it.each([
    ["dns", module], ["promises", promises], ["Resolver", module.Resolver], ["ResolverProto", proto(module.Resolver)], ["PResolver", promises.Resolver], ["PResolverProto", proto(promises.Resolver)],
  ] as const)("%s has Node's keys in Node's order, with its names, lengths and attributes", (label, target) => {
    expect(printed(describeObject(target))).toEqual(surface[label]);
  });

  it("derives both Resolver classes from one ResolverBase, whose methods are not enumerable", () => {
    const base = prototypeOf(proto(module.Resolver));
    expect(base).toBe(prototypeOf(proto(promises.Resolver)));
    if (typeof base !== "object" || base === null) throw new TypeError("Expected a base prototype");
    const methods = Reflect.ownKeys(base).map(key => { const descriptor = Reflect.getOwnPropertyDescriptor(base, key), value: unknown = descriptor?.value; return [String(key), typeof value, typeof value === "function" ? value.name : undefined, typeof value === "function" ? value.length : undefined, descriptor?.enumerable]; });
    expect(methods).toEqual((Array.isArray(validate["baseProto"]) ? validate["baseProto"] : []).slice(0, 5));
    const same = object(surface["same"]);
    expect({
      resolverSame: module.Resolver === promises.Resolver, protoChain: base === Object.prototype, ctorParent: nameOf(prototypeOf(module.Resolver)),
      pctorParent: nameOf(prototypeOf(promises.Resolver)), ownKeysInstance: Reflect.ownKeys(new module.Resolver()), pownKeys: Reflect.ownKeys(new promises.Resolver()),
    }).toEqual({ resolverSame: same["resolverSame"], protoChain: same["protoChain"], ctorParent: same["ctorParent"], pctorParent: same["pctorParent"], ownKeysInstance: same["ownKeysInstance"], pownKeys: same["pownKeys"] });
    expect(() => { Reflect.apply(module.Resolver, undefined, []); }).toThrow(TypeError);
  });
});

describe("argument validation, in Node's order and words (recorded from Node 24.18.1)", () => {
  const cb = (): void => undefined;
  /** The recorder's `t`: the value a call returned, or how it threw. */
  function attempt(run: () => unknown): unknown {
    try {
      const value = run();
      if (value instanceof Promise) value.catch(() => undefined);
      return { value: value === undefined ? "<undefined>" : value instanceof Promise ? "<promise>" : printed(value) };
    } catch (error) { return { thrown: thrownShape(error) }; }
  }
  const label = (values: readonly unknown[]): string => values.map(value => typeof value === "function" ? "cb" : typeof value === "symbol" ? "sym" : JSON.stringify(value)).join(",");
  const shown = (value: unknown): unknown => typeof value === "object" && value !== null ? { ctor: value.constructor.name, keys: Object.keys(value) } : value;
  const invoke = apply;
  /** The recorded row, without the server list the recorder's machine had after a refused call. */
  const row = (name: string): unknown => { const entry = object(validate[name]); return "thrown" in entry ? { thrown: entry["thrown"] } : entry; };

  it("new Resolver(options)", () => {
    const { Resolver } = dns();
    for (const options of [{ timeout: "x" }, { timeout: -1 }, { timeout: -2 }, { timeout: 0 }, { timeout: 1.5 }, { timeout: 2 ** 31 }, { timeout: 2 ** 31 - 1 }, { tries: 0 }, { tries: "x" }, { tries: 1.5 }, { tries: 2 ** 31 }, { maxTimeout: -1 }, { maxTimeout: 0 }, { maxTimeout: "x" }, { maxTimeout: 1.5 }, { maxTimeout: 5 }, { timeout: null }, { tries: null }]) {
      const name = `new Resolver(${JSON.stringify(options)})`;
      expect(attempt(() => { new Resolver(options); return true; }), name).toEqual(row(name));
    }
    for (const options of [null, 1, "x"]) expect(attempt(() => { new Resolver(options); return true; })).toEqual({ value: true });
  });

  it("resolve4, resolve and reverse, as callbacks and as promises", () => {
    const module = dns(), fresh = (): object => new module.Resolver(), promised = (): object => new module.promises.Resolver();
    for (const args of [[], [1, cb], ["a.test"], ["a.test", {}], ["a.test", null, cb], ["a.test", 1, cb], ["a.test", "x", cb], ["a.test", { ttl: "x" }, cb], [null, cb], [Symbol.iterator, cb], ["a.test", cb, cb]]) {
      const name = `resolve4(${label(args)})`;
      expect(attempt(() => shown(invoke(fresh(), "resolve4", args))), name).toEqual(row(name));
    }
    for (const args of [["a.test", "BOGUS", cb], ["a.test", "a", cb], ["a.test", 1, cb], ["a.test", null, cb], ["a.test", undefined, cb], ["a.test", {}, cb], ["a.test"], ["a.test", "A"], [1, "A", cb], ["a.test", "MX"], ["a.test", cb, "MX"]]) {
      const name = `resolve(${args.map(value => typeof value === "function" ? "cb" : JSON.stringify(value)).join(",")})`;
      expect(attempt(() => shown(invoke(fresh(), "resolve", args))), name).toEqual(row(name));
    }
    expect(attempt(() => invoke(fresh(), "reverse", []))).toEqual(row("reverse()"));
    expect(attempt(() => invoke(fresh(), "reverse", [1, cb]))).toEqual(row("reverse(1,cb)"));
    expect(attempt(() => invoke(fresh(), "reverse", ["1.2.3.4"]))).toEqual(row("reverse(\"1.2.3.4\")"));
    for (const args of [[], [1], ["a.test", 1], ["a.test", "x"]]) expect(attempt(() => invoke(promised(), "resolve4", args)), JSON.stringify(args)).toEqual(row(`promises.resolve4(${JSON.stringify(args)})`));
    for (const args of [["a.test", "BOGUS"], ["a.test", 1], ["a.test", null], [1]]) expect(attempt(() => invoke(promised(), "resolve", args)), JSON.stringify(args)).toEqual(row(`promises.resolve(${JSON.stringify(args)})`));
  });

  it("setServers and getServers: addresses, ports, brackets, and what is no address", () => {
    const { Resolver } = dns();
    expect(attempt(() => invoke(new Resolver(), "getServers", []))).toEqual(row("getServers default"));
    // `1.2.3.4:0` is left out: Node 24.18.1 aborts the process on it. Here port 0 is the DNS port.
    for (const servers of [["1.2.3.4"], ["1.2.3.4:53"], ["1.2.3.4:5353"], ["[::1]:53"], ["[::1]:5353"], ["::1"], ["[::1]"], ["2001:DB8::1"], ["[2001:db8::1%eth0]:53"], ["fe80::1%eth0"], ["1.2.3.4", "::1", "[2001:db8::2]:99"], [], ["a.test"], ["1.2.3.4:x"], ["1.2.3.4:70000"], ["1.2.3.4:"], ["01.2.3.4"], ["1.2.3"], [1], [null], ["[::1]:x"], ["[::1"], ["::1:53"], [" 1.2.3.4"], ["1.2.3.4:053"], ["[1.2.3.4]:53"], ["[1.2.3.4]"], ["::ffff:1.2.3.4"], ["1.2.3.4", "bad"]]) {
      const name = `setServers(${JSON.stringify(servers)})`, resolver = new Resolver(), expected = object(validate[name]);
      expect(attempt(() => { const returned = invoke(resolver, "setServers", [servers]); return { ret: returned === undefined ? "<undefined>" : returned, servers: invoke(resolver, "getServers", []) }; }), name).toEqual(row(name));
      // A refused list changes nothing.
      if ("after" in expected) expect(invoke(resolver, "getServers", []), name).toEqual(expected["after"]);
    }
    for (const [shownAs, servers] of [["1.2.3.4", "1.2.3.4"], ["null", null], ["undefined", undefined], ["[object Object]", { length: 1, 0: "1.2.3.4" }], ["[object Set]", new Set(["1.2.3.4"])]] as const) {
      expect(attempt(() => invoke(new Resolver(), "setServers", [servers])), shownAs).toEqual(row(`setServers non-array ${shownAs}`));
    }
    expect(invoke((() => { const resolver = new Resolver(); invoke(resolver, "setServers", [["1.2.3.4:0", "[::1]:0"]]); return resolver; })(), "getServers", [])).toEqual(["1.2.3.4", "::1"]);
  });

  it("setLocalAddress and cancel", () => {
    const { Resolver } = dns();
    for (const args of [[], ["1.2.3.4"], ["1.2.3.4", "::1"], ["::1"], ["::1", "1.2.3.4"], ["x"], ["1.2.3.4", "x"], [1], ["1.2.3.4", 1], ["1.2.3.4", "::1", "x"], ["0.0.0.0", "::0"], [undefined, "::1"], ["1.2.3.4", undefined], [null]]) {
      const name = `setLocalAddress(${JSON.stringify(args)})`;
      expect(attempt(() => invoke(new Resolver(), "setLocalAddress", args)), name).toEqual(row(name));
    }
    expect(attempt(() => invoke(new Resolver(), "setLocalAddress", ["1.2.3.4", "5.6.7.8"]))).toMatchObject({ thrown: { code: "ERR_INVALID_ARG_VALUE", message: "Cannot specify two IPv4 addresses." } });
    expect(attempt(() => invoke(new Resolver(), "cancel", []))).toEqual(row("cancel()"));
  });

  it("dns.setServers replaces the default resolver for both APIs and binds the module functions anew", () => {
    const module = dns(), before = module.resolve4, promisedBefore = module.promises.resolve4;
    expect(module.getServers()).toEqual(object(validate["getServers default"])["value"]);
    expect(attempt(() => { const returned = apply(module, "setServers", [["9.9.9.9"]]); return { v: returned === undefined ? "<undefined>" : returned, now: module.getServers(), p: module.promises.getServers() }; })).toEqual(row("module setServers"));
    expect([module.resolve4 === before, module.promises.resolve4 === promisedBefore, module.resolve4.name]).toEqual([false, false, "bound queryA"]);
    expect(() => { module.setServers(["bad"]); }).toThrow(expect.objectContaining({ code: "ERR_INVALID_IP_ADDRESS" }));
    expect(module.getServers()).toEqual(["9.9.9.9"]);
  });

  it("setDefaultResultOrder", () => {
    const module = dns();
    for (const value of ["ipv4first", "ipv6first", "verbatim", "x", undefined, 1]) {
      const name = `setDefaultResultOrder(${String(value)})`;
      expect(attempt(() => { const returned = apply(module, "setDefaultResultOrder", [value]); return { x: returned === undefined ? "<undefined>" : returned, now: module.getDefaultResultOrder(), p: module.promises.getDefaultResultOrder() }; }), name).toEqual(row(name));
    }
  });

  it("lookupService: arguments, then the hosts file's name and the service of /etc/services", async () => {
    const module = dns();
    for (const args of [[], ["127.0.0.1"], ["127.0.0.1", 22], ["x", 22, cb], ["127.0.0.1", "x", cb], ["127.0.0.1", -1, cb], ["127.0.0.1", 65536, cb], ["127.0.0.1", 1.5, cb], ["127.0.0.1", "22", cb], ["127.0.0.1", 0, cb], [1, 22, cb], ["127.0.0.1", null, cb], ["::1", 22, cb]]) {
      const name = `lookupService(${args.map(value => typeof value === "function" ? "cb" : JSON.stringify(value)).join(",")})`;
      expect(attempt(() => shown(module.lookupService(...args))), name).toEqual(row(name));
    }
    for (const args of [[], ["x", 22], ["127.0.0.1", "x"], ["127.0.0.1", 65536], ["127.0.0.1", "22"], [1, 22]]) {
      const name = `promises.lookupService(${JSON.stringify(args)})`;
      expect(attempt(() => module.promises.lookupService(...args)), name).toEqual(row(name));
    }
    const service = (address: string, port: number): Promise<unknown> => new Promise(resolve => { module.lookupService(address, port, (error: unknown, ...found: unknown[]) => { resolve(error === null ? { h: found[0], s: found[1], argc: found.length } : errorShape(error)); }); });
    const expected = object(validate["ls"]), strip = (value: unknown): unknown => { const { message, keys, props } = object(value); return { message, keys, props }; };
    expect({ ssh: await service("127.0.0.1", 22), http: await service("127.0.0.1", 80), unknownPort: await service("127.0.0.1", 54321), v6: await service("::1", 443), zero: await service("127.0.0.1", 0) })
      .toEqual({ ssh: expected["ssh"], http: expected["http"], unknownPort: expected["unknownPort"], v6: expected["v6"], zero: expected["zero"] });
    expect(await service("192.0.2.123", 22)).toEqual(strip(expected["nohost"]));
    expect(await module.promises.lookupService("127.0.0.1", 22)).toEqual(expected["p"]);
    expect(errorShape(await module.promises.lookupService("192.0.2.123", 22).catch((error: unknown) => error))).toEqual(strip(expected["pErr"]));
    expect(text(object(expected["ssh"])["s"])).toBe("ssh");
  });
});
