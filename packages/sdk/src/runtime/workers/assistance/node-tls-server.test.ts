import { connect as netConnect } from "node:net";
import { connect, type TLSSocket as NodeTLSSocket } from "node:tls";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { controls, list, outcome, rows } from "./node-controls.test-support.ts";
import type { EventEmitter } from "./node-streams.js";
import type { TlsSocket } from "./node-tls.ts";
import { TLS_SERVER_WINDOW, tlsServerGuestArguments } from "./node-tls-server-guest.ts";
import type { TlsServer } from "./node-tls-server.ts";
import { decodeTlsServerEvent } from "./node-tls-server-wire.ts";
import { translatePeerCertificate } from "./node-tls-server-certificate.ts";
import { assistedServers, OPEN, scriptedServers } from "./node-tls-server.test-support.ts";

// Recorded from node:24.18.1-alpine (OpenSSL 3.5.7); the recorder and its throwaway identity are in the control file.
const control = controls("node-tls-server.controls.json");
const identity = record(control["identity"], "identity");
const key = String(identity["key"]), cert = String(identity["cert"]), clientKey = String(identity["clientKey"]), clientCert = String(identity["clientCert"]);
const scenarios = new Map(rows(control["scenarios"]).map(row => [String(row["name"]), row]));
const validation = record(control["validation"], "validation");

function event(emitter: EventEmitter, name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const failed = (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))); };
    emitter.once(name, (...args: unknown[]) => { emitter.removeListener("error", failed); resolve(args); });
    if (name !== "error") emitter.once("error", failed);
  });
}
function field(value: unknown, name: string): unknown { const found: unknown = typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined; return found; }
function call(target: object, name: string, args: readonly unknown[] = []): unknown {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new TypeError(`Missing ${name}`);
  const result: unknown = Reflect.apply(method, target, args); return result;
}
function secureSocket(servers: ReturnType<typeof assistedServers>, value: unknown): TlsSocket {
  if (!(value instanceof servers.tls.TLSSocket)) throw new TypeError("Expected the assisted TLSSocket");
  return value;
}
async function listening(server: TlsServer): Promise<number> {
  server.listen(0, "127.0.0.1"); await event(server, "listening");
  const port = field(server.address(), "port");
  if (typeof port !== "number") throw new Error("Missing server port");
  return port;
}
async function closed(server: TlsServer): Promise<void> { const done = event(server, "close"); server.close(); await done; }
async function received(socket: NodeTLSSocket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (bytes: Buffer) => { chunks.push(bytes); });
  await once(socket, "close");
  return Buffer.concat(chunks);
}
/** What the recorder kept of a server-side socket. */
function described(server: TlsServer, socket: TlsSocket): Record<string, unknown> {
  const peer = record(socket.getPeerCertificate(), "peer"), subject: unknown = peer["subject"];
  return { encrypted: socket.encrypted, authorized: socket.authorized, authorizationError: socket.authorizationError, alpnProtocol: socket.alpnProtocol, servername: socket.servername,
    protocol: socket.getProtocol(), cipher: socket.getCipher(), peerKeys: Object.keys(peer).sort(), peerSubject: typeof subject === "object" && subject !== null ? { ...subject } : null,
    remoteAddress: socket.remoteAddress, remoteFamily: socket.remoteFamily, localAddress: socket.localAddress, localPortIsServer: socket.localPort === field(server.address(), "port"),
    ctor: socket.constructor.name, isTLSSocket: true, allowHalfOpen: field(socket, "allowHalfOpen"), pending: socket.pending, connecting: socket.connecting, hasServer: field(socket, "server") === server };
}
async function scenario(name: string, serverOptions: object, clientOptions: object): Promise<void> {
  const f = assistedServers(), recorded = scenarios.get(name), events: unknown[] = [];
  if (recorded === undefined) throw new Error(`Missing scenario ${name}`);
  try {
    const server = f.servers.createServer(serverOptions);
    for (const kind of ["listening", "close"]) server.on(kind, () => { events.push({ kind }); });
    server.on("secureConnection", (...args: unknown[]) => {
      const socket = secureSocket(f, args[0]);
      events.push({ kind: "secureConnection", socket: described(server, socket), argc: args.length }); socket.on("error", () => {}); socket.end("hello");
    });
    server.on("tlsClientError", (...args: unknown[]) => {
      const error = args[0], socket = secureSocket(f, args[1]);
      events.push({ kind: "tlsClientError", error: error instanceof Error ? { name: error.name, ctor: error.constructor.name, code: field(error, "code"), message: error.message } : null,
        socketCtor: socket.constructor.name, isTLS: true, destroyed: socket.destroyed, argc: args.length });
    });
    const port = await listening(server);
    const client = connect({ port, host: "127.0.0.1", ...clientOptions }); client.on("error", () => {});
    const data = await received(client);
    const expectedClient = record(recorded["client"], "client");
    expect(data.toString()).toBe(expectedClient["data"]);
    await closed(server);
    // Node also emits 'connection' with the raw net.Socket, which stays in Linux here.
    expect(events).toEqual(list(recorded["events"]).filter(entry => record(entry, "event")["kind"] !== "connection"));
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); }
}

