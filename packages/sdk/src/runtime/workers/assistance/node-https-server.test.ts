import { Agent, get, request, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { controls, list, outcome } from "./node-controls.test-support.ts";
import type { EventEmitter } from "./node-streams.js";
import { createHttpsServers, type HttpsServer } from "./node-https-server.ts";
import { assistedServers, scriptedServers } from "./node-tls-server.test-support.ts";

// Recorded from node:24.18.1-alpine; the recorder and its throwaway identity are in the control file.
const control = controls("node-tls-server.controls.json");
const identity = record(control["identity"], "identity"), key = String(identity["key"]), cert = String(identity["cert"]);
const recorded = record(control["https"], "https"), instance = record(control["httpsInstance"], "httpsInstance");

function event(emitter: EventEmitter, name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const failed = (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))); };
    emitter.once(name, (...args: unknown[]) => { emitter.removeListener("error", failed); resolve(args); });
    if (name !== "error") emitter.once("error", failed);
  });
}
function field(value: unknown, name: string): unknown { const found: unknown = typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined; return found; }
async function listening(server: HttpsServer): Promise<number> {
  server.listen(0, "127.0.0.1"); await event(server, "listening");
  const port = field(server.address(), "port");
  if (typeof port !== "number") throw new Error("Missing server port");
  return port;
}
function fetched(options: RequestOptions): Promise<{ status: number | undefined; body: string; connection: string | undefined; localPort: number | undefined }> {
  return new Promise((resolve, reject) => {
    get(options, response => {
      let body = ""; const localPort = response.socket.localPort;
      response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      response.on("end", () => { resolve({ status: response.statusCode, body, connection: response.headers.connection, localPort }); });
    }).on("error", reject);
  });
}

it("has Node's shape: a tls.Server with HTTP's listener, timers and method names", () => {
  const f = scriptedServers(), http = { _connectionListener(this: unknown): void {} };
  const https = assistedServers(), functions = record(control["functions"], "functions");
  try {
    const { Server, createServer } = https.https, server = createServer();
    const listeners = field(server, "listeners"), found: unknown = typeof listeners === "function" ? Reflect.apply(listeners, server, ["secureConnection"]) : [], registered = list(found);
    expect([Server.name, Server.length]).toEqual(functions["https.Server"]);
    expect([createServer.name, createServer.length]).toEqual(functions["https.createServer"]);
    for (const name of ["setTimeout", "closeAllConnections", "closeIdleConnections", "close"]) {
      const method: unknown = Reflect.get(Server.prototype, name);
      expect(typeof method === "function" ? [method.name, method.length] : null, name).toEqual(functions[`https.Server#${name}`]);
    }
    expect({ isNet: server instanceof https.net.Server, isTls: server instanceof https.servers.Server, isHttp: server instanceof https.http.Server, isHttps: server instanceof Server, allowHalfOpen: server.allowHalfOpen,
      timeout: server.timeout, keepAliveTimeout: server.keepAliveTimeout, keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer, httpAllowHalfOpen: field(server, "httpAllowHalfOpen"),
      listenerCounts: { secureConnection: server.listenerCount("secureConnection"), tlsClientError: server.listenerCount("tlsClientError"), request: server.listenerCount("request") },
      secureListenerIsHttp: registered[0] === https.http._connectionListener, withListener: createServer(() => {}).listenerCount("request"), withOptionsListener: createServer({}, () => {}).listenerCount("request") })
      .toEqual({ isNet: instance["isNet"], isTls: instance["isTls"], isHttp: instance["isHttp"], isHttps: instance["isHttps"], allowHalfOpen: instance["allowHalfOpen"],
        timeout: instance["timeout"], keepAliveTimeout: instance["keepAliveTimeout"], keepAliveTimeoutBuffer: instance["keepAliveTimeoutBuffer"], httpAllowHalfOpen: instance["httpAllowHalfOpen"],
        listenerCounts: { secureConnection: 1, tlsClientError: 1, request: 0 }, secureListenerIsHttp: instance["secureListenerIsHttp"], withListener: instance["withListener"], withOptionsListener: instance["withOptionsListener"] });
    expect(outcome(() => createServer("x"))).toMatchObject({ error: { code: "ERR_INVALID_ARG_TYPE", message: "The \"options\" argument must be of type object. Received type string ('x')" } });
    for (const options of [{ requestTimeout: 1 }, { insecureHTTPParser: true }, { IncomingMessage: function IncomingMessage() { return undefined; } }]) expect(outcome(() => createServer(options))).toMatchObject({ error: { ctor: "VMError", code: "FEATURE_NOT_AVAILABLE" } });
    expect(createServer({ keepAliveTimeout: 9 }).keepAliveTimeout).toBe(9);
    // The HTTP listener still refuses a stream that no TLS server of this process accepted.
    expect(() => { Reflect.apply(https.http._connectionListener, server, [new Duplex()]); }).toThrow(TypeError);
    // HTTP/1.1 is the protocol an HTTPS server offers unless the program names others.
    createHttpsServers(f.servers, http).createServer({ key, cert }).listen(0);
    const staged = Buffer.concat(f.sent.flatMap(entry => entry.tag === 0 && entry.id === 0 ? [entry.bytes] : [])).toString();
    expect(record(record(JSON.parse(staged), "start")["options"], "options")).toMatchObject({ ALPNProtocols: ["http/1.1"], noDelay: true });
  } finally { https.dispose(); }
});

