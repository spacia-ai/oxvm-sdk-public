import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets, type NodeSocket } from "./node-socket.js";
import { createHttpAgents, type AgentRequest, type HttpAgent } from "./node-http-agent.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";

/** Recorded from Node v24.18.1; the recorders are embedded in the file. JSON writes Infinity as null. */
const controls: unknown = JSON.parse(readFileSync(new URL("node-http-agent.controls.json", import.meta.url), "utf8"));
function recorded(...path: string[]): unknown {
  let value: unknown = controls;
  for (const key of path) value = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (value === undefined) throw new Error(`Missing control ${path.join(".")}`);
  return value;
}
const agentResult = (key: string): unknown => recorded("agent", "results", key);
function recordedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Control is not an object");
  return Object.fromEntries(Object.entries(value));
}
function recordedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Control is not a list");
  return value.filter((entry: unknown): entry is string => typeof entry === "string");
}
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const read = (target: unknown, key: string): unknown => typeof target === "object" && target !== null || typeof target === "function" ? Reflect.get(target, key) : undefined;

function sockets() {
  const context = createAsyncContext(); const operations: AssistanceOperation[] = []; let id = 0;
  const readers = new Map<number, PromiseWithResolvers<AssistanceResult>>();
  const net = createNodeSockets({ retain: () => () => {},
    callSync(operation) { operations.push(operation); return { kind: "unit" }; },
    call(operation) {
      operations.push(operation);
      if (operation.kind === "socket-connect-local") return Promise.resolve({ kind: "socket", fd: ++id, local: { address: "127.0.0.1", port: 1000 + id }, peer: operation.address });
      if (operation.kind === "socket-read") {
        const read = Promise.withResolvers<AssistanceResult>(); readers.set(operation.fd, read); return read.promise;
      }
      if (operation.kind === "socket-close") readers.get(operation.fd)?.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    },
  }, context);
  return { context, net, operations, count: () => id };
}
/** A request as the agent sees one: what ClientRequest gives it, and a socket it marks for reuse after its response. */
function requestThrough(agent: HttpAgent, options: Record<string, unknown>, host?: string) {
  const assigned = Promise.withResolvers<NodeSocket>();
  const request: AgentRequest & { getHeader(name: string): unknown } = { reusedSocket: false,
    getHeader: name => name === "host" ? host : undefined,
    onSocket(socket, error) {
      if (error) assigned.reject(error);
      else if (socket) { Reflect.set(socket, "_httpMessage", { shouldKeepAlive: true }); assigned.resolve(socket); }
      else assigned.reject(new Error("Socket missing"));
    } };
  agent.addRequest(request, options);
  return { request, assigned: assigned.promise };
}
function agents() {
  const f = sockets(); const http = createHttpAgents(f.net, f.context);
  const createConnection = vi.fn<(...args: unknown[]) => NodeSocket>(() => f.net.createConnection({ host: "127.0.0.1", port: 3000 }));
  return { ...f, http, https: createHttpAgents({ createConnection }, f.context, "https:", http.Agent), createConnection };
}
const lateFailure = (subject: string): unknown => expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject } });
const connected = (socket: NodeSocket) => socket.connecting ? new Promise(resolve => socket.once("connect", resolve)) : Promise.resolve();

it("has Node's own properties, methods, defaults and connection names", () => {
  const { http, https } = agents();
  const plain = new http.Agent(), secure = new https.Agent();
  // The EventEmitter's own bookkeeping keys (_events and the like) are left out: they belong to the emitter, not the agent.
  expect(Object.keys(plain).filter(key => !key.startsWith("_")).sort()).toEqual(recordedStrings(agentResult("ownKeys")).filter(key => !key.startsWith("_")));
  expect(Object.getOwnPropertyNames(http.Agent.prototype).sort()).toEqual(agentResult("protoKeys"));
  const lengths = recordedObject(agentResult("lengths"));
  expect(Object.fromEntries(Object.keys(lengths).map(name => { const method: unknown = Reflect.get(http.Agent.prototype, name); return [name, typeof method === "function" ? method.length : undefined]; }))).toEqual(lengths);
  expect(read(read(read(https.Agent, "prototype"), "createConnection"), "length")).toBe(agentResult("secureCreateConnectionLength"));
  expect(http.Agent.name).toBe("Agent"); expect(https.Agent.name).toBe("Agent");
  expect(secure).toBeInstanceOf(http.Agent);
  expect(json({ maxSockets: plain.maxSockets, maxTotalSockets: plain.maxTotalSockets, maxFreeSockets: plain.maxFreeSockets, keepAliveMsecs: plain.keepAliveMsecs,
    keepAlive: plain.keepAlive, scheduling: plain.scheduling, total: plain.totalSocketCount, optionKeys: Object.keys(plain.options), noDelay: plain.options["noDelay"],
    path: plain.options["path"], httpsOptionKeys: Object.keys(secure.options), maxCachedSessions: read(secure, "maxCachedSessions"), defaultPort: secure.defaultPort })).toEqual(agentResult("defaults"));
  expect(Object.getPrototypeOf(plain.sockets)).toBe(null); expect(Object.getPrototypeOf(plain.options)).toBe(null);
  expect({ http: plain.getName({ host: "a.test", port: 80 }), httpFamily: plain.getName({ host: "a.test", port: 80, family: 6, localAddress: "::1" }),
    https: secure.getName({ host: "a.test", port: 443, servername: "b.test", rejectUnauthorized: false }), httpsEmpty: secure.getName({}) }).toEqual(agentResult("names"));
  plain.destroy(); secure.destroy();
});