it("was recorded from pinned Node", () => { expect(record(control["node"], "node")["version"]).toBe("v24.18.1"); });

it("keeps keys and certificates off the helper's command line", () => {
  const f = scriptedServers();
  f.servers.createServer({ key, cert }).listen(0, "127.0.0.1");
  expect(f.spawned).toEqual([tlsServerGuestArguments()]);
  expect(f.spawned.flat().join("")).not.toContain("PRIVATE KEY");
  const staged = Buffer.concat(f.sent.flatMap(entry => entry.tag === 0 && entry.id === 0 ? [entry.bytes] : [])).toString();
  expect(record(JSON.parse(staged), "start")).toEqual({ options: { handshakeTimeout: 120000, requestCert: false, rejectUnauthorized: true, key: { t: "s", v: key }, cert: { t: "s", v: cert } }, contexts: [], listen: { port: 0, host: "127.0.0.1" } });
  expect(f.controls()).toEqual([{ kind: "start" }]);
});

it("has Node's export shapes and argument checks", () => {
  const f = scriptedServers(), functions = record(control["functions"], "functions"), { Server, createServer } = f.servers;
  expect([Server.name, Server.length]).toEqual(functions["tls.Server"]);
  expect([createServer.name, createServer.length]).toEqual(functions["tls.createServer"]);
  for (const name of ["listen", "close", "address", "getConnections", "ref", "unref", "setSecureContext", "addContext", "getTicketKeys", "setTicketKeys"]) {
    const method: unknown = Reflect.get(Server.prototype, name);
    expect(typeof method === "function" ? [method.name, method.length] : null, name).toEqual(functions[`tls.Server#${name}`]);
  }
  const instance = record(control["instance"], "instance"), server = createServer();
  expect({ isNet: server instanceof f.servers.Server, listening: server.listening, address: server.address(), allowHalfOpen: server.allowHalfOpen, requestCert: server.requestCert, rejectUnauthorized: server.rejectUnauthorized,
    ticketKeysLength: server.getTicketKeys().length, withListener: createServer(() => {}).listenerCount("secureConnection"), withOptionsListener: createServer({}, () => {}).listenerCount("secureConnection") })
    .toEqual({ isNet: instance["isNet"], listening: instance["listening"], address: instance["address"], allowHalfOpen: instance["allowHalfOpen"], requestCert: instance["requestCert"], rejectUnauthorized: instance["rejectUnauthorized"],
      ticketKeysLength: instance["ticketKeysLength"], withListener: instance["withListener"], withOptionsListener: instance["withOptionsListener"] });
  const calls: Record<string, () => unknown> = {
    createString: () => { createServer("x"); return "ok"; }, createNumber: () => { createServer(5); return "ok"; }, createNull: () => { createServer(null); return "ok"; },
    badHandshakeTimeout: () => { createServer({ handshakeTimeout: "x" }); return "ok"; }, badSessionTimeout: () => { createServer({ sessionTimeout: "x" }); return "ok"; },
    badTicketKeysOption: () => { createServer({ ticketKeys: Buffer.alloc(3) }); return "ok"; }, badTicketKeysType: () => { createServer({ ticketKeys: "x" }); return "ok"; },
    badALPN: () => { createServer({ ALPNProtocols: ["a"], ALPNCallback() {} }); return "ok"; }, badSNI: () => { createServer({ SNICallback: 5 }); return "ok"; }, badPsk: () => { createServer({ pskCallback: 5 }); return "ok"; },
    setTicketKeysShort: () => { createServer().setTicketKeys(Buffer.alloc(3)); return "ok"; }, setTicketKeysString: () => { createServer().setTicketKeys("x"); return "ok"; },
    setTicketKeysOk: () => { const made = createServer(), keys = Buffer.alloc(48, 7); return [call(made, "setTicketKeys", [keys]) === undefined, made.getTicketKeys().equals(keys), made.getTicketKeys() === keys]; },
    setSecureContextString: () => { createServer().setSecureContext("x"); return "ok"; }, setSecureContextNone: () => { call(createServer(), "setSecureContext"); return "ok"; },
    setSecureContextOk: () => call(createServer(), "setSecureContext", [{ key, cert }]) === undefined,
    addContextNoHost: () => { call(createServer(), "addContext"); return "ok"; }, addContextOk: () => call(createServer(), "addContext", ["a.example", { key, cert }]) === undefined,
    addContextNoContext: () => call(createServer(), "addContext", ["a.example"]) === undefined,
    listenBadPort: () => { createServer().listen(70000); return "ok"; }, listenNegative: () => { createServer().listen(-1); return "ok"; }, listenEmptyObject: () => { createServer().listen({}); return "ok"; },
    listenBool: () => { createServer().listen(true); return "ok"; }, getConnectionsNoCallback: () => { call(createServer(), "getConnections"); return "ok"; },
    closeBadCallback: () => { const made = createServer(); return made.close(5) === made; }, refReturns: () => { const made = createServer(); return [made.ref() === made, made.unref() === made]; },
    listenTwice: () => { const made = createServer({ key, cert }); made.listen(0); made.listen(0); return "ok"; },
  };
  for (const [name, call] of Object.entries(calls)) {
    const expected = record(validation[name], name), error = expected["error"];
    expect(outcome(call), name).toEqual(error === undefined ? expected : { error: { name: record(error, name)["name"], code: record(error, name)["code"], message: record(error, name)["message"], ctor: record(error, name)["ctor"] } });
  }
  expect(f.references()).toBe(1);
});

