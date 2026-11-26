import { describe, expect, it } from "vitest";
import type { LinuxSocketAddress } from "../../../js-process-types.js";
import type { DnsServer } from "./node-dns-config.ts";
import { DnsTransportError, type DnsExchange } from "./node-dns-resolver.ts";
import { createDnsTransport, IDLE_SOCKET_MS, MAX_CONCURRENT_EXCHANGES, unreachableDnsTransport, type DnsSockets, type DnsTimers } from "./node-dns-transport.ts";

const SERVER: DnsServer = { address: "10.0.2.3", family: 4, port: 53 }, SERVER6: DnsServer = { address: "fd00::3", family: 6, port: 5353 };
const QUERY = Uint8Array.of(0x12, 0x34, 1, 0);
type Datagram = { readonly bytes: Uint8Array; readonly source: LinuxSocketAddress | null };

/** Sockets that record every operation; datagrams and stream chunks are handed out in order, then the wait hangs until aborted. */
function sockets(script: { datagrams?: Datagram[]; chunks?: Uint8Array[]; fail?: string } = {}) {
  const log: string[] = [], written: number[] = [];
  const hang = <Value>(signal: AbortSignal | undefined): Promise<Value> => new Promise((_resolve, reject) => { if (signal?.aborted === true) reject(new Error("aborted")); else signal?.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true }); });
  const step = (name: string): void => { log.push(name); if (script.fail === name.split(" ")[0]) throw new Error(`EPERM ${name}`); };
  const port: DnsSockets = {
    datagram: family => { step(`datagram ${family}`); return Promise.resolve(7); },
    sendTo: (fd, bytes, destination) => { step(`sendTo ${String(fd)} ${destination.family === "unix" ? "unix" : `${destination.address}:${String(destination.port)}`}`); return Promise.resolve(bytes.byteLength); },
    receiveFrom: (fd, max, signal) => { step(`receiveFrom ${String(fd)} ${String(max)}`); const next = script.datagrams?.shift(); return next === undefined ? hang(signal) : Promise.resolve(next); },
    stream: family => { step(`stream ${family}`); return Promise.resolve(9); },
    connect: (fd, address) => { step(`connect ${String(fd)} ${address.family === "unix" ? "unix" : `${address.address}:${String(address.port)}`}`); return Promise.resolve(); },
    // The peer takes three bytes at a time.
    write: (_fd, bytes) => { step("write"); const count = Math.min(3, bytes.byteLength); written.push(...bytes.subarray(0, count)); return Promise.resolve(count); },
    read: (_fd, max, signal) => { step(`read ${String(max)}`); const next = script.chunks?.shift(); return next === undefined ? hang(signal) : Promise.resolve(next); },
    close: fd => { log.push(`close ${String(fd)}`); return Promise.resolve(); },
  };
  return { port, log, written };
}
/** Timers the test fires by hand. */
function timers() {
  const pending = new Map<object, () => void>(), waits: number[] = [];
  const port: DnsTimers = { set: (callback, ms) => { const key = {}; pending.set(key, callback); waits.push(ms); return key; }, clear: timer => { if (typeof timer === "object" && timer !== null) pending.delete(timer); } };
  return { port, waits, pending, fire: () => { for (const [key, callback] of [...pending]) { pending.delete(key); callback(); } } };
}
const exchange = (accept: (reply: Uint8Array) => boolean = () => true, signal = new AbortController().signal): DnsExchange => ({ timeoutMs: 2000, signal, accept });
const from = (address: string, port: number, ...bytes: number[]): Datagram => ({ bytes: Uint8Array.from(bytes), source: { family: address.includes(":") ? "ipv6" : "ipv4", address, port } });