it("validates scheduling and maxTotalSockets as Node does and keeps the other options as given", () => {
  const { http } = agents();
  for (const value of [{ scheduling: "x" }, { maxTotalSockets: 0 }, { maxTotalSockets: "3" }, { maxTotalSockets: null }, { keepAlive: "yes" }, { maxSockets: 0 }, { maxSockets: -1 }]) {
    const expected = agentResult(`ctor ${JSON.stringify(value)}`);
    let actual: unknown;
    try { const agent = new http.Agent(value); actual = json({ maxSockets: agent.maxSockets, keepAlive: agent.keepAlive, maxTotalSockets: agent.maxTotalSockets }); }
    catch (error) { actual = error instanceof Error ? { name: error.name, code: read(error, "code"), message: error.message } : error; }
    expect(actual).toEqual(expected);
  }
});

it("asks a subclass's createSocket for each connection and hands createConnection Node's option bag", async () => {
  const f = agents(); const calls: Record<string, unknown> = {};
  class Spy extends f.http.Agent {
    override createSocket(...args: Parameters<HttpAgent["createSocket"]>): void {
      const [request, options, callback] = args; const proto: unknown = Object.getPrototypeOf(options);
      calls["createSocket"] = { argc: args.length, keys: Object.keys(options).sort(), proto, servername: options["servername"], keepAlive: options["keepAlive"], path: options["path"] };
      super.createSocket(request, options, callback);
    }
    override createConnection(...args: unknown[]): NodeSocket | undefined {
      const options = args[0];
      calls["createConnection"] = { argc: args.length, cbType: typeof args[1], keys: typeof options === "object" && options !== null ? Object.keys(options).sort() : [] };
      return super.createConnection(...args);
    }
  }
  const spy = new Spy({ keepAlive: true, maxSockets: 2 });
  const first = requestThrough(spy, { host: "127.0.0.1", port: 3000, agent: spy, path: "/x", headers: { "x-a": "1" } }, "127.0.0.1:3000");
  const socket = await first.assigned; await connected(socket);
  // The recorded request was Node's ClientRequest; this one is the agent's view of one.
  const created = Object.fromEntries(Object.entries(recordedObject(agentResult("createSocketArgs"))).filter(([name]) => name !== "reqIsRequest"));
  expect(calls["createSocket"]).toEqual(created);
  expect(calls["createConnection"]).toEqual(agentResult("createConnectionArgs"));
  expect(spy.totalSocketCount).toBe(1); expect(spy.sockets["127.0.0.1:3000:"]).toEqual([socket]);
  socket.emit("free");
  expect(Object.keys(spy.freeSockets)).toEqual(["127.0.0.1:3000:"]); expect(Object.keys(spy.requests)).toEqual([]);
  const second = requestThrough(spy, { host: "127.0.0.1", port: 3000 });
  expect(await second.assigned).toBe(socket); expect(second.request.reusedSocket).toBe(true); expect(f.count()).toBe(1);
  spy.destroy();
});

