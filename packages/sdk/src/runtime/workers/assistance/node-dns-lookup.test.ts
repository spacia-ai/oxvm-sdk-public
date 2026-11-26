import { PassThrough } from "readable-stream";
import { describe, expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeDns } from "./node-dns.js";
import { encodeResponse } from "./node-dns-wire-encode.ts";
import { peekQuestion } from "./node-dns-wire.ts";
import type { AddressSources } from "./node-dns-sort.ts";
import { controls, errorShape, list, object, printed, recordedQueries, replayTransport, text, thrownBrief, type ReplayTransport } from "./node-dns-replay.test-support.ts";

const recorded = controls("node-dns-lookup"), musl = object(recorded["musl"]);
const FILES = { "/etc/hosts": text(recorded["hosts"]), "/etc/resolv.conf": text(recorded["resolvConf"]) };
/** The recorder's server answered a name it did not know with NXDOMAIN. */
const unknownName = (query: Uint8Array): Uint8Array => { const asked = peekQuestion(query); return encodeResponse({ id: asked?.id ?? 0, name: asked?.question.name ?? "", type: asked?.question.type ?? 1, rcode: 3 }); };

/**
 * The recorder's container, as musl's address sorting saw it: an IPv4 address on a bridge, both loopbacks, and no route
 * for any other IPv6 destination (the connect fails). A VM differs: see node-dns-lookup-vm.test.ts.
 */
const containerSources: AddressSources = (family, destination) => {
  const mapped = (...four: number[]): Uint8Array => Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...four);
  if (family === 4) return destination[12] === 127 ? mapped(127, 0, 0, 1) : mapped(172, 17, 0, 2);
  if (destination[15] === 1 && destination.subarray(0, 15).every(byte => byte === 0)) return destination;
  // An IPv4-mapped destination goes out over IPv4.
  return destination[10] === 0xff && destination[11] === 0xff && destination.subarray(0, 10).every(byte => byte === 0) ? mapped(172, 17, 0, 2) : undefined;
};