it("refuses what needs the program's code or raw socket inside the guest's handshake", () => {
  const { createServer } = scriptedServers().servers;
  for (const options of [{ SNICallback() {} }, { ALPNCallback() {} }, { pskCallback() {} }, { enableTrace: true }, { pauseOnConnect: true }, { highWaterMark: 1 }, { allowPartialTrustChain: true }]) {
    expect(outcome(() => createServer(options)), Object.keys(options).join()).toMatchObject({ error: { ctor: "VMError", code: "FEATURE_NOT_AVAILABLE" } });
  }
  for (const args of [["/tmp/tls.sock"], [{ path: "/tmp/tls.sock" }], [{ fd: 3 }], [{ port: 0, signal: new AbortController().signal }]]) {
    expect(outcome(() => createServer().listen(...args))).toMatchObject({ error: { ctor: "VMError", code: "FEATURE_NOT_AVAILABLE" } });
  }
  expect(() => createServer().listen({ port: 0 }, () => {})).not.toThrow();
});

it("decodes exact bounded helper events", () => {
  const decode = (value: unknown) => decodeTlsServerEvent(new TextEncoder().encode(JSON.stringify(value)));
  expect(decode({ ...OPEN, id: 1 })).toMatchObject({ kind: "open", id: 1, peer: null, secure: { kind: "secure", authorized: false, authorizationError: null, servername: "localhost", remotePort: 50000 } });
  expect(decode({ ...OPEN, id: 1, peer: { subject: { CN: "client" }, raw: { base64: "AQID" }, ca: true } })).toMatchObject({ peer: { subject: { CN: "client" }, raw: Buffer.from([1, 2, 3]), ca: true } });
  expect(decode({ kind: "error", error: { code: "EADDRINUSE", message: "listen EADDRINUSE", errno: -98, syscall: "listen", address: "127.0.0.1", port: 1 } })).toMatchObject({ error: { errno: -98, port: 1 } });
  for (const value of [{ ...OPEN, id: 0 }, { ...OPEN, id: 1, authorized: true, authorizationError: "X" }, { ...OPEN, id: 1, protocol: "SSLv3" }, { ...OPEN, id: 1, ignored: 1 }, { kind: "written", id: 1, count: 65533 },
    { kind: "conn-close", id: 1 }, { kind: "listening", address: "127.0.0.1", port: 1, family: "IPv6" }, { kind: "error", error: { code: "E", message: "m", extra: 1 } }, { kind: "unrecognized" }]) {
    expect(() => decode(value)).toThrow(VMError);
  }
});

