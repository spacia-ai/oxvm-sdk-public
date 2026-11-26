import type { LinuxSocketAddress } from "../../../js-process-types.js";
import { LinuxError } from "../../js-process/codec.js";
import { unavailableNodeApi } from "./node-capability.ts";
import { EADDRINUSE, EAFNOSUPPORT, EAGAIN, EBADF, EINVAL } from "./node-dgram-errors.ts";
import { canonicalIp, ipVersion } from "./node-net-address.ts";

/**
 * The process's own UDP sockets, as `datagramSockets(client)` of `runtime/js-process/sockets.ts` builds them from its
 * Linux client. What Node's handle answers at once is synchronous; a send that must wait and every receive are not.
 * Each method fails with the `LinuxError` of the errno Linux answered.
 */
export interface DgramSockets {
  open(family: "ipv4" | "ipv6"): number;
  bind(fd: number, address: LinuxSocketAddress): void;
  connect(fd: number, address: LinuxSocketAddress): void;
  disconnect(fd: number): void;
  name(fd: number, peer: boolean): LinuxSocketAddress;
  /** setsockopt with one 32-bit integer value. */
  setOption(fd: number, level: number, option: number, value: number): void;
  /** sendto with MSG_DONTWAIT: the bytes sent, or EAGAIN when the datagram would have to wait. */
  sendNow(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress | null): number;
  send(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress | null): Promise<number>;
  /** Waits for one datagram; aborting the signal ends the wait with a rejection. */
  receive(fd: number, max: number, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly source: LinuxSocketAddress | null }>;
  close(fd: number): Promise<void>;
}
/** How the sockets join the process: its UDP sockets, a hold on its event loop and its callback queue. */
export interface DgramPorts {
  readonly sockets: DgramSockets;
  readonly retain: () => () => void;
  readonly dispatch: (callback: () => void) => void;
}

export interface DgramName { address: string; family: "IPv4" | "IPv6"; port: number }
export interface DgramBindFlags { readonly reuseAddr: boolean; readonly reusePort: boolean; readonly ipv6Only: boolean }
/** One socket as libuv's `uv_udp_t` behaves: no descriptor until it is bound, and an errno (0 for success) from each call. */
export interface DgramHandle {
  readonly opened: boolean;
  fd(): number;
  bind(ip: string, port: number, flags: DgramBindFlags, done: (errno: number) => void): void;
  connect(ip: string, port: number): number;
  disconnect(): number;
  name(peer: boolean): DgramName | number;
  setOption(level: number, option: number, value: number): number;
  /** `late` tells a completion that arrived after the call returned from one known at once. */
  send(bytes: Uint8Array, destination: { readonly address: string; readonly port: number } | null, done?: (errno: number, sent: number, late: boolean) => void): void;
  receive(message: (bytes: Uint8Array, source: DgramName | null) => void, failed: (errno: number) => void): void;
  stop(): void;
  ref(referenced: boolean): void;
  queued(): { readonly bytes: number; readonly count: number };
  close(): void;
}

/** The largest datagram a receive asks for: the receive operation's own bound, above any UDP payload. */
const MAX_DATAGRAM = 64 * 1024;
const EINTR = 4;
const SOL_SOCKET = 1, SO_REUSEADDR = 2, SO_REUSEPORT = 15, IPPROTO_IPV6 = 41, IPV6_V6ONLY = 26;

function named(address: LinuxSocketAddress | null): DgramName | null {
  if (address === null || address.family === "unix") return null;
  return address.family === "ipv4" ? { address: address.address, family: "IPv4", port: address.port }
    : { address: canonicalIp(address.address) ?? address.address, family: "IPv6", port: address.port };
}
/** The errno of a Linux refusal; anything else is not Linux's answer and is not turned into one. */
function errnoOf(error: unknown): number {
  if (error instanceof LinuxError) return error.errno;
  throw error instanceof Error ? error : new TypeError("A datagram socket operation failed without an error");
}
function attempt(run: () => void): number {
  try { run(); return 0; } catch (error) { return errnoOf(error); }
}

