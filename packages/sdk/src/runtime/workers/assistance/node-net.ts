import type { ProcessScheduler } from "./process-scheduler.js";
import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeAssistanceSocketAddress } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { ProcessIO } from "./process-io.js";
import type { AsyncContext } from "./async-context.js";
import { bindAsyncEvents, EventEmitter, streamError } from "./node-streams.js";
import { nodeResult } from "./node-file-operations.js";
import { createNodeSockets } from "./node-socket.js";
import type { SocketLookup, SocketNetworking } from "./node-socket-connect.js";
import { blockedAddress, BlockList, invalidBlockList, SocketAddress } from "./node-net-address.ts";
import { createServerHandle, normalizeArgs } from "./node-net-extras.ts";

type Listener = Extract<AssistanceResult, { kind: "socket" }>;

export type NodeServer = EventEmitter & {
  readonly listening: boolean;
  address(): object | null;
  ref(): NodeServer;
  unref(): NodeServer;
  listen(...args: unknown[]): NodeServer;
  close(callback?: unknown): NodeServer;
  getConnections(callback: unknown): void;
};
type NodeNet = ReturnType<typeof createNodeSockets> & {
  readonly Server: new (options?: unknown, listener?: unknown) => NodeServer;
  readonly createServer: (options?: unknown, listener?: unknown) => NodeServer;
  readonly isIP: (value: unknown) => number;
  readonly isIPv4: (value: unknown) => boolean;
  readonly isIPv6: (value: unknown) => boolean;
  readonly BlockList: typeof BlockList;
  readonly SocketAddress: typeof SocketAddress;
  readonly Stream: ReturnType<typeof createNodeSockets>["Socket"];
  readonly _normalizeArgs: typeof normalizeArgs;
  readonly _createServerHandle: typeof createServerHandle;
};

