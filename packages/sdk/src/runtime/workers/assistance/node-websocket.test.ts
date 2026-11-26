import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { controls, list, outcome, rows } from "./node-controls.test-support.ts";
import { createNodeWebSocket, type NodeWebSocketDeps, type NodeWebSocketInstance } from "./node-websocket.ts";
import { encodeFrame, FrameReceiver, MAX_MESSAGE_BYTES } from "./node-websocket-frames.ts";
import { acceptFor, checkAnswer, encodeUpgrade } from "./node-websocket-handshake.ts";
import { fakeNetwork, frame, runScenario } from "./node-websocket.test-support.ts";

// Recorded from the global `WebSocket` of node:24.18.1-alpine (undici 7.29.0) against the recorder's own server; the
// recorder and its scenarios are embedded in the control file.
const control = controls("node-websocket.controls.json"), cases = record(control["cases"], "cases"), shape = record(control["shape"], "shape");

/** A process around the in-memory network: holds are counted, callbacks run from a queue. */
function world(extra: Partial<NodeWebSocketDeps> = {}) {
  const network = fakeNetwork();
  let held = 0, dispatched = 0;
  const made = createNodeWebSocket({
    net: network.net, tls: network.tls,
    retain: () => { held++; let released = false; return () => { if (!released) { released = true; held--; } }; },
    dispatch: callback => { dispatched++; queueMicrotask(callback); },
    ...extra,
  });
  return { ...made, network, held: () => held, dispatched: () => dispatched };
}
const settle = async (turns = 30): Promise<void> => { for (let index = 0; index < turns; index++) await new Promise<void>(resolve => { setImmediate(resolve); }); };
function opened(ws: NodeWebSocketInstance): Promise<void> { return new Promise(resolve => { ws.addEventListener("open", () => { resolve(); }, { once: true }); }); }
function closed(ws: NodeWebSocketInstance): Promise<Event> { return new Promise(resolve => { ws.addEventListener("close", event => { resolve(event); }, { once: true }); }); }

it("was recorded from pinned Node", () => {
  expect(record(control["node"], "node")).toEqual({ version: "v24.18.1", image: "node:24.18.1-alpine", undici: "7.29.0" });
  expect(Object.keys(cases).length).toBeGreaterThanOrEqual(25);
});

/** What this runtime does differently from the recording, on purpose. */
function expectedOf(name: string): { client: unknown; server: unknown } {
  const recorded = record(cases[name], name);
  // No extension is offered: permessage-deflate is not implemented.
  const server = rows(recorded["server"]).map(entry => entry["event"] === "request" ? { ...entry, headers: list(entry["headers"]).filter(header => list(header)[0] !== "sec-websocket-extensions") } : entry);
  if (name === "protocol chosen with none offered") {
    // Node throws an uncaught TypeError and leaves the socket connecting for ever; here the connection fails.
    expect(recorded["client"]).toContainEqual({ uncaught: { class: "TypeError", name: "TypeError", message: "Cannot read properties of null (reading 'includes')" } });
    const failed = record(cases["protocol chosen that was not offered"], "failed");
    return { client: failed["client"], server: [{ event: "request", line: "GET /echo?protocol=c HTTP/1.1", headers: list(record(rows(record(cases["client close"], "plain")["server"])[0], "request")["headers"]).filter(header => list(header)[0] !== "sec-websocket-extensions") }, { event: "closed" }] };
  }
  return { client: recorded["client"], server };
}

describe("replays what Node did", () => {
  for (const scenario of rows(control["scenarios"])) {
    const name = String(scenario["name"]);
    it(name, async () => {
      const { WebSocket, network, held } = world();
      const url = typeof scenario["url"] === "string" ? scenario["url"] : `ws://${typeof scenario["userinfo"] === "string" ? `${scenario["userinfo"]}@` : ""}127.0.0.1:8080/${typeof scenario["path"] === "string" ? scenario["path"] : ""}`;
      const client = await runScenario(scenario, url, WebSocket, network.activity);
      await settle(5);
      const expected = expectedOf(name);
      expect(client).toEqual(expected.client);
      expect(network.server).toEqual(expected.server);
      // The process is held exactly until the close event; a socket Node left open is still held.
      const open = client.some(entry => "mark" in entry && entry["mark"] === "timeout");
      expect(held()).toBe(open ? 1 : 0);
    });
  }
});

