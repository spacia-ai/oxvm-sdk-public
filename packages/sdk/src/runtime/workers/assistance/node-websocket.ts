/**
 * Node's global `WebSocket` (`http.WebSocket`) for a fast-path process.
 *
 * The worker's own `WebSocket` is the browser's: it connects from the page's network, not from the VM's. This one
 * speaks RFC 6455 on the process's Linux sockets: `ws:` through `net.connect`, `wss:` through `tls.connect`. A
 * connection therefore reaches what the VM reaches, under the VM's network policy, and nothing else.
 *
 * The interface, its errors and its event sequences are those of undici v7.29.0 in Node.js v24.18.1
 * (`node-websocket.controls.json` holds what real Node did). Differences:
 * - `permessage-deflate` is not offered, so `extensions` is always empty and a compressed frame is refused;
 * - the `dispatcher` option is refused: it would choose another network path;
 * - a server that names a subprotocol when none was offered fails the connection (Node throws an uncaught TypeError);
 * - a program's own `Host`, `Connection`, `Upgrade` and `Sec-WebSocket-*` headers are not sent.
 *
 * An open or connecting socket holds the process's event loop until its `close` event has been delivered. Socket
 * events enter through the process's dispatch, in the async context the socket was constructed in.
 */
import { closePayload, decodeText, encodeFrame, FrameReceiver, OPCODE, type CloseInfo } from "./node-websocket-frames.ts";
import { templateText } from "./node-util-validators.ts";
import { checkAnswer, createKey, encodeUpgrade, headEnd, MAX_HEAD_BYTES } from "./node-websocket-handshake.ts";

/** A socket factory of the process: `net.connect` or `tls.connect`. The socket is used as a Node stream. */
export interface WebSocketTransport { connect(options: Record<string, unknown>): unknown }
/** What a `WebSocket` uses of its process. */
export interface NodeWebSocketDeps {
  /** Plain TCP for `ws:`. */
  readonly net: WebSocketTransport;
  /** TLS for `wss:`. */
  readonly tls: WebSocketTransport;
  /** A hold on the process's event loop; the result releases it. */
  readonly retain: () => () => void;
  /** The process's callback queue. */
  readonly dispatch: (callback: () => void) => void;
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
  /** Refuses a feature this runtime does not have; the default throws a TypeError. */
  readonly unsupported?: (feature: string) => never;
}

type EventClass = new (type: string, init?: Record<string, unknown>) => Event;
/** A `WebSocket` instance. */
export interface NodeWebSocketInstance extends EventTarget {
  readonly url: string; readonly readyState: number; readonly bufferedAmount: number; readonly extensions: string; readonly protocol: string;
  binaryType: string;
  onopen: unknown; onerror: unknown; onclose: unknown; onmessage: unknown;
  close(code?: unknown, reason?: unknown): void;
  send(data?: unknown): void;
  readonly CONNECTING: 0; readonly OPEN: 1; readonly CLOSING: 2; readonly CLOSED: 3;
}
/** The `WebSocket` class. */
export interface NodeWebSocketClass {
  new (...args: unknown[]): NodeWebSocketInstance;
  readonly prototype: NodeWebSocketInstance;
  readonly CONNECTING: 0; readonly OPEN: 1; readonly CLOSING: 2; readonly CLOSED: 3;
}
export interface NodeWebSocket {
  readonly WebSocket: NodeWebSocketClass;
  readonly CloseEvent: EventClass;
  readonly MessageEvent: EventClass;
  /** Defines the three classes on a realm's global, as Node does; returns the undo. */
  readonly install: (realm: unknown) => () => void;
}

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
type EventType = "open" | "error" | "close" | "message";

const member = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, name) : undefined;
function invoke(target: unknown, name: string, ...args: unknown[]): void {
  const method = member(target, name);
  if (typeof method !== "function") throw new TypeError(`WebSocket: the socket has no ${name}()`);
  Reflect.apply(method, target, args);
}
function isEventClass(value: unknown): value is EventClass { return typeof value === "function"; }
function isListener(value: unknown): value is EventListenerOrEventListenerObject { return typeof value === "function" || (typeof value === "object" && value !== null); }
function isIterable(value: object): value is Iterable<unknown> { return typeof Reflect.get(value, Symbol.iterator) === "function"; }
const illegal = (): TypeError => Object.assign(new TypeError("Illegal invocation"), { code: "ERR_INVALID_THIS" });
/** WebIDL's USVString: lone surrogates become U+FFFD. */
const scalarString = (value: unknown): string => templateText(value).toWellFormed();