it("takes a socket or an error that a subclass's createConnection delivers later through its callback", async () => {
  const f = agents();
  class Later extends f.http.Agent {
    override createConnection(...args: unknown[]): undefined {
      const done = args[1]; if (typeof done !== "function") throw new Error("Missing callback");
      queueMicrotask(() => { Reflect.apply(done, undefined, [null, f.net.createConnection({ host: "127.0.0.1", port: 3000 })]); });
      return undefined;
    }
  }
  class Fails extends f.http.Agent {
    override createConnection(...args: unknown[]): undefined {
      const done = args[1]; if (typeof done !== "function") throw new Error("Missing callback");
      queueMicrotask(() => { Reflect.apply(done, undefined, [Object.assign(new Error("nope"), { code: "EBOOM" })]); });
      return undefined;
    }
  }
  const later = new Later(); const socket = await requestThrough(later, { host: "127.0.0.1", port: 3000 }).assigned;
  expect(later.sockets["127.0.0.1:3000:"]).toEqual([socket]); expect(later.totalSocketCount).toBe(1);
  const error: unknown = await requestThrough(new Fails(), { host: "127.0.0.1", port: 3000 }).assigned.catch((failure: unknown) => failure);
  expect(error).toMatchObject(recordedObject(recordedObject(agentResult("callbackError"))["error"]));
  later.destroy();
});

it("keeps a registry a subclass may write, as agent-base does with its placeholder sockets", () => {
  const f = agents(); const agent = new f.http.Agent({ maxSockets: 15 });
  agent.sockets["x:1:"] ??= []; const placeholder = new f.net.Socket({ writable: false });
  agent.sockets["x:1:"].push(placeholder); agent.totalSocketCount++;
  expect({ pushed: agent.sockets["x:1:"].length, total: agent.totalSocketCount, fakeWritable: read(placeholder, "writable"), fakeReadable: read(placeholder, "readable"),
    fakeConnecting: placeholder.connecting, fakeDestroyed: placeholder.destroyed }).toEqual(agentResult("agentBase"));
  agent.sockets["x:1:"].splice(0, 1); agent.totalSocketCount--; Reflect.deleteProperty(agent.sockets, "x:1:");
  expect({ keys: Object.keys(agent.sockets), total: agent.totalSocketCount }).toEqual(agentResult("agentBaseAfter"));
  class Throws extends f.http.Agent {
    override createSocket(_request: AgentRequest, _options: Record<string, unknown>, callback: Parameters<HttpAgent["createSocket"]>[2]): void { callback(Object.assign(new Error("refused"), { code: "EREFUSED" })); }
  }
  return expect(requestThrough(new Throws(), { host: "127.0.0.1", port: 3000 }).assigned).rejects.toMatchObject(recordedObject(recordedObject(agentResult("createSocketError"))["error"]));
});

it("queues at maxSockets in its requests registry and hands the queued request the freed socket", async () => {
  const f = agents(); const agent = new f.http.Agent({ maxSockets: 1, keepAlive: true });
  const first = requestThrough(agent, { host: "127.0.0.1", port: 3000 }); const socket = await first.assigned; await connected(socket);
  const second = requestThrough(agent, { host: "127.0.0.1", port: 3000 });
  expect({ requestKeys: Object.keys(agent.requests), queuedLength: agent.requests["127.0.0.1:3000:"]?.length, total: agent.totalSocketCount })
    .toEqual({ ...recordedObject(agentResult("queued")), requestKeys: ["127.0.0.1:3000:"] });
  socket.emit("free");
  expect(await second.assigned).toBe(socket); expect(f.count()).toBe(1); expect(Object.keys(agent.requests)).toEqual([]);
  socket.emit("free");
  expect(f.operations).toContainEqual({ kind: "socket-keepalive", fd: 1, enabled: true, delaySeconds: 1 });
  expect(agent.freeSockets["127.0.0.1:3000:"]).toEqual([socket]);
  socket.destroy(); await new Promise(resolve => socket.once("close", resolve));
  expect(agent.totalSocketCount).toBe(0); expect(Object.keys(agent.freeSockets)).toEqual([]);
});

it("passes a lookup function and hints to net, which resolves the host through it", async () => {
  const f = agents(); const calls: unknown[] = [];
  const agent = new f.http.Agent({ hints: 32, lookup: (host: unknown, options: unknown, callback: unknown) => {
    calls.push([host, options]); if (typeof callback === "function") Reflect.apply(callback, undefined, [null, [{ address: "127.0.0.1", family: 4 }]]);
  } });
  const socket = await requestThrough(agent, { host: "web.invalid", port: 8080 }).assigned; await connected(socket);
  expect(calls).toEqual(recordedObject(recorded("tlsLookup", "results", "agentLookup"))["calls"]);
  expect(f.operations).toContainEqual({ kind: "socket-connect-local", address: { address: "127.0.0.1", port: 8080 } });
  agent.destroy();
});

