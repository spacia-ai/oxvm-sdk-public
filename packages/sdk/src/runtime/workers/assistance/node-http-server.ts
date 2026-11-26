import { EventEmitter, isEventListener } from "./node-streams.js";
import { exactKeys, record } from "../../decode.js";
import type { AsyncContext } from "./async-context.js";
import type { createNodeNet, NodeServer } from "./node-net.js";
import type { NodeSocket } from "./node-socket.js";
import { HttpParseError } from "./http-parser.js";
import { createHttpConnection } from "./node-http-connection.js";
import { createHttpResponses } from "./node-http-response.js";
import { IncomingMessage } from "./node-http-incoming.js";

type Connection = ReturnType<typeof createHttpConnection>;
type RequestListener = Parameters<typeof createHttpConnection>[3]["request"];
type HttpServer = NodeServer & { timeout: number; keepAliveTimeout: number; keepAliveTimeoutBuffer: number; setTimeout(duration: unknown, callback?: unknown): HttpServer; closeIdleConnections(): void; closeAllConnections(): void };
/** The methods Node 24.18.1's HTTP parser accepts, as `http.METHODS` lists them. */
const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE",
  "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND",
  "UNLINK", "UNLOCK", "UNSUBSCRIBE"] as const;

type Servers = {
  readonly IncomingMessage: typeof IncomingMessage;
  /** A fresh array per module, as Node gives each process its own. */
  readonly METHODS: string[];
  readonly ServerResponse: ReturnType<typeof createHttpResponses>["ServerResponse"];
  readonly STATUS_CODES: Readonly<Record<number, string>>;
  readonly Server: {
    new (listener?: RequestListener): HttpServer;
    new (options: unknown, listener?: RequestListener): HttpServer;
  };
  readonly createServer: {
    (listener?: RequestListener): HttpServer;
    (options: unknown, listener?: RequestListener): HttpServer;
  };
  /** Node's `http._connectionListener`: serves HTTP on a connected socket for the server it is called on. */
  readonly _connectionListener: (this: unknown, socket: unknown) => void;
};
type Tracking = { readonly connections: Map<NodeSocket, Connection>; closing: boolean };
// Per server, so that the listener also serves a server this module did not construct (https.Server is a tls.Server).
const tracked = new WeakMap<object, Tracking>();
function tracking(server: object): Tracking {
  let state = tracked.get(server);
  if (state === undefined) { state = { connections: new Map(), closing: false }; tracked.set(server, state); }
  return state;
}
const admitted = new WeakMap<object, NodeSocket>();
/** Lets `http._connectionListener` serve a socket that is not a `net.Socket`: the TLSSocket of an accepted TLS connection. */
export function admitHttpSocket(socket: NodeSocket): void { admitted.set(socket, socket); }
/** What `server.close()`, `closeIdleConnections()` and `closeAllConnections()` do to the HTTP connections of any server the listener serves. */
export function closeHttpConnections(server: object, which: "when-idle" | "idle" | "all"): void {
  const state = tracking(server);
  if (which === "when-idle") { state.closing = true; for (const connection of state.connections.values()) connection.closeWhenIdle(); }
  else if (which === "idle") for (const connection of state.connections.values()) connection.closeIdle();
  else for (const socket of state.connections.keys()) socket.destroy();
}
/** A server that listens again serves its new connections normally. */
export function reopenHttpConnections(server: object): void { tracking(server).closing = false; }

/** HTTP reuses the net owner for bind, accept, connection accounting and close.
 * Only HTTP parsing, response ordering and idle retirement belong here. */
