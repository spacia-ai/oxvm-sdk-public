import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { VMError } from "../../errors.ts";
import { record } from "../../decode.js";
import { createNodeDgram, type NodeDgram } from "./node-dgram.ts";
import { FakeUdpNetwork } from "./node-dgram.test-support.ts";
import { BlockList } from "./node-net-address.ts";

const controls = record(JSON.parse(readFileSync(new URL("./node-dgram.controls.json", import.meta.url), "utf8")), "dgram controls");
interface Recorded { readonly name: string; readonly code: string; readonly result: unknown; readonly routed: boolean }
function recorded(key: string): Recorded[] {
  const entries: unknown = controls[key];
  if (!Array.isArray(entries)) throw new TypeError(`Missing recorded ${key}`);
  return entries.map((entry: unknown) => {
    const fields = record(entry, "recorded case"), name = fields["name"], code = fields["code"];
    if (typeof name !== "string" || typeof code !== "string") throw new TypeError("Invalid recorded case");
    return { name, code, result: fields["result"], routed: fields["routed"] === true };
  });
}
const prelude = typeof controls["prelude"] === "string" ? controls["prelude"] : "";

/** A process around one fake network: `dns.lookup` answers an address with itself a tick later, as Node's does. */
function setup(options: { readonly routed?: boolean } = {}) {
  const network = new FakeUdpNetwork(options), warnings: string[] = [];
  // The process's callback queue: each callback is a turn of the event loop's poll phase, with the program's ticks and
  // promise jobs run after it, as the scheduler of a process runs them.
  const channel = new MessageChannel(), turns: (() => void)[] = [];
  channel.port1.on("message", () => { turns.shift()?.(); });
  channel.port1.unref();
  let held = 0;
  const dgram = createNodeDgram({
    sockets: network,
    retain: () => { let active = true; held += 1; return () => { if (active) { active = false; held -= 1; } }; },
    dispatch: callback => { turns.push(callback); channel.port2.postMessage(null); },
    nextTick: callback => { process.nextTick(callback); },
    lookup: (host: string, family: number, callback: (error: null, address: string, family: number) => void) => { process.nextTick(callback, null, host, family); },
    warn: (message, type, code) => { warnings.push(`${type} ${code}: ${message}`); },
  });
  return { network, dgram, warnings, held: () => held };
}
const turn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
const once = (emitter: { once(event: string, listener: (...args: unknown[]) => void): unknown }, event: string): Promise<unknown[]> => new Promise(resolve => { emitter.once(event, (...args) => { resolve(args); }); });
async function settled(held: () => number): Promise<void> { for (let turns = 0; turns < 20 && held() !== 0; turns++) await turn(); }

/** Runs a recorded program against this implementation, as the recorder ran it against Node. */
async function replay(code: string, dgram: NodeDgram): Promise<unknown> {
  const prototype: unknown = Object.getPrototypeOf(async () => { await Promise.resolve(); });
  const AsyncFunction: unknown = typeof prototype === "object" && prototype !== null ? Reflect.get(prototype, "constructor") : undefined;
  if (typeof AsyncFunction !== "function") throw new TypeError("Missing AsyncFunction");
  const program: unknown = Reflect.construct(AsyncFunction, ["dgram", "Buffer", "BlockList", prelude + code]);
  if (typeof program !== "function") throw new TypeError("Invalid recorded program");
  const result: unknown = await Reflect.apply(program, undefined, [dgram, Buffer, BlockList]);
  return JSON.parse(JSON.stringify(result));
}

describe("validation and state, as recorded from Node.js v24.18.1", () => {
  it.each(recorded("cases"))("$name", async ({ code, result }) => {
    const { dgram, network, held } = setup();
    expect(await replay(code, dgram)).toEqual(result);
    await settled(held);
    expect([held(), network.openSockets]).toEqual([0, 0]);
  });
});

describe("datagram exchanges, as recorded from Node.js v24.18.1", () => {
  it.each(recorded("scenarios"))("$name", async ({ code, result, routed }) => {
    const { dgram, network, held } = setup({ routed });
    expect(await replay(code, dgram)).toEqual(result);
    await settled(held);
    expect([held(), network.openSockets]).toEqual([0, 0]);
  });
});

