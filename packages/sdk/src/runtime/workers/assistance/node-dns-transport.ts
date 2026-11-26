import type { LinuxSocketAddress } from "../../../js-process-types.js";
import { parseAddress } from "./node-dns-address.ts";
import type { DnsServer } from "./node-dns-config.ts";
import { DnsTransportError, type DnsExchange, type DnsTransport } from "./node-dns-resolver.ts";

/**
 * The process's own VM sockets, as the resolver uses them: the datagram operations of OXJR 41/44/45 and the stream
 * operations of OXJR 41/42 with the descriptor reads and writes. `processSockets(client, files)` of
 * `wasm/runner/net-ports.ts` builds exactly this from a process's Linux client. Rust's socket owner applies the VM's
 * network policy to every socket opened here.
 */
export interface DnsSockets {
  stream(family: "ipv4" | "ipv6"): Promise<number>;
  connect(fd: number, address: LinuxSocketAddress, signal?: AbortSignal): Promise<void>;
  /** Up to `max` bytes; an empty answer is the peer's end of stream. */
  read(fd: number, max: number, signal?: AbortSignal): Promise<Uint8Array>;
  write(fd: number, bytes: Uint8Array, signal?: AbortSignal): Promise<number>;
  close(fd: number): Promise<void>;
  datagram(family: "ipv4" | "ipv6"): Promise<number>;
  sendTo(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress): Promise<number>;
  receiveFrom(fd: number, max: number, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly source: LinuxSocketAddress | null }>;
}

/** The timer the transport bounds a wait with; the process's own `setTimeout` by default. */
export interface DnsTimers {
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}
const hostTimers: DnsTimers = (() => {
  const set = globalThis.setTimeout.bind(globalThis), clear = globalThis.clearTimeout.bind(globalThis), pending = new Map<object, ReturnType<typeof setTimeout>>();
  return {
    set: (callback, ms) => { const key = {}; pending.set(key, set(() => { pending.delete(key); callback(); }, ms)); return key; },
    clear: timer => { if (typeof timer !== "object" || timer === null) return; const handle = pending.get(timer); pending.delete(timer); if (handle !== undefined) clear(handle); },
  };
})();

/** A UDP reply is at most 64 KiB; a TCP one is bounded by its 16-bit length. */
const MAX_DATAGRAM = 64 * 1024, READ_CHUNK = 16 * 1024;

const linuxAddress = (server: DnsServer): LinuxSocketAddress => ({ family: server.family === 4 ? "ipv4" : "ipv6", address: server.address, port: server.port });

/** Whether a datagram came from the server asked: c-ares drops replies from anywhere else. */
function fromServer(source: LinuxSocketAddress | null, server: DnsServer): boolean {
  if (source === null) return true;
  if (source.family === "unix" || source.port !== server.port) return false;
  const from = parseAddress(source.address), to = parseAddress(server.address);
  return from !== undefined && to !== undefined && from.family === to.family && from.bytes.every((byte, index) => byte === to.bytes[index]);
}

/**
 * How many exchanges of one process hold a socket at once, and how long an unused datagram socket is kept for the next
 * question. Every socket that reaches the VM's resolver is one stream of the VM's relay connection, which carries 64
 * streams for the whole VM and keeps a closed one on its books until the relay confirms it. Measured in the VM with a
 * socket per question: 200 lookups started together (400 sockets) stopped the process and then the VM's network, and
 * so did ten rounds of 30 parallel lookups even with 16 sockets at a time (sockets then fail with ENOTCONN). So a
 * process keeps at most 16 sockets and reuses them, one question on a socket at a time: c-ares asks every question on
 * one socket per server, but replies to several questions outstanding on one socket are lost on the way back through
 * the relay (the guest's own Node gets 14 answers for 200 parallel `resolve4` calls).
 */
export const MAX_CONCURRENT_EXCHANGES = 16, IDLE_SOCKET_MS = 250;

const serverKey = (server: DnsServer): string => `${String(server.family)} ${server.address} ${String(server.port)}`;

/**
 * The process's datagram sockets, each connected to one server. A socket whose exchange ended with its reply goes back
 * for the next question to that server; any other is closed. Unused sockets are closed `IDLE_SOCKET_MS` after the last
 * one came back, and an unused socket for another server makes room before a new one is opened.
 */
function datagramPool(sockets: DnsSockets, timers: DnsTimers): { take(server: DnsServer): Promise<number>; give(server: DnsServer, fd: number, reusable: boolean): Promise<void> } {
  const idle: { readonly fd: number; readonly key: string }[] = [];
  let linger: unknown;
  const closeIdle = (): void => { linger = undefined; for (const entry of idle.splice(0)) void sockets.close(entry.fd).catch(() => undefined); };
  return {
    take: async server => {
      const key = serverKey(server), index = idle.findIndex(entry => entry.key === key), kept = index < 0 ? undefined : idle.splice(index, 1)[0];
      if (kept !== undefined) return kept.fd;
      const other = idle.shift();
      if (other !== undefined) await sockets.close(other.fd).catch(() => undefined);
      const fd = await sockets.datagram(server.family === 4 ? "ipv4" : "ipv6");
      // c-ares connects its datagram socket: Linux then reports a port nobody listens on (ECONNREFUSED) on the wait
      // for the reply instead of leaving the question to time out. Measured in the VM against 127.0.0.1:53.
      try { await sockets.connect(fd, linuxAddress(server)); }
      catch (error) { await sockets.close(fd).catch(() => undefined); throw error; }
      return fd;
    },
    give: async (server, fd, reusable) => {
      if (!reusable) { await sockets.close(fd).catch(() => undefined); return; }
      idle.push({ fd, key: serverKey(server) });
      if (linger !== undefined) timers.clear(linger);
      linger = timers.set(closeIdle, IDLE_SOCKET_MS);
    },
  };
}

