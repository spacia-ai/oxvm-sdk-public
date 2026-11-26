import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createAsyncContext } from "./async-context.js";
import { controls, decoded, list, outcome, plain, rows } from "./node-controls.test-support.ts";
import { createNodeNet } from "./node-net.ts";
import { BlockList, SocketAddress } from "./node-net-address.ts";
import { createServerHandle, normalizeArgs } from "./node-net-extras.ts";
import { inspectValue } from "./node-util-validators.ts";

// Recorded from `require("net")` of node:24.18.1-alpine; the recorder is embedded in the control file.
const control = controls("node-net-extras.controls.json");
const U = { $: "undefined" };
/** The recorder's arguments: `{ $: "sa", v }` is a SocketAddress built from `v`. */
function argument(value: unknown): unknown {
  if (typeof value === "object" && value !== null && Reflect.get(value, "$") === "sa") return new SocketAddress(Reflect.get(value, "v"));
  return decoded(value);
}
const expected = (row: Record<string, unknown>): unknown => row["error"] === undefined ? { value: row["value"] } : { error: row["error"] };
const descriptor = (target: object, key: string): unknown => {
  const found = Object.getOwnPropertyDescriptor(target, key);
  if (found === undefined) return null;
  const value: unknown = Reflect.get(found, "value"), getter: unknown = Reflect.get(found, "get"), callee = value ?? getter;
  return { e: found.enumerable, w: found.writable ?? null, c: found.configurable, get: typeof getter, set: typeof found.set, type: typeof callee, length: member(callee, "length"), name: member(callee, "name") };
};
function member(value: unknown, key: string): unknown { return typeof value === "function" || (typeof value === "object" && value !== null) ? Reflect.get(value, key) : undefined; }

it("was recorded from pinned Node", () => { expect(record(control["node"], "node")["version"]).toBe("v24.18.1"); });

it("has the classes' names, members, descriptors and own keys", () => {
  const surface = record(control["surface"], "surface");
  for (const [name, target] of [["BlockList", BlockList], ["SocketAddress", SocketAddress]] as const) {
    const recorded = record(surface[name], name);
    expect([target.name, target.length]).toEqual([recorded["name"], recorded["length"]]);
    expect(Object.getOwnPropertyNames(target).sort()).toEqual(recorded["static"]);
    expect(Object.getOwnPropertyNames(target.prototype).sort().map(key => [key, descriptor(target.prototype, key)])).toEqual(list(recorded["proto"]).toSorted((left, right) => String(list(left)[0]) < String(list(right)[0]) ? -1 : 1));
    for (const row of list(recorded["staticDesc"])) expect(descriptor(target, String(list(row)[0]))).toEqual(list(row)[1]);
  }
  expect([outcome(() => Reflect.apply(BlockList, undefined, [])), outcome(() => Reflect.apply(SocketAddress, undefined, []))]).toEqual(surface["callWithoutNew"]);
  expect([Reflect.ownKeys(new BlockList()).map(String), Reflect.ownKeys(new SocketAddress()).map(String)]).toEqual(surface["ownKeys"]);
  expect(Object.getOwnPropertySymbols(BlockList.prototype).map(String)).toContain("Symbol(nodejs.util.inspect.custom)");
});

it("matches addresses, ranges and subnets across IPv4, IPv6 and IPv4-mapped IPv6 like Node", () => {
  let checks = 0;
  for (const [name, value] of Object.entries(record(control["lists"], "lists"))) {
    const recorded = record(value, name), blocked = new BlockList();
    for (const step of list(recorded["steps"])) {
      const [method, ...args] = list(step);
      if (method === "addAddress") blocked.addAddress(argument(args[0]), argument(args[1]));
      else if (method === "addRange") blocked.addRange(argument(args[0]), argument(args[1]), argument(args[2]));
      else blocked.addSubnet(argument(args[0]), argument(args[1]), argument(args[2]));
    }
    expect(blocked.rules, name).toEqual(recorded["rules"]);
    expect(outcome(() => blocked.toJSON())).toEqual(recorded["json"]);
    expect(inspectValue(blocked), name).toBe(recorded["inspect"]);
    for (const row of rows(recorded["checks"])) {
      const args = list(row["args"]).map(argument);
      expect(outcome(() => args.length === 1 ? blocked.check(args[0]) : blocked.check(args[0], args[1])), `${name} ${JSON.stringify(row["args"])}`).toEqual(expected(row));
      checks++;
    }
  }
  expect(checks).toBeGreaterThanOrEqual(30);
});

