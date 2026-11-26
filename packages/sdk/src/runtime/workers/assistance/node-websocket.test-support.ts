import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { record } from "../../decode.js";
import { list } from "./node-controls.test-support.ts";
import type { NodeWebSocketClass, NodeWebSocketInstance, WebSocketTransport } from "./node-websocket.ts";

/**
 * An in-memory network for the `WebSocket` tests: a pair of sockets per connection, with the tiny RFC 6455 server
 * and the scenario client of the recorder embedded in `node-websocket.controls.json`, line for line. The request
 * path picks the server's behaviour.
 */
type Log = Record<string, unknown>[];
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function bytesOf(bytes: Uint8Array): Record<string, unknown> {
  return bytes.length > 64 ? { length: bytes.length, head: hex(bytes.subarray(0, 8)), sum: bytes.reduce((sum, byte) => (sum + byte) % 65521, 0) } : { hex: hex(bytes) };
}
/** One unmasked frame, as a server sends it. */
export function frame(opcode: number, payload: string | readonly number[] | Uint8Array, fin = true): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload), length = body.length, first = (fin ? 0x80 : 0) | opcode;
  const head = length < 126 ? Buffer.from([first, length]) : length < 65536 ? Buffer.from([first, 126, length >> 8, length & 255])
    : Buffer.from([first, 127, 0, 0, 0, 0, length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255]);
  return Buffer.concat([head, body]);
}
const closeFrame = (code?: number, reason = ""): Buffer => frame(8, code === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)]));