it("reads a connection only as fast as the program takes its plaintext", async () => {
  const f = scriptedServers(), server = f.servers.createServer({ key, cert });
  server.listen(8443, "127.0.0.1");
  f.event({ kind: "listening", address: "127.0.0.1", port: 8443, family: "IPv4" });
  const accepted = event(server, "secureConnection");
  f.event({ ...OPEN, id: 1 });
  const socket = f.tls.TLSSocket; const [value] = await accepted;
  if (!(value instanceof socket)) throw new TypeError("Expected a TLSSocket");
  expect(f.controls().slice(1)).toEqual([{ kind: "accept", id: 1 }]);
  // The stream holds one 64 KiB mark; the rest of the window stays unacknowledged until the program reads.
  const chunk = Buffer.alloc(32768, 1);
  for (let sent = 0; sent < TLS_SERVER_WINDOW; sent += chunk.length) f.data(1, chunk);
  await f.settle();
  const acknowledged = () => f.controls().reduce((sum, entry) => sum + (entry["kind"] === "ack" ? Number(entry["count"]) : 0), 0);
  expect(acknowledged()).toBe(32768); expect(value.readableLength).toBe(TLS_SERVER_WINDOW); expect(value.bytesRead).toBe(TLS_SERVER_WINDOW);
  let taken = 0;
  value.on("data", (bytes: unknown) => { if (bytes instanceof Uint8Array) taken += bytes.length; });
  await f.settle();
  expect(taken).toBe(TLS_SERVER_WINDOW); expect(acknowledged()).toBe(TLS_SERVER_WINDOW);
  // One write frame is in flight at a time, and its callback waits for the helper's acknowledgement.
  let written = false;
  value.write(Buffer.alloc(70000, 2), () => { written = true; });
  await f.settle();
  const frames = () => f.sent.flatMap(entry => entry.tag === 0 && entry.id === 1 ? [entry.bytes.length] : []);
  expect(frames()).toEqual([65532]); expect(written).toBe(false);
  f.event({ kind: "written", id: 1, count: 65532 }); await f.settle();
  expect(frames()).toEqual([65532, 4468]); expect(written).toBe(false);
  f.event({ kind: "written", id: 1, count: 4468 }); await f.settle();
  expect(written).toBe(true); expect(value.bytesWritten).toBe(70000);
  value.destroy(); await f.settle();
  expect(f.controls().at(-1)).toEqual({ kind: "destroy", id: 1 });
});