/** The event classes the platform lacks, with the fields Node's have. */
function fallbackEvents(): Record<"CloseEvent" | "MessageEvent" | "ErrorEvent", EventClass> {
  const text = (value: unknown): string => value === undefined ? "" : templateText(value);
  class CloseEvent extends Event {
    readonly wasClean: boolean; readonly code: number; readonly reason: string;
    constructor(type: string, init: Record<string, unknown> = {}) { super(type, init); this.wasClean = Boolean(init["wasClean"]); this.code = Number(init["code"] ?? 0); this.reason = text(init["reason"]); }
  }
  class MessageEvent extends Event {
    readonly data: unknown; readonly origin: string; readonly lastEventId: string; readonly source: unknown; readonly ports: readonly unknown[];
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      this.data = init["data"] ?? null; this.origin = text(init["origin"]); this.lastEventId = text(init["lastEventId"]); this.source = init["source"] ?? null;
      this.ports = Object.freeze([]);
    }
  }
  class ErrorEvent extends Event {
    readonly message: string; readonly filename: string; readonly lineno: number; readonly colno: number; readonly error: unknown;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      this.message = text(init["message"]); this.filename = text(init["filename"]); this.lineno = Number(init["lineno"] ?? 0); this.colno = Number(init["colno"] ?? 0); this.error = init["error"];
    }
  }
  // The bundle renames classes; programs read these names.
  for (const [name, target] of Object.entries({ CloseEvent, MessageEvent, ErrorEvent })) Object.defineProperty(target, "name", { value: name, configurable: true });
  return { CloseEvent, MessageEvent, ErrorEvent };
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
/** The `headers` option as a list of lower-case names; the forms a `Headers` constructor takes. */
function headerList(init: unknown): Map<string, string> {
  const headers = new Map<string, string>();
  if (init === undefined || init === null) return headers;
  const add = (name: unknown, value: unknown): void => {
    const key = templateText(name).toLowerCase(), text = templateText(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "");
    if (!TOKEN.test(key)) throw new TypeError(`Headers.append: "${key}" is an invalid header name.`);
    // A line break or NUL in a value would write another header or request.
    if (/[\0\r\n]/u.test(text) || /[^\0-\xff]/u.test(text)) throw new TypeError(`Headers.append: "${text}" is an invalid header value.`);
    const previous = headers.get(key);
    headers.set(key, previous === undefined ? text : `${previous}, ${text}`);
  };
  if (typeof init !== "object" && typeof init !== "function") throw new TypeError("Headers constructor: Argument 1 could not be converted to one of: sequence<sequence<ByteString>>, record<ByteString, ByteString>.");
  if (isIterable(init)) {
    for (const pair of init) {
      const items = typeof pair === "object" && pair !== null && isIterable(pair) ? [...pair] : undefined;
      if (items === undefined) throw new TypeError("Headers constructor: Sequence: Value of type Number is not an Object.");
      if (items.length !== 2) throw new TypeError(`Headers constructor: expected name/value pair to be length 2, found ${items.length}.`);
      add(items[0], items[1]);
    }
  } else for (const [name, value] of Object.entries(init)) add(name, value);
  return headers;
}

/** RFC 6455's subprotocol token, as undici checks one. */
function validProtocol(protocol: string): boolean {
  if (protocol.length === 0) return false;
  for (let index = 0; index < protocol.length; index++) {
    const code = protocol.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || '"(),/:;<=>?@[\\]{}'.includes(protocol.charAt(index))) return false;
  }
  return true;
}

/** The constructor's second argument: subprotocols, or undici's `{ protocols, headers, dispatcher }`. */
function initOptions(value: unknown): { readonly protocols: string[]; readonly headers: unknown; readonly dispatcher: unknown } {
  const strings = (list: unknown): string[] => (typeof list === "object" && list !== null) || typeof list === "function" ? isIterable(list) ? [...list].map(templateText) : [templateText(list)] : [templateText(list)];
  if (((typeof value === "object" && value !== null) || typeof value === "function") && !isIterable(value)) {
    const protocols: unknown = Reflect.get(value, "protocols");
    return { protocols: protocols === undefined ? [] : strings(protocols), headers: Reflect.get(value, "headers"), dispatcher: Reflect.get(value, "dispatcher") };
  }
  return { protocols: strings(value), headers: undefined, dispatcher: undefined };
}