/** One end of an in-memory connection, with the part of `net.Socket` the client and the server use. */
export class FakeSocket extends EventEmitter {
  peer: FakeSocket | undefined;
  destroyed = false;
  #ended = false;
  readonly #activity: () => void;
  constructor(activity: () => void) { super(); this.#activity = activity; }
  write(chunk: unknown, callback?: unknown): boolean {
    if (this.destroyed || this.#ended) return false;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.alloc(0);
    this.#activity();
    queueMicrotask(() => {
      if (this.peer?.destroyed === false) this.peer.emit("data", bytes);
      if (typeof callback === "function") Reflect.apply(callback, undefined, []);
    });
    return true;
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined) this.write(chunk);
    if (this.#ended) return;
    this.#ended = true;
    this.#activity();
    queueMicrotask(() => { this.peer?.ended(); this.#close(); });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#activity();
    queueMicrotask(() => { this.emit("close"); this.peer?.ended(); });
  }
  /** The other side went away: no half-open connection is kept. */
  ended(): void { if (this.destroyed) return; this.emit("end"); this.#close(); }
  #close(): void { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
}

/** One connection of the server; the same steps as `serve` in the recorder. */
function serve(socket: FakeSocket, log: Log): void {
  let buffer: Buffer = Buffer.alloc(0), mode = "", upgraded = false, closeSent = false;
  const send = (bytes: Uint8Array | string): void => { if (!socket.destroyed) socket.write(bytes); };
  const sendClose = (code?: number, reason = ""): void => { closeSent = true; send(closeFrame(code, reason)); };
  const handshake = (head: string): void => {
    const lines = head.split("\r\n"), headers = new Map<string, string>();
    for (const line of lines.slice(1)) { const colon = line.indexOf(":"); headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()); }
    const url = new URL((lines[0] ?? "").split(" ")[1] ?? "/", "http://server"), key = headers.get("sec-websocket-key") ?? "";
    log.push({ event: "request", line: lines[0], headers: [...headers].map(([name, value]) => [name, name === "sec-websocket-key" ? "<key>" : name === "host" ? "<host>" : value]).sort((a, b) => (a[0] ?? "") < (b[0] ?? "") ? -1 : 1) });
    mode = url.pathname.slice(1);
    const param = (name: string): string | null => url.searchParams.get(name);
    if (mode === "hang") return;
    if (mode === "status") { socket.end(`HTTP/1.1 ${param("code") ?? ""} Status\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno`); return; }
    if (mode === "redirect") { socket.end("HTTP/1.1 302 Found\r\nLocation: /echo\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
    if (mode === "garbage") { socket.end("not http at all\r\n\r\n"); return; }
    const accept = mode === "bad-accept" ? "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" : createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const answer = ["HTTP/1.1 101 Switching Protocols"];
    if (mode !== "no-upgrade") answer.push(`Upgrade: ${mode === "upgrade-case" ? "WebSocket" : "websocket"}`);
    answer.push(`Connection: ${mode === "no-connection" ? "keep-alive" : "Upgrade"}`);
    if (mode !== "no-accept") answer.push(`Sec-WebSocket-Accept: ${accept}`);
    const protocol = param("protocol"), extensions = param("extensions"), code = param("code");
    if (protocol !== null) answer.push(`Sec-WebSocket-Protocol: ${protocol}`);
    if (extensions !== null) answer.push(`Sec-WebSocket-Extensions: ${extensions}`);
    send(`${answer.join("\r\n")}\r\n\r\n`);
    upgraded = true;
    if (mode === "greet") { send(frame(1, "hello")); send(frame(2, [1, 2, 3])); send(frame(1, "")); send(frame(1, "zażółć 🙂")); sendClose(1000, "done"); }
    else if (mode === "fragment") { send(frame(1, "frag", false)); send(frame(9, "p")); send(frame(0, "men", false)); send(frame(0, "ted")); send(frame(2, [1, 2], false)); send(frame(0, [3])); sendClose(1000, ""); }
    else if (mode === "ping") send(frame(9, "pp"));
    else if (mode === "pong") { send(frame(10, "unsolicited")); send(frame(1, "after pong")); sendClose(1000, ""); }
    else if (mode === "close") sendClose(code === null ? undefined : Number(code), param("reason") ?? "");
    else if (mode === "drop") socket.destroy();
    else if (mode === "end") socket.end();
    else if (mode === "raw") send(Buffer.from(param("hex") ?? "", "hex"));
    else if (mode === "split") {
      const bytes = Buffer.concat([frame(1, "split across writes"), frame(2, Buffer.alloc(300, 7)), closeFrame(1000, "split")]);
      let offset = 0;
      const step = (): void => { if (offset >= bytes.length) return; send(bytes.subarray(offset, offset + 5)); offset += 5; setImmediate(step); };
      step(); closeSent = true;
    } else if (mode === "big") { send(frame(2, Buffer.alloc(70000, 9))); sendClose(1000, ""); }
  };
  const frames = (): void => {
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0] ?? 0, second = buffer[1] ?? 0, masked = (second & 0x80) !== 0;
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = buffer.readUInt32BE(6); offset = 10; }
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const payload = Buffer.from(buffer.subarray(total - length, total));
      if (masked) for (let index = 0; index < length; index++) payload[index] = (payload[index] ?? 0) ^ (buffer[offset + (index & 3)] ?? 0);
      buffer = buffer.subarray(total);
      const opcode = first & 0x0f;
      log.push({ event: "frame", fin: (first & 0x80) !== 0, opcode, masked, ...(opcode === 1 ? { text: payload.toString() } : opcode === 8 && length >= 2 ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() } : bytesOf(payload)) });
      if (opcode === 8) { if (!closeSent) { closeSent = true; send(frame(8, payload)); } socket.end(); return; }
      if (mode === "echo" && (opcode === 1 || opcode === 2)) send(frame(opcode, payload));
      if (mode === "ping" && opcode === 10) sendClose(1000, "ponged");
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded && mode === "") {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("latin1");
      buffer = buffer.subarray(end + 4);
      handshake(head);
    }
    if (upgraded) frames();
  });
  socket.on("close", () => { log.push({ event: "closed" }); });
}

export interface Connection { readonly secure: boolean; readonly options: Record<string, unknown>; readonly client: FakeSocket; readonly server: FakeSocket }
/** The `net` and `tls` a `WebSocket` is given: every connection reaches the server above; port 1 refuses. */
export function fakeNetwork() {
  const connections: Connection[] = [], server: Log = [];
  let activity = 0;
  const touch = (): void => { activity++; };
  const transport = (secure: boolean): WebSocketTransport => ({
    connect(options) {
      const client = new FakeSocket(touch), remote = new FakeSocket(touch);
      touch();
      if (options["port"] === 1) { queueMicrotask(() => { client.destroyed = true; client.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })); client.emit("close"); }); return client; }
      client.peer = remote; remote.peer = client;
      connections.push({ secure, options, client, server: remote });
      serve(remote, server);
      return client;
    },
  });
  return { net: transport(false), tls: transport(true), connections, server, activity: () => activity };
}

function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { value: String(error) };
  const code: unknown = Reflect.get(error, "code");
  return { class: error.constructor.name, name: field(error, "name"), message: field(error, "message"), ...(code === undefined ? {} : { code }) };
}
const fromHex = (text: unknown): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(String(text), "hex"));
const turn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
function actions(value: unknown): unknown[][] { return value === undefined ? [] : list(value).map(list); }
function field(target: object, name: string): unknown { const value: unknown = Reflect.get(target, name); return value; }

