import type { LinuxSocketAddress } from "../../../js-process-types.js";
import { LinuxError } from "../../js-process/codec.js";
import type { DgramSockets } from "./node-dgram-handle.ts";
import { canonicalIp } from "./node-net-address.ts";

const EPERM = 1, EINTR = 4, EBADF = 9, EACCES = 13, EDESTADDRREQ = 89, ENOPROTOOPT = 92, EADDRINUSE = 98, EADDRNOTAVAIL = 99, ENETUNREACH = 101, ENOTCONN = 107;
interface Datagram { readonly bytes: Uint8Array; readonly source: LinuxSocketAddress | null }
interface Endpoint {
  readonly family: "ipv4" | "ipv6";
  local: { address: string; port: number } | undefined;
  peer: { address: string; port: number } | undefined;
  /** Linux's SOCK_BINDPORT_LOCK: the program chose the port, so dissolving an association keeps it. */
  portLocked: boolean;
  readonly options: Map<string, number>;
  readonly queue: Datagram[];
  waiter: { resolve(datagram: Datagram): void } | undefined;
}
export type FakeOperation = "open" | "bind" | "connect" | "disconnect" | "name" | "setOption" | "sendNow" | "send" | "receive";

/** An address the way the Linux client decodes one: IPv6 as eight groups. */
function wire(family: "ipv4" | "ipv6", address: string, port: number): LinuxSocketAddress {
  if (family === "ipv4") return { family, address, port };
  const [head = "", tail] = address.split("::"), left = head === "" ? [] : head.split(":"), right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? left : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  return { family, address: groups.join(":"), port };
}
const canonical = (address: string): string => canonicalIp(address) ?? address;

/**
 * UDP as one VM's Linux serves it to its JavaScript processes, in memory: sockets of the same network exchange
 * datagrams over loopback, an address in use is refused, a broadcast needs SO_BROADCAST, and what is beyond the VM is
 * ENETUNREACH without a route and EPERM (the VM's network policy) with one. `refuse` makes the next call of an
 * operation fail with an errno.
 */
