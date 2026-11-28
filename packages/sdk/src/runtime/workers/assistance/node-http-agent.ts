// Ported from Node.js v24.18.1 lib/_http_agent.js and the Agent of lib/https.js.
// Copyright Node.js contributors. All rights reserved.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
// and this permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { ipFamily } from "./node-socket-connect.js";
import { UNSUPPORTED_TLS_OPTIONS } from "./node-tls.js";
import { copyOptions, otherDefaultPort, refuseSetOptions, truthy, UNSUPPORTED_CONNECT_OPTIONS, UNSUPPORTED_NET_SOCKET_OPTIONS, type SetTests } from "./node-connect-options.js";
import { VMError } from "../../errors.js";
import type { AsyncContext } from "./async-context.js";
import type { NodeSocket } from "./node-socket.js";
import { EventEmitter, bindAsyncEvents } from "./node-streams.js";
import { invalidValue, outOfRange, templateText, validateNumber, validateString } from "./node-util-validators.js";

/** What the agent asks of a request: Node's ClientRequest, or a program's own object passed to addRequest. */
export type AgentRequest = { reusedSocket?: boolean; onSocket(socket: NodeSocket | null | undefined, error?: Error | null): void };
type Options = Record<string, unknown>;
type Created = (error: Error | null | undefined, socket?: NodeSocket) => void;
type Connect = (...args: unknown[]) => NodeSocket;
export type HttpAgent = EventEmitter & {
  options: Options; defaultPort: unknown; protocol: unknown;
  requests: Record<string, AgentRequest[]>; sockets: Record<string, NodeSocket[]>; freeSockets: Record<string, NodeSocket[]>;
  keepAliveMsecs: unknown; keepAlive: unknown; maxSockets: unknown; maxFreeSockets: unknown; scheduling: unknown; maxTotalSockets: number; totalSocketCount: number;
  agentKeepAliveTimeoutBuffer: number;
  createConnection(...args: unknown[]): NodeSocket | undefined;
  getName(options?: Options): string;
  addRequest(request: AgentRequest, options: unknown, port?: unknown, localAddress?: unknown): void;
  createSocket(request: AgentRequest, options: Options, callback: Created): void;
  removeSocket(socket: NodeSocket, options: Options): void;
  keepSocketAlive(socket: NodeSocket): boolean;
  reuseSocket(socket: NodeSocket, request: AgentRequest): void;
  destroy(): void;
};
export type HttpAgentClass = new (options?: unknown) => HttpAgent;

/** Bounds the assisted path adds to Node's agent: sockets one agent opens, and requests it holds waiting for one. */
const SOCKET_LIMIT = 128;
const REQUEST_LIMIT = 1024;
/** Marks an https Agent class; subclasses inherit it, as `instanceof https.Agent` would. */
const SECURE = Symbol("https agent");
/** Options a queued request was added with, and the async context it runs its socket assignment in (Node's kRequestOptions and kRequestAsyncResource). */
const queuedOptions = new WeakMap<AgentRequest, Options>();
const queuedContext = new WeakMap<AgentRequest, (callback: () => void) => void>();

function freeSocketErrorListener(this: NodeSocket): void { this.destroy(); this.emit("agentRemove"); }

/** Removes `request` from the queue it waits in, so a destroyed request never takes a socket. */
export function dropQueuedRequest(agent: unknown, request: AgentRequest): void {
  const options = queuedOptions.get(request); if (options === undefined || !isAgentLike(agent)) return;
  queuedOptions.delete(request); queuedContext.delete(request);
  const requests: unknown = Reflect.get(agent, "requests");
  if (typeof requests !== "object" || requests === null) return;
  for (const name of Object.keys(requests)) {
    const list: unknown = Reflect.get(requests, name);
    if (!Array.isArray(list)) continue;
    const index = list.indexOf(request);
    if (index !== -1) { list.splice(index, 1); if (list.length === 0) Reflect.deleteProperty(requests, name); return; }
  }
}
function isAgentLike(value: unknown): value is object { return typeof value === "object" && value !== null; }

