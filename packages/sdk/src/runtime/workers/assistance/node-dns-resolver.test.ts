import { describe, expect, it } from "vitest";
import { createDnsResolvers } from "./node-dns-api.ts";
import { DnsFailure } from "./node-dns-errors.ts";
import { DnsChannel, DnsTransportError, queryName, type DnsTransport } from "./node-dns-resolver.ts";
import { encodeResponse } from "./node-dns-wire-encode.ts";
import { peekQuestion, RR_TYPE } from "./node-dns-wire.ts";
import { apply, call, controls, errorShape, list, object, recordedQueries, replayTransport, scheduling, sequence, text } from "./node-dns-replay.test-support.ts";

const recorded = controls("node-dns-resolver"), resolveCases = object(recorded["resolve"]), timingCases = object(recorded["timing"]), misc = object(recorded["misc"]);
const fixedRandom = { id: () => 0x1234, jitter: () => 0 };

function resolvers(transport: DnsTransport) {
  const process = scheduling();
  return { process, ...createDnsResolvers({ transport, scheduling: process, random: fixedRandom }) };
}
/** The recorded outcome of a case, without the recorder's bookkeeping. */
function outcome(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key === "result" || key === "error" || key === "thrown"));
}

describe("dns.Resolver against the replies Node 24.18.1 was given (recorded with a scripted server)", () => {
  for (const [label, value] of Object.entries(resolveCases)) {
    it(`${label}: the same question, the same result`, async () => {
      const entry = object(value), queries = recordedQueries(entry["queries"]), transport = replayTransport(queries), { Resolver, process } = resolvers(transport);
      const resolver = new Resolver();
      apply(resolver, "setServers", [["127.0.0.1:5353"]]);
      expect(await call(resolver, text(entry["method"]), list(entry["args"]))).toEqual(outcome(entry));
      expect(transport.asked).toEqual(sequence(queries));
      expect(process.held()).toBe(0);
    });
  }
});

describe("retries, fail-over and TCP as c-ares does them for Node (recorded)", () => {
  for (const [label, value] of Object.entries(timingCases)) {
    const entry = object(value);
    // Cancellation, the promise API and the resolver three cases share have their own tests below, as has the TLSA hole.
    if (typeof entry["method"] !== "string" || label.startsWith("cancel") || label.startsWith("sticky") || label === "tlsa hole") continue;
    it(`${label}: asks the same servers in the same order`, async () => {
      const queries = recordedQueries(entry["queries"]), transport = replayTransport(queries), { Resolver } = resolvers(transport);
      const resolver = new Resolver(entry["options"]), servers = list(entry["servers"]);
      // The recorder read getServers() after the answer, when a server that failed had moved behind the other.
      apply(resolver, "setServers", [servers.length === 2 ? ["127.0.0.1:5353", "127.0.0.1:5354"] : servers]);
      expect(await call(resolver, text(entry["method"]), list(entry["args"]))).toEqual(outcome(entry));
      // Nothing listened on port 5399, so the recorder saw no query there.
      expect(transport.asked.filter(asked => !asked.includes(":5399:"))).toEqual(sequence(queries));
      expect(apply(resolver, "getServers", [])).toEqual(servers);
    });
  }

  it("asks a server that failed after the others from then on", async () => {
    const transport = replayTransport([]), { Resolver } = resolvers(transport), resolver = new Resolver({ timeout: 100, tries: 2 });
    apply(resolver, "setServers", [["127.0.0.1:5353", "127.0.0.1:5354"]]);
    for (const label of ["sticky 1", "sticky 2", "sticky 3"]) {
      const entry = object(timingCases[label]), queries = recordedQueries(entry["queries"]);
      transport.feed(queries);
      expect(await call(resolver, text(entry["method"]), list(entry["args"])), label).toEqual(outcome(entry));
      expect(transport.asked, label).toEqual(sequence(queries));
    }
  });

  it("waits 2 s, then doubles per round up to maxTimeout, never under 250 ms, shortened by up to half as jitter", async () => {
    const waits = async (options: { timeout: number; tries: number; maxTimeout: number }, jitter: number, servers = 1): Promise<number[]> => {
      const timeouts: number[] = [];
      const transport: DnsTransport = { readFile: () => undefined, tcp: () => Promise.reject(new Error("unused")), udp: (_server, _query, wait) => { timeouts.push(wait.timeoutMs); return Promise.reject(new DnsTransportError("timeout", "silent")); } };
      const channel = new DnsChannel(transport, options, { id: () => 7, jitter: () => jitter });
      channel.servers = Array.from({ length: servers }, (_, index) => ({ address: "192.0.2.1", family: 4 as const, port: 53 + index }));
      await expect(channel.query("silent.test", RR_TYPE.A)).rejects.toMatchObject({ status: "ETIMEOUT" });
      return timeouts;
    };
    expect(await waits({ timeout: -1, tries: 4, maxTimeout: 0 }, 0)).toEqual([2000, 4000, 8000, 16000]);
    expect(await waits({ timeout: -1, tries: 4, maxTimeout: 0 }, 1)).toEqual([2000, 2000, 4000, 8000]);
    expect(await waits({ timeout: 100, tries: 4, maxTimeout: 1000 }, 0)).toEqual([250, 500, 1000, 1000]);
    expect(await waits({ timeout: 200, tries: 5, maxTimeout: 1000 }, 1)).toEqual([250, 250, 500, 500, 500]);
    // Two servers share a round: the timeout grows once both were asked.
    expect(await waits({ timeout: 100, tries: 2, maxTimeout: 0 }, 0, 2)).toEqual([250, 250, 500, 500]);
    // Node's recorded gaps between retries with the defaults lie between full jitter and none, plus its 1 s timer tick.
    const times = list(object(timingCases["default timing"])["queryTimes"]).map(Number), end = Number(object(timingCases["default timing"])["elapsed"]);
    const gaps = [...times.slice(1), end].map((time, index) => time - (times[index] ?? 0));
    const least = await waits({ timeout: -1, tries: 4, maxTimeout: 0 }, 1), most = await waits({ timeout: -1, tries: 4, maxTimeout: 0 }, 0);
    gaps.forEach((gap, index) => { expect(gap).toBeGreaterThanOrEqual(least[index] ?? 0); expect(gap).toBeLessThanOrEqual((most[index] ?? 0) + 1000 + 50); });
  });

  it("leaves a hole for every other record before a TLSA record, as Node does", async () => {
    const entry = object(timingCases["tlsa hole"]), { Resolver } = resolvers(replayTransport(recordedQueries(entry["queries"])));
    const resolver = new Resolver();
    apply(resolver, "setServers", [["127.0.0.1:5353"]]);
    const result = await new Promise<unknown>(resolve => { apply(resolver, "resolveTlsa", ["tlsahole.test", (_error: unknown, records: unknown) => { resolve(records); }]); });
    const records = list(result), second = object(records[1]), data = second["data"];
    expect([0 in records, records.length, Object.keys(second), data instanceof ArrayBuffer ? Array.from(new Uint8Array(data)) : data]).toEqual([false, 2, ["certUsage", "selector", "match", "data"], [0xab]]);
    expect(list(entry["holes"])).toEqual([false, 2, ["certUsage", "selector", "match", "data"], "ab"]);
  });
});

