import { Readable } from "readable-stream";
import { expect, it } from "vitest";
import { createHttpClients } from "./node-http-client.js";
import type { AgentRequest, HttpAgent, HttpAgentClass } from "./node-http-agent.js";
import type { NodeSocket, NodeSockets } from "./node-socket.js";
import { body, fixture, module } from "./node-http-client.test-support.js";

type Created = Parameters<HttpAgent["createSocket"]>[2];
type Connect = (...args: unknown[]) => NodeSocket;

/**
 * An agent built the way npm 11's is: agent-base 7.1.4's createSocket and createConnection, with its placeholder
 * sockets, and the connect of @npmcli/agent 4.0.2, which passes its own lookup and the whole option bag to net.connect
 * or tls.connect. Condensed from those packages (MIT License, Copyright Nathan Rajlich; Copyright npm, Inc.).
 */
function npmAgent(Base: HttpAgentClass, net: Pick<NodeSockets, "Socket" | "connect">, tlsConnect: Connect) {
  abstract class AgentBase extends Base {
    #currentSocket: NodeSocket | undefined;
    abstract connect(request: AgentRequest, options: Record<string, unknown>): Promise<NodeSocket>;
    override createSocket(request: AgentRequest, options: Record<string, unknown>, callback: Created): void {
      const connectOptions = { ...options, secureEndpoint: options["protocol"] === "https:" };
      const name = this.getName(connectOptions); const placeholder = this.#incrementSockets(name);
      Promise.resolve().then(() => this.connect(request, connectOptions)).then(socket => {
        this.#decrementSockets(name, placeholder); this.#currentSocket = socket; super.createSocket(request, options, callback);
      }, (error: unknown) => { this.#decrementSockets(name, placeholder); callback(error instanceof Error ? error : new Error(String(error))); });
    }
    override createConnection(): NodeSocket {
      const socket = this.#currentSocket; this.#currentSocket = undefined;
      if (socket === undefined) throw new Error("No socket was returned in the `connect()` function");
      return socket;
    }
    #incrementSockets(name: string): NodeSocket | null {
      if (this.maxSockets === Infinity && this.maxTotalSockets === Infinity) return null;
      this.sockets[name] ??= [];
      const placeholder = new net.Socket({ writable: false });
      this.sockets[name].push(placeholder); this.totalSocketCount++;
      return placeholder;
    }
    #decrementSockets(name: string, placeholder: NodeSocket | null): void {
      const sockets = placeholder === null ? undefined : this.sockets[name];
      if (sockets === undefined || placeholder === null) return;
      const index = sockets.indexOf(placeholder);
      if (index !== -1) { sockets.splice(index, 1); this.totalSocketCount--; if (sockets.length === 0) Reflect.deleteProperty(this.sockets, name); }
    }
  }
  class Agent extends AgentBase {
    readonly lookups: unknown[] = [];
    readonly connected: Record<string, unknown>[] = [];
    readonly #lookup = (host: unknown, options: unknown, callback: unknown) => {
      this.lookups.push([host, options]);
      if (typeof callback === "function") queueMicrotask(() => { Reflect.apply(callback, undefined, [null, [{ address: "127.0.0.1", family: 4 }]]); });
    };
    constructor() { super({ keepAliveMsecs: 1000, maxSockets: 15, maxTotalSockets: Infinity, maxFreeSockets: 256, scheduling: "fifo", family: 0, keepAlive: true, hints: 32 }); }
    override async connect(_request: AgentRequest, options: Record<string, unknown>): Promise<NodeSocket> {
      options["lookup"] ??= this.#lookup;
      this.connected.push(options);
      const socket = options["secureEndpoint"] === true ? tlsConnect(options) : net.connect(options);
      socket.setKeepAlive(Boolean(this.keepAlive), Number(this.keepAliveMsecs)); socket.setNoDelay(Boolean(this.keepAlive));
      if (socket.connecting) await new Promise(resolve => socket.once("connect", resolve));
      return socket;
    }
  }
  return Agent;
}

it("runs requests through an npm-style agent: its createSocket, placeholders, lookup and reused connection", async () => {
  const f = fixture((request, response) => { request.resume(); response.end(`served ${request.url}`); });
  const Agent = npmAgent(f.http.Agent, f.net, () => { throw new Error("Unexpected TLS"); });
  const agent = new Agent();
  const get = (path: string) => new Promise<string>((resolve, reject) => {
    f.http.get({ host: "registry.invalid", port: 3000, path, agent }, (response: unknown) => { if (!(response instanceof Readable)) { reject(new TypeError("Expected a response")); return; } void body(response).then(resolve, reject); }).on("error", reject);
  });
  expect(await get("/vite")).toBe("served /vite");
  expect(await get("/react")).toBe("served /react");
  expect(agent.lookups).toEqual([["registry.invalid", { hints: 32, all: true }]]);
  expect(f.connections()).toBe(1); expect(agent.totalSocketCount).toBe(1);
  expect(Object.values(agent.sockets).flat()).toHaveLength(0); expect(Object.values(agent.freeSockets).flat()).toHaveLength(1);
  agent.destroy();
});

it("takes an npm-style http.Agent on https.request, as Node does, and hands its connect the https option bag", async () => {
  const f = fixture((request, response) => { request.resume(); response.end("secure"); });
  // The guest TLS helper is not part of this test: the https connection is a plain socket to the in-memory server.
  const tlsConnect: Connect = () => f.net.connect({ host: "127.0.0.1", port: 3000 });
  const https = createHttpClients({ createConnection: tlsConnect }, module, f.context, queueMicrotask, f.retain, "https:", f.http.Agent);
  const Agent = npmAgent(f.http.Agent, f.net, tlsConnect);
  const agent = new Agent();
  expect(new https.Agent()).toBeInstanceOf(f.http.Agent);
  const text = await new Promise<string>((resolve, reject) => {
    https.get({ host: "registry.npmjs.org", port: 443, path: "/vite", agent }, (response: unknown) => { if (!(response instanceof Readable)) { reject(new TypeError("Expected a response")); return; } void body(response).then(resolve, reject); }).on("error", reject);
  });
  expect(text).toBe("secure");
  expect(agent.connected[0]).toMatchObject({ host: "registry.npmjs.org", port: 443, protocol: "https:", secureEndpoint: true, servername: "registry.npmjs.org", hints: 32, path: null });
  expect(typeof agent.connected[0]?.["lookup"]).toBe("function");
  agent.destroy();
});

it("lets net.connect ignore the keys it does not read and apply timeout, noDelay and keepAlive, as Node does", async () => {
  const f = fixture((request, response) => { request.resume(); response.end("ok"); });
  const socket = f.net.connect({ port: 3000, host: "127.0.0.1", method: "GET", headers: {}, agent: {}, servername: "x", _agentKey: "k", encoding: null,
    timeout: 50, noDelay: true, keepAlive: true, keepAliveInitialDelay: 1000, secureEndpoint: false });
  expect(socket.timeout).toBe(50);
  await new Promise(resolve => socket.once("connect", resolve)); socket.destroy();
  expect(() => f.net.connect({ port: 3000, localAddress: "10.0.0.2" })).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE", message: "localAddress is not supported for net.connect" }));
});
