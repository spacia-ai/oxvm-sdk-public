import { describe, expect, it } from "vitest";
import { datagram, datagramSocket, datagramSockets, decodeAddress, encodeAddress } from "./sockets.js";
import { Writer, type LinuxOperation } from "./codec.js";
import type { ClientSockets } from "../../wasm/capabilities.js";

it.each([
  { family: "ipv4", address: "127.0.0.1", port: 0x1234 },
  { family: "ipv6", address: "0:0:0:0:0:0:0:1", port: 65535 },
  { family: "unix", path: "/tmp/bridge.sock" },
  { family: "unix", path: "\0abstract" },
] as const)("round trips a numeric or Unix address: %j", address => {
  expect(decodeAddress(encodeAddress(address))).toEqual(address);
});
it("expands IPv6 compressed numeric addresses and refuses hostname resolution", () => {
  expect(decodeAddress(encodeAddress({ family: "ipv6", address: "::1", port: 80 }))).toEqual({ family: "ipv6", address: "0:0:0:0:0:0:0:1", port: 80 });
  expect(() => encodeAddress({ family: "ipv4", address: "example.com", port: 80 })).toThrow();
  expect(() => encodeAddress({ family: "ipv6", address: "localhost", port: 80 })).toThrow();
  expect(() => encodeAddress({ family: "ipv6", address: "1::2::3", port: 80 })).toThrow();
});