it("refuses a set connection key on http.Agent and https.Agent by name, and plain http ignores TLS keys", () => {
  const { https, http, createConnection } = agents();
  // An agent's own options override every request's (Agent.addRequest), so a host, port or signal there redirects or
  // aborts all of its connections.
  const refused: readonly (readonly [string, unknown])[] = [["family", 6], ["localAddress", "10.0.0.2"],
    ["socketPath", "/var/run/docker.sock"], ["defaultPort", 8080], ["host", "other.example.test"], ["port", 8080], ["signal", new AbortController().signal]];
  for (const [key, value] of refused) {
    expect(() => new http.Agent({ [key]: value })).toThrow(lateFailure(`node:http.Agent ${key}`));
    expect(() => new https.Agent({ [key]: value })).toThrow(lateFailure(`node:https.Agent ${key}`));
  }
  // The guest TLS helper takes no client certificate: set on https, refused; plain http never reads it.
  expect(() => new https.Agent({ cert: "pem" })).toThrow(lateFailure("node:https.Agent cert"));
  new http.Agent({ cert: "pem", key: "pem", ca: "pem", rejectUnauthorized: false, maxCachedSessions: 0, socket: {} }).destroy();
  new http.Agent({ lookup: () => {}, hints: 32 }).destroy(); new https.Agent({ lookup: () => {}, hints: 32 }).destroy();
  expect(createConnection).not.toHaveBeenCalled();
});

it("refuses the keys only one protocol's agent reads, and the proxy variable of its own protocol", () => {
  const { https, http } = agents();
  const httpProxy = { HTTP_PROXY: "http://proxy.example.test:3128" }, httpsProxy = { https_proxy: "http://proxy.example.test:3128" };
  // net.Socket opens fd and applies blockList; a plain agent's connections are net sockets, an https agent's are not.
  for (const [key, value] of [["fd", 3], ["blockList", {}], ["protocol", "https:"], ["proxyEnv", httpProxy]] as const) {
    expect(() => new http.Agent({ [key]: value })).toThrow(lateFailure(`node:http.Agent ${key}`));
  }
  // tls.connect wraps an existing socket when one is given.
  for (const [key, value] of [["socket", {}], ["protocol", "http:"], ["proxyEnv", httpsProxy]] as const) {
    expect(() => new https.Agent({ [key]: value })).toThrow(lateFailure(`node:https.Agent ${key}`));
  }
  // Node reads only the proxy variable of the agent's own protocol (lower case first).
  new http.Agent({ proxyEnv: httpsProxy }).destroy(); new https.Agent({ proxyEnv: httpProxy }).destroy();
  new http.Agent({ fd: undefined, protocol: "http:" }).destroy(); new https.Agent({ fd: 3, blockList: {} }).destroy();
});

it("https.Agent accepts maxCachedSessions as Node does and hands tls.connect the whole option bag", async () => {
  const { https, createConnection } = agents();
  // Tuning keys, keys Node never reads on this API, and values Node's own test treats as unset are ignored.
  const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0, agentKeepAliveTimeoutBuffer: 500, freeSocketTimeout: 4000, highWaterMark: 16384,
    ca: null, servername: undefined, lookup: undefined, family: 0, localAddress: null, socketPath: "", defaultPort: 443, protocol: "https:", proxyEnv: {},
    // Agent.createSocket calls its own createConnection method; TLSSocket builds its socket without fd or blockList.
    // (A host or port given as undefined would still override the request's, as Node spreads the agent's options last.)
    createConnection: () => {}, fd: 3, blockList: {}, signal: null,
    // tls.connect hard-codes requestCert and never passes pskIdentityHint; passphrase and privateKeyEngine only
    // qualify a key, pfx or privateKeyIdentifier; and these values are falsy where Node tests truthiness.
    requestCert: true, pskIdentityHint: "hint", passphrase: "secret", privateKeyEngine: "engine",
    honorCipherOrder: false, secureOptions: 0, enableTrace: false, session: "", secureProtocol: "", requestOCSP: false });
  expect(read(agent, "maxCachedSessions")).toBe(0);
  await requestThrough(agent, { host: "api.example.test", port: 443 }).assigned;
  expect(createConnection).toHaveBeenCalledTimes(1);
  const name = agent.getName({ ...agent.options, host: "api.example.test", port: 443, servername: "api.example.test" });
  expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ host: "api.example.test", port: 443, servername: "api.example.test", _agentKey: name, encoding: null, keepAlive: true, keepAliveInitialDelay: 1000 }));
  agent.destroy();
});