describe("the classes", () => {
  const { WebSocket, CloseEvent, MessageEvent } = world();
  const flags = (descriptor: PropertyDescriptor): string => `${descriptor.enumerable === true ? "e" : "-"}${descriptor.configurable === true ? "c" : "-"}${"value" in descriptor ? (descriptor.writable === true ? "w" : "-") : ""}`;
  const describeOne = (object: object, key: string | symbol): unknown[] => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key) ?? {}, value: unknown = descriptor.value;
    if ("value" in descriptor) return [flags(descriptor), typeof value === "function" ? `function ${value.name}/${value.length}` : typeof value === "object" ? "object" : value];
    return [flags(descriptor), `get ${String(descriptor.get?.name)}`, descriptor.set === undefined ? "no setter" : `set ${descriptor.set.name}/${descriptor.set.length}`];
  };
  const table = (object: object): Record<string, unknown> => Object.fromEntries(Reflect.ownKeys(object).map(key => [String(key), describeOne(object, key)]));
  const attempt = (run: () => unknown): unknown => outcome(run, value => value);
  const thrown = (value: unknown): unknown => { const error = record(record(value, "attempt")["threw"], "threw"); return { name: error["name"], code: error["code"] ?? null, message: error["message"], ctor: error["class"] }; };
  const accessor = (key: string, kind: "get" | "set"): (...args: unknown[]) => unknown => { const found: unknown = Reflect.get(Object.getOwnPropertyDescriptor(WebSocket.prototype, key) ?? {}, kind); if (typeof found !== "function") throw new TypeError(`no ${kind} ${key}`); return (...args) => { const result: unknown = Reflect.apply(found, {}, args); return result; }; };
  const method = (key: string): (...args: unknown[]) => unknown => { const found: unknown = Reflect.get(WebSocket.prototype, key); if (typeof found !== "function") throw new TypeError(`no ${key}`); return (...args) => { const result: unknown = Reflect.apply(found, {}, args); return result; }; };

  it("have Node's names, members and descriptors", () => {
    expect([WebSocket.name, WebSocket.length]).toEqual([shape["name"], shape["length"]]);
    expect(table(WebSocket)).toEqual(shape["statics"]);
    // Node's accessors are named `get x`; the engine names a class's the same way.
    expect(table(WebSocket.prototype)).toEqual(shape["prototype"]);
    expect(Object.keys(table(WebSocket.prototype))).toEqual(Object.keys(record(shape["prototype"], "prototype")));
    const ws = new WebSocket("ws://127.0.0.1:1/");
    ws.onerror = () => undefined;
    expect(Object.prototype.toString.call(ws)).toBe(shape["tag"]);
    expect(Object.getPrototypeOf(WebSocket.prototype) === EventTarget.prototype).toBe(shape["extendsEventTarget"]);
    expect([ws.CONNECTING, ws.OPEN, ws.CLOSING, ws.CLOSED]).toEqual(shape["instanceConstants"]);
    expect(ws instanceof EventTarget).toBe(true);
  });

  it("refuse a foreign receiver and a call without new, as Node does", () => {
    const brand = record(shape["brand"], "brand");
    expect(attempt(() => accessor("readyState", "get")())).toEqual({ error: thrown(brand["readyState"]) });
    expect(attempt(() => method("send")("x"))).toEqual({ error: thrown(brand["send"]) });
    expect(attempt(() => method("close")())).toEqual({ error: thrown(brand["close"]) });
    expect(attempt(() => accessor("onopen", "set")(null))).toEqual({ error: thrown(brand["onopen"]) });
    expect(() => { Reflect.apply(WebSocket, undefined, ["ws://127.0.0.1:1/"]); }).toThrow(TypeError);
  });

  it("keep an event handler that is a function or an object, and null anything else", () => {
    const ws = new WebSocket("ws://127.0.0.1:1/"), handler = (): void => undefined, results: Record<string, string> = {};
    ws.onerror = () => undefined;
    for (const [label, value] of [["number", 5], ["object", {}], ["null", null], ["undefined", undefined], ["string", "x"]] as const) {
      ws.onopen = handler; ws.onopen = value;
      results[label] = ws.onopen === value ? "kept" : ws.onopen === null ? "null" : "other";
    }
    expect(results).toEqual(shape["handlers"]);
    ws.onopen = handler;
    expect(ws.onopen === handler).toBe(shape["handlerKept"]);
  });

  it("replace a handler instead of adding a second one", async () => {
    const { WebSocket: Socket } = world(), ws = new Socket("ws://127.0.0.1:8080/close?code=1000"), seen: string[] = [];
    ws.onclose = () => { seen.push("first"); };
    ws.onclose = () => { seen.push("second"); };
    ws.addEventListener("close", () => { seen.push("listener"); });
    await closed(ws);
    expect(seen).toEqual(["second", "listener"]);
  });

  it("use the platform's event classes", () => {
    expect(CloseEvent).toBe(globalThis.CloseEvent);
    expect(MessageEvent).toBe(globalThis.MessageEvent);
    const close = record(shape["closeEvent"], "closeEvent"), message = record(shape["messageEvent"], "messageEvent");
    expect([CloseEvent.name, CloseEvent.length]).toEqual([close["name"], close["length"]]);
    expect([MessageEvent.name, MessageEvent.length]).toEqual([message["name"], message["length"]]);
  });
});

