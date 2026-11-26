/*!
 * Portions adapted from Node.js v24.18.1 lib/dgram.js and lib/internal/dgram.js (the Socket state machine, its
 * argument handling and its send queue), and from libuv's src/unix/udp.c (the checks made before a system call).
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { Buffer } from "buffer";
import { unavailableNodeApi } from "./node-capability.ts";
import {
  alreadyBound, badBufferSize, badSocketType, bufferSizeFailure, closedHandle, EBADF, EINVAL, errnoException, exceptionWithHostPort, invalidBlockListOption, invalidBuffer,
  isConnected, missingArgument, notConnected, notRunning, outOfBounds, validatePort,
} from "./node-dgram-errors.ts";
import { createDgramHandles, type DgramHandle, type DgramPorts } from "./node-dgram-handle.ts";
import { blockedAddress, BlockList, ipVersion } from "./node-net-address.ts";
import { EventEmitter } from "./node-streams.ts";
import { named, validateAbortSignal, validateFunction, validateInteger, validateNumber, validateString } from "./node-util-validators.ts";

export type { DgramPorts, DgramSockets } from "./node-dgram-handle.ts";

type Listener = (...args: unknown[]) => void;
type Lookup = (address: unknown, family: 4 | 6, callback: (error: unknown, address?: unknown) => void) => unknown;
const isListener = (value: unknown): value is Listener => typeof value === "function";
const isLookup = (value: unknown): value is Lookup => typeof value === "function";
/** An address as Node's handle reads the one a lookup answered: text, or nothing an address parser accepts. */
const addressText = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ? `${value}` : "";
/** JavaScript's truthiness of a value a program passed. */
const truthy = (value: unknown): boolean => Boolean(value);
const option = (options: object | undefined, key: string): unknown => options === undefined ? undefined : Reflect.get(options, key);

/** A block list as the socket consults it: Node calls its `check` with the address and the lowercase family. */
function blocks(list: unknown, address: string): boolean {
  if (typeof list !== "object" || list === null) return false;
  const check: unknown = Reflect.get(list, "check");
  return typeof check === "function" && Reflect.apply(check, list, [address, `ipv${String(ipVersion(address))}`]) === true;
}

/** A Buffer over the same bytes; the vendored Buffer views only an ArrayBuffer, so shared memory is copied. */
function bufferOver(view: ArrayBufferView, offset = 0, length = view.byteLength - offset): Buffer {
  return view.buffer instanceof ArrayBuffer ? Buffer.from(view.buffer, view.byteOffset + offset, length) : Buffer.from(new Uint8Array(view.buffer, view.byteOffset + offset, length));
}
/** Node's `sliceBuffer`: the part of one datagram a caller names by offset and length. */
function sliceBuffer(value: unknown, offset: unknown, length: unknown): Buffer {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  if (!ArrayBuffer.isView(buffer)) throw invalidBuffer("buffer", value);
  const from = Number(offset) >>> 0, count = Number(length) >>> 0;
  if (from > buffer.byteLength) throw outOfBounds("offset");
  if (from + count > buffer.byteLength) throw outOfBounds("length");
  return bufferOver(buffer, from, count);
}
/** Node's `fixBufferList`: every part as a Buffer, or nothing when one is neither text nor a view. */
function fixBufferList(list: readonly unknown[]): Buffer[] | undefined {
  const parts: Buffer[] = [];
  for (const part of list) {
    if (typeof part === "string") parts.push(Buffer.from(part));
    else if (Buffer.isBuffer(part)) parts.push(part);
    else if (ArrayBuffer.isView(part)) parts.push(bufferOver(part));
    else return undefined;
  }
  return parts;
}

const UNBOUND = 0, BINDING = 1, BOUND = 2, DISCONNECTED = 0, CONNECTING = 1, CONNECTED = 2;
interface State {
  handle: DgramHandle | null;
  receiving: boolean;
  bindState: 0 | 1 | 2;
  connectState: 0 | 1 | 2;
  queue: (() => void)[] | undefined;
  readonly lookup: Lookup;
  readonly reuseAddr: unknown; readonly reusePort: unknown; readonly ipv6Only: unknown;
  readonly recvBufferSize: unknown; readonly sendBufferSize: unknown;
  readonly receiveBlockList: unknown; readonly sendBlockList: unknown;
}