/**
 * Node's http.Agent: `requests`, `sockets` and `freeSockets` are the agent's own registry, writable as in Node, so a
 * subclass (agent-base, @npmcli/agent) can override createSocket and createConnection and keep its own entries there.
 * http connections are assisted net sockets; https ones come from `connect`, the assisted tls.connect.
 */
export function createHttpAgents(net: { readonly createConnection: Connect }, context: AsyncContext, protocol: "http:" | "https:" = "http:", base?: HttpAgentClass): { Agent: HttpAgentClass; globalAgent: HttpAgent } {
  if (protocol === "https:") {
    const Agent = secureAgent(base ?? plainAgent(net.createConnection, context), net.createConnection);
    return { Agent, globalAgent: new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 }) };
  }
  const Agent = plainAgent(net.createConnection, context);
  return { Agent, globalAgent: new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 }) };
}

/** Keys Node's Agent reads, for itself or for every socket it creates, that this agent does not honor. Its own
 * options override each request's (addRequest, createSocket), so a socketPath, a signal (when truthy), a host or a
 * port (unless undefined) applies to every connection; then another default port or protocol, a proxy that
 * proxyEnv names for this protocol, and what the sockets read: net.Socket's keys for http, the TLS keys for https.
 * Tuning keys such as maxCachedSessions and agentKeepAliveTimeoutBuffer, and keys Node never reads, are ignored. */
function unsupportedAgentOptions(secure: boolean): SetTests {
  const protocol = secure ? "https:" : "http:", proxies = secure ? ["https_proxy", "HTTPS_PROXY"] : ["http_proxy", "HTTP_PROXY"];
  return {
    ...UNSUPPORTED_CONNECT_OPTIONS, socketPath: Boolean, signal: Boolean, host: value => value !== undefined, port: value => value !== undefined,
    defaultPort: otherDefaultPort(secure ? 443 : 80), protocol: value => Boolean(value) && value !== protocol,
    proxyEnv: value => typeof value === "object" && value !== null && proxies.some(name => { const proxy: unknown = Reflect.get(value, name); return Boolean(proxy); }),
    ...(secure ? UNSUPPORTED_TLS_OPTIONS : UNSUPPORTED_NET_SOCKET_OPTIONS),
  };
}
const UNSUPPORTED_HTTP = unsupportedAgentOptions(false), UNSUPPORTED_HTTPS = unsupportedAgentOptions(true);