it("reports a helper that dies as 'error' then 'close', and destroys its connections", async () => {
  const f = scriptedServers(), server = f.servers.createServer({ key, cert }), events: string[] = [];
  server.listen(8443, "127.0.0.1");
  f.event({ kind: "listening", address: "127.0.0.1", port: 8443, family: "IPv4" });
  const accepted = event(server, "secureConnection");
  f.event({ ...OPEN, id: 1 });
  const [value] = await accepted;
  if (!(value instanceof f.tls.TLSSocket)) throw new TypeError("Expected a TLSSocket");
  value.on("error", (error: unknown) => { events.push(`socket error ${String(field(error, "code"))}`); }); value.on("close", () => { events.push("socket close"); });
  server.on("error", (error: unknown) => { events.push(`error ${String(field(error, "code"))}`); }); server.on("close", () => { events.push("close"); });
  expect(f.references()).toBe(2);
  f.exit(1, null); await f.settle();
  expect(events).toEqual(["error ERR_TLS_BRIDGE_EOF", "close", "socket error ERR_TLS_BRIDGE_EOF", "socket close"]);
  expect(server.listening).toBe(false); expect(server.address()).toBeNull(); expect(f.references()).toBe(0); expect(f.killed()).toBe(true);
});

it("kills a helper that breaks the protocol", async () => {
  const f = scriptedServers(), server = f.servers.createServer({ key, cert }), failed = event(server, "error");
  server.listen(8443, "127.0.0.1");
  f.event({ kind: "listening", address: "127.0.0.1", port: 8443, family: "IPv4" });
  f.data(7, Buffer.from("stray"));
  const [error] = await failed;
  expect(error).toBeInstanceOf(VMError); expect(f.killed()).toBe(true); expect(f.references()).toBe(0);
});

it("keeps the process alive while listening unless unreferenced", async () => {
  const f = scriptedServers(), server = f.servers.createServer({ key, cert });
  expect(f.references()).toBe(0);
  server.listen(8443); expect(f.references()).toBe(1);
  server.unref(); expect(f.references()).toBe(0);
  server.ref(); server.ref(); expect(f.references()).toBe(1);
  f.event({ kind: "listening", address: "::", port: 8443, family: "IPv6" }); await f.settle();
  expect(server.address()).toEqual({ address: "::", family: "IPv6", port: 8443 });
  const order: unknown[] = [];
  server.on("close", () => { order.push(["close"]); });
  server.close((error?: unknown) => { order.push(["callback", error === undefined ? "undefined" : "error"]); }); order.unshift(["listening-after-close", server.listening]);
  expect(f.controls().at(-1)).toEqual({ kind: "close" });
  f.event({ kind: "closed" }); f.event({ kind: "done" }); await f.settle(); f.exit(0, null); await f.settle();
  expect(order).toEqual([["listening-after-close", false], ["close"], ["callback", "undefined"]]);
  expect(f.references()).toBe(0);
});

it("answers close() on a server that is not running as Node does", async () => {
  const f = scriptedServers(), server = f.servers.createServer(), order: unknown[] = [];
  server.on("close", () => { order.push(["close"]); });
  server.close((error?: unknown) => { order.push(["callback", error instanceof Error ? { name: error.name, ctor: error.constructor.name, code: field(error, "code"), message: error.message } : error]); });
  order.push(["sync"]); await f.settle();
  expect(order).toEqual(validation["closeNotRunning"]);
});

for (const [name, serverOptions, clientOptions] of [
  ["plain", { key, cert }, { ca: cert, servername: "localhost" }],
  ["alpn", { key, cert, ALPNProtocols: ["h2", "http/1.1"] }, { ca: cert, servername: "localhost", ALPNProtocols: ["http/1.1"] }],
  ["no-sni", { key, cert }, { rejectUnauthorized: false }],
  ["request-cert-trusted", { key, cert, requestCert: true, ca: clientCert }, { ca: cert, servername: "localhost", key: clientKey, cert: clientCert }],
  ["request-cert-untrusted-allowed", { key, cert, requestCert: true, rejectUnauthorized: false }, { ca: cert, servername: "localhost", key: clientKey, cert: clientCert }],
  ["request-cert-missing-allowed", { key, cert, requestCert: true, rejectUnauthorized: false }, { ca: cert, servername: "localhost" }],
  ["request-cert-untrusted-rejected", { key, cert, requestCert: true }, { ca: cert, servername: "localhost", key: clientKey, cert: clientCert }],
  ["tls12", { key, cert, maxVersion: "TLSv1.2" }, { ca: cert, servername: "localhost" }],
] as const) {
  it(`real helper: ${name} handshake gives the socket Node's server gives`, async () => { await scenario(name, serverOptions, clientOptions); }, 20000);
}