/** undici's `getURLRecord`: the address a socket connects to. */
function urlRecord(input: string): URL {
  // Node has no page to resolve a relative address against.
  if (!URL.canParse(input)) throw new DOMException("TypeError: Invalid URL", "SyntaxError");
  const url = new URL(input);
  if (url.protocol === "http:") url.protocol = "ws:"; else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new DOMException("expected a ws: or wss: url", "SyntaxError");
  if (url.hash.length > 0 || url.href.endsWith("#")) throw new DOMException("hash", "SyntaxError");
  return url;
}

/** WebIDL's `[Clamp] unsigned short`. */
function clampedShort(value: unknown): number {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  // undici's rounding, not WebIDL's nearest: down to an even integer, else up.
  const bounded = Math.min(Math.max(number, 0), 65535), floor = Math.floor(bounded);
  return floor % 2 === 0 ? floor : Math.ceil(bounded);
}

interface Queued { frame: Uint8Array | undefined; readonly size: number; dropped: boolean }

/** Creates the `WebSocket` class of one process, and the event classes that go with it. */
export function createNodeWebSocket(deps: NodeWebSocketDeps): NodeWebSocket {
  const fallback = fallbackEvents();
  const platform = (name: "CloseEvent" | "MessageEvent" | "ErrorEvent"): EventClass => { const found: unknown = Reflect.get(globalThis, name); return isEventClass(found) ? found : fallback[name]; };
  // The platform's event classes do no I/O; they are the ones a program's `instanceof` expects.
  const CloseEventClass = platform("CloseEvent"), MessageEventClass = platform("MessageEvent"), ErrorEventClass = platform("ErrorEvent");
  const unsupported = deps.unsupported ?? ((feature: string): never => { throw new TypeError(`${feature} is not supported in a browser-assisted process`); });

  class WebSocket extends EventTarget {
    static readonly CONNECTING = CONNECTING; static readonly OPEN = OPEN; static readonly CLOSING = CLOSING; static readonly CLOSED = CLOSED;
    declare readonly CONNECTING: 0; declare readonly OPEN: 1; declare readonly CLOSING: 2; declare readonly CLOSED: 3;
    #state = CONNECTING;
    #url = ""; #origin = ""; #protocol = ""; #binaryType = "blob"; #buffered = 0;
    readonly #handlers: Record<EventType, unknown> = { open: null, error: null, close: null, message: null };
    #socket: unknown;
    #head: Uint8Array = new Uint8Array();
    #key = ""; #offered: readonly string[] = [];
    #receiver: FrameReceiver | undefined;
    #closeSent = false; #closeReceived = false; #closeInfo: CloseInfo | undefined;
    #finished = false;
    readonly #queue: Queued[] = [];
    #release: (() => void) | undefined;
    #run: <Result>(callback: () => Result) => Result = callback => callback();

    constructor(...args: unknown[]) {
      super();
      if (args.length < 1) throw new TypeError("WebSocket constructor: 1 argument required, but 0 found.");
      const options = initOptions(args[1] === undefined ? [] : args[1]), url = urlRecord(scalarString(args[0])), protocols = options.protocols;
      if (protocols.length !== new Set(protocols.map(protocol => protocol.toLowerCase())).size || !protocols.every(validProtocol)) throw new DOMException("Invalid Sec-WebSocket-Protocol value", "SyntaxError");
      this.#url = url.href; this.#origin = url.origin;
      const headers = headerList(options.headers);
      if (options.dispatcher !== undefined) unsupported("WebSocket: the dispatcher option");
      this.#offered = protocols; this.#key = createKey();
      this.#run = deps.context?.capture() ?? this.#run;
      this.#release = deps.retain();
      this.#connect(url, headers);
    }

    close(...args: unknown[]): void {
      if (!(#state in this)) throw illegal();
      const [code, reason] = args;
      const status = code === undefined ? null : clampedShort(code), text = reason === undefined ? "" : scalarString(reason);
      if (status !== null && status !== 1000 && (status < 3000 || status > 4999)) throw new DOMException("invalid code", "InvalidAccessError");
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > 123) throw new DOMException(`Reason must be less than 123 bytes; received ${bytes}`, "SyntaxError");
      if (this.#state === CLOSED || this.#state === CLOSING) return;
      if (this.#state === CONNECTING) {
        this.#failConnecting();
        // undici leaves a socket closed before it opened in the closing state.
        this.#state = CLOSING;
        return;
      }
      this.#sendClose(status === null && text.length > 0 ? 1000 : status, text);
    }

    send(...args: unknown[]): void {
      if (!(#state in this)) throw illegal();
      if (args.length < 1) throw new TypeError("WebSocket.send: 1 argument required, but 0 found.");
      const data = args[0], blob = data instanceof Blob ? data : undefined;
      const bytes = blob !== undefined ? undefined : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
      const text = blob === undefined && bytes === undefined ? new TextEncoder().encode(scalarString(data)) : undefined;
      if (this.#state === CONNECTING) throw new DOMException("Sent before connected.", "InvalidStateError");
      if (this.#state !== OPEN) return;
      if (blob !== undefined) { this.#sendBlob(blob); return; }
      const payload = text ?? bytes ?? new Uint8Array(), entry: Queued = { frame: encodeFrame(text === undefined ? OPCODE.binary : OPCODE.text, payload), size: payload.length, dropped: false };
      this.#buffered += entry.size;
      this.#queue.push(entry);
      this.#drain();
    }

    get readyState(): number { if (!(#state in this)) throw illegal(); return this.#state; }
    get bufferedAmount(): number { if (!(#state in this)) throw illegal(); return this.#buffered; }
    get url(): string { if (!(#state in this)) throw illegal(); return this.#url; }
    get extensions(): string { if (!(#state in this)) throw illegal(); return ""; }
    get protocol(): string { if (!(#state in this)) throw illegal(); return this.#protocol; }
    get onopen(): unknown { if (!(#state in this)) throw illegal(); return this.#handlers.open; }
    set onopen(handler: unknown) { if (!(#state in this)) throw illegal(); this.#handler("open", handler); }
    get onerror(): unknown { if (!(#state in this)) throw illegal(); return this.#handlers.error; }
    set onerror(handler: unknown) { if (!(#state in this)) throw illegal(); this.#handler("error", handler); }
    get onclose(): unknown { if (!(#state in this)) throw illegal(); return this.#handlers.close; }
    set onclose(handler: unknown) { if (!(#state in this)) throw illegal(); this.#handler("close", handler); }
    get onmessage(): unknown { if (!(#state in this)) throw illegal(); return this.#handlers.message; }
    set onmessage(handler: unknown) { if (!(#state in this)) throw illegal(); this.#handler("message", handler); }
    get binaryType(): string { if (!(#state in this)) throw illegal(); return this.#binaryType; }
    set binaryType(type: string) { if (!(#state in this)) throw illegal(); this.#binaryType = type === "arraybuffer" ? "arraybuffer" : "blob"; }

    #handler(type: EventType, handler: unknown): void {
      const previous = this.#handlers[type];
      if (isListener(previous)) this.removeEventListener(type, previous);
      // WebIDL's EventHandler: anything but a function or an object is null.
      if (isListener(handler)) { this.addEventListener(type, handler); this.#handlers[type] = handler; } else this.#handlers[type] = null;
    }

    /** Socket work joins the process's callback queue, in the context the socket was made in. */
    #deliver(work: () => void): void { deps.dispatch(() => { this.#run(work); }); }

    #connect(url: URL, headers: ReadonlyMap<string, string>): void {
      const secure = url.protocol === "wss:", port = url.port === "" ? (secure ? 443 : 80) : Number(url.port), host = url.hostname.replace(/^\[|\]$/gu, "");
      try {
        // An address literal has no server name to indicate.
        const socket = this.#socket = secure ? deps.tls.connect({ host, port, servername: /^[0-9.]+$/u.test(host) || host.includes(":") ? "" : host }) : deps.net.connect({ host, port });
        invoke(socket, "on", "data", (chunk: unknown) => { if (chunk instanceof Uint8Array) this.#deliver(() => { this.#data(socket, chunk); }); });
        invoke(socket, "on", "error", () => { this.#deliver(() => { this.#socketError(socket); }); });
        // A peer that ends its side gets no half-open connection.
        invoke(socket, "on", "end", () => { this.#deliver(() => { if (this.#socket === socket) invoke(socket, "destroy"); }); });
        invoke(socket, "on", "close", () => { this.#deliver(() => { if (this.#socket === socket) this.#socketClosed(); }); });
        // The request leaves on the next turn: a socket closed in the turn it was made sends nothing, as in Node.
        this.#deliver(() => {
          if (this.#socket !== socket || this.#state !== CONNECTING) return;
          try { invoke(socket, "write", encodeUpgrade(url, this.#key, this.#offered, headers)); } catch { this.#failConnecting(); }
        });
      } catch {
        // A socket that cannot be made is a network error, which Node reports as events.
        this.#deliver(() => { if (this.#state === CONNECTING) this.#failConnecting(); });
      }
    }

    #data(socket: unknown, chunk: Uint8Array): void {
      if (this.#socket !== socket || this.#finished) return;
      if (this.#receiver !== undefined) { this.#receiver.push(chunk); return; }
      if (this.#state !== CONNECTING) return;
      const head = new Uint8Array(this.#head.length + chunk.length);
      head.set(this.#head); head.set(chunk, this.#head.length);
      const end = headEnd(head);
      if (end < 0) { if (head.length > MAX_HEAD_BYTES) this.#failConnecting(); else this.#head = head; return; }
      const answer = checkAnswer(head.subarray(0, end - 4), this.#key, this.#offered);
      if ("failure" in answer) { this.#failConnecting(); return; }
      this.#head = new Uint8Array();
      this.#protocol = answer.protocol;
      const receiver = this.#receiver = new FrameReceiver({
        message: (opcode, payload) => { this.#message(opcode, payload); },
        ping: payload => { if (!this.#closeReceived) this.#write(encodeFrame(OPCODE.pong, payload)); },
        close: info => { this.#peerClosed(info); },
        fail: (code, reason) => { this.#fail(code, reason); },
      });
      this.#state = OPEN;
      this.dispatchEvent(new Event("open"));
      receiver.push(head.subarray(end));
    }

    #message(opcode: 1 | 2, payload: Uint8Array<ArrayBuffer>): void {
      if (this.#state !== OPEN) return;
      let data: string | Blob | ArrayBuffer;
      if (opcode === OPCODE.text) {
        const text = decodeText(payload);
        if (text === undefined) { this.#fail(1007, "Received invalid UTF-8 in text frame."); return; }
        data = text;
      } else data = this.#binaryType === "blob" ? new Blob([payload]) : payload.buffer;
      this.dispatchEvent(new MessageEventClass("message", { origin: this.#origin, data }));
    }

    #peerClosed(info: CloseInfo): void {
      this.#closeInfo = info;
      if (!this.#closeSent) {
        this.#closeSent = true;
        // undici answers with the code alone.
        this.#write(encodeFrame(OPCODE.close, closePayload(info.code === undefined || info.code === 0 ? null : info.code, "")));
      }
      this.#state = CLOSING;
      this.#closeReceived = true;
      // The server closes the connection; the `close` event follows the socket's.
    }

    /** The closing handshake's first frame, unless one was sent or received. */
    #sendClose(code: number | null, reason: string, done?: () => void): void {
      if (!this.#closeSent && !this.#closeReceived) {
        this.#closeSent = true;
        this.#write(encodeFrame(OPCODE.close, closePayload(code, reason)), done);
      } else done?.();
      this.#state = CLOSING;
    }

    /** undici's `failWebsocketConnection` for an established connection: say why, then drop the socket. */
    #fail(code: number, reason: string): void {
      this.#receiver?.stop();
      const socket = this.#socket, destroy = (): void => { if (this.#socket === socket && !this.#finished) invoke(socket, "destroy"); };
      // The socket goes once the close frame has been handed to Linux: destroying it first would drop the frame.
      if (this.#state === OPEN) this.#sendClose(code, reason, destroy); else destroy();
    }

    #socketError(socket: unknown): void {
      if (this.#socket !== socket || this.#finished) return;
      if (this.#state === CONNECTING) { this.#failConnecting(); return; }
      this.#state = CLOSING;
      invoke(socket, "destroy");
    }

    /** A connection that never opened: the socket goes and the events fire at once. */
    #failConnecting(): void {
      const socket = this.#socket;
      this.#socket = undefined;
      this.#socketClosed();
      if (socket !== undefined) { try { invoke(socket, "destroy"); } catch { /* A socket that cannot be destroyed is already gone. */ } }
    }

    /** undici's `onSocketClose`: the end of the connection, clean only after both close frames. */
    #socketClosed(): void {
      if (this.#finished) return;
      this.#finished = true;
      this.#receiver?.stop();
      const wasClean = this.#closeSent && this.#closeReceived, info = this.#closeInfo, reason = info?.reason ?? "";
      let code = info?.code ?? 1005;
      this.#state = CLOSED;
      try {
        if (!this.#closeReceived) {
          code = 1006;
          this.dispatchEvent(new ErrorEventClass("error", { error: new TypeError(reason) }));
        }
        this.dispatchEvent(new CloseEventClass("close", { wasClean, code, reason }));
      } finally { this.#release?.(); this.#release = undefined; }
    }

    #write(frame: Uint8Array, done?: () => void): void {
      const socket = this.#socket;
      if (socket === undefined || this.#finished) return;
      try { invoke(socket, "write", frame, () => { done?.(); }); } catch { done?.(); }
    }

    /** Frames leave in the order of the `send` calls; one whose Blob is still being read holds the later ones. */
    #drain(): void {
      for (let entry = this.#queue[0]; entry !== undefined && (entry.frame !== undefined || entry.dropped); entry = this.#queue[0]) {
        this.#queue.shift();
        const { frame, size } = entry;
        if (frame === undefined || this.#socket === undefined || this.#finished) continue;
        this.#write(frame, () => { this.#buffered -= size; });
      }
    }

    #sendBlob(blob: Blob): void {
      const entry: Queued = { frame: undefined, size: blob.size, dropped: false };
      this.#buffered += entry.size;
      this.#queue.push(entry);
      // Only the browser settles this promise, so the process is held until it has.
      const release = deps.retain(), settle = (frame: Uint8Array | undefined): void => {
        this.#deliver(() => { try { entry.frame = frame; entry.dropped = frame === undefined; this.#drain(); } finally { release(); } });
      };
      void blob.arrayBuffer().then(buffer => { settle(encodeFrame(OPCODE.binary, new Uint8Array(buffer))); }, () => { settle(undefined); });
    }
  }

  const constant = (value: number): PropertyDescriptor => ({ value, enumerable: true, writable: false, configurable: false });
  const constants = { CONNECTING: constant(CONNECTING), OPEN: constant(OPEN), CLOSING: constant(CLOSING), CLOSED: constant(CLOSED) };
  // Node's members are enumerable, and the bundle renames the class.
  for (const key of ["close", "send", "readyState", "bufferedAmount", "url", "extensions", "protocol", "onopen", "onerror", "onclose", "onmessage", "binaryType"]) Object.defineProperty(WebSocket.prototype, key, { enumerable: true });
  Object.defineProperties(WebSocket.prototype, { ...constants, [Symbol.toStringTag]: { value: "WebSocket", writable: false, enumerable: false, configurable: true } });
  const send: unknown = Reflect.get(WebSocket.prototype, "send");
  if (typeof send === "function") Object.defineProperty(send, "length", { value: 1, configurable: true });
  Object.defineProperties(WebSocket, { ...constants, name: { value: "WebSocket", configurable: true }, length: { value: 1, configurable: true } });

  const install = (realm: unknown): (() => void) => {
    if (typeof realm !== "object" || realm === null) throw new TypeError("Invalid realm");
    const undo: (() => void)[] = [];
    const define = (name: string, value: unknown, replace: boolean): void => {
      const previous = Object.getOwnPropertyDescriptor(realm, name);
      // Leaving the browser's WebSocket in place would let the program connect from the page's network.
      if (replace && previous?.configurable === false) throw new TypeError(`${name}: the realm's own ${name} cannot be replaced`);
      if (previous !== undefined && !replace) return;
      Object.defineProperty(realm, name, { configurable: true, enumerable: false, writable: true, value });
      undo.push(() => { if (previous === undefined) Reflect.deleteProperty(realm, name); else Object.defineProperty(realm, name, previous); });
    };
    define("WebSocket", WebSocket, true);
    define("CloseEvent", CloseEventClass, false);
    define("MessageEvent", MessageEventClass, false);
    return () => { for (const restore of undo.reverse()) restore(); };
  };
  return { WebSocket, CloseEvent: CloseEventClass, MessageEvent: MessageEventClass, install };
}