function plainAgent(connect: Connect, context: AsyncContext): HttpAgentClass {
  class Agent extends EventEmitter implements HttpAgent {
    declare options: Options;
    declare defaultPort: unknown;
    declare protocol: unknown;
    declare requests: Record<string, AgentRequest[]>;
    declare sockets: Record<string, NodeSocket[]>;
    declare freeSockets: Record<string, NodeSocket[]>;
    declare keepAliveMsecs: unknown;
    declare keepAlive: unknown;
    declare maxSockets: unknown;
    declare maxFreeSockets: unknown;
    declare scheduling: unknown;
    declare maxTotalSockets: number;
    declare totalSocketCount: number;
    declare agentKeepAliveTimeoutBuffer: number;
    constructor(value?: unknown) {
      super();
      const options = copyOptions(value);
      const secure = Reflect.get(new.target, SECURE) === true;
      refuseSetOptions(options, secure ? UNSUPPORTED_HTTPS : UNSUPPORTED_HTTP, "http.Agent", secure ? "https.Agent" : "http.Agent");
      this.options = options;
      this.defaultPort = or(options["defaultPort"], 80);
      this.protocol = or(options["protocol"], "http:");
      if (options["noDelay"] === undefined) options["noDelay"] = true;
      // Don't confuse net and make it think that we're connecting to a pipe
      options["path"] = null;
      this.requests = nullRecord(); this.sockets = nullRecord(); this.freeSockets = nullRecord();
      this.keepAliveMsecs = or(options["keepAliveMsecs"], 1000);
      this.keepAlive = or(options["keepAlive"], false);
      this.maxSockets = or(options["maxSockets"], Infinity);
      this.maxFreeSockets = or(options["maxFreeSockets"], 256);
      this.scheduling = or(options["scheduling"], "lifo");
      const buffer = options["agentKeepAliveTimeoutBuffer"];
      this.agentKeepAliveTimeoutBuffer = typeof buffer === "number" && buffer >= 0 && Number.isFinite(buffer) ? buffer : 1000;
      if (this.scheduling !== "fifo" && this.scheduling !== "lifo") throw invalidValue("scheduling", this.scheduling, "must be one of: 'fifo', 'lifo'");
      const total = options["maxTotalSockets"];
      if (total !== undefined) {
        validateNumber(total, "maxTotalSockets");
        if (!(total >= 1)) throw outOfRange("maxTotalSockets", ">= 1", total);
        this.maxTotalSockets = total;
      } else this.maxTotalSockets = Infinity;
      this.totalSocketCount = 0;
      this.on("free", (...args: unknown[]) => { const [socket, socketOptions] = args; if (isSocket(socket)) this.#free(socket, isOptions(socketOptions) ? socketOptions : {}); });
      bindAsyncEvents(this, context);
    }
    #free(socket: NodeSocket, options: Options): void {
      const name = this.getName(options);
      if (!isWritable(socket)) { socket.destroy(); return; }
      const requests = this.requests[name];
      const queued = requests?.shift();
      if (requests !== undefined && queued !== undefined) {
        const run = queuedContext.get(queued); queuedContext.delete(queued); queuedOptions.delete(queued);
        if (requests.length === 0) Reflect.deleteProperty(this.requests, name);
        if (run === undefined) setRequestSocket(this, queued, socket); else run(() => { setRequestSocket(this, queued, socket); });
        return;
      }
      // If there are no pending requests, then put it in the freeSockets pool, but only if we're allowed to do so.
      const request: unknown = Reflect.get(socket, "_httpMessage");
      if (typeof request !== "object" || request === null || Reflect.get(request, "shouldKeepAlive") !== true || !truthy(this.keepAlive)) { socket.destroy(); return; }
      const freeSockets = this.freeSockets[name] ?? [];
      const freeLength = freeSockets.length;
      const count = freeLength + (this.sockets[name]?.length ?? 0);
      if (this.totalSocketCount > this.maxTotalSockets || count > Number(this.maxSockets) || freeLength >= Number(this.maxFreeSockets) || !this.keepSocketAlive(socket)) {
        socket.destroy(); return;
      }
      this.freeSockets[name] = freeSockets;
      Reflect.set(socket, "_httpMessage", null);
      this.removeSocket(socket, options);
      socket.once("error", freeSocketErrorListener);
      freeSockets.push(socket);
    }
    // Forward to net.createConnection, which reads the keys it knows from the option bag.
    createConnection(...args: unknown[]): NodeSocket | undefined { return connect(...args); }
    getName(options: Options = {}): string {
      let name = truthy(options["host"]) ? templateText(options["host"]) : "localhost";
      name += ":";
      if (truthy(options["port"])) name += templateText(options["port"]);
      name += ":";
      if (truthy(options["localAddress"])) name += templateText(options["localAddress"]);
      // Pacify parallel/test-http-agent-getname by only appending the ':' when options.family is set.
      if (options["family"] === 4 || options["family"] === 6) name += `:${templateText(options["family"])}`;
      if (truthy(options["socketPath"])) name += `:${templateText(options["socketPath"])}`;
      return name;
    }
    addRequest(request: AgentRequest, value: unknown, port?: unknown, localAddress?: unknown): void {
      // Legacy API: addRequest(req, host, port, localAddress)
      const given: unknown = typeof value === "string" ? { host: value, port, localAddress } : value;
      // Here the agent options will override per-request options.
      const options = mergeOptions(given, this.options);
      normalizeServerName(options, request);
      const name = this.getName(options);
      const sockets = this.sockets[name] ??= [];
      const freeSockets = this.freeSockets[name];
      let socket: NodeSocket | undefined;
      if (freeSockets !== undefined) {
        while (freeSockets.length > 0 && freeSockets[0]?.destroyed === true) freeSockets.shift();
        socket = this.scheduling === "fifo" ? freeSockets.shift() : freeSockets.pop();
        if (freeSockets.length === 0) Reflect.deleteProperty(this.freeSockets, name);
      }
      const freeLength = freeSockets?.length ?? 0;
      const socketCount = freeLength + sockets.length;
      if (socket !== undefined) {
        // Reusing a socket from the pool.
        this.reuseSocket(socket, request);
        setRequestSocket(this, request, socket);
        sockets.push(socket);
      } else if (socketCount < Number(this.maxSockets) && this.totalSocketCount < Math.min(this.maxTotalSockets, SOCKET_LIMIT)) {
        // If we are under maxSockets create a new one.
        this.createSocket(request, options, (error, created) => {
          if (error) { request.onSocket(created, error); return; }
          if (created !== undefined) setRequestSocket(this, request, created);
        });
      } else {
        // We are over limit so we'll add it to the queue.
        if (Object.values(this.requests).reduce((total, list) => total + list.length, 0) >= REQUEST_LIMIT) {
          throw new VMError("QUOTA_EXCEEDED", "HTTP agent pending request limit exceeded");
        }
        queuedOptions.set(request, options); queuedContext.set(request, context.capture());
        (this.requests[name] ??= []).push(request);
      }
    }
    createSocket(request: AgentRequest, value: Options, callback: Created): void {
      // Here the agent options will override per-request options.
      const options = mergeOptions(value, this.options);
      if (truthy(options["socketPath"])) options["path"] = options["socketPath"];
      normalizeServerName(options, request);
      // Make sure per-request timeout is respected.
      const timeout: unknown = or(or(Reflect.get(request, "timeout"), this.options["timeout"]), undefined);
      if (truthy(timeout)) options["timeout"] = timeout;
      const name = this.getName(options);
      options["_agentKey"] = name;
      options["encoding"] = null;
      let done = false;
      const oncreate: Created = (error, socket) => {
        if (done) return; done = true;
        if (error) { callback(error); return; }
        if (socket === undefined) return;
        (this.sockets[name] ??= []).push(socket);
        this.totalSocketCount++;
        installListeners(this, socket, options);
        callback(null, socket);
      };
      // When keepAlive is true, pass the related options to createConnection
      if (truthy(this.keepAlive)) { options["keepAlive"] = this.keepAlive; options["keepAliveInitialDelay"] = this.keepAliveMsecs; }
      const socket = this.createConnection(options, oncreate);
      if (socket) oncreate(null, socket);
    }
    removeSocket(socket: NodeSocket, value: Options): void {
      let options: Options | undefined = value;
      const name = this.getName(options);
      // If the socket was destroyed, remove it from the free buffers too.
      const sets = isWritable(socket) ? [this.sockets] : [this.sockets, this.freeSockets];
      for (const set of sets) {
        const list = set[name];
        const index = list?.indexOf(socket) ?? -1;
        if (list !== undefined && index !== -1) { list.splice(index, 1); if (list.length === 0) Reflect.deleteProperty(set, name); }
      }
      let request: AgentRequest | undefined;
      const waiting = this.requests[name];
      if (waiting !== undefined && waiting.length > 0) request = waiting[0];
      else {
        // TODO(rickyes): this logic will not be FIFO across origins. There might be older requests in a different
        // origin, but if the origin which releases the socket has pending requests that will be prioritized.
        const key = Object.keys(this.requests)[0];
        // Check whether this specific origin is already at maxSockets
        if (key !== undefined && (this.sockets[key]?.length ?? 0) === 0) {
          request = this.requests[key]?.[0];
          options = request === undefined ? undefined : queuedOptions.get(request);
        }
      }
      if (request !== undefined && options !== undefined) {
        const pending = request;
        // If we have pending requests and a socket gets closed make a new one
        this.createSocket(pending, options, (error, created) => {
          if (error) { pending.onSocket(null, error); return; }
          created?.emit("free");
        });
      }
    }
    keepSocketAlive(socket: NodeSocket): boolean {
      socket.setKeepAlive(true, Number(this.keepAliveMsecs));
      socket.unref();
      let agentTimeout = Number(or(this.options["timeout"], 0));
      let canKeepSocketAlive = true;
      const hint = keepAliveHint(socket);
      if (hint !== undefined) {
        // Let the timer expire before the announced timeout to reduce the likelihood of ECONNRESET errors
        let serverHintTimeout = hint * 1000 - this.agentKeepAliveTimeoutBuffer;
        serverHintTimeout = serverHintTimeout > 0 ? serverHintTimeout : 0;
        // Cannot safely reuse the socket because the server timeout is too short
        if (serverHintTimeout === 0) canKeepSocketAlive = false;
        else if (serverHintTimeout < agentTimeout) agentTimeout = serverHintTimeout;
      }
      if (socket.timeout !== agentTimeout) socket.setTimeout(agentTimeout);
      return canKeepSocketAlive;
    }
    reuseSocket(socket: NodeSocket, request: AgentRequest): void {
      socket.removeListener("error", freeSocketErrorListener);
      request.reusedSocket = true;
      socket.ref();
    }
    destroy(): void {
      for (const set of [this.freeSockets, this.sockets]) for (const name of Object.keys(set)) for (const socket of [...(set[name] ?? [])]) socket.destroy();
    }
  }
  Object.defineProperty(Agent, "name", { value: "Agent" });
  return Agent;
}

function secureAgent(base: HttpAgentClass, connect: Connect): HttpAgentClass {
  class Agent extends base {
    static readonly [SECURE] = true;
    declare maxCachedSessions: unknown;
    declare _sessionCache: { map: Record<string, unknown>; list: unknown[] };
    constructor(value?: unknown) {
      const options = copyOptions(value);
      options["defaultPort"] ??= 443;
      options["protocol"] ??= "https:";
      super(options);
      const sessions = this.options["maxCachedSessions"];
      this.maxCachedSessions = sessions === undefined ? 100 : sessions;
      // The guest's TLS takes no session, so the cache stays empty.
      this._sessionCache = { map: {}, list: [] };
    }
    override createConnection(...args: unknown[]): NodeSocket {
      const first = args[0], second = args[1], third = args[2];
      // XXX: This signature (port, host, options) is different from all the other createConnection() methods.
      const options = typeof first === "object" && first !== null ? copyOptions(first)
        : typeof second === "object" && second !== null ? copyOptions(second)
          : typeof third === "object" && third !== null ? copyOptions(third) : copyOptions({});
      if (typeof first === "number") options["port"] = first;
      if (typeof second === "string") options["host"] = second;
      const socket = connect(options);
      // Node's tls.connect hands noDelay and keepAlive to the TLSSocket it builds; the assisted one takes them as calls.
      if (truthy(options["noDelay"])) socket.setNoDelay(true);
      if (truthy(options["keepAlive"])) socket.setKeepAlive(true, Number(options["keepAliveInitialDelay"]) || 0);
      return socket;
    }
    override getName(options: Options = {}): string {
      let name = super.getName(options);
      for (const key of ["ca", "cert", "clientCertEngine", "ciphers", "key", "pfx"] as const) { name += ":"; if (truthy(options[key])) name += templateText(options[key]); }
      name += ":"; if (options["rejectUnauthorized"] !== undefined) name += templateText(options["rejectUnauthorized"]);
      name += ":"; if (truthy(options["servername"]) && options["servername"] !== options["host"]) name += templateText(options["servername"]);
      for (const key of ["minVersion", "maxVersion", "secureProtocol", "crl"] as const) { name += ":"; if (truthy(options[key])) name += templateText(options[key]); }
      name += ":"; if (options["honorCipherOrder"] !== undefined) name += templateText(options["honorCipherOrder"]);
      for (const key of ["ecdhCurve", "dhparam"] as const) { name += ":"; if (truthy(options[key])) name += templateText(options[key]); }
      name += ":"; if (options["secureOptions"] !== undefined) name += templateText(options["secureOptions"]);
      for (const key of ["sessionIdContext", "sigalgs", "privateKeyIdentifier", "privateKeyEngine"] as const) { name += ":"; if (truthy(options[key])) name += templateText(options[key]); }
      return name;
    }
  }
  Object.defineProperty(Agent, "name", { value: "Agent" });
  return Agent;
}

function installListeners(agent: HttpAgent, socket: NodeSocket, options: Options): void {
  const onFree = () => { agent.emit("free", socket, options); };
  // This is the only place where sockets get removed from the Agent. If you want to remove a socket from the pool,
  // just close it. All socket errors end in a close event anyway.
  const onClose = () => { agent.totalSocketCount--; agent.removeSocket(socket, options); };
  // Destroy if in free list.
  const onTimeout = () => { if (Object.values(agent.freeSockets).some(list => list.includes(socket))) socket.destroy(); };
  // We need this function for cases like HTTP 'upgrade' (defined by WebSockets) where we need to remove a socket
  // from the pool because it'll be locked up indefinitely
  const onRemove = () => {
    agent.totalSocketCount--; agent.removeSocket(socket, options);
    socket.removeListener("close", onClose); socket.removeListener("free", onFree);
    socket.removeListener("timeout", onTimeout); socket.removeListener("agentRemove", onRemove);
  };
  socket.on("free", onFree); socket.on("close", onClose); socket.on("timeout", onTimeout); socket.on("agentRemove", onRemove);
}

function setRequestSocket(agent: HttpAgent, request: AgentRequest, socket: NodeSocket): void {
  request.onSocket(socket);
  const agentTimeout: unknown = or(agent.options["timeout"], 0);
  const timeout: unknown = Reflect.get(request, "timeout");
  if (timeout === undefined || timeout === agentTimeout) return;
  socket.setTimeout(timeout);
}

function normalizeServerName(options: Options, request: AgentRequest): void {
  if (!truthy(options["servername"]) && options["servername"] !== "") options["servername"] = calculateServerName(options, request);
}
function calculateServerName(options: Options, request: AgentRequest): unknown {
  let servername: unknown = options["host"];
  const getHeader: unknown = Reflect.get(request, "getHeader");
  const header: unknown = typeof getHeader === "function" ? Reflect.apply(getHeader, request, ["host"]) : undefined;
  if (truthy(header)) {
    validateString(header, "options.headers.host");
    // abc => abc, abc:123 => abc, [::1] => ::1, [::1]:123 => ::1
    if (header.startsWith("[")) {
      const index = header.indexOf("]");
      // Leading '[', but no ']'. Need to do something...
      servername = index === -1 ? header : header.substring(1, index);
    } else servername = header.split(":", 1)[0];
  }
  // Don't implicitly set invalid (IP) servernames.
  if (typeof servername === "string" && ipFamily(servername) !== 0) servername = "";
  return servername;
}

/** `{ __proto__: null, ...options, ...agentOptions }`: the agent's options override the request's. */
function mergeOptions(value: unknown, agentOptions: Options): Options {
  const options = copyOptions(typeof value === "object" && value !== null ? value : {});
  return Object.assign(options, agentOptions);
}
/** Node's `value || fallback`. */
function or(value: unknown, fallback: unknown): unknown { return truthy(value) ? value : fallback; }
function nullRecord<T>(): Record<string, T> { const record: Record<string, T> = {}; Object.setPrototypeOf(record, null); return record; }

/** The `timeout=` hint of the Keep-Alive header of the response this socket just carried, in seconds. */
function keepAliveHint(socket: NodeSocket): number | undefined {
  const request: unknown = Reflect.get(socket, "_httpMessage");
  const response: unknown = typeof request === "object" && request !== null ? Reflect.get(request, "res") : undefined;
  const headers: unknown = typeof response === "object" && response !== null ? Reflect.get(response, "headers") : undefined;
  const hint: unknown = typeof headers === "object" && headers !== null ? Reflect.get(headers, "keep-alive") : undefined;
  if (!truthy(hint)) return undefined;
  const match = /^timeout=(\d+)/u.exec(templateText(hint))?.[1];
  return match === undefined ? undefined : Number.parseInt(match, 10);
}
/** A socket an agent's `free` event names: anything a program emits there with a destroy method. */
function isSocket(value: unknown): value is NodeSocket { return typeof value === "object" && value !== null && typeof Reflect.get(value, "destroy") === "function"; }
function isOptions(value: unknown): value is Options { return typeof value === "object" && value !== null; }
/** Duplex's `writable`: false once the socket ended, finished or was destroyed. */
function isWritable(socket: NodeSocket): boolean { const value: unknown = Reflect.get(socket, "writable"); return value === true; }