describe("the transport", () => {
  it("connects ws: through net and wss: through tls, to the URL's host and port", async () => {
    const { WebSocket, network } = world();
    const plain = new WebSocket("ws://server.test/echo"), secure = new WebSocket("wss://server.test/echo"), literal = new WebSocket("wss://127.0.0.1:8443/echo"), six = new WebSocket("https://[::1]/echo"), port = new WebSocket("http://server.test:8080/echo");
    await Promise.all([plain, secure, literal, six, port].map(opened));
    expect(network.connections.map(connection => [connection.secure, connection.options])).toEqual([
      [false, { host: "server.test", port: 80 }], [true, { host: "server.test", port: 443, servername: "server.test" }],
      [true, { host: "127.0.0.1", port: 8443, servername: "" }], [true, { host: "::1", port: 443, servername: "" }], [false, { host: "server.test", port: 8080 }],
    ]);
    expect([secure.url, six.url, port.url]).toEqual(["wss://server.test/echo", "wss://[::1]/echo", "ws://server.test:8080/echo"]);
    const hosts = network.server.filter(entry => entry["event"] === "request").length;
    expect(hosts).toBe(5);
    for (const ws of [plain, secure, literal, six, port]) ws.close();
    await settle();
  });

  it("writes the Host header with a port that is not the scheme's own", () => {
    const head = (url: string): string => new TextDecoder().decode(encodeUpgrade(new URL(url), "a2V5", ["a", "b"], new Map([["x-one", "1"], ["host", "evil.test"], ["user-agent", "mine"], ["sec-websocket-key", "theirs"]])));
    expect(head("ws://server.test:8080/p?q=1").split("\r\n")).toEqual(["GET /p?q=1 HTTP/1.1", "host: server.test:8080", "connection: upgrade", "upgrade: websocket", "x-one: 1", "user-agent: mine", "accept: */*", "accept-language: *",
      "sec-fetch-mode: websocket", "pragma: no-cache", "cache-control: no-cache", "accept-encoding: gzip, deflate", "sec-websocket-key: a2V5", "sec-websocket-version: 13", "sec-websocket-protocol: a, b", "", ""]);
    expect(head("wss://server.test/")).toContain("\r\nhost: server.test\r\n");
  });

  it("fails when the socket cannot be made, with events and no throw", async () => {
    const { WebSocket, held } = world({ tls: { connect: () => { throw new Error("tls.connect refused the options"); } } });
    const ws = new WebSocket("wss://server.test/"), seen: string[] = [];
    ws.onerror = () => { seen.push("error"); };
    ws.onclose = (event: unknown) => { seen.push(`close ${String(Reflect.get(Object(event), "code"))}`); };
    expect([ws.readyState, held()]).toEqual([0, 1]);
    await settle(3);
    expect([seen, ws.readyState, held()]).toEqual([["error", "close 1006"], 3, 0]);
  });

  it("refuses a header that would write another line, and the dispatcher option", () => {
    const { WebSocket, network, held } = world();
    expect(() => new WebSocket("ws://server.test/", { headers: { "x-a": "1\r\nx-b: 2" } })).toThrow(TypeError);
    expect(() => new WebSocket("ws://server.test/", { headers: { "x a": "1" } })).toThrow(TypeError);
    expect(() => new WebSocket("ws://server.test/", { headers: [["only-a-name"]] })).toThrow("Headers constructor: expected name/value pair to be length 2, found 1.");
    expect(() => new WebSocket("ws://server.test/", { dispatcher: {} })).toThrow("WebSocket: the dispatcher option is not supported in a browser-assisted process");
    const refused = world({ unsupported: feature => { throw new RangeError(feature); } });
    expect(() => new refused.WebSocket("ws://server.test/", { dispatcher: null })).toThrow(RangeError);
    expect([network.connections.length, held()]).toEqual([0, 0]);
  });

  it("gives up on a response head that never ends", async () => {
    const { WebSocket, network, held } = world(), ws = new WebSocket("ws://server.test/hang"), end = closed(ws);
    ws.onerror = () => undefined;
    await settle(2);
    network.connections[0]?.server.write(`HTTP/1.1 101 Switching Protocols\r\nx-filler: ${"a".repeat(20_000)}`);
    expect(Reflect.get(await end, "code")).toBe(1006);
    expect([held(), network.connections[0]?.client.destroyed]).toEqual([0, true]);
  });
});