function dns(transport: ReplayTransport, fastLookup = true) {
  const stderr = new PassThrough(); stderr.resume();
  let spawned = 0, held = 0;
  const retain = (): (() => void) => { held += 1; return () => { held -= 1; }; };
  const module = createNodeDns({ spawn: () => { spawned += 1; throw new Error("The guest's Node was asked"); } }, createAsyncContext(), stderr, queueMicrotask, { transport, fastLookup, retain, random: { id: () => 0x4242, jitter: () => 0 }, addressSources: containerSources });
  return { module, spawned: () => spawned, held: () => held };
}
function lookup(module: ReturnType<typeof dns>["module"], args: readonly unknown[]): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    try { module.lookup(...args, (error: unknown, ...values: unknown[]) => { resolve(error === null ? { result: printed(values) } : { error: errorShape(error) }); }); }
    catch (error) { resolve({ thrown: thrownBrief(error) }); }
  });
}
const outcome = (entry: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entry).filter(([key]) => key === "result" || key === "error" || key === "thrown"));
describe("dns.lookup answered in the process, against getaddrinfo in Node 24.18.1 (recorded on musl)", () => {
  for (const [label, value] of Object.entries(musl)) {
    const entry = object(value);
    if (!Array.isArray(entry["args"])) continue;
    it(`${label}: the result, error or refusal Node gave`, async () => {
      const transport = replayTransport(recordedQueries(entry["queries"], 53), FILES, unknownName), { module, spawned, held } = dns(transport);
      expect(await lookup(module, list(entry["args"]))).toEqual(outcome(entry));
      expect([spawned(), held()]).toEqual([0, 0]);
    });
  }

  it("asks the search list first for a short name, the name alone when it has a dot (musl), and nothing for a bad name", async () => {
    const asked = async (name: string, options: object = {}): Promise<string[]> => { const transport = replayTransport([], FILES, unknownName); await lookup(dns(transport).module, [name, options]); return transport.asked; };
    expect(await asked("single")).toEqual(["udp:53:single.search.test/1", "udp:53:single.search.test/28", "udp:53:single/1", "udp:53:single/28"]);
    expect(await asked("nx.test", { family: 6 })).toEqual(["udp:53:nx.test/28"]);
    expect(await asked("nx.test.", { family: 4 })).toEqual(["udp:53:nx.test/1"]);
    expect(await asked("hosts4.test.", { family: 4 })).toEqual(["udp:53:hosts4.test/1"]);
    expect(await asked("a b")).toEqual([]);
    expect(await asked("hosts4.test", { family: 6 })).toEqual([]);
  });

  it("requires a callback, returns Node's request object, and calls back in a later turn even for a literal", async () => {
    const { module } = dns(replayTransport([], FILES, unknownName)), order: string[] = [];
    expect(await new Promise(resolve => { try { module.lookup("a"); resolve(undefined); } catch (error) { resolve(thrownBrief(error)); } })).toEqual(object(musl["no callback"])["thrown"]);
    const shape = (value: object): unknown => ({ ctor: value.constructor.name, keys: Object.keys(value) }), returned = object(recorded["returned"]);
    expect(shape(module.lookup("127.0.0.1", () => { order.push("cb"); }))).toEqual(returned["literal"]);
    order.push("sync");
    expect(shape(module.lookup("both.test", () => undefined))).toEqual(returned["name"]);
    await new Promise(resolve => { setTimeout(resolve, 0); });
    expect(order).toEqual(recorded["literalTiming"]);
  });

  it("promises.lookup resolves with one address, all of them, or null, and rejects with the same error", async () => {
    const promised = object(recorded["promises"]), queries = Object.values(musl).flatMap(entry => { const item = object(entry); return item["queries"] === undefined ? [] : recordedQueries(item["queries"], 53); });
    const { module, held } = dns(replayTransport(queries.filter(query => query.name === "both.test"), FILES, unknownName));
    const pending = module.promises.lookup("both.test");
    expect(held()).toBe(1);
    expect(await pending).toEqual(promised["one"]);
    expect(held()).toBe(0);
    expect(await module.promises.lookup("both.test", { all: true })).toEqual(promised["all"]);
    expect(await module.promises.lookup(null)).toEqual(promised["nul"]);
    expect(await module.promises.lookup("127.0.0.1")).toEqual(promised["lit"]);
    const { message, keys, props } = object(promised["err"]);
    expect(errorShape(await module.promises.lookup("nx.test").catch((error: unknown) => error))).toEqual({ message, keys, props });
    expect(() => module.promises.lookup(1)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => module.promises.lookup("a", "x")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", message: "The \"options\" argument must be of type object or integer. Received type string ('x')" }));
  });

  it("leaves a name to the guest's Node when the VM's resolv.conf cannot be read or names no server, and when switched off", async () => {
    const hostsOnly = { "/etc/hosts": FILES["/etc/hosts"] };
    for (const [files, fast] of [[hostsOnly, true], [{ ...hostsOnly, "/etc/resolv.conf": "# none\n" }, true], [FILES, false]] as const) {
      const transport = replayTransport([], files, unknownName), { module, spawned } = dns(transport, fast);
      // The hosts file and literals need no nameserver; switched off, only what Node itself answers stays here.
      expect(await lookup(module, ["127.0.0.1"])).toEqual({ result: ["127.0.0.1", 4] });
      expect(await lookup(module, [""])).toEqual({ result: [null, 4] });
      expect(spawned()).toBe(0);
      expect(await lookup(module, ["hosts4.test"])).toMatchObject(fast ? { result: ["10.9.8.7", 4] } : { error: { message: "The guest's Node was asked" } });
      expect(await lookup(module, ["both.test"])).toMatchObject({ error: { message: "The guest's Node was asked" } });
      expect([spawned(), transport.asked]).toEqual([fast ? 1 : 2, []]);
    }
  });
});