/** A UDP socket as programs hold it. */
export interface DgramSocket extends EventEmitter {
  type: unknown;
  bind(...args: unknown[]): this;
  connect(port?: unknown, address?: unknown, callback?: unknown): void;
  disconnect(): void;
  sendto(buffer?: unknown, offset?: unknown, length?: unknown, port?: unknown, address?: unknown, callback?: unknown): void;
  send(buffer?: unknown, offset?: unknown, length?: unknown, port?: unknown, address?: unknown, callback?: unknown): void;
  close(callback?: unknown): this;
  address(): { address: string; family: string; port: number };
  remoteAddress(): { address: string; family: string; port: number };
  setBroadcast(arg?: unknown): void;
  setTTL(ttl?: unknown): unknown;
  setMulticastTTL(ttl?: unknown): unknown;
  setMulticastLoopback(arg?: unknown): unknown;
  setMulticastInterface(interfaceAddress?: unknown): void;
  addMembership(multicastAddress?: unknown, interfaceAddress?: unknown): void;
  dropMembership(multicastAddress?: unknown, interfaceAddress?: unknown): void;
  addSourceSpecificMembership(sourceAddress?: unknown, groupAddress?: unknown, interfaceAddress?: unknown): void;
  dropSourceSpecificMembership(sourceAddress?: unknown, groupAddress?: unknown, interfaceAddress?: unknown): void;
  ref(): this;
  unref(): this;
  setRecvBufferSize(size?: unknown): void;
  setSendBufferSize(size?: unknown): void;
  getRecvBufferSize(): void;
  getSendBufferSize(): void;
  getSendQueueSize(): number;
  getSendQueueCount(): number;
  [Symbol.asyncDispose](): Promise<void>;
}
export interface NodeDgram {
  readonly Socket: new (type?: unknown, listener?: unknown) => DgramSocket;
  readonly createSocket: (type?: unknown, listener?: unknown) => DgramSocket;
  readonly _createSocketHandle: () => never;
}
/** What `node:dgram` runs on: the process's UDP sockets, its event loop, and the `dns.lookup` a socket resolves names with. */
export interface DgramDependencies extends DgramPorts {
  readonly nextTick: (callback: () => void) => void;
  readonly lookup: (...args: never[]) => unknown;
  /** `process.emitWarning`, for the deprecated underscore members (DEP0112). */
  readonly warn?: (message: string, type: string, code: string) => void;
}

/** Methods as Node declares them: assigned to the prototype, so enumerable and anonymous, with these arities. */
const METHODS: Readonly<Record<string, number>> = {
  bind: 2, connect: 3, disconnect: 0, sendto: 6, send: 6, close: 1, address: 0, remoteAddress: 0, setBroadcast: 1, setTTL: 1, setMulticastTTL: 1, setMulticastLoopback: 1,
  setMulticastInterface: 1, addMembership: 2, dropMembership: 2, addSourceSpecificMembership: 3, dropSourceSpecificMembership: 3, ref: 0, unref: 0,
  setRecvBufferSize: 1, setSendBufferSize: 1, getRecvBufferSize: 0, getSendBufferSize: 0, getSendQueueSize: 0, getSendQueueCount: 0,
};

/**
 * Node's `dgram` on the process's own UDP sockets. Linux owns every socket: binding, routing, delivery between the
 * processes of the VM and each refusal are its answers, reported in Node's shape. What has no Linux operation for a
 * JavaScript process (group membership, reading a buffer size, adopting a descriptor) is refused as unavailable.
 */