it("real helper: a client that does not speak TLS is a 'tlsClientError'", async () => {
  const f = assistedServers();
  try {
    const server = f.servers.createServer({ key, cert }), port = await listening(server);
    for (const [name, bytes] of [["garbage", Buffer.alloc(64, 0x41)], ["http", Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n")]] as const) {
      const failed = event(server, "tlsClientError"), raw = netConnect(port, "127.0.0.1", () => { raw.write(bytes); });
      raw.on("error", () => {}); raw.resume();
      const [error, socket] = await failed; raw.destroy();
      const recorded = record(record(list(record(scenarios.get(name) ?? {}, name)["events"])[2], "event")["error"], "error");
      expect({ code: field(error, "code"), library: field(error, "library"), reason: field(error, "reason") }).toEqual({ code: recorded["code"], library: recorded["library"], reason: recorded["reason"] });
      expect(error).toBeInstanceOf(Error); expect(secureSocket(f, socket).destroyed).toBe(true);
    }
    await closed(server); expect(f.references()).toBe(0);
  } finally { f.dispose(); }
}, 20000);

it("real helper: megabytes flow both ways under backpressure, and close() waits for open connections", async () => {
  const f = assistedServers();
  try {
    const server = f.servers.createServer({ key, cert }), upload = Buffer.alloc(3 * 1024 * 1024, 5), download = Buffer.alloc(2 * 1024 * 1024, 6), taken: Uint8Array[] = [];
    const order: string[] = [];
    server.on("secureConnection", (value: unknown) => {
      const socket = secureSocket(f, value);
      socket.pause();
      // The client's megabytes wait in Linux while the program does not read.
      setTimeout(() => { expect(socket.readableLength).toBeLessThanOrEqual(65536 + TLS_SERVER_WINDOW); socket.on("data", (bytes: unknown) => { if (bytes instanceof Uint8Array) taken.push(bytes); }); socket.resume(); }, 300);
      socket.on("end", () => { order.push("socket end"); socket.end(download); });
      socket.on("close", () => { order.push("socket close"); });
    });
    server.on("close", () => { order.push("server close"); });
    const port = await listening(server);
    const client = connect({ port, host: "127.0.0.1", ca: cert, servername: "localhost" }), response = received(client);
    await Promise.all([once(client, "secureConnect"), event(server, "secureConnection")]);
    const counted = await new Promise<unknown[]>(resolve => { server.getConnections((...args: unknown[]) => { resolve(args); }); });
    expect(counted).toEqual([null, 1]);
    server.close(); expect(server.listening).toBe(false);
    client.end(upload);
    expect((await response).equals(download)).toBe(true);
    if (!order.includes("server close")) await event(server, "close");
    expect(Buffer.concat(taken).equals(upload)).toBe(true);
    expect(order).toEqual(["socket end", "socket close", "server close"]);
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); }
}, 30000);

it("real helper: a port in use and a key OpenSSL refuses are 'error' events in Node's shape", async () => {
  const f = assistedServers();
  try {
    const first = f.servers.createServer({ key, cert }), port = await listening(first);
    const second = f.servers.createServer({ key, cert }), failed = event(second, "error");
    second.listen(port, "127.0.0.1");
    const [error] = await failed, recorded = record(record(validation["addressInUse"], "addressInUse")["error"], "error");
    if (!(error instanceof Error)) throw new TypeError("Expected an error");
    expect({ name: error.name, ctor: error.constructor.name, code: field(error, "code"), errno: field(error, "errno"), syscall: field(error, "syscall"), address: field(error, "address"), port: field(error, "port") })
      .toEqual({ name: recorded["name"], ctor: recorded["ctor"], code: recorded["code"], errno: recorded["errno"], syscall: recorded["syscall"], address: recorded["address"], port });
    expect(error.message).toBe(`listen EADDRINUSE: address already in use 127.0.0.1:${String(port)}`); expect(second.listening).toBe(false);
    const bad = f.servers.createServer({ key: "garbage", cert }), refused = event(bad, "error");
    bad.listen(0, "127.0.0.1");
    const [unsupported] = await refused, badKey = record(record(validation["badKey"], "badKey")["error"], "error");
    expect({ code: field(unsupported, "code"), message: field(unsupported, "message"), library: field(unsupported, "library"), reason: field(unsupported, "reason") })
      .toEqual({ code: badKey["code"], message: badKey["message"], library: badKey["library"], reason: badKey["reason"] });
    await closed(first);
    await new Promise<void>(resolve => { setTimeout(resolve, 200); });
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); }
}, 20000);

