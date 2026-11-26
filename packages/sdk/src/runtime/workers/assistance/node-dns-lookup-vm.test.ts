import { PassThrough } from "readable-stream";
import { describe, expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeDns } from "./node-dns.js";
import { libcChannelOptions, parseResolvConf } from "./node-dns-config.ts";
import { DnsTransportError, type DnsTransport } from "./node-dns-resolver.ts";
import { sortAddresses, vmAddressSources } from "./node-dns-sort.ts";
import { encodeResponse, type EncodedRecord } from "./node-dns-wire-encode.ts";
import { peekQuestion, RR_TYPE } from "./node-dns-wire.ts";
import { parseAddress } from "./node-dns-address.ts";
import { controls, list, object, text } from "./node-dns-replay.test-support.ts";

/** What the guest's own Node answered inside a relay-connected VM; see the controls' `recorder`. */
const recorded = controls("node-dns-lookup-vm"), zone = object(recorded["zone"]), cases = object(recorded["cases"]);
const FILES: Readonly<Record<string, string>> = { "/etc/hosts": text(recorded["hosts"]), "/etc/resolv.conf": text(recorded["resolvConf"]) };

/** The VM's resolver as the recorder's relay peer answered: CNAMEs followed, NXDOMAIN for a name it does not know. */
function vmTransport(): DnsTransport & { readonly asked: string[]; readonly timeouts: number[] } {
  const asked: string[] = [], timeouts: number[] = [];
  const records = (name: string, type: "A" | "AAAA"): unknown => zone[name] === undefined ? undefined : object(zone[name])[type] ?? [];
  return {
    asked, timeouts,
    readFile: path => FILES[path],
    tcp: () => Promise.reject(new DnsTransportError("failed", "EPERM: the relay carries no TCP to port 53")),
    udp: (server, query, exchange) => {
      const peeked = peekQuestion(query), name = peeked?.question.name.toLowerCase() ?? "", type = peeked?.question.type === RR_TYPE.AAAA ? "AAAA" : "A", id = peeked?.id ?? 0;
      asked.push(`${server.address}:${String(server.port)} ${name}/${type}`); timeouts.push(exchange.timeoutMs);
      const reply = (fields: { rcode?: number; truncated?: boolean; answers?: EncodedRecord[] }): Promise<Uint8Array> => Promise.resolve(encodeResponse({ id, name, type: RR_TYPE[type], ...fields }));
      const answers: EncodedRecord[] = [];
      let owner = name;
      for (let depth = 0; depth < 8; depth += 1) {
        const entry = zone[owner] === undefined ? undefined : object(zone[owner]);
        if (entry === undefined) return reply({ rcode: 3 });
        const alias = entry["CNAME"];
        if (typeof alias === "string") { answers.push({ name: owner, ttl: 60, data: { type: "CNAME", value: alias } }); owner = alias; continue; }
        const found = records(owner, type);
        if (found === "silent") return Promise.reject(new DnsTransportError("timeout", "no reply"));
        if (found === "truncated") return reply({ truncated: true });
        if (found === "servfail" || found === "refused") return reply({ rcode: found === "servfail" ? 2 : 5 });
        for (const address of list(found)) answers.push({ name: owner, ttl: 60, data: { type, address: text(address) } });
        return reply({ answers });
      }
      return reply({ rcode: 3 });
    },
  };
}

function dns(transport: DnsTransport, fastLookup = true) {
  const stderr = new PassThrough(); stderr.resume();
  let held = 0;
  const retain = (): (() => void) => { held += 1; return () => { held -= 1; }; };
  const module = createNodeDns({ spawn: () => { throw new Error("The guest's Node was asked"); } }, createAsyncContext(), stderr, queueMicrotask, { transport, fastLookup, retain, random: { id: () => 0x4242, jitter: () => 0 } });
  return { module, held: () => held };
}
type Dns = ReturnType<typeof dns>["module"];
/** The recorder's calls, by their label in the controls. */
const VARIANTS: Readonly<Record<string, (module: Dns, name: string) => Promise<unknown>>> = {
  cb: (module, name) => new Promise((resolve, reject) => { module.lookup(name, (error: unknown, ...values: unknown[]) => { if (error === null) resolve(values); else reject(error instanceof Error ? error : new Error("dns.lookup failed with something that is no Error")); }); }),
  all: (module, name) => module.promises.lookup(name, { all: true }),
  f4: (module, name) => module.promises.lookup(name, { family: 4 }),
  f6: (module, name) => module.promises.lookup(name, { family: 6 }),
  f4all: (module, name) => module.promises.lookup(name, { family: 4, all: true }),
  f6all: (module, name) => module.promises.lookup(name, { family: 6, all: true }),
  v4first: (module, name) => module.promises.lookup(name, { all: true, order: "ipv4first" }),
  v6first: (module, name) => module.promises.lookup(name, { all: true, order: "ipv6first" }),
  addrconfig: (module, name) => module.promises.lookup(name, { all: true, hints: module.ADDRCONFIG }),
  f6mapped: (module, name) => module.promises.lookup(name, { all: true, family: 6, hints: module.V4MAPPED }),
  f6mappedall: (module, name) => module.promises.lookup(name, { all: true, family: 6, hints: module.V4MAPPED | module.ALL }),
};
const errorFields = (error: unknown): unknown => error instanceof Error ? { message: error.message, ...Object.fromEntries(["code", "errno", "syscall", "hostname"].map(key => [key, Reflect.get(error, key)])) } : error;