export function createNodeDgram(dependencies: DgramDependencies): NodeDgram {
  const { nextTick } = dependencies, handles = createDgramHandles(dependencies);
  const defaultLookup: unknown = dependencies.lookup;
  const warned = new Set<string>();
  const deprecated = (member: string): void => {
    if (warned.has("DEP0112")) return;
    warned.add("DEP0112"); dependencies.warn?.(`Socket.prototype.${member} is deprecated`, "DeprecationWarning", "DEP0112");
  };

  class Socket extends EventEmitter {
    type: unknown;
    readonly #state: State;

    constructor(type?: unknown, listener?: unknown) {
      super();
      const options = type !== null && typeof type === "object" ? type : undefined;
      let kind = type, lookup: unknown;
      if (options !== undefined) {
        kind = option(options, "type"); lookup = option(options, "lookup");
        for (const name of ["recvBufferSize", "sendBufferSize"]) {
          const size = option(options, name);
          if (truthy(size)) validateInteger(size, `options.${name}`, 0, 0xffff_ffff);
        }
        for (const name of ["receiveBlockList", "sendBlockList"]) {
          const list = option(options, name);
          if (Boolean(list) && !BlockList.isBlockList(list)) throw invalidBlockListOption(`options.${name}`, list);
        }
      }
      if (lookup !== undefined) validateFunction(lookup, "lookup");
      const resolver = lookup ?? defaultLookup;
      if (kind !== "udp4" && kind !== "udp6") throw badSocketType();
      if (!isLookup(resolver)) throw badSocketType();
      this.type = kind;
      if (isListener(listener)) this.on("message", listener);
      this.#state = {
        handle: handles.create(kind === "udp4" ? "ipv4" : "ipv6"), receiving: false, bindState: UNBOUND, connectState: DISCONNECTED, queue: undefined, lookup: resolver,
        reuseAddr: option(options, "reuseAddr"), reusePort: option(options, "reusePort"), ipv6Only: option(options, "ipv6Only"),
        recvBufferSize: option(options, "recvBufferSize"), sendBufferSize: option(options, "sendBufferSize"),
        receiveBlockList: option(options, "receiveBlockList"), sendBlockList: option(options, "sendBlockList"),
      };
      const signal = option(options, "signal");
      if (signal !== undefined) {
        validateAbortSignal(signal, "options.signal");
        const aborted = (): void => { if (this.#state.handle !== null) this.close(); };
        if (signal.aborted) aborted();
        else { signal.addEventListener("abort", aborted, { once: true }); this.once("close", () => { signal.removeEventListener("abort", aborted); }); }
      }
    }

    #running(): DgramHandle {
      if (this.#state.handle === null) throw notRunning();
      return this.#state.handle;
    }
    /** The handle a method reads without a health check: Node dereferences null there. */
    #handle(method: string): DgramHandle {
      if (this.#state.handle === null) throw closedHandle(method);
      return this.#state.handle;
    }
    /** `handle.lookup`: an absent address is the loopback of the socket's family. */
    #lookup(address: unknown, callback: (error: unknown, ip?: unknown) => void): void {
      const four = this.type === "udp4", fallback = four ? "127.0.0.1" : "::1";
      this.#state.lookup(truthy(address) ? address : fallback, four ? 4 : 6, callback);
    }
    #enqueue(entry: () => void): void {
      const state = this.#state;
      if (state.queue === undefined) { state.queue = []; this.once("listening", this.#flush); }
      state.queue.push(entry);
    }
    readonly #flush = (): void => {
      const queue = this.#state.queue ?? [];
      this.#state.queue = undefined;
      for (const entry of queue) entry();
    };
    /** A bind that failed: the socket may be bound again, and what waited for it is dropped before 'error' is heard. */
    #unbound(error: unknown): void {
      this.#state.bindState = UNBOUND;
      if (this.#state.queue !== undefined) { this.#state.queue = undefined; this.removeListener("listening", this.#flush); }
      this.emit("error", error);
    }
    #startListening(): void {
      const state = this.#state, handle = this.#running();
      handle.receive((bytes, source) => {
        if (source !== null && blocks(state.receiveBlockList, source.address)) return;
        const message = bufferOver(bytes);
        this.emit("message", message, { address: source?.address, family: source?.family, port: source?.port, size: message.length });
      }, errno => { this.emit("error", errnoException(errno, "recvmsg")); });
      state.receiving = true; state.bindState = BOUND;
      if (truthy(state.recvBufferSize)) this.#bufferSize(state.recvBufferSize, true, "set");
      if (truthy(state.sendBufferSize)) this.#bufferSize(state.sendBufferSize, false, "set");
      this.emit("listening");
    }
    #bufferSize(size: unknown, receive: boolean, mode: "set" | "get"): void {
      if (typeof size !== "number" || size >>> 0 !== size) throw badBufferSize();
      const handle = this.#handle("bufferSize");
      if (!handle.opened) throw bufferSizeFailure(EBADF, receive);
      // Reading a size is getsockopt, which a JavaScript process has no operation for; a zero size reads and discards.
      if (mode === "get") return unavailableNodeApi(receive ? "dgram.Socket.getRecvBufferSize" : "dgram.Socket.getSendBufferSize");
      if (size === 0) return;
      const errno = handle.setOption(1, receive ? 8 : 7, size);
      if (errno !== 0) throw bufferSizeFailure(errno, receive);
    }

    bind(...args: unknown[]): this {
      const state = this.#state, first = args[0], last = args.at(-1);
      this.#running();
      if (state.bindState !== UNBOUND) throw alreadyBound();
      state.bindState = BINDING;
      if (isListener(last)) {
        const removeListeners = (): void => { this.removeListener("error", removeListeners); this.removeListener("listening", onListening); };
        const onListening = (): void => { removeListeners(); Reflect.apply(last, this, []); };
        this.on("error", removeListeners); this.on("listening", onListening);
      }
      const options = first !== null && typeof first === "object" ? first : undefined;
      if (options !== undefined && typeof Reflect.get(options, "recvStart") === "function") return unavailableNodeApi("dgram.Socket.bind with a handle");
      const fd = option(options, "fd");
      if (typeof fd === "number" && (fd | 0) === fd && fd > 0) return unavailableNodeApi("dgram.Socket.bind with a file descriptor");
      const port = options === undefined ? first : option(options, "port"), given = options === undefined ? (typeof args[1] === "function" ? "" : args[1]) : option(options, "address");
      const address = truthy(given) ? given : this.type === "udp4" ? "0.0.0.0" : "::";
      this.#lookup(address, (error, ip) => {
        const handle = state.handle;
        if (handle === null) return;
        if (error !== null && error !== undefined && error !== false) { this.#unbound(error); return; }
        const text = addressText(ip);
        handle.bind(text, Number(truthy(port) ? port : 0) >>> 0 & 0xffff, { reuseAddr: Boolean(state.reuseAddr), reusePort: Boolean(state.reusePort), ipv6Only: Boolean(state.ipv6Only) }, errno => {
          if (state.handle === null) return;
          if (errno !== 0) this.#unbound(exceptionWithHostPort(errno, "bind", text, port));
          else this.#startListening();
        });
      });
      return this;
    }

    connect(port?: unknown, address?: unknown, callback?: unknown): void {
      const to = validatePort(port), state = this.#state;
      let host = address, done = callback;
      if (typeof host === "function") { done = host; host = ""; } else if (host === undefined) host = "";
      validateString(host, "address");
      if (state.connectState !== DISCONNECTED) throw isConnected();
      state.connectState = CONNECTING;
      if (state.bindState === UNBOUND) this.bind({ port: 0, exclusive: true }, null);
      const name = host, connect = (): void => { this.#connect(to, name, done); };
      if (state.bindState !== BOUND) this.#enqueue(connect); else connect();
    }
    #connect(port: number, address: string, callback: unknown): void {
      const state = this.#state, listener = isListener(callback) ? callback : undefined;
      if (listener !== undefined) this.once("connect", listener);
      this.#lookup(address, (failure, ip) => {
        const handle = state.handle;
        if (handle === null) return;
        const text = addressText(ip);
        let error: unknown = failure !== null && failure !== undefined && failure !== false ? failure : undefined;
        if (error === undefined && blocks(state.sendBlockList, text)) error = blockedAddress(text);
        if (error === undefined) { const errno = handle.connect(text, port); if (errno !== 0) error = exceptionWithHostPort(errno, "connect", address, port); }
        if (error !== undefined) {
          const reason = error;
          state.connectState = DISCONNECTED;
          nextTick(() => { if (listener === undefined) this.emit("error", reason); else { this.removeListener("connect", listener); listener(reason); } });
          return;
        }
        state.connectState = CONNECTED;
        nextTick(() => { this.emit("connect"); });
      });
    }
    disconnect(): void {
      const state = this.#state;
      if (state.connectState !== CONNECTED || state.handle === null) throw notConnected();
      const errno = state.handle.disconnect();
      if (errno !== 0) throw errnoException(errno, "connect");
      state.connectState = DISCONNECTED;
    }

    sendto(buffer?: unknown, offset?: unknown, length?: unknown, port?: unknown, address?: unknown, callback?: unknown): void {
      validateNumber(offset, "offset"); validateNumber(length, "length"); validateNumber(port, "port"); validateString(address, "address");
      this.send(buffer, offset, length, port, address, callback);
    }
    send(buffer?: unknown, offset?: unknown, length?: unknown, port?: unknown, address?: unknown, callback?: unknown): void {
      const state = this.#state, connected = state.connectState === CONNECTED;
      let data = buffer, to = port, host = address, done = callback;
      if (!connected) {
        if (Boolean(host) || (Boolean(to) && typeof to !== "function")) data = sliceBuffer(data, offset, length);
        else { done = to; to = offset; host = length; }
      } else {
        if (typeof length === "number") { data = sliceBuffer(data, offset, length); if (typeof to === "function") { done = to; to = null; } }
        else done = offset;
        if (Boolean(to) || Boolean(host)) throw isConnected();
      }
      let list: Buffer[] | undefined;
      if (Array.isArray(data)) { list = fixBufferList(data); if (list === undefined) throw invalidBuffer("buffer list arguments", data); }
      else if (typeof data === "string") list = [Buffer.from(data)];
      else if (Buffer.isBuffer(data)) list = [data];
      else if (ArrayBuffer.isView(data)) list = [bufferOver(data)];
      else throw invalidBuffer("buffer", data);
      const destination = connected ? undefined : validatePort(to);
      if (typeof done !== "function") done = undefined;
      if (typeof host === "function") { done = host; host = undefined; } else if (host !== undefined && host !== null) validateString(host, "address");
      this.#running();
      if (state.bindState === UNBOUND) this.bind({ port: 0, exclusive: true }, null);
      const parts = list, name = host, listener = isListener(done) ? done : undefined;
      const send = (): void => { this.#send(parts, destination, name, listener); };
      // Until the socket is bound the datagram waits; it is sent once 'listening' has been emitted.
      if (state.bindState !== BOUND) { this.#enqueue(send); return; }
      send();
    }
    #send(list: readonly Buffer[], port: number | undefined, address: unknown, callback: Listener | undefined): void {
      const state = this.#state;
      const afterDns = (failure: unknown, ip: unknown): void => {
        if (failure !== null && failure !== undefined && failure !== false) {
          nextTick(() => { if (callback === undefined) this.emit("error", failure); else callback(failure); });
          return;
        }
        const handle = state.handle;
        if (handle === null) return;
        const text = ip === null ? null : addressText(ip);
        if (text !== null && blocks(state.sendBlockList, text)) { if (callback !== undefined) nextTick(() => { callback(blockedAddress(text)); }); return; }
        const bytes = list.length === 1 && list[0] !== undefined ? list[0] : Buffer.concat([...list]);
        // A send without a callback reports nothing, as in Node: its failure is not an 'error' event.
        handle.send(bytes, text === null || port === undefined ? null : { address: text, port }, callback === undefined ? undefined : (errno, sent, late) => {
          const deliver = (): void => { if (errno === 0) callback(null, sent); else callback(exceptionWithHostPort(errno, "send", address, port)); };
          if (late) deliver(); else nextTick(deliver);
        });
      };
      if (state.connectState === CONNECTED) afterDns(null, null); else this.#lookup(address, afterDns);
    }

    close(callback?: unknown): this {
      const state = this.#state;
      if (isListener(callback)) this.on("close", callback);
      if (state.queue !== undefined) { state.queue.push(() => { this.close(); }); return this; }
      const handle = this.#running();
      state.receiving = false; state.handle = null;
      handle.close();
      nextTick(() => { this.emit("close"); });
      return this;
    }
    address(): { address: string; family: string; port: number } {
      const name = this.#running().name(false);
      if (typeof name === "number") throw errnoException(name, "getsockname");
      return name;
    }
    remoteAddress(): { address: string; family: string; port: number } {
      const handle = this.#running();
      if (this.#state.connectState !== CONNECTED) throw notConnected();
      const name = handle.name(true);
      if (typeof name === "number") throw errnoException(name, "getpeername");
      return name;
    }

    #option(method: string, errno: number): void { if (errno !== 0) throw errnoException(errno, method); }
    setBroadcast(arg?: unknown): void { this.#option("setBroadcast", this.#handle("setBroadcast").setOption(1, 6, truthy(arg) ? 1 : 0)); }
    setTTL(ttl?: unknown): unknown {
      validateNumber(ttl, "ttl");
      const handle = this.#handle("setTTL"), value = ttl | 0, six = this.type === "udp6";
      // libuv refuses a hop limit outside 1..255 before it asks Linux.
      this.#option("setTTL", value < 1 || value > 255 ? EINVAL : handle.setOption(six ? 41 : 0, six ? 16 : 2, value));
      return ttl;
    }
    setMulticastTTL(ttl?: unknown): unknown {
      validateNumber(ttl, "ttl");
      const six = this.type === "udp6";
      this.#option("setMulticastTTL", this.#handle("setMulticastTTL").setOption(six ? 41 : 0, six ? 18 : 33, ttl | 0));
      return ttl;
    }
    setMulticastLoopback(arg?: unknown): unknown {
      const six = this.type === "udp6";
      this.#option("setMulticastLoopback", this.#handle("setMulticastLoopback").setOption(six ? 41 : 0, six ? 19 : 34, truthy(arg) ? 1 : 0));
      return arg;
    }
    setMulticastInterface(interfaceAddress?: unknown): void {
      const handle = this.#running();
      validateString(interfaceAddress, "interfaceAddress");
      const version = ipVersion(interfaceAddress);
      if (version === 0) throw errnoException(EINVAL, "setMulticastInterface");
      if (!handle.opened) throw errnoException(EBADF, "setMulticastInterface");
      // An IPv6 interface is named by its zone, and a zone's index is the kernel's to give: there is no operation for it.
      if (version === 6 && interfaceAddress.includes("%")) return unavailableNodeApi("dgram.Socket.setMulticastInterface with an IPv6 zone");
      const [a = 0, b = 0, c = 0, d = 0] = version === 4 ? interfaceAddress.split(".").map(Number) : [];
      this.#option("setMulticastInterface", version === 4 ? handle.setOption(0, 32, (a | b << 8 | c << 16 | d << 24) >>> 0) : handle.setOption(41, 17, 0));
    }
    /** Membership options take a structure (`ip_mreq`, `ipv6_mreq`, `ip_mreq_source`); setsockopt for a JavaScript process carries one integer. */
    #membership(method: string, ...addresses: unknown[]): never {
      for (const address of addresses) if (typeof address !== "string" || ipVersion(address) === 0) throw errnoException(EINVAL, method);
      return unavailableNodeApi(`dgram.Socket.${method}`);
    }
    addMembership(multicastAddress?: unknown, interfaceAddress?: unknown): void {
      this.#running();
      if (!truthy(multicastAddress)) throw missingArgument("multicastAddress");
      this.#membership("addMembership", multicastAddress, ...(interfaceAddress === undefined ? [] : [interfaceAddress]));
    }
    dropMembership(multicastAddress?: unknown, interfaceAddress?: unknown): void {
      this.#running();
      if (!truthy(multicastAddress)) throw missingArgument("multicastAddress");
      this.#membership("dropMembership", multicastAddress, ...(interfaceAddress === undefined ? [] : [interfaceAddress]));
    }
    addSourceSpecificMembership(sourceAddress?: unknown, groupAddress?: unknown, interfaceAddress?: unknown): void {
      this.#running();
      validateString(sourceAddress, "sourceAddress"); validateString(groupAddress, "groupAddress");
      this.#membership("addSourceSpecificMembership", sourceAddress, groupAddress, ...(interfaceAddress === undefined ? [] : [interfaceAddress]));
    }
    dropSourceSpecificMembership(sourceAddress?: unknown, groupAddress?: unknown, interfaceAddress?: unknown): void {
      this.#running();
      validateString(sourceAddress, "sourceAddress"); validateString(groupAddress, "groupAddress");
      this.#membership("dropSourceSpecificMembership", sourceAddress, groupAddress, ...(interfaceAddress === undefined ? [] : [interfaceAddress]));
    }
    ref(): this { this.#state.handle?.ref(true); return this; }
    unref(): this { this.#state.handle?.ref(false); return this; }
    setRecvBufferSize(size?: unknown): void { this.#bufferSize(size, true, "set"); }
    setSendBufferSize(size?: unknown): void { this.#bufferSize(size, false, "set"); }
    getRecvBufferSize(): void { this.#bufferSize(0, true, "get"); }
    getSendBufferSize(): void { this.#bufferSize(0, false, "get"); }
    getSendQueueSize(): number { return this.#handle("getSendQueueSize").queued().bytes; }
    getSendQueueCount(): number { return this.#handle("getSendQueueCount").queued().count; }

    get _handle(): object | null { deprecated("_handle"); const handle = this.#state.handle; return handle === null ? null : { fd: handle.fd() }; }
    set _handle(_value: unknown) { deprecated("_handle"); unavailableNodeApi("dgram.Socket._handle assignment"); }
    get _receiving(): boolean { deprecated("_receiving"); return this.#state.receiving; }
    set _receiving(value: unknown) { deprecated("_receiving"); this.#state.receiving = Boolean(value); }
    get _bindState(): number { deprecated("_bindState"); return this.#state.bindState; }
    set _bindState(value: unknown) { deprecated("_bindState"); if (value === UNBOUND || value === BINDING || value === BOUND) this.#state.bindState = value; }
    get _queue(): unknown { deprecated("_queue"); return this.#state.queue; }
    set _queue(_value: unknown) { deprecated("_queue"); }
    get _reuseAddr(): unknown { deprecated("_reuseAddr"); return this.#state.reuseAddr; }
    set _reuseAddr(_value: unknown) { deprecated("_reuseAddr"); }
    _healthCheck(): void { deprecated("_healthCheck()"); this.#running(); }
    _stopReceiving(): void {
      deprecated("_stopReceiving()");
      if (!this.#state.receiving) return;
      this.#state.handle?.stop(); this.#state.receiving = false;
    }

    async [Symbol.asyncDispose](): Promise<void> {
      if (this.#state.handle === null) return;
      await new Promise<void>(resolve => { this.close(() => { resolve(); }); });
    }
  }
  named(Socket, "Socket");
  for (const [name, length] of Object.entries(METHODS)) {
    const method: unknown = Reflect.get(Socket.prototype, name);
    if (typeof method !== "function") continue;
    Object.defineProperty(method, "name", { value: "", configurable: true }); Object.defineProperty(method, "length", { value: length, configurable: true });
    Object.defineProperty(Socket.prototype, name, { value: method, writable: true, enumerable: true, configurable: true });
  }
  for (const name of ["_healthCheck", "_stopReceiving"]) {
    const method: unknown = Reflect.get(Socket.prototype, name);
    if (typeof method !== "function") continue;
    Object.defineProperty(method, "name", { value: "deprecated", configurable: true });
    Object.defineProperty(Socket.prototype, name, { value: method, writable: true, enumerable: true, configurable: true });
  }
  const createSocket = named(function (type?: unknown, listener?: unknown): DgramSocket { return new Socket(type, listener); }, "createSocket");
  /** Node's deprecated factory of raw UDP handles (DEP0112): there is no handle object to give. */
  const createSocketHandle = named(function (): never { return unavailableNodeApi("dgram._createSocketHandle"); }, "deprecated");
  return { _createSocketHandle: createSocketHandle, createSocket, Socket };
}