export class FakeUdpNetwork implements DgramSockets {
  readonly #endpoints = new Map<number, Endpoint>();
  readonly #refusals = new Map<FakeOperation, number[]>();
  readonly #routed: boolean;
  #nextFd = 10;
  #nextPort = 40_000;
  /** Every setsockopt Linux was asked for, as `level:option=value`. */
  readonly optionsSet: string[] = [];
  /** Datagrams that went through the waiting send rather than the immediate one. */
  waited = 0;
  constructor(options: { readonly routed?: boolean } = {}) { this.#routed = options.routed === true; }

  get openSockets(): number { return this.#endpoints.size; }
  refuse(operation: FakeOperation, errno: number): void { this.#refusals.set(operation, [...this.#refusals.get(operation) ?? [], errno]); }
  /** A receive failure for the socket's pending or next receive. */
  #refused(operation: FakeOperation): void {
    const errno = this.#refusals.get(operation)?.shift();
    if (errno !== undefined) throw new LinuxError(errno);
  }
  #endpoint(fd: number): Endpoint {
    const endpoint = this.#endpoints.get(fd);
    if (endpoint === undefined) throw new LinuxError(EBADF);
    return endpoint;
  }
  #wildcard(endpoint: Endpoint): string { return endpoint.family === "ipv4" ? "0.0.0.0" : "::"; }
  #autobind(endpoint: Endpoint): { address: string; port: number } {
    endpoint.local ??= { address: this.#wildcard(endpoint), port: this.#nextPort++ };
    return endpoint.local;
  }

  open(family: "ipv4" | "ipv6"): number {
    this.#refused("open");
    const fd = this.#nextFd++;
    this.#endpoints.set(fd, { family, local: undefined, peer: undefined, portLocked: false, options: new Map(), queue: [], waiter: undefined });
    return fd;
  }
  bind(fd: number, address: LinuxSocketAddress): void {
    this.#refused("bind");
    const endpoint = this.#endpoint(fd);
    if (address.family !== endpoint.family) throw new LinuxError(97);
    const wanted = canonical(address.address), wildcard = this.#wildcard(endpoint);
    if (wanted !== wildcard && wanted !== "::1" && !wanted.startsWith("127.")) throw new LinuxError(EADDRNOTAVAIL);
    for (const other of this.#endpoints.values()) {
      if (other === endpoint || other.family !== endpoint.family || other.local === undefined || address.port === 0 || other.local.port !== address.port) continue;
      if (other.local.address !== wanted && other.local.address !== wildcard && wanted !== wildcard) continue;
      const shared = (key: string): boolean => other.options.get(key) === 1 && endpoint.options.get(key) === 1;
      if (!shared("1:2") && !shared("1:15")) throw new LinuxError(EADDRINUSE);
    }
    endpoint.local = { address: wanted, port: address.port === 0 ? this.#nextPort++ : address.port };
    endpoint.portLocked = address.port !== 0;
  }
  connect(fd: number, address: LinuxSocketAddress): void {
    this.#refused("connect");
    const endpoint = this.#endpoint(fd);
    if (address.family === "unix") throw new LinuxError(97);
    this.#autobind(endpoint);
    endpoint.peer = { address: canonical(address.address), port: address.port };
  }
  /** As Linux does: a socket whose port the kernel chose loses it with its peer, and is bound afresh by its next send. */
  disconnect(fd: number): void {
    this.#refused("disconnect");
    const endpoint = this.#endpoint(fd);
    endpoint.peer = undefined;
    if (!endpoint.portLocked) endpoint.local = undefined;
  }
  name(fd: number, peer: boolean): LinuxSocketAddress {
    this.#refused("name");
    const endpoint = this.#endpoint(fd), named = peer ? endpoint.peer : endpoint.local ?? { address: this.#wildcard(endpoint), port: 0 };
    if (named === undefined) throw new LinuxError(ENOTCONN);
    return wire(endpoint.family, named.address, named.port);
  }
  setOption(fd: number, level: number, option: number, value: number): void {
    this.#refused("setOption");
    const endpoint = this.#endpoint(fd);
    if (level === 41 && endpoint.family === "ipv4") throw new LinuxError(ENOPROTOOPT);
    endpoint.options.set(`${String(level)}:${String(option)}`, value);
    this.optionsSet.push(`${String(level)}:${String(option)}=${String(value)}`);
  }
  #deliver(endpoint: Endpoint, bytes: Uint8Array, destination: LinuxSocketAddress | null): number {
    const local = this.#autobind(endpoint);
    const target: { address: string; port: number } | undefined = destination === null ? endpoint.peer : destination.family === "unix" ? undefined : { address: canonical(destination.address), port: destination.port };
    if (target === undefined) throw new LinuxError(EDESTADDRREQ);
    const loopback = target.address === "::1" || target.address.startsWith("127.");
    if (target.address === "255.255.255.255") {
      if (!this.#routed) throw new LinuxError(ENETUNREACH);
      if (endpoint.options.get("1:6") !== 1) throw new LinuxError(EACCES);
      return bytes.byteLength;
    }
    if (!loopback) throw new LinuxError(this.#routed ? EPERM : ENETUNREACH);
    const wildcard = this.#wildcard(endpoint), source = { address: local.address === wildcard ? target.address : local.address, port: local.port };
    for (const receiver of this.#endpoints.values()) {
      if (receiver.family !== endpoint.family || receiver.local?.port !== target.port) continue;
      if (receiver.local.address !== wildcard && receiver.local.address !== target.address) continue;
      if (receiver.peer !== undefined && (receiver.peer.address !== source.address || receiver.peer.port !== source.port)) continue;
      const datagram = { bytes: bytes.slice(), source: wire(endpoint.family, source.address, source.port) }, waiter = receiver.waiter;
      if (waiter === undefined) receiver.queue.push(datagram); else { receiver.waiter = undefined; waiter.resolve(datagram); }
      break;
    }
    return bytes.byteLength;
  }
  sendNow(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress | null): number {
    this.#refused("sendNow");
    return this.#deliver(this.#endpoint(fd), bytes, destination);
  }
  async send(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress | null): Promise<number> {
    this.waited += 1;
    await new Promise<void>(resolve => { setImmediate(resolve); });
    this.#refused("send");
    return this.#deliver(this.#endpoint(fd), bytes, destination);
  }
  receive(fd: number, _max: number, signal: AbortSignal): Promise<Datagram> {
    return new Promise((resolve, reject) => {
      const refusal = this.#refusals.get("receive")?.shift(), endpoint = this.#endpoints.get(fd);
      if (signal.aborted || endpoint === undefined) { reject(new LinuxError(signal.aborted ? EINTR : EBADF)); return; }
      if (refusal !== undefined) { reject(new LinuxError(refusal)); return; }
      const queued = endpoint.queue.shift();
      if (queued !== undefined) { resolve(queued); return; }
      const cancel = (): void => { endpoint.waiter = undefined; reject(new LinuxError(EINTR)); };
      endpoint.waiter = { resolve: datagram => { signal.removeEventListener("abort", cancel); resolve(datagram); } };
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  /** Linux confirms a close a turn later; until then the socket holds its address. */
  async close(fd: number): Promise<void> {
    await new Promise<void>(resolve => { setImmediate(resolve); });
    if (this.#endpoint(fd).waiter !== undefined) throw new Error("A socket was closed while its receive was pending");
    this.#endpoints.delete(fd);
  }
}