describe("the process and Linux", () => {
  it("keeps the process alive while a socket receives, unless it is unref'd", async () => {
    const { dgram, held, network } = setup(), socket = dgram.createSocket("udp4");
    expect(held()).toBe(0);
    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
    expect(held()).toBe(1);
    socket.unref(); expect(held()).toBe(0);
    socket.unref(); socket.ref(); socket.ref(); expect(held()).toBe(1);
    socket.close();
    // The hold of the receiving socket is gone; Linux's close is still awaited.
    await once(socket, "close");
    await settled(held);
    expect([held(), network.openSockets]).toEqual([0, 0]);
  });

  it("asks Linux for the options a socket was created with, before it binds", async () => {
    const { dgram, network } = setup(), socket = dgram.createSocket({ type: "udp6", reuseAddr: true, reusePort: true, ipv6Only: true, recvBufferSize: 4096, sendBufferSize: 8192 });
    socket.bind(0, "::1");
    await once(socket, "listening");
    expect(network.optionsSet).toEqual(["1:2=1", "1:15=1", "41:26=1", "1:8=4096", "1:7=8192"]);
    socket.setBroadcast(1); socket.setTTL(9); socket.setMulticastTTL(3); socket.setMulticastLoopback(0); socket.setMulticastInterface("::1");
    expect(network.optionsSet.slice(5)).toEqual(["1:6=1", "41:16=9", "41:18=3", "41:19=0", "41:17=0"]);
    socket.close();
    const four = dgram.createSocket("udp4"); four.bind(0, "127.0.0.1"); await once(four, "listening");
    four.setTTL(9); four.setMulticastTTL(3); four.setMulticastLoopback(true); four.setMulticastInterface("127.0.0.1");
    expect(network.optionsSet.slice(10)).toEqual(["0:2=9", "0:33=3", "0:34=1", `0:32=${String(0x0100_007f)}`]);
    four.close();
  });

  it("reports what Linux refuses with Linux's errno in Node's shape", async () => {
    const { dgram, network } = setup({ routed: true }), socket = dgram.createSocket("udp4");
    socket.bind(0, "0.0.0.0"); await once(socket, "listening");
    const sent = (address: string): Promise<unknown[]> => new Promise(resolve => { socket.send("x", 9, address, (...args: unknown[]) => { resolve(args); }); });
    // Beyond the VM: the network policy's refusal.
    const [refused] = await sent("192.0.2.7");
    expect(refused).toBeInstanceOf(Error);
    expect({ ...Object(refused), message: refused instanceof Error ? refused.message : "" }).toEqual({ message: "send EPERM 192.0.2.7:9", errno: -1, code: "EPERM", syscall: "send", address: "192.0.2.7", port: 9 });
    network.refuse("setOption", 95);
    expect(() => { socket.setBroadcast(true); }).toThrow(expect.objectContaining({ message: "setBroadcast ENOTSUP", errno: -95, code: "ENOTSUP", syscall: "setBroadcast" }));
    network.refuse("setOption", 22);
    expect(() => { socket.setRecvBufferSize(1); }).toThrow(expect.objectContaining({ name: "SystemError", code: "ERR_SOCKET_BUFFER_SIZE", errno: -22, syscall: "uv_recv_buffer_size", message: "Could not get or set buffer size: uv_recv_buffer_size returned EINVAL (invalid argument)" }));
    network.refuse("name", 9);
    expect(() => socket.address()).toThrow(expect.objectContaining({ message: "getsockname EBADF", errno: -9 }));
    const failed = once(socket, "error");
    network.refuse("receive", 111); socket.send("wake", socket.address().port, "127.0.0.1");
    expect((await failed)[0]).toEqual(expect.objectContaining({ message: "recvmsg ECONNREFUSED", errno: -111, code: "ECONNREFUSED", syscall: "recvmsg" }));
    // The socket still receives after a failed receive.
    const arrived = once(socket, "message"); socket.send("after", socket.address().port, "127.0.0.1");
    expect(String((await arrived)[0])).toBe("after");
    const connecting = dgram.createSocket("udp4");
    network.refuse("connect", 101);
    const [error] = await new Promise<unknown[]>(resolve => { connecting.connect(9, "192.0.2.7", (...args: unknown[]) => { resolve(args); }); });
    expect(error).toEqual(expect.objectContaining({ message: "connect ENETUNREACH 192.0.2.7:9", errno: -101, code: "ENETUNREACH", syscall: "connect", address: "192.0.2.7", port: 9 }));
    connecting.close(); socket.close();
    const unbindable = dgram.createSocket("udp4"), refusal = once(unbindable, "error");
    unbindable.bind(53, "192.0.2.7");
    expect((await refusal)[0]).toEqual(expect.objectContaining({ message: "bind EADDRNOTAVAIL 192.0.2.7:53", errno: -99, code: "EADDRNOTAVAIL", syscall: "bind", address: "192.0.2.7", port: 53 }));
    unbindable.close();
  });

  it("queues a datagram Linux cannot take at once, counts it, and completes it later", async () => {
    const { dgram, network, held } = setup(), server = dgram.createSocket("udp4"), client = dgram.createSocket("udp4");
    server.bind(0, "127.0.0.1"); await once(server, "listening"); client.bind(0, "127.0.0.1"); await once(client, "listening");
    client.unref(); server.unref();
    const port = server.address().port, order: string[] = [];
    network.refuse("sendNow", 11);
    const arrived = once(server, "message");
    client.send("slow", port, "127.0.0.1", (error: unknown, bytes: unknown) => { order.push(`callback ${String(error)} ${String(bytes)}`); });
    await new Promise<void>(resolve => { process.nextTick(resolve); });
    // The lookup has answered and the datagram waits in Linux: the process is held for it though both sockets are unref'd.
    expect([client.getSendQueueCount(), client.getSendQueueSize(), held(), network.waited]).toEqual([1, 4, 1, 1]);
    expect(String((await arrived)[0])).toBe("slow");
    await turn();
    expect([order, client.getSendQueueCount(), client.getSendQueueSize(), held()]).toEqual([["callback null 4"], 0, 0, 0]);
    network.refuse("sendNow", 11); network.refuse("send", 13);
    const [failure] = await new Promise<unknown[]>(resolve => { client.send("late", port, "127.0.0.1", (...args: unknown[]) => { resolve(args); }); });
    expect(failure).toEqual(expect.objectContaining({ message: `send EACCES 127.0.0.1:${String(port)}`, errno: -13, code: "EACCES" }));
    client.close(); server.close();
  });

  it("binds an address again once Linux has closed the socket that held it", async () => {
    const { dgram, network } = setup(), first = dgram.createSocket("udp4");
    first.bind(0, "127.0.0.1"); await once(first, "listening");
    const port = first.address().port, second = dgram.createSocket("udp4");
    // Node's close is complete when it returns; here Linux still holds the address for a turn.
    first.close(() => { second.bind(port, "127.0.0.1"); });
    await once(second, "listening"); await turn();
    expect([second.address().port, network.openSockets]).toEqual([port, 1]);
    second.close();
  });

  it("refuses what has no Linux operation for a JavaScript process", async () => {
    const { dgram } = setup(), socket = dgram.createSocket("udp4");
    const unavailable = (run: () => unknown): void => {
      let thrown: unknown;
      try { run(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(VMError);
      expect(thrown).toEqual(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
    };
    unavailable(() => { socket.bind({ fd: 7 }); });
    const bound = dgram.createSocket("udp4"); bound.bind(0, "127.0.0.1"); await once(bound, "listening");
    unavailable(() => { bound.getRecvBufferSize(); }); unavailable(() => { bound.getSendBufferSize(); });
    unavailable(() => { bound.addMembership("224.0.0.114"); });
    unavailable(() => { bound.dropMembership("224.0.0.114", "127.0.0.1"); });
    unavailable(() => { bound.addSourceSpecificMembership("10.0.0.1", "232.1.1.1"); });
    unavailable(() => { bound.dropSourceSpecificMembership("10.0.0.1", "232.1.1.1"); });
    unavailable(() => { bound.setMulticastInterface("fe80::1%eth0"); });
    unavailable(() => dgram._createSocketHandle());
    bound.close();
  });

  it("warns once about the deprecated underscore members", async () => {
    const { dgram, warnings } = setup(), socket = dgram.createSocket("udp4");
    expect([Reflect.get(socket, "_bindState"), Reflect.get(socket, "_receiving"), Reflect.get(socket, "_queue"), Reflect.get(socket, "_reuseAddr")]).toEqual([0, false, undefined, undefined]);
    expect(Reflect.get(socket, "_handle")).toEqual({ fd: -1 });
    socket.bind(0, "127.0.0.1"); await once(socket, "listening");
    expect([Reflect.get(socket, "_bindState"), Reflect.get(socket, "_receiving")]).toEqual([2, true]);
    socket.close();
    expect(Reflect.get(socket, "_handle")).toBeNull();
    expect(warnings).toEqual(["DeprecationWarning DEP0112: Socket.prototype._bindState is deprecated"]);
  });
});
