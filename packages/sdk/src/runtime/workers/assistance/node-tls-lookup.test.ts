import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:tls";
import { expect, it } from "vitest";
import { nativeServiceFixture } from "./native-service.test-support.js";
import { createNodeTls, type TlsSocket } from "./node-tls.js";
import { createTLSTestIdentity } from "./tls-test-identity.test-support.js";

// Fresh test-only identity per run, for localhost; never used by managed guest artifacts.
const { key, cert } = await createTLSTestIdentity();
/** Recorded from Node v24.18.1; the recorders are embedded in the file. */
const controls: unknown = JSON.parse(readFileSync(new URL("node-http-agent.controls.json", import.meta.url), "utf8"));
function recorded(...path: string[]): unknown {
  let value: unknown = controls;
  for (const name of path) value = typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  if (value === undefined) throw new Error(`Missing control ${path.join(".")}`);
  return value;
}
const lookupResult = (name: string): unknown => recorded("tlsLookup", "results", name);
function field(value: unknown, name: string): unknown { return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined; }
type Lookup = (host: unknown, options: unknown, callback: unknown) => void;
const answering = (addresses: readonly { address: string; family: 4 | 6 }[], calls: unknown[] = []): Lookup => (host, options, callback) => {
  calls.push([host, options]);
  if (typeof callback === "function") setImmediate(() => { Reflect.apply(callback, undefined, [null, addresses]); });
};
function assistedTls() {
  const fixture = nativeServiceFixture();
  return { ...fixture, tls: createNodeTls(fixture.native, fixture.context, fixture.retain) };
}
async function tlsServer() {
  const server = createServer({ key, cert }, socket => { socket.on("error", () => {}); socket.end("hello"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  return { server, port: address.port };
}
async function closedPort(): Promise<number> {
  const server = createNetServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  server.close(); await once(server, "close"); return address.port;
}
function outcome(socket: TlsSocket): Promise<{ authorized?: boolean; text?: string; error?: unknown }> {
  return new Promise(resolve => {
    let text = ""; let authorized: boolean | undefined;
    socket.on("secureConnect", () => { authorized = socket.authorized; });
    socket.on("data", bytes => { text += String(bytes); });
    socket.on("error", error => { resolve({ error }); });
    socket.on("close", () => { resolve({ ...(authorized === undefined ? {} : { authorized }), text }); });
  });
}

it("resolves the host through the program's lookup as net does and checks the certificate against the hostname", async () => {
  const { server, port } = await tlsServer(); const f = assistedTls();
  try {
    const calls: unknown[] = [], events: unknown[] = [];
    const socket = f.tls.connect({ host: "localhost", port, ca: cert, lookup: answering([{ address: "127.0.0.1", family: 4 }], calls) });
    expect(socket.secureConnecting).toBe(true);
    socket.on("lookup", (...values: unknown[]) => { events.push(values); });
    const result = await outcome(socket);
    expect(result).toEqual({ ...Object(recorded("tlsIdentity", "results", "lookupLocalhost")), text: "hello" });
    expect(socket.secureConnecting).toBe(false);
    // Node's tls.connect asks for every address with ADDRCONFIG and emits lookup for each answer.
    const recordedCalls = field(lookupResult("tlsLookupDefault"), "calls"), first: unknown = Array.isArray(recordedCalls) ? recordedCalls[0] : undefined;
    expect(calls).toEqual([["localhost", Array.isArray(first) ? first[1] : undefined]]);
    expect(events).toEqual([[null, "127.0.0.1", 4, "localhost"]]);
    // The name the lookup resolved stays the identity: another hostname fails against a localhost certificate.
    const other = await outcome(f.tls.connect({ host: "other.invalid", port, ca: cert, lookup: answering([{ address: "127.0.0.1", family: 4 }]) }));
    expect(other.error).toMatchObject({ code: field(recorded("tlsIdentity", "results", "lookupOtherName"), "code") });
    const named = await outcome(f.tls.connect({ host: "other.invalid", servername: "localhost", port, ca: cert, lookup: answering([{ address: "127.0.0.1", family: 4 }]) }));
    expect(named).toEqual({ ...Object(recorded("tlsIdentity", "results", "withServername")), text: "hello" });
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 30000);

it("asks for one address of the requested family when automatic selection is off, and tries each answer in turn", async () => {
  const { server, port } = await tlsServer(); const f = assistedTls();
  try {
    const calls: unknown[] = [];
    const single = await outcome(f.tls.connect({ host: "localhost", port, ca: cert, autoSelectFamily: false, lookup: (host: unknown, options: unknown, callback: unknown) => {
      calls.push([host, options]); if (typeof callback === "function") Reflect.apply(callback, undefined, [null, "127.0.0.1", 4]);
    } }));
    expect(single).toMatchObject({ authorized: true, text: "hello" }); expect(calls).toEqual([["localhost", { family: 0, hints: 32 }]]);
    // The first address refuses (nothing listens on 127.0.0.2); the guest's Node goes on to the next, as net does.
    const several = await outcome(f.tls.connect({ host: "localhost", port, ca: cert, lookup: answering([{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }]) }));
    expect(several).toMatchObject({ authorized: true, text: "hello" });
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 30000);

it("refuses a lookup that is not a function, reports its failures as Node does, and skips it for an IP address", async () => {
  const f = assistedTls(); const port = await closedPort();
  try {
    expect(() => f.tls.connect({ host: "h.invalid", port, lookup: 42 })).toThrow(expect.objectContaining(field(lookupResult("tlsLookupNotFunction"), "thrown") ?? {}));
    const failure = Object.assign(new Error("lookup boom"), { code: "ENOTFOUND" });
    const failed = await outcome(f.tls.connect({ host: "h.invalid", port, lookup: (_host: unknown, _options: unknown, callback: unknown) => {
      if (typeof callback === "function") Reflect.apply(callback, undefined, [failure]);
    } }));
    expect({ same: failed.error === failure, code: field(failed.error, "code"), message: field(failed.error, "message") }).toEqual(lookupResult("tlsLookupFails"));
    const bad = await outcome(f.tls.connect({ host: "h.invalid", port, lookup: answering([{ address: "not-an-ip", family: 4 }]) }));
    expect(bad.error).toBeInstanceOf(TypeError);
    expect({ name: field(bad.error, "name"), code: field(bad.error, "code"), message: field(bad.error, "message") }).toEqual(lookupResult("tlsLookupBadAddress"));
    let called = false;
    const literal = await outcome(f.tls.connect({ host: "127.0.0.1", port, lookup: () => { called = true; } }));
    expect({ called, code: field(literal.error, "code") }).toEqual(lookupResult("tlsLookupIpHost"));
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); }
}, 30000);