it("validates rules in Node's order with Node's errors", () => {
  for (const row of rows(control["invalid"])) {
    const [method, ...raw] = list(row["step"]), args = raw.map(argument);
    expect(outcome(() => {
      const blocked = new BlockList(), callee: unknown = Reflect.get(blocked, String(method));
      if (typeof callee !== "function") throw new TypeError("no such method");
      const returned: unknown = Reflect.apply(callee, blocked, args);
      return { returned: returned === undefined ? U : returned, rules: blocked.rules };
    }), JSON.stringify(row["step"])).toEqual(expected(row));
  }
  for (const row of rows(control["isBlockList"])) {
    const index = Number(row["i"]), value = [new BlockList(), {}, null, undefined, 1, { rules: [] }, BlockList.prototype][index];
    expect(BlockList.isBlockList(value)).toBe(row["value"]);
  }
});

it("serializes rules and reads them back as Node does", () => {
  const json = record(control["json"], "json"), blocked = new BlockList();
  blocked.addAddress("1.1.1.1"); blocked.addRange("::1", "::9", "ipv6"); blocked.addSubnet("10.0.0.0", 8);
  expect(blocked.toJSON()).toEqual(json["toJSON"]);
  expect(JSON.stringify(blocked)).toBe(json["stringify"]);
  expect(Reflect.get(BlockList, "fromJSON")).toBeUndefined();
  for (const row of rows(json["from"])) {
    expect(outcome(() => {
      const fresh = new BlockList();
      fresh.fromJSON(decoded(row["input"]));
      return { returned: U, rules: fresh.rules };
    }), JSON.stringify(row["input"])).toEqual(expected(row));
  }
});

it("builds and parses socket addresses", () => {
  const show = (value: unknown): unknown => {
    if (!(value instanceof SocketAddress)) return U;
    return plain({ address: value.address, port: value.port, family: value.family, flowlabel: value.flowlabel, json: value.toJSON(), inspect: inspectValue(value), keys: Object.keys(value) });
  };
  for (const row of rows(control["socketAddress"])) {
    const args = list(decoded(row["args"]));
    expect(outcome(() => args.length === 0 ? new SocketAddress() : new SocketAddress(args[0]), show), JSON.stringify(row["args"])).toEqual(expected(row));
  }
  for (const row of rows(control["parse"])) expect(outcome(() => SocketAddress.parse(decoded(row["arg"])), show), JSON.stringify(row["arg"])).toEqual(expected(row));
  for (const row of rows(control["isSocketAddress"])) {
    const value = [new SocketAddress(), {}, null, undefined, { address: "1.1.1.1", port: 0, family: "ipv4", flowlabel: 0 }][Number(row["i"])];
    expect(SocketAddress.isSocketAddress(value)).toBe(row["value"]);
  }
  // Node aborts on an IPv6 flow label above 20 bits; this refuses it.
  expect(() => new SocketAddress({ address: "::1", family: "ipv6", flowlabel: 1_048_576 })).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
});

it("normalizes connection arguments and marks the result", () => {
  expect([normalizeArgs.name, normalizeArgs.length]).toEqual(["normalizeArgs", 1]);
  for (const row of rows(control["normalizeArgs"])) {
    const input = list(decoded(row["args"]));
    expect(outcome(() => {
      const result = normalizeArgs(input), callback = result[1];
      return plain({ isArray: Array.isArray(result), length: result.length, options: result[0], sameOptions: result[0] === input[0], cb: callback === null ? null : typeof callback,
        cbSame: typeof callback === "function" ? input.includes(callback) : null, symbols: Object.getOwnPropertySymbols(result).map((symbol): unknown[] => { const mark: unknown = Reflect.get(result, symbol); return [String(symbol), mark]; }), keys: Object.keys(result) });
    }), JSON.stringify(row["args"])).toEqual(expected(row));
  }
  for (const row of rows(control["normalizeArgsLoose"])) {
    expect(outcome(() => { const result = normalizeArgs(decoded(row["arg"])); return plain({ options: result[0], cb: result[1] }); }), JSON.stringify(row["arg"])).toEqual(expected(row));
  }
});

it("refuses the libuv server handle", () => {
  expect([createServerHandle.name, createServerHandle.length]).toEqual(Object.values(record(control["createServerHandle"], "handle")));
  expect(() => createServerHandle()).toThrow(VMError);
});