it("real helper: setSecureContext and addContext change what a listening server presents", async () => {
  const f = assistedServers();
  try {
    const server = f.servers.createServer({ key, cert }), port = await listening(server);
    server.on("secureConnection", (value: unknown) => { secureSocket(f, value).end("ok"); });
    const subject = async (servername: string): Promise<unknown> => {
      const client = connect({ port, host: "127.0.0.1", rejectUnauthorized: false, servername }); await once(client, "secureConnect");
      const name: unknown = client.getPeerCertificate().subject.CN; client.resume(); await once(client, "close"); return name;
    };
    expect(await subject("localhost")).toBe("localhost");
    server.addContext("other.example", { key: clientKey, cert: clientCert });
    server.setSecureContext({ key: [{ pem: Buffer.from(clientKey) }], cert: Buffer.from(clientCert) });
    // The helper applies the change when it reads it, not within the call as Node does.
    const settled = async (expected: string): Promise<string> => { for (let attempt = 0; attempt < 50; attempt++) if (await subject("localhost") === expected) return expected; return "unchanged"; };
    expect(await settled("client")).toBe("client");
    server.setSecureContext({ key, cert });
    expect([await settled("localhost"), await subject("other.example")]).toEqual(["localhost", "client"]);
    await closed(server); expect(f.references()).toBe(0);
  } finally { f.dispose(); }
}, 20000);

it("translates a legacy certificate's infoAccess as _tls_common does", () => {
  const shown = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(shown);
    return { ...(Object.getPrototypeOf(value) === null ? { __null: true } : {}), ...Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shown(item)])) };
  };
  const cases: Record<string, unknown[]> = { none: [], nullish: [null], zero: [0], empty: [{}], plain: [{ subject: "CN=a", n: 1 }],
    info: [{ infoAccess: "OCSP - URI:http://o.example/\nCA Issuers - URI:http://c.example/a\nOCSP - URI:http://o2.example/\n" }],
    quoted: [{ infoAccess: "OCSP - URI:\"http://o.example/\\u0041\"\n" }], infoEmpty: [{ infoAccess: "" }], infoNoNewline: [{ infoAccess: "a:b" }],
    issuer: [{ subject: "s", issuerCertificate: { subject: "i", infoAccess: "k:v\n" } }] };
  const recorded = record(record(control["translatePeerCertificate"], "translatePeerCertificate")["rows"], "rows");
  for (const [name, args] of Object.entries(cases)) {
    const made = translatePeerCertificate(...args);
    expect({ value: shown(made), same: made === args[0] }, name).toEqual(recorded[name]);
  }
  const self: Record<string, unknown> = { subject: "s" }; self["issuerCertificate"] = self;
  expect(translatePeerCertificate(self)).toBe(self); expect(self["issuerCertificate"]).toBe(self);
  expect([translatePeerCertificate.name, translatePeerCertificate.length]).toEqual(record(control["functions"], "functions")["_tls_common.translatePeerCertificate"]);
});