export function createDgramHandles(ports: DgramPorts): { create(family: "ipv4" | "ipv6"): DgramHandle } {
  const { sockets, retain, dispatch } = ports;
  /** Descriptors this process has closed whose close Linux has not confirmed: until then their addresses may be taken. */
  const closing = new Set<Promise<void>>();
  /** Closes a descriptor once `before` has settled, holding the process until Linux has confirmed. */
  const discard = (fd: number, before: Promise<void>): void => {
    const release = retain();
    const done: Promise<void> = before.then(() => sockets.close(fd)).catch(() => undefined).finally(() => { closing.delete(done); release(); });
    closing.add(done);
  };

  function create(family: "ipv4" | "ipv6"): DgramHandle {
    const version = family === "ipv4" ? 4 : 6;
    let descriptor: number | undefined, closed = false, referenced = true, hold: (() => void) | undefined;
    let receiver: AbortController | undefined, loop: Promise<void> = Promise.resolve();
    let queuedBytes = 0, queuedCount = 0;
    /** A receiving socket keeps the process alive unless it was unref'd. */
    const updateHold = (): void => {
      const wanted = receiver !== undefined && referenced && !closed;
      if (wanted && hold === undefined) hold = retain();
      else if (!wanted && hold !== undefined) { const release = hold; hold = undefined; release(); }
    };
    const address = (ip: string, port: number): LinuxSocketAddress | number => {
      if (ipVersion(ip) !== version) return EINVAL;
      // A zone names an interface, and its index is the kernel's to give: there is no operation for that.
      if (ip.includes("%")) return unavailableNodeApi("dgram with an IPv6 zone");
      return { family, address: ip, port };
    };
    /** socket, the options libuv sets before binding, then bind: the descriptor exists only if all of it succeeded. */
    const tryBind = (target: LinuxSocketAddress, flags: DgramBindFlags): number => {
      let fd: number | undefined;
      try {
        fd = sockets.open(family);
        if (flags.reuseAddr) sockets.setOption(fd, SOL_SOCKET, SO_REUSEADDR, 1);
        if (flags.reusePort) sockets.setOption(fd, SOL_SOCKET, SO_REUSEPORT, 1);
        if (flags.ipv6Only) sockets.setOption(fd, IPPROTO_IPV6, IPV6_V6ONLY, 1);
        sockets.bind(fd, target);
        descriptor = fd;
        return 0;
      } catch (error) {
        if (fd !== undefined) discard(fd, Promise.resolve());
        const errno = errnoOf(error);
        return errno === EAFNOSUPPORT ? EINVAL : errno;
      }
    };
    /** Runs a receive callback in the process's queue, and resolves a turn of that queue later: as after each libuv
     * callback, what the program does in reaction (its ticks and promise jobs) runs before the next datagram is heard. */
    const delivered = (signal: AbortSignal, run: () => void): Promise<void> => new Promise(resolve => {
      dispatch(() => { try { if (!signal.aborted) run(); } finally { dispatch(resolve); } });
    });
    const receiveLoop = async (fd: number, signal: AbortSignal, message: (bytes: Uint8Array, source: DgramName | null) => void, failed: (errno: number) => void): Promise<void> => {
      const stopped = (): boolean => signal.aborted;
      while (!stopped()) {
        try {
          const datagram = await sockets.receive(fd, MAX_DATAGRAM, signal);
          // The next receive is asked for once this datagram has been heard, so a slow listener holds back Linux's queue, not this one.
          await delivered(signal, () => { message(datagram.bytes, named(datagram.source)); });
        } catch (error) {
          if (stopped()) return;
          if (!(error instanceof LinuxError)) { const failure = error instanceof Error ? error : new TypeError("A datagram receive failed without an error"); dispatch(() => { throw failure; }); return; }
          const errno = error.errno;
          if (errno === EINTR || errno === EAGAIN) continue;
          await delivered(signal, () => { failed(errno); });
          if (errno === EBADF) return;
        }
      }
    };

    return {
      get opened() { return descriptor !== undefined; },
      fd: () => descriptor ?? -1,
      bind(ip, port, flags, done) {
        if (flags.ipv6Only && family === "ipv4") { done(EINVAL); return; }
        const target = address(ip, port);
        if (typeof target === "number") { done(target); return; }
        const pending = [...closing], first = tryBind(target, flags);
        if (first !== EADDRINUSE || pending.length === 0) { done(first); return; }
        // A socket this process closed a moment ago may still hold the address: ask again once Linux has closed it.
        const release = retain();
        void Promise.all(pending).then(() => { dispatch(() => { try { if (!closed) done(tryBind(target, flags)); } finally { release(); } }); });
      },
      connect(ip, port) {
        if (descriptor === undefined) return EBADF;
        const fd = descriptor, target = address(ip, port);
        return typeof target === "number" ? target : attempt(() => { sockets.connect(fd, target); });
      },
      disconnect() {
        if (descriptor === undefined) return EBADF;
        const fd = descriptor;
        return attempt(() => { sockets.disconnect(fd); });
      },
      name(peer) {
        if (descriptor === undefined) return EBADF;
        try { return named(sockets.name(descriptor, peer)) ?? EINVAL; } catch (error) { return errnoOf(error); }
      },
      setOption(level, option, value) {
        if (descriptor === undefined) return EBADF;
        const fd = descriptor;
        return attempt(() => { sockets.setOption(fd, level, option, value); });
      },
      send(bytes, destination, done) {
        if (descriptor === undefined) { done?.(EBADF, 0, false); return; }
        const fd = descriptor, target = destination === null ? null : address(destination.address, destination.port);
        if (typeof target === "number") { done?.(target, 0, false); return; }
        // libuv's uv_udp_try_send: the datagram leaves at once unless Linux would have to wait.
        let sent: number | undefined, refused = 0;
        try { sent = sockets.sendNow(fd, bytes, target); } catch (error) { refused = errnoOf(error); }
        if (sent !== undefined) { done?.(0, sent, false); return; }
        if (refused !== EAGAIN) { done?.(refused, 0, false); return; }
        queuedBytes += bytes.byteLength; queuedCount += 1;
        const release = retain();
        const settle = (errno: number, sent: number): void => {
          queuedBytes -= bytes.byteLength; queuedCount -= 1;
          dispatch(() => { try { done?.(errno, sent, true); } finally { release(); } });
        };
        sockets.send(fd, bytes, target).then(count => { settle(0, count); }, (error: unknown) => {
          if (error instanceof LinuxError) { settle(error.errno, 0); return; }
          queuedBytes -= bytes.byteLength; queuedCount -= 1;
          const failure = error instanceof Error ? error : new TypeError("A datagram send failed without an error");
          dispatch(() => { release(); throw failure; });
        });
      },
      receive(message, failed) {
        if (descriptor === undefined || receiver !== undefined || closed) return;
        const controller = new AbortController();
        receiver = controller; updateHold();
        loop = receiveLoop(descriptor, controller.signal, message, failed);
      },
      stop() {
        receiver?.abort(); receiver = undefined; updateHold();
      },
      ref(on) { referenced = on; updateHold(); },
      queued: () => ({ bytes: queuedBytes, count: queuedCount }),
      close() {
        if (closed) return;
        closed = true;
        receiver?.abort(); receiver = undefined; updateHold();
        // The wait for a datagram is cancelled first: Linux keeps a socket whose receive is still pending.
        if (descriptor !== undefined) { discard(descriptor, loop); descriptor = undefined; }
      },
    };
  }
  return { create };
}