function network(lookup?: (host: unknown, options: unknown, callback: unknown) => unknown) {
  const operations: string[] = [], context = createAsyncContext();
  const connected: AssistanceResult = { kind: "socket", fd: 7, local: { address: "127.0.0.1", port: 5000 }, peer: { address: "10.0.0.9", port: 9 } };
  const net = createNodeNet({ callSync: () => ({ kind: "unit" }), retain: () => () => undefined,
    call(operation) {
      operations.push(operation.kind);
      if (operation.kind === "socket-connect-local") return Promise.resolve(connected);
      if (operation.kind === "socket-read") return Promise.resolve({ kind: "data", bytes: new Uint8Array() });
      return Promise.resolve({ kind: "unit" });
    } }, context, undefined, lookup === undefined ? undefined : { lookup });
  return { net, operations };
}
type Attempt = { label: unknown; events: unknown[]; sync?: unknown; thrown?: unknown };
function attempt(label: unknown, make: () => { connecting: boolean; destroyed: boolean; on(name: string, listener: (...args: unknown[]) => void): unknown; destroy(): unknown }): Promise<Attempt> {
  return new Promise(resolve => {
    const seen: Attempt = { label, events: [] };
    let made: ReturnType<typeof make> | undefined;
    const thrown = outcome(() => { made = make(); return null; });
    if (made === undefined) { resolve({ ...seen, thrown: thrown["error"] }); return; }
    const socket = made;
    seen.sync = { connecting: socket.connecting, destroyed: socket.destroyed };
    socket.on("error", error => { const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined; if (error instanceof Error) seen.events.push(["error", { name: error.name, code, message: error.message, ctor: error.constructor.name }, Object.keys(error)]); });
    // The existing Linux socket emits `close` without Node's `hadError`; an error event before it says the same.
    socket.on("close", () => { seen.events.push(["close", seen.events.some(event => Array.isArray(event) && event[0] === "error")]); resolve(seen); });
    socket.on("connect", () => { seen.events.push(["connect"]); socket.destroy(); });
  });
}

it("never connects to an address its blockList holds", async () => {
  const recorded = rows(control["blockListConnect"]), blocked = new BlockList();
  blocked.addAddress("127.0.0.1"); blocked.addAddress("::1", "ipv6");
  const { net, operations } = network();
  expect(net.Stream).toBe(net.Socket);
  expect(net.BlockList).toBe(BlockList);
  expect(net.SocketAddress).toBe(SocketAddress);
  expect(net._normalizeArgs).toBe(normalizeArgs);
  expect(net.Socket.name).toBe("Socket");
  const answers = [
    await attempt("ip", () => net.connect({ host: "127.0.0.1", port: 9, blockList: blocked })),
    await attempt("ip6", () => net.connect({ host: "::1", port: 9, blockList: blocked })),
    await attempt("invalid", () => net.connect({ host: "127.0.0.1", port: 9, blockList: {} })),
    await attempt("ctor", () => new net.Socket({ blockList: {} })),
    await attempt("ctor-ok", () => new net.Socket({ blockList: blocked }).connect(9, "127.0.0.1")),
  ];
  expect(answers).toEqual(recorded.slice(0, 5));
  expect(operations).toEqual([]);
  // A resolved name: Node destroys the socket inside the lookup callback; here the lookup's answer is refused.
  for (const all of [true, false]) {
    const resolving = network((_host, options, callback) => {
      if (typeof callback !== "function") return;
      const wantsAll = typeof options === "object" && options !== null && Reflect.get(options, "all") === true;
      expect(wantsAll || !all).toBe(true);
      Reflect.apply(callback, undefined, wantsAll ? [null, [{ address: "127.0.0.1", family: 4 }]] : [null, "127.0.0.1", 4]);
    });
    if (!all) resolving.net.setDefaultAutoSelectFamily(false);
    const answer = await attempt("lookup", () => resolving.net.connect({ host: "x.invalid", port: 9, blockList: blocked }));
    expect(answer.events).toEqual(record(recorded[5], "lookup")["events"]);
    expect(resolving.operations).toEqual([]);
  }
  // An address the list does not hold connects, and a mixed answer keeps only the open addresses.
  const open = network((_host, _options, callback) => { if (typeof callback === "function") Reflect.apply(callback, undefined, [null, [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.9", family: 4 }]]); });
  expect((await attempt("open", () => open.net.connect({ host: "x.invalid", port: 9, blockList: blocked }))).events).toEqual([["connect"], ["close", false]]);
  expect(open.operations.filter(kind => kind === "socket-connect-local")).toHaveLength(1);
  const direct = network();
  expect((await attempt("direct", () => direct.net.connect({ host: "10.0.0.9", port: 9, blockList: blocked }))).events).toEqual([["connect"], ["close", false]]);
});