describe("DNS over the process's VM sockets", () => {
  it("sends one datagram and returns the first accepted reply from that server, and keeps the socket for the next question", async () => {
    const script = { datagrams: [from("10.0.2.9", 53, 1), from("10.0.2.3", 54, 2), from("10.0.2.3", 53, 3), from("10.0.2.3", 53, 4)] }, net = sockets(script), clock = timers();
    const transport = createDnsTransport(net.port, () => undefined, clock.port);
    expect(Array.from(await transport.udp(SERVER, QUERY, exchange(reply => reply[0] === 4)))).toEqual([4]);
    expect(net.log).toEqual(["datagram ipv4", "connect 7 10.0.2.3:53", "sendTo 7 10.0.2.3:53", "receiveFrom 7 65536", "receiveFrom 7 65536", "receiveFrom 7 65536", "receiveFrom 7 65536"]);
    expect(clock.waits).toEqual([2000, IDLE_SOCKET_MS]);
    // The next question to that server goes out on the same socket; one to another server replaces it.
    net.log.length = 0; script.datagrams.push(from("10.0.2.3", 53, 9), from("fd00::3", 5353, 8));
    expect(Array.from(await transport.udp(SERVER, QUERY, exchange()))).toEqual([9]);
    expect(net.log).toEqual(["sendTo 7 10.0.2.3:53", "receiveFrom 7 65536"]);
    net.log.length = 0;
    expect(Array.from(await transport.udp(SERVER6, QUERY, exchange()))).toEqual([8]);
    expect(net.log).toEqual(["close 7", "datagram ipv6", "connect 7 fd00::3:5353", "sendTo 7 fd00::3:5353", "receiveFrom 7 65536"]);
    // Unused for a while, it is closed.
    net.log.length = 0;
    expect(clock.pending.size).toBe(1);
    clock.fire();
    expect(net.log).toEqual(["close 7"]);
    expect(clock.pending.size).toBe(0);
  });

  it("compares IPv6 sources by value and opens an IPv6 socket for an IPv6 server", async () => {
    const net = sockets({ datagrams: [from("fd00:0:0:0:0:0:0:3", 5353, 5)] });
    expect(Array.from(await createDnsTransport(net.port, () => undefined, timers().port).udp(SERVER6, QUERY, exchange()))).toEqual([5]);
    expect(net.log.slice(0, 3)).toEqual(["datagram ipv6", "connect 7 fd00::3:5353", "sendTo 7 fd00::3:5353"]);
  });

  it("reports a silent server as a timeout, a refused send as a failure, and cancellation as a failure, closing each time", async () => {
    const silent = sockets(), clock = timers(), pending = createDnsTransport(silent.port, () => undefined, clock.port).udp(SERVER, QUERY, exchange()).catch((error: unknown) => error);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    clock.fire();
    const timeout: unknown = await pending;
    expect(timeout).toBeInstanceOf(DnsTransportError);
    expect(timeout).toMatchObject({ kind: "timeout" });
    expect(silent.log.at(-1)).toBe("close 7");

    const refused = sockets({ fail: "sendTo" });
    expect(await createDnsTransport(refused.port, () => undefined, timers().port).udp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(refused.log).toEqual(["datagram ipv4", "connect 7 10.0.2.3:53", "sendTo 7 10.0.2.3:53", "close 7"]);
    const closed = sockets({ fail: "datagram" });
    expect(await createDnsTransport(closed.port, () => undefined, timers().port).udp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(closed.log).toEqual(["datagram ipv4"]);

    const controller = new AbortController(), cancelled = sockets(), stopped = timers();
    const waiting = createDnsTransport(cancelled.port, () => undefined, stopped.port).udp(SERVER, QUERY, exchange(() => true, controller.signal)).catch((error: unknown) => error);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect(await waiting).toMatchObject({ kind: "failed" });
    expect(cancelled.log.at(-1)).toBe("close 7");
    expect(stopped.pending.size).toBe(0);
  });

  it("connects its datagram socket, so a port nobody listens on is refused at once instead of timing out (measured in the VM)", async () => {
    // Linux reports the ICMP refusal on the connected socket's next operation: here the wait for the reply.
    const net = sockets({ fail: "receiveFrom" }), clock = timers();
    expect(await createDnsTransport(net.port, () => undefined, clock.port).udp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(net.log).toEqual(["datagram ipv4", "connect 7 10.0.2.3:53", "sendTo 7 10.0.2.3:53", "receiveFrom 7 65536", "close 7"]);
    expect(clock.pending.size).toBe(0);
  });

  it("closes a socket whose connect is refused, and one whose exchange ends without its reply", async () => {
    const net = sockets({ fail: "connect" });
    expect(await createDnsTransport(net.port, () => undefined, timers().port).udp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(net.log).toEqual(["datagram ipv4", "connect 7 10.0.2.3:53", "close 7"]);
  });

  it("holds at most 16 sockets at once: later exchanges wait without a deadline running, in order, and can be cancelled", async () => {
    const net = sockets(), clock = timers(), transport = createDnsTransport(net.port, () => undefined, clock.port), turn = async (): Promise<void> => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
    const controller = new AbortController(), outcomes: string[] = [];
    const ask = (label: string, signal = new AbortController().signal): void => { void transport.udp(SERVER, QUERY, exchange(() => true, signal)).then(() => outcomes.push(`${label} answered`), (error: unknown) => outcomes.push(`${label} ${error instanceof DnsTransportError ? error.kind : "?"}`)); };
    for (let index = 0; index < MAX_CONCURRENT_EXCHANGES; index += 1) ask(`first${String(index)}`);
    ask("waiting", controller.signal); ask("next");
    await turn();
    const opened = (): number => net.log.filter(entry => entry.startsWith("datagram")).length;
    expect([opened(), clock.waits.length]).toEqual([MAX_CONCURRENT_EXCHANGES, MAX_CONCURRENT_EXCHANGES]);
    controller.abort();
    await turn();
    expect(outcomes).toEqual(["waiting failed"]);
    expect(opened()).toBe(MAX_CONCURRENT_EXCHANGES);
    // The sixteen time out and free their places; the one still waiting gets a socket and its own deadline.
    clock.fire();
    await turn();
    expect([opened(), clock.pending.size, outcomes.filter(entry => entry.endsWith("timeout")).length]).toEqual([MAX_CONCURRENT_EXCHANGES + 1, 1, MAX_CONCURRENT_EXCHANGES]);
    clock.fire();
    await turn();
    expect(outcomes.at(-1)).toBe("next timeout");
    expect(net.log.filter(entry => entry.startsWith("close")).length).toBe(MAX_CONCURRENT_EXCHANGES + 1);
  });

  it("frames a query over TCP with its length and reads a reply that arrives in pieces", async () => {
    const net = sockets({ chunks: [Uint8Array.of(0), Uint8Array.of(5, 0xaa), Uint8Array.of(0xbb, 0xcc), Uint8Array.of(0xdd, 0xee)] });
    expect(Array.from(await createDnsTransport(net.port, () => undefined, timers().port).tcp(SERVER, QUERY, exchange()))).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    expect(net.written).toEqual([0, 4, 0x12, 0x34, 1, 0]);
    expect(net.log).toEqual(["stream ipv4", "connect 9 10.0.2.3:53", "write", "write", "read 2", "read 1", "read 4", "read 2", "close 9"]);
  });

  it("fails a TCP exchange whose peer closes early, and reads the VM's files through the port it was given", async () => {
    const net = sockets({ chunks: [Uint8Array.of(0, 9, 1), new Uint8Array(0)] });
    const transport = createDnsTransport(net.port, path => path === "/etc/resolv.conf" ? "nameserver 10.0.2.3\n" : undefined, timers().port);
    expect(await transport.tcp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(net.log.at(-1)).toBe("close 9");
    expect([transport.readFile("/etc/resolv.conf"), transport.readFile("/etc/hosts")]).toEqual(["nameserver 10.0.2.3\n", undefined]);
  });

  it("without sockets fails every exchange and reads nothing", async () => {
    expect(await unreachableDnsTransport.udp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(await unreachableDnsTransport.tcp(SERVER, QUERY, exchange()).catch((error: unknown) => error)).toMatchObject({ kind: "failed" });
    expect(unreachableDnsTransport.readFile("/etc/hosts")).toBeUndefined();
  });
});
