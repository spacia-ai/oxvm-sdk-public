import { Buffer } from "buffer";
import { VMError } from "../../errors.js";
import type { AsyncContext } from "./async-context.js";
import { admitHttpSocket } from "./node-http-server.ts";
import type { NodeServer } from "./node-net.js";
import { isEventListener } from "./node-streams.js";
import { tlsServerSockets, type TlsServerLink, type TlsServerSide, type TlsSocket } from "./node-tls.ts";
import { TLS_SERVER_FRAME, TlsServerBridge, type TlsServerChildren } from "./node-tls-server-bridge.ts";
import { TLS_SERVER_MAX_CONNECTIONS } from "./node-tls-server-guest.ts";
import { tlsContextOptions, tlsListenArguments, tlsReplacementContext, tlsServerOptions, type TlsServerOptions } from "./node-tls-server-options.ts";
import { tlsServerError, type TlsServerEvent } from "./node-tls-server-wire.ts";
import { invalidInstance, invalidType, validateFunction, validateString } from "./node-util-validators.ts";
import type { ProcessScheduler } from "./process-scheduler.js";

export type TlsServer = NodeServer & {
  allowHalfOpen: boolean; requestCert: boolean; rejectUnauthorized: boolean;
  setSecureContext(options: unknown): void;
  addContext(hostname: unknown, context?: unknown): void;
  getTicketKeys(): Buffer;
  setTicketKeys(keys: unknown): void;
};
export type TlsServers = {
  readonly Server: new (options?: unknown, listener?: unknown) => TlsServer;
  readonly createServer: (options?: unknown, listener?: unknown) => TlsServer;
};
export type TlsServerPorts = {
  readonly children: TlsServerChildren; readonly context: AsyncContext; readonly retain: () => () => void; readonly scheduler?: ProcessScheduler;
  /** The process's `tls` module: accepted connections are instances of its TLSSocket. */
  readonly tls: { readonly TLSSocket: object };
  /** The process's `net` module: a TLS server is an instance of its Server, as in Node. */
  readonly net: { readonly Server: new (options?: unknown, listener?: unknown) => NodeServer };
};
type Reply = PromiseWithResolvers<undefined>;
type Connection = {
  readonly side: TlsServerSide;
  write: { readonly count: number; readonly completion: Reply } | undefined;
  finish: Reply | undefined;
  /** The guest's stream finished its writable side. */
  finished: boolean;
  /** The guest's connection is gone. */
  closed: boolean;
  /** The guest sent the last plaintext of this connection. */
  marked: boolean;
  /** The program's socket was destroyed. */
  destroyed: boolean;
};

function coded(error: Error, code: string, more: Readonly<Record<string, unknown>> = {}): Error { return Object.assign(error, { code, ...more }); }
function brokenPipe(): Error { return coded(new Error("write EPIPE"), "EPIPE", { errno: -32, syscall: "write" }); }
function reply(): Reply { const completion = Promise.withResolvers<undefined>(); void completion.promise.catch(() => {}); return completion; }
const IDLE_LINK: TlsServerLink = { write: () => Promise.reject(brokenPipe()), finish: () => Promise.resolve(), acknowledge: () => {}, command: () => {}, destroy: () => {} };

/**
 * `tls.Server` and `tls.createServer`. The guest's own Node holds the listening socket, the handshakes and the
 * certificates: one helper process per listening server, started by `listen()` and gone once the server and its
 * connections have closed. This side holds only the plaintext streams, as TLSSocket objects.
 */