/** Runs one recorded scenario's client steps, as `client` in the recorder does; resolves with its log. */
export async function runScenario(scenario: Record<string, unknown>, url: string, WebSocketClass: NodeWebSocketClass, activity: () => number): Promise<Log> {
  const log: Log = [], blobs: [Record<string, unknown>, Blob][] = [];
  const state = { messages: 0, closed: false };
  const make = (): NodeWebSocketInstance => "args" in scenario ? new WebSocketClass(url, ...list(scenario["args"])) : "noUrl" in scenario ? new WebSocketClass() : new WebSocketClass(url);
  let ws: NodeWebSocketInstance;
  try { ws = make(); } catch (error) { log.push({ threw: describeError(error), by: "constructor" }); return log; }
  const act = (action: unknown[]): void => {
    try {
      const [verb, first, second] = action;
      if (verb === "send") {
        if (first === "text") ws.send(second);
        else if (first === "buffer") ws.send(fromHex(second).buffer);
        else if (first === "view") { const bytes = new Uint8Array(fromHex(second).length + 4); bytes.set(fromHex(second), 2); ws.send(bytes.subarray(2, bytes.length - 2)); }
        else if (first === "dataview") ws.send(new DataView(fromHex(second).buffer));
        else if (first === "blob") ws.send(new Blob([fromHex(second)]));
        else if (first === "fill") ws.send(Uint8Array.from({ length: Number(second) }, (_, index) => index & 255));
        else if (first === "value") ws.send(second);
        else if (first === "none") ws.send();
      } else if (verb === "close") { if (action.length === 1) ws.close(); else if (action.length === 2) ws.close(first); else ws.close(first, second); }
      else if (verb === "set") Reflect.set(ws, String(first), second);
      else if (verb === "get") log.push({ get: first, value: Reflect.get(ws, String(first)) });
    } catch (error) { log.push({ threw: describeError(error), by: action[0] }); }
  };
  log.push({ constructed: { url: ws.url === url ? "<url>" : ws.url.replace(/\/\/[^/]+/u, "//<host>"), readyState: ws.readyState, protocol: ws.protocol, extensions: ws.extensions, binaryType: ws.binaryType, bufferedAmount: ws.bufferedAmount } });
  const on = scenario["on"] === undefined ? {} : record(scenario["on"], "on");
  ws.addEventListener("open", event => { log.push({ event: "open", class: event.constructor.name, readyState: ws.readyState, protocol: ws.protocol, extensions: ws.extensions }); for (const action of actions(on["open"])) act(action); });
  ws.onmessage = (event: Event): void => {
    const value = field(event, "data"), ports = field(event, "ports");
    const data = typeof value === "string" ? { text: value } : value instanceof ArrayBuffer ? { arraybuffer: true, ...bytesOf(new Uint8Array(value)) } : value instanceof Blob ? { blob: true, size: value.size, type: value.type } : { other: String(value) };
    const entry = { event: "message", class: event.constructor.name, readyState: ws.readyState, origin: String(field(event, "origin")).replace(/\/\/.+/u, "//<host>"), lastEventId: field(event, "lastEventId"), source: field(event, "source"), ports: Array.isArray(ports) ? ports.length : -1, data };
    if (value instanceof Blob) blobs.push([entry.data, value]);
    log.push(entry);
    const steps = on["message"] === undefined ? undefined : list(on["message"])[state.messages++];
    for (const action of actions(steps)) act(action);
  };
  ws.onerror = (event: Event): void => { log.push({ event: "error", class: event.constructor.name, readyState: ws.readyState, message: field(event, "message"), error: describeError(field(event, "error")) }); for (const action of actions(on["error"])) act(action); };
  ws.addEventListener("close", event => { log.push({ event: "close", class: event.constructor.name, readyState: ws.readyState, code: field(event, "code"), reason: field(event, "reason"), wasClean: field(event, "wasClean") }); for (const action of actions(on["close"])) act(action); state.closed = true; });
  for (const action of actions(scenario["start"])) act(action);
  log.push({ mark: "started", readyState: ws.readyState });
  // The recorder waits on the clock; here the scenario is over once nothing has moved for a number of loop turns.
  for (let quiet = 0, seen = -1; quiet < 25;) {
    await turn();
    const now = activity() + log.length;
    if (now === seen) quiet++; else { quiet = 0; seen = now; }
  }
  if (!state.closed) log.push({ mark: "timeout", readyState: ws.readyState });
  for (const [data, blob] of blobs) Object.assign(data, bytesOf(new Uint8Array(await blob.arrayBuffer())));
  return log;
}