describe("the lifetime", () => {
  it("holds the process from construction until the close event, and delivers socket events through dispatch", async () => {
    const { WebSocket, held, dispatched } = world(), ws = new WebSocket("ws://server.test/echo");
    expect(held()).toBe(1);
    await opened(ws);
    expect(held()).toBe(1);
    expect(dispatched()).toBeGreaterThan(0);
    ws.close();
    expect(held()).toBe(1);
    await closed(ws);
    expect(held()).toBe(0);
  });

  it("holds the process while a Blob is read, and sends it before what was sent after it", async () => {
    const { WebSocket, held, network } = world(), ws = new WebSocket("ws://server.test/echo");
    ws.binaryType = "arraybuffer";
    await opened(ws);
    ws.send(new Blob([new Uint8Array([1, 2, 3])]));
    ws.send("next");
    expect([held(), ws.bufferedAmount]).toEqual([2, 7]);
    await settle();
    expect([held(), ws.bufferedAmount]).toEqual([1, 0]);
    expect(network.server.filter(entry => entry["event"] === "frame").map(entry => entry["opcode"])).toEqual([2, 1]);
    ws.close();
    await closed(ws);
  });

  it("runs events in the async context the socket was constructed in", async () => {
    let current = "outside";
    const seen: string[] = [];
    const context = { capture: () => { const captured = current; return <Result>(callback: () => Result): Result => { const previous = current; current = captured; try { return callback(); } finally { current = previous; } }; } };
    const { WebSocket } = world({ context });
    current = "request 1";
    const ws = new WebSocket("ws://server.test/greet");
    current = "outside";
    ws.onopen = () => { seen.push(`open in ${current}`); };
    ws.onmessage = () => { seen.push(`message in ${current}`); };
    ws.onclose = () => { seen.push(`close in ${current}`); };
    await closed(ws);
    expect(seen).toEqual(["open in request 1", "message in request 1", "message in request 1", "message in request 1", "message in request 1", "close in request 1"]);
  });
});

describe("install", () => {
  it("defines the classes as Node's globals are, and undoes it", () => {
    const { WebSocket, CloseEvent, MessageEvent, install } = world(), browser = function BrowserWebSocket(): void { /* The page's class. */ }, realm: Record<string, unknown> = { WebSocket: browser };
    const undo = install(realm), globals = record(shape["globals"], "globals");
    expect([realm["WebSocket"], realm["CloseEvent"], realm["MessageEvent"]]).toEqual([WebSocket, CloseEvent, MessageEvent]);
    for (const name of ["WebSocket", "CloseEvent", "MessageEvent"]) expect([name, Object.getOwnPropertyDescriptor(realm, name)]).toEqual([name, expect.objectContaining({ enumerable: false, configurable: globals[name] === "-cw", writable: true })]);
    undo();
    expect(realm).toEqual({ WebSocket: browser });
    expect(Object.keys(realm)).toEqual(["WebSocket"]);
  });

  it("keeps a realm's own event classes and fails closed when WebSocket cannot be replaced", () => {
    const { WebSocket, install } = world(), own = function CloseEvent(): void { /* The realm's class. */ }, realm: Record<string, unknown> = { CloseEvent: own };
    const undo = install(realm);
    expect([realm["WebSocket"], realm["CloseEvent"]]).toEqual([WebSocket, own]);
    undo();
    expect(Object.keys(realm)).toEqual(["CloseEvent"]);
    const frozen = Object.defineProperty({}, "WebSocket", { value: null, configurable: false, writable: false });
    expect(() => install(frozen)).toThrow("WebSocket: the realm's own WebSocket cannot be replaced");
    expect(() => install(null)).toThrow("Invalid realm");
  });
});