/** A counting gate: `enter` resolves in arrival order as places free up, or rejects when `signal` aborts first. */
function gate(limit: number): { enter(signal: AbortSignal): Promise<void>; leave(): void } {
  let active = 0;
  const waiting: { readonly admit: () => void }[] = [];
  return {
    enter: signal => {
      if (signal.aborted) return Promise.reject(new DnsTransportError("failed", "The DNS query was cancelled"));
      if (active < limit) { active += 1; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        const cancelled = (): void => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(new DnsTransportError("failed", "The DNS query was cancelled")); };
        const entry = { admit: (): void => { signal.removeEventListener("abort", cancelled); resolve(); } };
        waiting.push(entry);
        signal.addEventListener("abort", cancelled, { once: true });
      });
    },
    // A place that is handed on stays counted.
    leave: () => { const next = waiting.shift(); if (next === undefined) active -= 1; else next.admit(); },
  };
}
type Gate = ReturnType<typeof gate>;

/**
 * Runs one exchange under its deadline and the caller's cancellation, and releases its socket whatever happens. The
 * deadline starts when the exchange gets its place, as c-ares starts it when it sends. A wait the deadline ended is a
 * `timeout`; cancellation rejects with the signal's reason; anything else `failed`.
 */
async function bounded(ports: { readonly timers: DnsTimers; readonly places: Gate }, exchange: DnsExchange, socket: { open(): Promise<number>; release(fd: number, answered: boolean): Promise<void> }, work: (fd: number, signal: AbortSignal) => Promise<Uint8Array>): Promise<Uint8Array> {
  const { timers, places } = ports;
  await places.enter(exchange.signal);
  const controller = new AbortController(), cancelled = (): void => { controller.abort(); }, cancelledByCaller = (): boolean => exchange.signal.aborted;
  const deadline = { passed: false };
  let fd: number | undefined, answered = false;
  const timer = timers.set(() => { deadline.passed = true; controller.abort(); }, exchange.timeoutMs);
  exchange.signal.addEventListener("abort", cancelled, { once: true });
  try {
    if (cancelledByCaller()) controller.abort();
    fd = await socket.open();
    const reply = await work(fd, controller.signal);
    answered = true;
    return reply;
  } catch (error) {
    if (cancelledByCaller()) throw new DnsTransportError("failed", "The DNS query was cancelled", { cause: error });
    if (deadline.passed) throw new DnsTransportError("timeout", "The DNS server did not answer in time");
    throw error instanceof DnsTransportError ? error : new DnsTransportError("failed", "The DNS server could not be reached", { cause: error });
  } finally {
    timers.clear(timer);
    exchange.signal.removeEventListener("abort", cancelled);
    if (fd !== undefined) await socket.release(fd, answered);
    places.leave();
  }
}

/** The resolver's transport over a process's VM sockets and its view of the guest's files. */
export function createDnsTransport(sockets: DnsSockets, readFile: (path: string) => string | undefined, timers: DnsTimers = hostTimers): DnsTransport {
  const family = (server: DnsServer): "ipv4" | "ipv6" => server.family === 4 ? "ipv4" : "ipv6";
  const ports = { timers, places: gate(MAX_CONCURRENT_EXCHANGES) }, pool = datagramPool(sockets, timers);
  const close = (fd: number): Promise<void> => sockets.close(fd).catch(() => undefined);
  return {
    readFile,
    udp: (server, query, exchange) => bounded(ports, exchange, { open: () => pool.take(server), release: (fd, answered) => pool.give(server, fd, answered) }, async (fd, signal) => {
      if (await sockets.sendTo(fd, query, linuxAddress(server)) !== query.byteLength) throw new DnsTransportError("failed", "The DNS query was not sent whole");
      for (;;) {
        const reply = await sockets.receiveFrom(fd, MAX_DATAGRAM, signal);
        if (fromServer(reply.source, server) && exchange.accept(reply.bytes)) return reply.bytes;
      }
    }),
    tcp: (server, query, exchange) => bounded(ports, exchange, { open: () => sockets.stream(family(server)), release: close }, async (fd, signal) => {
      await sockets.connect(fd, linuxAddress(server), signal);
      const framed = new Uint8Array(2 + query.byteLength);
      framed[0] = query.byteLength >> 8; framed[1] = query.byteLength & 0xff; framed.set(query, 2);
      for (let sent = 0; sent < framed.byteLength;) {
        const count = await sockets.write(fd, framed.subarray(sent), signal);
        if (count <= 0) throw new DnsTransportError("failed", "The DNS server closed the connection");
        sent += count;
      }
      const chunks: Uint8Array[] = [];
      let have = 0, need = 2;
      for (;;) {
        const chunk = await sockets.read(fd, Math.min(READ_CHUNK, need - have), signal);
        if (chunk.byteLength === 0) throw new DnsTransportError("failed", "The DNS server closed the connection");
        chunks.push(chunk.slice()); have += chunk.byteLength;
        if (have < need) continue;
        const whole = new Uint8Array(have);
        let at = 0;
        for (const part of chunks) { whole.set(part, at); at += part.byteLength; }
        if (need === 2) { need = 2 + (((whole[0] ?? 0) << 8) | (whole[1] ?? 0)); if (have < need) continue; }
        return whole.subarray(2, need);
      }
    }),
  };
}

/** A process without sockets for the resolver: every query finds no server, and no configuration file is read. */
export const unreachableDnsTransport: DnsTransport = {
  readFile: () => undefined,
  udp: () => Promise.reject(new DnsTransportError("failed", "This process has no datagram sockets")),
  tcp: () => Promise.reject(new DnsTransportError("failed", "This process has no stream sockets")),
};