describe("cancel(), the promise API and what a resolver reads from the VM", () => {
  /** A transport whose queries wait until cancelled. */
  function waiting(): DnsTransport {
    const wait = (_server: unknown, _query: unknown, exchange: { readonly signal: AbortSignal }): Promise<Uint8Array> => new Promise((_resolve, reject) => {
      exchange.signal.addEventListener("abort", () => { reject(new DnsTransportError("failed", "cancelled")); }, { once: true });
    });
    return { readFile: () => undefined, udp: wait, tcp: wait };
  }
  it("fails every pending query with ECANCELLED, in a later turn, and keeps the resolver usable", async () => {
    const { Resolver, process } = resolvers(waiting()), resolver = new Resolver();
    const pending = call(resolver, "resolve4", ["silent.test"]);
    let settled = false;
    void pending.then(() => { settled = true; });
    expect(process.held()).toBeGreaterThan(0);
    apply(resolver, "cancel", []);
    expect(settled).toBe(false);
    expect(await pending).toEqual({ error: object(object(timingCases["cancel"])["error"]) });
    expect(process.held()).toBe(0);
    const again = call(resolver, "resolveMx", ["ok.test"]);
    apply(resolver, "cancel", []);
    expect(await again).toMatchObject({ error: { message: "queryMx ECANCELLED ok.test" } });
  });

  it("promises.Resolver resolves with the value alone and rejects with the same DNSException", async () => {
    const promised = object(timingCases["promise"]);
    const reply = (name: string, rcode: number): DnsTransport["udp"] => (_server, query) => Promise.resolve(encodeResponse({ id: peekQuestion(query)?.id ?? 0, name, type: 1, rcode, ...(rcode === 0 ? { answers: [{ ttl: 1, data: { type: "A", address: "192.0.2.1" } }] } : {}) }));
    const use = (udp: DnsTransport["udp"]) => { const made = resolvers({ readFile: () => undefined, udp, tcp: udp }); return { process: made.process, resolver: new made.PromisesResolver({ timeout: 100, tries: 1 }) }; };
    const ask = (target: object, method: string, ...args: unknown[]): unknown => apply(target, method, args);
    const ok = use(reply("ok.test", 0)), pending = ask(ok.resolver, "resolve4", "ok.test");
    expect(pending).toBeInstanceOf(Promise);
    expect(ok.process.held()).toBe(1);
    expect(await pending).toEqual(promised["ok"]);
    expect(ok.process.held()).toBe(0);
    expect(errorShape(await Promise.resolve(ask(use(reply("nx.test", 3)).resolver, "resolve4", "nx.test")).catch((error: unknown) => error))).toEqual(promised["nx"] === undefined ? undefined : pick(promised["nx"]));
    const silent = use(() => Promise.reject(new DnsTransportError("timeout", "silent")));
    expect(errorShape(await Promise.resolve(ask(silent.resolver, "resolve4", "silent.test")).catch((error: unknown) => error))).toEqual(pick(promised["timeout"]));
    // An address that is none rejects; the callback API throws the same error.
    const bad = ask(silent.resolver, "reverse", "zz");
    expect(bad).toBeInstanceOf(Promise);
    expect(errorShape(await Promise.resolve(bad).catch((error: unknown) => error))).toEqual(pick(promised["reverseBad"]));
    expect(promised["reverseThrowsSync"]).toBe(false);
  });
  const pick = (value: unknown): unknown => { const { message, keys, props } = object(value); return { message, keys, props }; };

  it("answers a reverse lookup from the hosts file as Node does: the aliases of the merged entry, not its first name", async () => {
    const hosts = text(misc["hosts"]);
    for (const [label, address] of [["revLoop", "127.0.0.1"], ["revHosts", "10.9.8.7"], ["revHostsBoth", "10.9.8.8"], ["revV6", "::1"], ["revMapped", "::ffff:10.9.8.7"], ["revZone", "fe80::1%eth0"], ["revUpper", "FD00::8"]] as const) {
      const entry = object(misc[label]), queries = recordedQueries(entry["queries"], 53), transport = replayTransport(queries, { "/etc/hosts": hosts, "/etc/resolv.conf": "nameserver 127.0.0.1\n" });
      const resolver = new (resolvers(transport).Resolver)();
      expect(await call(resolver, "reverse", [address]), label).toEqual(entry["result"] === undefined ? { error: entry["error"] } : { result: [entry["result"]] });
      expect(transport.asked, label).toEqual(sequence(queries));
    }
  });

  it("takes its servers from the VM's resolv.conf, 127.0.0.1 when it names none, and fails as Node does with none set", async () => {
    const servers = (conf: string | undefined): unknown => { const resolver = new (resolvers({ readFile: path => path === "/etc/resolv.conf" ? conf : undefined, udp: () => Promise.reject(new Error("unused")), tcp: () => Promise.reject(new Error("unused")) }).Resolver)(); return apply(resolver, "getServers", []); };
    expect(servers("nameserver 127.0.0.1\nnameserver ::1\nnameserver 10.0.0.9\nnameserver 10.0.0.10\nsearch a.test b.test\noptions timeout:1 attempts:1 ndots:2\n")).toEqual(misc["confServers"]);
    expect(servers("# nothing\n")).toEqual(misc["emptyConf"]);
    expect(servers(undefined)).toEqual(misc["emptyConf"]);
    expect(servers("nameserver 1.2.3.4 # c\n nameserver   5.6.7.8\nnameserver bad\nnameserver [::1]:5353\nnameserver 9.9.9.9:54\n; nameserver 7.7.7.7\nnameserver fe80::1%eth0\n")).toEqual(misc["oddConf"]);
    const empty = new (resolvers(replayTransport([])).Resolver)();
    apply(empty, "setServers", [[]]);
    expect(await call(empty, "resolve4", ["a.test"])).toEqual({ error: pick(misc["noServers"]) });
  });

  it("asks for a name in lower case and in Punycode, and moves on when a socket fails", async () => {
    expect([queryName("UPPER.Test"), queryName("café.test"), queryName("a b.test")]).toEqual(["upper.test", "xn--caf-dma.test", "a b.test"]);
    const channel = new DnsChannel({ readFile: () => undefined, udp: () => Promise.reject(new Error("EPERM")), tcp: () => Promise.reject(new Error("unused")) }, { timeout: -1, tries: 2, maxTimeout: 0 }, fixedRandom);
    channel.servers = [{ address: "10.0.2.3", family: 4, port: 53 }];
    const failure: unknown = await channel.query("a.test", RR_TYPE.A).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DnsFailure);
    expect(failure).toMatchObject({ status: "ECONNREFUSED" });
  });
});