export function createTlsServers(ports: TlsServerPorts): TlsServers {
  const accept = tlsServerSockets(ports.tls);
  const nextTick = (callback: () => void): void => {
    const run = ports.context.capture();
    if (ports.scheduler === undefined) queueMicrotask(() => { run(callback); }); else ports.scheduler.nextTick(() => { run(callback); });
  };
  class Server extends ports.net.Server {
    allowHalfOpen: boolean;
    requestCert: boolean;
    rejectUnauthorized: boolean;
    #options: TlsServerOptions;
    readonly #contexts: { readonly hostname: string; readonly options: Readonly<Record<string, unknown>> }[] = [];
    #ticketKeys: Buffer | undefined;
    #bridge: TlsServerBridge | undefined;
    #state: "idle" | "opening" | "listening" | "closing" = "idle";
    #bound: { readonly address: string; readonly family: string; readonly port: number } | undefined;
    /** Whether Node would emit 'close' when the helper is gone: the server listened, or close() was called. */
    #closeDue = false;
    readonly #connections = new Map<number, Connection>();
    readonly #sockets = new Set<TlsSocket>();
    #referenced = true;
    #release: (() => void) | undefined;
    #requests = 0;

    constructor(options?: unknown, listener?: unknown) {
      super({});
      const callback = typeof options === "function" ? options : listener, given = typeof options === "function" ? undefined : options;
      if (given !== undefined && given !== null && typeof given !== "object") throw invalidType("options", "object", given);
      this.#options = tlsServerOptions(given, "tls.createServer", "tls");
      this.allowHalfOpen = this.#options.allowHalfOpen; this.requestCert = this.#options.requestCert; this.rejectUnauthorized = this.#options.rejectUnauthorized;
      if (callback !== undefined && callback !== null && callback !== false) {
        if (!isEventListener(callback)) throw invalidType("listener", "function", callback);
        this.on("secureConnection", callback);
      }
    }

    static {
      // net.Server declares `listening` as a prototype getter; this one answers for the helper.
      Object.defineProperty(Server.prototype, "listening", { configurable: true, enumerable: false, get(this: unknown): boolean { return this instanceof Server && this.#state === "listening"; } });
    }
    override address(): object | null { return this.#state === "listening" && this.#bound !== undefined ? { ...this.#bound } : null; }
    override ref(): this { this.#referenced = true; if (this.#bridge !== undefined) this.#release ??= ports.retain(); return this; }
    override unref(): this { this.#referenced = false; this.#release?.(); this.#release = undefined; return this; }

    override listen(...args: unknown[]): this {
      if (this.#state !== "idle") throw coded(new Error("Listen method has been called more than once without closing."), "ERR_SERVER_ALREADY_LISTEN");
      const { listen, callback } = tlsListenArguments(args, "tls.Server.listen", "tls");
      if (callback !== undefined) this.once("listening", callback);
      if (this.#referenced) this.#release = ports.retain();
      try {
        this.#bridge = new TlsServerBridge(ports.children, { options: this.#wire(), contexts: this.#contexts, listen }, {
          event: event => { this.#event(event); },
          data: (id, bytes) => { this.#data(id, bytes); },
          retired: error => { this.#retired(error); },
        }, ports.scheduler);
      } catch (error) { this.#release?.(); this.#release = undefined; throw error; }
      this.#state = "opening";
      return this;
    }

    override close(callback?: unknown): this {
      const running = this.#state === "opening" || this.#state === "listening";
      if (typeof callback === "function") {
        this.once("close", () => { Reflect.apply(callback, this, running ? [] : [coded(new Error("Server is not running."), "ERR_SERVER_NOT_RUNNING")]); });
      }
      if (this.#state === "idle") { nextTick(() => { this.emit("close"); }); return this; }
      if (!running) return this;
      this.#state = "closing"; this.#closeDue = true;
      this.#bridge?.send({ kind: "close" });
      return this;
    }

    override getConnections(callback: unknown): this {
      validateFunction(callback, "callback");
      nextTick(() => { Reflect.apply(callback, this, [null, this.#sockets.size]); });
      return this;
    }

    setSecureContext(options: unknown): void {
      const context = tlsReplacementContext(options, "tls.Server.setSecureContext", "tls");
      this.#options = { ...this.#options, context };
      if (this.#bridge === undefined) return;
      this.#bridge.options(this.#context()); this.#bridge.send({ kind: "secure-context", request: ++this.#requests });
    }

    addContext(hostname: unknown, context?: unknown): void {
      if (hostname === undefined || hostname === null || hostname === "" || hostname === false || hostname === 0) throw coded(new Error("\"servername\" is required parameter for Server.addContext"), "ERR_TLS_REQUIRED_SERVER_NAME");
      validateString(hostname, "hostname");
      const options = tlsContextOptions(context, "tls.Server.addContext", "tls");
      this.#contexts.push({ hostname, options });
      if (this.#bridge === undefined) return;
      this.#bridge.options(options); this.#bridge.send({ kind: "add-context", request: ++this.#requests, hostname });
    }

    /** The keys are made here on first use and given to the guest, so that this call can answer at once. */
    getTicketKeys(): Buffer {
      if (this.#ticketKeys === undefined) {
        this.#ticketKeys = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(48)));
        this.#bridge?.send({ kind: "ticket-keys", keys: this.#ticketKeys.toString("base64") });
      }
      return Buffer.from(this.#ticketKeys);
    }

    setTicketKeys(keys: unknown): void {
      if (!ArrayBuffer.isView(keys)) throw invalidInstance("buffer", "Buffer, TypedArray, or DataView", keys);
      if (keys.byteLength !== 48) {
        throw coded(new Error("Session ticket keys must be a 48-byte buffer\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n"), "ERR_INTERNAL_ASSERTION");
      }
      this.#ticketKeys = Buffer.from(new Uint8Array(keys.buffer, keys.byteOffset, keys.byteLength));
      this.#bridge?.send({ kind: "ticket-keys", keys: this.#ticketKeys.toString("base64") });
    }

    #context(): Readonly<Record<string, unknown>> {
      const held = this.#options.context;
      return this.#ticketKeys === undefined || held["ticketKeys"] !== undefined ? held : { ...held, ticketKeys: this.#ticketKeys.toString("base64") };
    }
    #wire(): Readonly<Record<string, unknown>> { return { ...this.#options.rest, ...this.#context() }; }
    #violation(message: string): void { this.#bridge?.fail(new VMError("PROTOCOL_ERROR", message)); }

    #event(event: Exclude<TlsServerEvent, { kind: "fatal" | "done" }>): void {
      switch (event.kind) {
        case "listening":
          if (this.#state !== "opening") return;
          this.#bound = { address: event.address, family: event.family, port: event.port };
          this.#state = "listening"; this.#closeDue = true; this.emit("listening"); return;
        case "error": this.emit("error", tlsServerError(event.error)); return;
        case "applied": if (event.error !== null) this.emit("error", tlsServerError(event.error)); return;
        case "closed": return;
        case "client-error":
          this.emit("tlsClientError", tlsServerError(event.error), accept(IDLE_LINK, { peer: null, allowHalfOpen: false, server: this }).socket); return;
        case "open": this.#open(event); return;
        case "written": case "finished": case "timeout": case "conn-error": case "conn-close": this.#connectionEvent(event);
      }
    }

    #open(event: Extract<TlsServerEvent, { kind: "open" }>): void {
      const bridge = this.#bridge, id = event.id;
      if (bridge === undefined) return;
      if (this.#connections.has(id) || this.#connections.size >= TLS_SERVER_MAX_CONNECTIONS) { this.#violation("Duplicate or excessive TLS server connection"); return; }
      const link: TlsServerLink = {
        write: async bytes => {
          for (let offset = 0; offset < bytes.length; offset += TLS_SERVER_FRAME) {
            if (connection.destroyed) throw coded(new Error("TLS socket is closed"), "ERR_SOCKET_CLOSED");
            if (connection.closed) throw brokenPipe();
            const part = bytes.subarray(offset, offset + TLS_SERVER_FRAME), completion = reply();
            connection.write = { count: part.length, completion };
            await bridge.write(id, part); await completion.promise;
          }
        },
        finish: async () => {
          if (connection.closed || connection.finished) return;
          if (connection.destroyed) throw coded(new Error("TLS socket is closed"), "ERR_SOCKET_CLOSED");
          const completion = reply(); connection.finish = completion;
          bridge.send({ kind: "end", id }); await completion.promise;
        },
        acknowledge: count => { if (!connection.closed && !connection.destroyed) bridge.send({ kind: "ack", id, count }); },
        command: control => { if (!connection.closed && !connection.destroyed) bridge.send({ ...control, id }); },
        destroy: () => {
          if (connection.destroyed) return;
          connection.destroyed = true; this.#settle(connection, coded(new Error("TLS socket is closed"), "ERR_SOCKET_CLOSED"));
          if (!connection.closed) bridge.send({ kind: "destroy", id });
        },
      };
      const side = accept(link, { secure: event.secure, peer: event.peer, allowHalfOpen: this.allowHalfOpen, server: this });
      const connection: Connection = { side, write: undefined, finish: undefined, finished: false, closed: false, marked: false, destroyed: false };
      const socket = side.socket;
      this.#connections.set(id, connection); this.#sockets.add(socket);
      socket.once("close", () => { this.#sockets.delete(socket); });
      admitHttpSocket(socket);
      // The helper sends this connection's plaintext only once it knows this side holds the connection.
      bridge.send({ kind: "accept", id });
      this.emit("secureConnection", socket);
    }

    #connectionEvent(event: Extract<TlsServerEvent, { kind: "written" | "finished" | "timeout" | "conn-error" | "conn-close" }>): void {
      const connection = this.#connections.get(event.id);
      if (connection === undefined) { this.#violation("Unknown TLS server connection"); return; }
      const socket = connection.side.socket;
      switch (event.kind) {
        case "written": {
          const pending = connection.write;
          if (connection.destroyed) return;
          if (pending === undefined || pending.count !== event.count) { this.#violation("Unmatched TLS server write"); return; }
          connection.write = undefined; pending.completion.resolve(undefined); return;
        }
        case "finished": connection.finished = true; connection.finish?.resolve(undefined); connection.finish = undefined; return;
        case "timeout": connection.side.timeout(); return;
        case "conn-error": if (!socket.destroyed) socket.destroy(tlsServerError(event.error)); return;
        case "conn-close":
          connection.closed = true; this.#settle(connection, brokenPipe());
          if (event.hadError && !socket.destroyed) socket.destroy(coded(new Error("read ECONNRESET"), "ECONNRESET", { errno: -104, syscall: "read" }));
          this.#retire(event.id, connection);
      }
    }

    #data(id: number, bytes: Buffer | null): void {
      const connection = this.#connections.get(id);
      if (connection === undefined) { this.#violation("Plaintext for an unknown TLS server connection"); return; }
      if (bytes === null) { connection.marked = true; connection.side.data(null); this.#retire(id, connection); }
      else if (connection.marked) this.#violation("Plaintext after the end of a TLS server connection");
      else connection.side.data(bytes);
    }

    /** A connection leaves once the guest has both closed it and sent its last plaintext. */
    #retire(id: number, connection: Connection): void {
      if (!connection.closed || !connection.marked) return;
      this.#connections.delete(id);
      // The guest never closes a healthy connection whose writable side this socket still holds open.
      if (!connection.finished && !connection.side.socket.destroyed) connection.side.socket.destroy();
    }

    #settle(connection: Connection, error: Error): void {
      connection.write?.completion.reject(error); connection.write = undefined;
      connection.finish?.reject(error); connection.finish = undefined;
    }

    #retired(error: Error | undefined): void {
      const closeDue = this.#closeDue;
      this.#bridge = undefined; this.#bound = undefined; this.#state = "idle"; this.#closeDue = false;
      this.#release?.(); this.#release = undefined;
      for (const connection of this.#connections.values()) {
        connection.closed = true; this.#settle(connection, error ?? brokenPipe());
        if (!connection.side.socket.destroyed) connection.side.socket.destroy(error);
      }
      this.#connections.clear();
      if (error !== undefined) this.emit("error", error);
      if (closeDue) this.emit("close");
    }
  }
  Object.defineProperty(Server, "name", { value: "Server" }); Object.defineProperty(Server, "length", { value: 2 });
  // Node assigns these to the prototype as anonymous functions.
  for (const [name, length] of [["listen", 0], ["close", 1], ["address", 0], ["getConnections", 1], ["ref", 0], ["unref", 0], ["setSecureContext", 1], ["addContext", 2]] as const) {
    const method: unknown = Reflect.get(Server.prototype, name);
    if (typeof method === "function") { Object.defineProperty(method, "name", { value: "" }); Object.defineProperty(method, "length", { value: length }); }
  }
  function createServer(options?: unknown, listener?: unknown): TlsServer { return new Server(options, listener); }
  Object.defineProperty(createServer, "name", { value: "createServer" }); Object.defineProperty(createServer, "length", { value: 2 });
  return { Server, createServer };
}