export function createHttpServers(net: ReturnType<typeof createNodeNet>, module: WebAssembly.Module, context: AsyncContext): Servers {
  const { ServerResponse, STATUS_CODES } = createHttpResponses(context);
  const setting = (server: object, name: string, fallback: number): number => { const value: unknown = Reflect.get(server, name); return typeof value === "number" ? value : fallback; };
  const serve = (server: unknown, value: unknown): void => {
    if (!(server instanceof EventEmitter)) throw new TypeError("http._connectionListener requires a server");
    const socket = value instanceof net.Socket ? value : typeof value === "object" && value !== null ? admitted.get(value) : undefined;
    if (socket === undefined) throw new TypeError("HTTP requires a Linux socket");
    const state = tracking(server);
    const connection = createHttpConnection(socket, module, context, {
      Response: ServerResponse,
      request: (request, response) => {
        const expectation = request.headers["expect"];
        if (expectation !== undefined && request.httpVersionMajor === 1 && request.httpVersionMinor === 1) {
          if (typeof expectation === "string" && /^100-continue$/iu.test(expectation)) {
            if (server.listenerCount("checkContinue") !== 0) { server.emit("checkContinue", request, response); return; }
            response.writeContinue();
          } else {
            if (server.listenerCount("checkExpectation") !== 0) server.emit("checkExpectation", request, response);
            else { response.statusCode = 417; response.end(); }
            return;
          }
        }
        server.emit("request", request, response);
      },
      upgrade: (request, socket, head) => {
        state.connections.delete(socket);
        return server.emit(request.method === "CONNECT" ? "connect" : "upgrade", request, socket, head);
      },
      clientError: error => {
        if (server.emit("clientError", error, socket)) return true;
        if (socket.destroyed || socket.writableEnded || !(error instanceof HttpParseError)) return false;
        const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
        return true;
      },
      timeout: () => server.emit("timeout", socket),
      active: () => { socket.setTimeout(setting(server, "timeout", 0)); },
      idle: () => {
        const keepAlive = setting(server, "keepAliveTimeout", 5000), extra = setting(server, "keepAliveTimeoutBuffer", 1000);
        const delay = Number.isFinite(keepAlive) && keepAlive > 0 ? keepAlive : 0;
        const buffer = Number.isFinite(extra) && extra >= 0 ? extra : 0;
        if (delay === 0) return false;
        socket.setTimeout(Math.min(delay + buffer, 0x7fff_ffff)); return true;
      },
      closed: () => { state.connections.delete(socket); },
    });
    state.connections.set(socket, connection);
    socket.setTimeout(setting(server, "timeout", 0));
    if (state.closing) connection.closeWhenIdle(); else socket.resume();
  };
  function connectionListener(this: unknown, socket: unknown): void { serve(this, socket); }
  Object.defineProperty(connectionListener, "name", { value: "connectionListener" });
  class Server extends net.Server {
    timeout = 0;
    keepAliveTimeout = 5000;
    keepAliveTimeoutBuffer = 1000;
    constructor(value: unknown = {}, listener?: unknown) {
      super({ allowHalfOpen: true, pauseOnConnect: true });
      if (typeof value === "function") { listener = value; value = {}; }
      exactKeys(record(value, "http.Server options"), []);
      if (listener !== undefined) {
        if (typeof listener !== "function") throw new TypeError("http.Server requires a request callback");
        this.on("request", (...args: unknown[]) => { Reflect.apply(listener, this, args); });
      }
      this.on("listening", () => { reopenHttpConnections(this); });
      this.on("connection", connectionListener);
    }
    setTimeout(duration: unknown, callback?: unknown): this {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw new RangeError("http.Server timeout must be a nonnegative finite number");
      if (callback !== undefined) {
        if (!isEventListener(callback)) throw new TypeError("http.Server timeout requires a callback");
        this.on("timeout", callback);
      }
      this.timeout = duration; return this;
    }
    override close(callback?: unknown): this {
      super.close(callback); closeHttpConnections(this, "when-idle");
      return this;
    }
    closeIdleConnections(): void { closeHttpConnections(this, "idle"); }
    closeAllConnections(): void { closeHttpConnections(this, "all"); }
  }
  return { Server, _connectionListener: connectionListener, ServerResponse, IncomingMessage, METHODS: [...METHODS], STATUS_CODES, createServer: (options?: unknown, listener?: RequestListener) => new Server(options, listener) };
}