export function createNodeNet(io: Pick<ProcessIO, "call" | "callSync" | "retain">, context: AsyncContext, scheduler?: ProcessScheduler, networking?: SocketNetworking): NodeNet {
  const plain = createNodeSockets(io, context, scheduler, networking);
  const deliver = <Result>(callback: () => Result): Promise<Result> => scheduler === undefined
    ? Promise.resolve(callback()) : scheduler.execute(callback);
  const nextTick = (callback: () => void) => {
    if (scheduler === undefined) queueMicrotask(callback); else scheduler.nextTick(callback);
  };
  /** The Linux-backed socket, with Node's `blockList` option: an address the list holds is never connected to. */
  class Socket extends plain.Socket {
    #blockList: BlockList | undefined;
    constructor(value: unknown = {}) {
      const { blockList, rest } = withoutBlockList(value);
      super(rest);
      this.#blockList = blockList;
    }
    override connect(...args: unknown[]): this {
      const list = this.#blockList;
      if (list === undefined) { super.connect(...args); return this; }
      const last = args.at(-1), callback = typeof last === "function" ? last : undefined, values = callback === undefined ? args : args.slice(0, -1);
      const options: Record<string, unknown> = typeof values[0] === "object" && values[0] !== null ? withoutBlockList(values[0]).rest : { port: values[0], ...(values[1] === undefined ? {} : { host: values[1] }) };
      const host = options["host"] ?? "localhost", custom = options["lookup"], lookup = callLookup(custom) ?? networking?.lookup;
      const literal = typeof host !== "string" ? undefined : isIP(host) !== 0 ? host : host === "localhost" && lookup === undefined ? "127.0.0.1" : undefined;
      if (literal !== undefined && list.check(literal, `ipv${String(isIP(literal))}`)) {
        // Node finds the block one tick into the connection; until then the socket is connecting.
        Reflect.defineProperty(this, "connecting", { configurable: true, get: () => true });
        const run = context.capture();
        nextTick(() => { Reflect.deleteProperty(this, "connecting"); run(() => { this.destroy(blockedAddress(literal)); }); });
        return this;
      }
      const guarded = literal !== undefined || lookup === undefined ? options : { ...options, lookup: allowedLookup(lookup, list) };
      super.connect(...(callback === undefined ? [guarded] : [guarded, callback]));
      return this;
    }
  }
  Object.defineProperty(Socket, "name", { value: "Socket" });
  const createConnection = (...args: unknown[]): InstanceType<typeof Socket> => {
    const first = args[0], blockList: unknown = typeof first === "object" && first !== null ? Reflect.get(first, "blockList") : undefined;
    return new Socket(blockList === undefined ? {} : { blockList }).connect(...args);
  };
  const sockets = { ...plain, Socket, createConnection, connect: createConnection };
  class Server extends EventEmitter {
    #state: "idle" | "opening" | "listening" | "closing" = "idle";
    #listener: Listener | undefined;
    readonly #connections = new Set<InstanceType<typeof sockets.Socket>>();
    readonly #allowHalfOpen: boolean;
    readonly #pauseOnConnect: boolean;
    #referenced = true;
    #release: (() => void) | undefined;

    constructor(value: unknown = {}, listener?: unknown) {
      super();
      if (typeof value === "function") { listener = value; value = {}; }
      const options = record(value, "net.Server options");
      exactKeys(options, [], ["allowHalfOpen", "pauseOnConnect"]);
      for (const key of ["allowHalfOpen", "pauseOnConnect"] as const) {
        if (options[key] !== undefined && typeof options[key] !== "boolean") throw new TypeError(`Invalid net.Server ${key}`);
      }
      this.#allowHalfOpen = options["allowHalfOpen"] === true;
      this.#pauseOnConnect = options["pauseOnConnect"] === true;
      bindAsyncEvents(this, context);
      if (listener !== undefined) {
        if (typeof listener !== "function") throw new TypeError("net.Server requires a connection callback");
        this.on("connection", socket => { Reflect.apply(listener, this, [socket]); });
      }
    }

    get listening(): boolean { return this.#state === "listening"; }
    address(): object | null {
      const address = this.#listener?.local;
      return address === undefined ? null : { ...address, family: address.address.includes(":") ? "IPv6" : "IPv4" };
    }
    ref(): this { this.#referenced = true; this.#reference(); return this; }
    unref(): this { this.#referenced = false; this.#release?.(); this.#release = undefined; return this; }
    #reference(): void { if (this.#referenced && this.#state !== "idle") this.#release ??= io.retain(); }

    listen(...args: unknown[]): this {
      if (this.#state !== "idle") throw Object.assign(new Error("Listen method has been called more than once"), { code: "ERR_SERVER_ALREADY_LISTEN" });
      const { address, backlog, callback } = listenArguments(args);
      if (callback !== undefined) this.once("listening", () => { Reflect.apply(callback, this, []); });
      this.#state = "opening"; this.#reference();
      const run = context.capture();
      void (async () => {
        try {
          const result = nodeResult(await io.call({ kind: "socket-listen", address, backlog }, false));
          if (result.kind !== "socket" || result.peer !== null) throw new VMError("PROTOCOL_ERROR", "Linux did not return a listener");
          this.#listener = result;
          if (this.#state === "closing") { await this.#stop(); return; }
          this.#state = "listening";
        } catch (error) {
          const closing = this.#state === "closing";
          this.#release?.(); this.#release = undefined;
          this.#state = closing ? "closing" : "idle";
          await deliver(() => run(() => this.emit("error", streamError(error))));
          if (closing) this.#closed();
          return;
        }
        await deliver(() => run(() => this.emit("listening")));
        await this.#accept();
      })();
      return this;
    }

    close(callback?: unknown): this {
      if (callback !== undefined && typeof callback !== "function") throw new TypeError("net.Server.close requires a callback");
      if (this.#state === "idle") {
        if (callback !== undefined) {
          const run = context.capture();
          nextTick(() => run(() => { Reflect.apply(callback, this, [Object.assign(new Error("Server is not running"), { code: "ERR_SERVER_NOT_RUNNING" })]); }));
        }
        return this;
      }
      if (callback !== undefined) this.once("close", () => { Reflect.apply(callback, this, []); });
      if (this.#state === "closing") return this;
      const listening = this.#state === "listening";
      this.#state = "closing";
      if (listening) void this.#stop();
      return this;
    }

    getConnections(callback: unknown): void {
      if (typeof callback !== "function") throw new TypeError("net.Server.getConnections requires a callback");
      const run = context.capture();
      nextTick(() => run(() => { Reflect.apply(callback, this, [null, this.#connections.size]); }));
    }

    async #stop(): Promise<void> {
      try {
        if (this.#listener !== undefined) nodeResult(await io.call({ kind: "socket-close", fd: this.#listener.fd }));
      } catch (error) { await deliver(() => this.emit("error", streamError(error))); }
      finally {
        this.#listener = undefined;
        this.#release?.(); this.#release = undefined;
        this.#closed();
      }
    }

    #closed(): void {
      if (this.#state !== "closing" || this.#listener !== undefined || this.#connections.size !== 0) return;
      this.#state = "idle";
      nextTick(() => this.emit("close"));
    }

    async #accept(): Promise<void> {
      while (this.#state === "listening" && this.#listener !== undefined) {
        let socket: InstanceType<typeof sockets.Socket>;
        try {
          const result = nodeResult(await io.call({ kind: "socket-accept", fd: this.#listener.fd }, false));
          if (result.kind !== "socket" || result.peer === null) throw new VMError("PROTOCOL_ERROR", "Invalid accepted Linux socket");
          if (!this.listening) { nodeResult(await io.call({ kind: "socket-close", fd: result.fd })); return; }
          try { socket = new sockets.Socket({ fd: result.fd, allowHalfOpen: this.#allowHalfOpen }); }
          catch (error) { nodeResult(await io.call({ kind: "socket-close", fd: result.fd })); throw error; }
        } catch (error) { if (this.listening) await deliver(() => this.emit("error", streamError(error))); return; }
        this.#connections.add(socket);
        socket.once("close", () => { this.#connections.delete(socket); this.#closed(); });
        if (this.#pauseOnConnect) socket.pause();
        await deliver(() => this.emit("connection", socket));
        if (!this.#pauseOnConnect) socket.read(0);
      }
    }
  }
  return { ...sockets, Server, createServer: (options?: unknown, listener?: unknown) => new Server(options, listener),
    isIP, isIPv4: (value: unknown) => isIP(value) === 4, isIPv6: (value: unknown) => isIP(value) === 6,
    BlockList, SocketAddress, Stream: Socket, _normalizeArgs: normalizeArgs, _createServerHandle: createServerHandle };
}

/** Node reads `blockList` when it is truthy and refuses anything but a BlockList. */
function withoutBlockList(value: unknown): { blockList: BlockList | undefined; rest: Record<string, unknown> } {
  const { blockList, ...rest } = record(value, "net.Socket options");
  if (blockList === undefined || blockList === null || blockList === false || blockList === 0 || blockList === "") return { blockList: undefined, rest };
  if (!(blockList instanceof BlockList)) throw invalidBlockList(blockList);
  return { blockList, rest };
}
function callLookup(custom: unknown): SocketLookup | undefined {
  if (typeof custom !== "function") return undefined;
  return (host, options, callback) => { const value: unknown = Reflect.apply(custom, undefined, [host, options, callback]); return value; };
}
/** A lookup whose blocked answers are dropped, as Node skips them; when every answer is blocked the first is the error. */
function allowedLookup(lookup: SocketLookup, list: BlockList): SocketLookup {
  return (host, options, callback) => lookup(host, options, (error: unknown, value: unknown, family: unknown) => {
    if (typeof callback !== "function") return;
    const blocked = (address: unknown, kind: unknown): boolean => typeof address === "string" && list.check(address, kind === 6 ? "ipv6" : "ipv4");
    let answer: unknown[] = [error, value, family];
    if ((error === null || error === undefined) && Array.isArray(value)) {
      const entries: unknown[] = value, open = entries.filter(entry => !(typeof entry === "object" && entry !== null && blocked(Reflect.get(entry, "address"), Reflect.get(entry, "family"))));
      const first: unknown = entries[0];
      answer = open.length === 0 && typeof first === "object" && first !== null ? [blockedAddress(String(Reflect.get(first, "address")))] : [error, open, family];
    } else if ((error === null || error === undefined) && blocked(value, family)) answer = [blockedAddress(String(value))];
    Reflect.apply(callback, undefined, answer);
  });
}

function isIP(value: unknown): number {
  if (typeof value !== "string") return 0;
  try { decodeAssistanceSocketAddress({ address: value, port: 1 }); return value.includes(":") ? 6 : 4; }
  catch { return 0; }
}

export function listenArguments(input: readonly unknown[]) {
  const args = [...input];
  // Node reads the last function as the callback and takes a trailing undefined for "not given".
  const absent = (value: unknown): boolean => value === undefined || value === null;
  while (args.length > 0 && absent(args.at(-1))) args.pop();
  const last = args.at(-1); const callback = typeof last === "function" ? last : undefined;
  if (callback !== undefined) args.pop();
  while (args.length > 1 && absent(args.at(-1))) args.pop();
  let port: unknown; let host: unknown; let backlog: unknown;
  if (typeof args[0] === "object" && args[0] !== null) {
    if (args.length !== 1) throw new TypeError("Unsupported net.Server.listen arguments");
    const options = record(args[0], "net.listen options");
    exactKeys(options, ["port"], ["host", "backlog"]);
    port = options["port"]; host = options["host"]; backlog = options["backlog"];
  } else {
    if (args.length < 1 || args.length > 3) throw new TypeError("Unsupported net.Server.listen arguments");
    [port, host, backlog] = args;
    if (host === null) host = undefined;
    if (typeof host === "number" && backlog === undefined) { backlog = host; host = undefined; }
  }
  if (typeof port === "string" && /^[0-9]+$/u.test(port)) port = Number(port);
  if (host === undefined) host = "::";
  else if (host === "localhost") host = "127.0.0.1";
  return { address: decodeAssistanceSocketAddress({ address: host, port }, true),
    backlog: backlog === undefined ? 511 : integer(backlog, "listen backlog", 0, 0x7fff_ffff), callback };
}