describe("frames", () => {
  const unmask = (bytes: Uint8Array): { opcode: number; payload: number[] } => {
    const second = (bytes[1] ?? 0) & 0x7f, offset = second < 126 ? 2 : second === 126 ? 4 : 10, mask = bytes.subarray(offset, offset + 4);
    return { opcode: (bytes[0] ?? 0) & 0x0f, payload: [...bytes.subarray(offset + 4)].map((byte, index) => byte ^ (mask[index & 3] ?? 0)) };
  };
  it("masks every client frame with a fresh key and writes the three length forms", () => {
    const small = encodeFrame(1, new Uint8Array([104, 105])), again = encodeFrame(1, new Uint8Array([104, 105]));
    expect([small[0], small[1], small.length]).toEqual([0x81, 0x82, 8]);
    expect(unmask(small)).toEqual({ opcode: 1, payload: [104, 105] });
    expect([...small.subarray(2, 6)]).not.toEqual([...again.subarray(2, 6)]);
    const medium = encodeFrame(2, new Uint8Array(300).fill(7)), large = encodeFrame(2, new Uint8Array(70_000).fill(9));
    expect([medium[1], (medium[2] ?? 0) << 8 | (medium[3] ?? 0), medium.length]).toEqual([0x80 | 126, 300, 308]);
    expect([large[1], new DataView(large.buffer).getBigUint64(2), large.length]).toEqual([0x80 | 127, 70_000n, 70_014]);
    expect(unmask(large).payload.every(byte => byte === 9)).toBe(true);
  });

  it("reads a frame delivered one byte at a time and stops after a failure", () => {
    const seen: unknown[] = [], receiver = new FrameReceiver({ message: (opcode, payload) => { seen.push([opcode, new TextDecoder().decode(payload)]); }, ping: payload => { seen.push(["ping", payload.length]); }, close: info => { seen.push(info); }, fail: (code, reason) => { seen.push([code, reason]); } });
    for (const byte of Buffer.concat([frame(1, "one", false), frame(9, "p"), frame(0, " two"), frame(2, "x")])) receiver.push(new Uint8Array([byte]));
    receiver.push(new Uint8Array([0x83, 0]));
    receiver.push(frame(1, "late"));
    expect(seen).toEqual([["ping", 1], [1, "one two"], [2, "x"], [1002, "Invalid opcode received"]]);
  });

  it("bounds a message at 128 MiB over all its fragments, from the length alone", () => {
    const failures: unknown[] = [], receiver = new FrameReceiver({ message: () => undefined, ping: () => undefined, close: () => undefined, fail: (code, reason) => { failures.push([code, reason]); } });
    const announce = (length: number, first: number): Uint8Array => { const head = new Uint8Array(10); head[0] = first; head[1] = 127; new DataView(head.buffer).setUint32(6, length); return head; };
    expect(MAX_MESSAGE_BYTES).toBe(134_217_728);
    receiver.push(frame(2, new Uint8Array(10), false));
    receiver.push(announce(MAX_MESSAGE_BYTES - 9, 0x80));
    expect(failures).toEqual([[1009, "Payload size exceeds maximum allowed size"]]);
  });

  it("checks the answer in undici's order", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==", head = (...lines: string[]): Uint8Array => new TextEncoder().encode(["HTTP/1.1 101 Switching Protocols", ...lines].join("\r\n"));
    // RFC 6455 section 1.3's own example.
    expect(acceptFor(key)).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const good = ["Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptFor(key)}`];
    expect(checkAnswer(head(...good), key, [])).toEqual({ protocol: "" });
    expect(checkAnswer(head(...good, "Sec-WebSocket-Protocol: b"), key, ["a", "b"])).toEqual({ protocol: "b" });
    expect(checkAnswer(head("Upgrade: h2c", "Connection: close"), key, ["a"])).toEqual({ failure: "Server did not respond with sent protocols." });
    expect(checkAnswer(head("Upgrade: h2c", "Connection: close"), key, [])).toEqual({ failure: 'Server did not set Upgrade header to "websocket".' });
    expect(checkAnswer(head("Upgrade: websocket", "Connection: close"), key, [])).toEqual({ failure: 'Server did not set Connection header to "upgrade".' });
    expect(checkAnswer(head("Upgrade: websocket", "Connection: upgrade", "Sec-WebSocket-Accept: no"), key, [])).toEqual({ failure: "Incorrect hash received in Sec-WebSocket-Accept header." });
    expect(checkAnswer(head(...good, "Sec-WebSocket-Extensions: permessage-deflate"), key, [])).toEqual({ failure: "Sec-WebSocket-Extensions header does not match." });
    expect(checkAnswer(new TextEncoder().encode("HTTP/1.1 200 OK"), key, [])).toEqual({ failure: "Received network error or non-101 status code." });
    expect(checkAnswer(new TextEncoder().encode("SSH-2.0-OpenSSH"), key, [])).toEqual({ failure: "Received network error or non-101 status code." });
  });
});