describe("datagram sockets for the runner's resolver (OXJR 41 with a type, 44 with a destination, 45; Userspace API 146)", () => {
  const resolver = { family: "ipv4", address: "10.0.2.3", port: 53 } as const;

  it("opens an AF_INET or AF_INET6 SOCK_DGRAM socket with {u32 family, u32 type}", () => {
    const open = datagram.socket("ipv4");
    expect(open.number).toBe(41);
    expect(Array.from(open.payload)).toEqual([2, 0, 0, 0, 2, 0, 0, 0]);
    expect(Array.from(datagram.socket("ipv6").payload)).toEqual([10, 0, 0, 0, 2, 0, 0, 0]);
    expect(open.decode({ value: 5n, bytes: new Uint8Array() })).toBe(5);
  });

  it("sends to a destination: fd, blob(bytes), flags, blob(address), and answers the count sent", () => {
    const query = Uint8Array.of(0x12, 0x34, 1, 0), send = datagram.sendTo(5, query, resolver);
    expect(send.number).toBe(44);
    expect(Array.from(send.payload)).toEqual(Array.from(new Writer().u64(5).blob(query).u64(0x4000).blob(encodeAddress(resolver)).finish()));
    expect(send.decode({ value: 4n, bytes: new Uint8Array() })).toBe(4);
    expect(() => send.decode({ value: 5n, bytes: new Uint8Array() })).toThrow();
  });

  it("receives a datagram with its source: the reply is u32 address length, the address, then the bytes", () => {
    const receive = datagram.receiveFrom(5, 512, { dontWait: true, peek: true });
    expect(receive.number).toBe(45);
    expect(Array.from(receive.payload)).toEqual(Array.from(new Writer().u64(5).u64(512).u64(0x40 | 0x2).finish()));
    const source = encodeAddress(resolver), answer = Uint8Array.of(0x12, 0x34, 0x81, 0x80);
    const reply = new Writer().u32(source.byteLength).raw(source).raw(answer).finish();
    expect(receive.decode({ value: 4n, bytes: reply })).toEqual({ bytes: answer, source: resolver });
    expect(Array.from(datagram.receiveFrom(5, 512).payload.subarray(16))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (const bytes of [reply.subarray(0, 3), new Writer().u32(200).raw(source).finish(), new Writer().u32(source.byteLength).raw(source).raw(answer).raw(answer).finish()]) {
      expect(() => receive.decode({ value: 4n, bytes })).toThrow();
    }
  });

  it("is the runner's alone: a module's client sockets have no datagram member", () => {
    const members: readonly (keyof ClientSockets)[] = ["socket", "connect", "address", "read", "write", "close", "shutdown"];
    expect(members).not.toContain("sendTo");
  });
});

describe("a program's own UDP socket (OXJR 49, 42, 51, 52, 54 and 44 on a datagram descriptor)", () => {
  const local = { family: "ipv4", address: "127.0.0.1", port: 5353 } as const;
  const bytes = (operation: LinuxOperation<unknown>): number[] => Array.from(operation.payload);

  it("binds, connects, and dissolves the association with an AF_UNSPEC address", () => {
    expect([datagramSocket.bind(7, local).number, bytes(datagramSocket.bind(7, local))]).toEqual([49, Array.from(new Writer().u64(7).blob(encodeAddress(local)).finish())]);
    expect([datagramSocket.connect(7, local).number, bytes(datagramSocket.connect(7, local))]).toEqual([42, Array.from(new Writer().u64(7).blob(encodeAddress(local)).finish())]);
    expect([datagramSocket.disconnect(7).number, bytes(datagramSocket.disconnect(7))]).toEqual([42, Array.from(new Writer().u64(7).blob(new Uint8Array(16)).finish())]);
  });

  it("reads the local and the peer name from 128 bytes of room and the length Linux wrote", () => {
    const answer = new Uint8Array(132); answer.set(encodeAddress(local)); new DataView(answer.buffer).setUint32(128, 16, true);
    expect([datagramSocket.name(7, false).number, datagramSocket.name(7, true).number]).toEqual([51, 52]);
    expect(datagramSocket.name(7, false).decode({ value: 0n, bytes: answer })).toEqual(local);
    expect(() => datagramSocket.name(7, false).decode({ value: 0n, bytes: answer.subarray(0, 100) })).toThrow();
  });

  it("sets an option to one 32-bit integer, negative values in two's complement", () => {
    expect([datagramSocket.setOption(7, 1, 6, 1).number, bytes(datagramSocket.setOption(7, 1, 6, 1))]).toEqual([54, Array.from(new Writer().u64(7).u32(1).u32(6).u32(1).finish())]);
    expect(bytes(datagramSocket.setOption(7, 0, 33, -1)).slice(16)).toEqual([255, 255, 255, 255]);
  });

  it("sends to a destination or to the connected peer, waiting or not", () => {
    const data = Uint8Array.of(1, 2, 3);
    expect(bytes(datagramSocket.send(7, data, local, true))).toEqual(Array.from(new Writer().u64(7).blob(data).u64(0x4000 | 0x40).blob(encodeAddress(local)).finish()));
    expect(bytes(datagramSocket.send(7, data, null, false))).toEqual(Array.from(new Writer().u64(7).blob(data).u64(0x4000).finish()));
    expect(datagramSocket.send(7, data, null, false).number).toBe(44);
    expect(datagramSocket.send(7, data, null, false).decode({ value: 3n, bytes: new Uint8Array() })).toBe(3);
    expect(() => datagramSocket.send(7, data, null, false).decode({ value: 4n, bytes: new Uint8Array() })).toThrow();
  });

  it("asks at once for what Node's handle answers at once, and waits only for a send that must wait, a receive and a close", async () => {
    const calls: string[] = [], reply = { value: 0n, bytes: new Uint8Array() }, name = new Uint8Array(132);
    name.set(encodeAddress(local)); new DataView(name.buffer).setUint32(128, 16, true);
    const answer = (operation: LinuxOperation<unknown>): { value: bigint; bytes: Uint8Array } => operation.number === 41 ? { value: 7n, bytes: new Uint8Array() }
      : operation.number === 51 ? { value: 0n, bytes: name } : operation.number === 44 ? { value: 2n, bytes: new Uint8Array() }
        : operation.number === 45 ? { value: 1n, bytes: new Writer().u32(16).raw(encodeAddress(local)).raw(Uint8Array.of(9)).finish() } : reply;
    const sockets = datagramSockets({
      sync: operation => { calls.push(`sync ${String(operation.number)}`); return operation.decode(answer(operation)); },
      call: (operation, signal) => { calls.push(`call ${String(operation.number)}${signal === undefined ? "" : " cancellable"}`); return Promise.resolve(operation.decode(answer(operation))); },
    });
    const fd = sockets.open("ipv4"), data = Uint8Array.of(1, 2);
    sockets.bind(fd, local); sockets.connect(fd, local); sockets.disconnect(fd); sockets.setOption(fd, 1, 6, 1);
    expect([fd, sockets.name(fd, false), sockets.sendNow(fd, data, local), await sockets.send(fd, data, null)]).toEqual([7, local, 2, 2]);
    expect(await sockets.receive(fd, 1024, new AbortController().signal)).toEqual({ bytes: Uint8Array.of(9), source: local });
    await sockets.close(fd);
    expect(calls).toEqual(["sync 41", "sync 49", "sync 42", "sync 42", "sync 54", "sync 51", "sync 44", "call 44", "call 45 cancellable", "call 3"]);
  });
});