describe("dns.lookup answered in the process, against the guest's Node 24.18.1 inside a relay-connected VM", () => {
  for (const [label, value] of Object.entries(cases)) {
    const entry = object(value), call = VARIANTS[text(entry["variant"])];
    it(`${label}: the addresses, their order, or the error`, async () => {
      if (call === undefined) throw new Error(`Unknown variant in ${label}`);
      const { module, held } = dns(vmTransport());
      const outcome = await call(module, text(entry["name"])).then(result => ({ result }), (error: unknown) => ({ error: errorFields(error) }));
      expect(outcome).toEqual(entry["error"] === undefined ? { result: entry["result"] } : { error: entry["error"] });
      expect(held()).toBe(0);
    });
  }

  it("models the VM's sockets as recorded: unspecified local addresses except towards a loopback", () => {
    const shown = (bytes: Uint8Array | undefined, family: 4 | 6): string | undefined => {
      if (bytes === undefined) return undefined;
      const mapped = bytes[10] === 0xff && bytes[11] === 0xff && bytes.subarray(0, 10).every(byte => byte === 0);
      if (family === 4 || (mapped && bytes[12] === 127)) return Array.from(bytes.subarray(12)).join(".");
      return bytes.every(byte => byte === 0) ? "::" : bytes[15] === 1 && bytes.subarray(0, 15).every(byte => byte === 0) ? "::1" : "other";
    };
    for (const [key, local] of Object.entries(object(recorded["udpConnect"]))) {
      const [kind, address] = key.split(" "), parsed = parseAddress(address ?? ""), family = kind === "udp4" ? 4 : 6;
      if (parsed === undefined) throw new Error(`Unreadable address in ${key}`);
      const destination = parsed.family === 4 ? Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...parsed.bytes) : parsed.bytes;
      expect([key, shown(vmAddressSources(family, destination), family)]).toEqual([key, local]);
    }
  });

  it("sorts as musl does with those sources: ::1, then global IPv6, IPv4, and IPv6 whose label differs from the source's", () => {
    const sorted = (...addresses: string[]): string[] => sortAddresses(addresses.map(address => ({ address, family: address.includes(":") ? 6 as const : 4 as const }))).map(entry => entry.address);
    expect(sorted("127.0.0.1", "::1")).toEqual(["::1", "127.0.0.1"]);
    expect(sorted("203.0.113.21", "203.0.113.22", "2001:db8::21")).toEqual(["2001:db8::21", "203.0.113.21", "203.0.113.22"]);
    // Only IPv4, or one address: the order found.
    expect(sorted("203.0.113.9", "10.0.0.1")).toEqual(["203.0.113.9", "10.0.0.1"]);
    expect(sorted("2001:db8::1")).toEqual(["2001:db8::1"]);
  });

  it("holds the process once for any number of pending calls (500 parallel lookups passed a process's 256 holds in the VM)", async () => {
    const stderr = new PassThrough(); stderr.resume();
    let held = 0, taken = 0;
    const retain = (): (() => void) => { held += 1; taken += 1; if (held > 256) throw new Error("JavaScript runtime I/O capacity exhausted"); return () => { held -= 1; }; };
    const module = createNodeDns({ spawn: () => { throw new Error("The guest's Node was asked"); } }, createAsyncContext(), stderr, queueMicrotask, { transport: vmTransport(), fastLookup: true, retain });
    const all = Promise.all([...Array.from({ length: 300 }, () => module.promises.lookup("one.test")), ...Array.from({ length: 300 }, () => module.promises.resolve4("one.test"))]);
    expect([held, taken]).toEqual([1, 1]);
    expect((await all).length).toBe(600);
    expect([held, taken]).toEqual([0, 1]);
    await module.promises.lookup("one.test");
    expect([held, taken]).toEqual([0, 2]);
  });

  it("asks each family once, waits `timeout` seconds in all across `attempts` sends, and stops at the first failure", async () => {
    const silent = vmTransport(), { module } = dns(silent);
    expect(errorFields(await module.promises.lookup("slow.test").catch((error: unknown) => error))).toMatchObject({ code: "EAI_AGAIN", errno: -3001 });
    // resolv.conf has no options: 5 s and 2 attempts, so 2.5 s for each send (the VM's Node failed after 5.0 s).
    expect(silent.asked).toEqual(["192.0.2.1:53 slow.test/A", "192.0.2.1:53 slow.test/AAAA", "192.0.2.1:53 slow.test/A", "192.0.2.1:53 slow.test/AAAA"]);
    expect(silent.timeouts).toEqual([2500, 2500, 2500, 2500]);
    expect(libcChannelOptions(parseResolvConf("nameserver 192.0.2.1\noptions timeout:3 attempts:4\n"))).toEqual({ timeout: 750, tries: 4, maxTimeout: 750 });
    const answered = vmTransport();
    await dns(answered).module.promises.lookup("multi.test", { all: true });
    expect(answered.asked).toEqual(["192.0.2.1:53 multi.test/A", "192.0.2.1:53 multi.test/AAAA"]);
  });
});