it("real helper: answers HTTPS requests on a kept-alive TLS connection, with the TLSSocket as req.socket", async () => {
  const f = assistedServers(), agent = new Agent({ keepAlive: true, ca: cert }), events: unknown[] = [];
  try {
    const server = f.https.createServer({ key, cert }, (...args: unknown[]) => {
      const [incoming, outgoing] = args, socket = field(incoming, "socket"), url = String(field(incoming, "url"));
      if (!(socket instanceof f.tls.TLSSocket)) throw new TypeError("Expected a TLSSocket");
      events.push({ kind: "request", encrypted: socket.encrypted, authorized: socket.authorized, url, socketCtor: socket.constructor.name, alpn: socket.alpnProtocol, sameServer: field(socket, "server") === server });
      if (!(outgoing instanceof f.http.ServerResponse)) throw new TypeError("Expected a ServerResponse");
      outgoing.sendDate = false; outgoing.setHeader("content-type", "text/plain"); outgoing.end(`secure ${url}`);
    });
    const port = await listening(server), options = { port, host: "127.0.0.1", servername: "localhost", agent };
    const first = await fetched({ ...options, path: "/a" }), second = await fetched({ ...options, path: "/b" });
    // Node negotiates no ALPN protocol with a client that offers none; this client offers none either.
    expect(events).toEqual(recorded["events"]);
    expect([first, second].map(({ status, body, connection }) => ({ status, body, connection }))).toEqual(recorded["responses"]);
    expect(first.localPort === second.localPort).toBe(recorded["reused"]);
    // close() retires the idle kept-alive connection, so 'close' follows without the client's help.
    const closed = event(server, "close"); server.close(); await closed;
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { agent.destroy(); f.dispose(); }
}, 20000);

it("real helper: streams a request body in and a large response out, and hands over an upgraded connection", async () => {
  const f = assistedServers();
  try {
    const body = Buffer.alloc(700 * 1024, 7);
    const server = f.https.createServer({ key, cert }, (...args: unknown[]) => {
      const [incoming, outgoing] = args; let size = 0;
      if (!(incoming instanceof f.http.IncomingMessage) || !(outgoing instanceof f.http.ServerResponse)) throw new TypeError("Expected HTTP messages");
      incoming.on("data", (chunk: unknown) => { if (chunk instanceof Uint8Array) size += chunk.length; });
      incoming.on("end", () => { outgoing.sendDate = false; outgoing.setHeader("x-received", String(size)); outgoing.end(body); });
    });
    server.on("upgrade", (...args: unknown[]) => {
      const socket = args[1];
      if (!(socket instanceof f.tls.TLSSocket)) throw new TypeError("Expected a TLSSocket");
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\nupgraded");
    });
    const port = await listening(server), options = { port, host: "127.0.0.1", servername: "localhost", ca: cert };
    const answer = await new Promise<{ received: unknown; size: number }>((resolve, reject) => {
      const outgoing = request({ ...options, method: "POST", path: "/upload" }, response => {
        let size = 0; response.on("data", (chunk: Buffer) => { size += chunk.length; });
        response.on("end", () => { resolve({ received: response.headers["x-received"], size }); });
      });
      outgoing.on("error", reject); outgoing.end(body);
    });
    expect(answer).toEqual({ received: String(body.length), size: body.length });
    const upgraded = await new Promise<string>((resolve, reject) => {
      const outgoing = request({ ...options, path: "/socket", headers: { connection: "Upgrade", upgrade: "echo" } });
      outgoing.on("error", reject);
      outgoing.on("upgrade", (_response, socket, head) => { let text = head.toString(); socket.on("data", (chunk: Buffer) => { text += chunk.toString(); }); socket.on("close", () => { resolve(text); }); socket.end(); });
      outgoing.end();
    });
    expect(upgraded).toBe("upgraded");
    const closed = event(server, "close"); server.close(); server.closeAllConnections(); await closed;
    expect(f.references()).toBe(0);
  } finally { f.dispose(); }
}, 30000);

it("real helper: a plain HTTP client is a 'clientError' with the destroyed TLSSocket", async () => {
  const f = assistedServers();
  try {
    const server = f.https.createServer({ key, cert }), port = await listening(server), failed = event(server, "clientError");
    const raw = netConnect(port, "127.0.0.1", () => { raw.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"); }); raw.on("error", () => {}); raw.resume();
    const hungUp = once(raw, "close"), [error, socket] = await failed; await hungUp;
    expect(field(error, "code")).toBe("ERR_SSL_HTTP_REQUEST");
    expect(socket instanceof f.tls.TLSSocket && socket.destroyed).toBe(true);
    const closed = event(server, "close"); server.close(); await closed;
  } finally { f.dispose(); }
}, 20000);
