/*!
 * Portions adapted from Node.js v24.18.1 lib/http.js (setGlobalProxyFromEnv), lib/internal/http.js (parseProxyUrl),
 * lib/_http_common.js (checkIsHttpToken, checkInvalidHeaderChar, the expressions and the method list),
 * lib/_http_incoming.js (readStart, readStop) and lib/_http_outgoing.js (parseUniqueHeadersOption).
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { unavailableNodeApi } from "./node-capability.ts";
import { named, validateObject } from "./node-util-validators.ts";

function member(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
  const boxed: unknown = Object(value);
  return (typeof boxed === "object" || typeof boxed === "function") && boxed !== null ? Reflect.get(boxed, key) : undefined;
}
function invalidProxy(message: string): Error { return Object.assign(new Error(message), { code: "ERR_PROXY_INVALID_CONFIG" }); }
/** The proxy an environment names for a protocol; the lower-case variable wins. */
function proxyUrl(env: object, secure: boolean): string | null {
  const lower: unknown = Reflect.get(env, secure ? "https_proxy" : "http_proxy"), upper: unknown = Reflect.get(env, secure ? "HTTPS_PROXY" : "HTTP_PROXY");
  const url: unknown = lower !== undefined && lower !== null && lower !== "" && lower !== 0 && lower !== false ? lower : upper;
  if (url === undefined || url === null || url === "" || url === 0 || url === false) return null;
  if (typeof url !== "string") throw new TypeError("proxyUrl.includes is not a function");
  if (url.includes("\r") || url.includes("\n")) throw invalidProxy(`Invalid proxy URL: ${url}`);
  return url;
}

type Constructor = abstract new (...args: never[]) => object;
function isConstructor(value: unknown): value is Constructor { return typeof value === "function"; }

/**
 * `http.setGlobalProxyFromEnv` and the event classes Node re-exports on `http`.
 *
 * The proxy setter validates as Node does and is a no-op when the environment names no proxy. Installing one would
 * replace the global agents and fetch's dispatcher with proxying ones, which this runtime does not have; that call
 * is refused, never silently skipped. `CloseEvent` and `MessageEvent` are the browser's own classes. `WebSocket`
 * is not here: the process's own, which connects through the VM's sockets, comes from node-websocket.ts.
 */
export function createHttpExtras(environment: () => object, globals: object = globalThis): {
  setGlobalProxyFromEnv: (env?: unknown) => () => void; CloseEvent?: Constructor; MessageEvent?: Constructor;
} {
  const setGlobalProxyFromEnv = named(function (...args: unknown[]): () => void {
    const env: unknown = args[0] === undefined ? environment() : args[0];
    validateObject(env, "proxyEnv");
    const httpProxy = proxyUrl(env, false), httpsProxy = proxyUrl(env, true);
    if (httpProxy === null && httpsProxy === null) return () => { /* Nothing was installed. */ };
    for (const url of [httpProxy, httpsProxy]) if (url !== null && !URL.canParse(url)) throw invalidProxy(url);
    return unavailableNodeApi("http.setGlobalProxyFromEnv");
  }, "setGlobalProxyFromEnv");
  const close: unknown = Reflect.get(globals, "CloseEvent"), message: unknown = Reflect.get(globals, "MessageEvent");
  return { setGlobalProxyFromEnv, ...(isConstructor(close) ? { CloseEvent: close } : {}), ...(isConstructor(message) ? { MessageEvent: message } : {}) };
}

const TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/u, INVALID_HEADER_CHARACTER = /[^\t\x20-\x7e\x80-\xff]/u;
const checkIsHttpToken = named((value: unknown): boolean => {
  const length: unknown = member(value, "length");
  return typeof value === "string" ? TOKEN.test(value) : length !== 0;
}, "checkIsHttpToken");
const checkInvalidHeaderChar = named((value: unknown): boolean => INVALID_HEADER_CHARACTER.test(typeof value === "symbol" ? value.toString() : String(value)), "checkInvalidHeaderChar");
/** llhttp's method table in its own order; `http.METHODS` is the sorted copy. */
const METHODS = ["DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL",
  "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "QUERY"] as const;
const readStart = named((socket: unknown): void => {
  if (socket === null || socket === undefined || socket === false || socket === 0 || socket === "") return;
  const paused: unknown = member(socket, "_paused"), readable: unknown = member(socket, "readable"), resume: unknown = member(socket, "resume");
  if ((paused === undefined || paused === null || paused === false || paused === 0 || paused === "") && Boolean(readable) && typeof resume === "function") Reflect.apply(resume, socket, []);
}, "readStart");
const readStop = named((socket: unknown): void => {
  if (socket === null || socket === undefined || socket === false || socket === 0 || socket === "") return;
  const pause: unknown = member(socket, "pause");
  if (typeof pause !== "function") throw new TypeError("socket.pause is not a function");
  Reflect.apply(pause, socket, []);
}, "readStop");
const parseUniqueHeadersOption = named((headers: unknown): Set<unknown> | null => {
  if (!Array.isArray(headers)) return null;
  const unique = new Set<unknown>(), items: unknown[] = headers;
  for (const header of items) {
    if (typeof header !== "string") throw new TypeError("headers[i].toLowerCase is not a function");
    unique.add(header.toLowerCase());
  }
  return unique;
}, "parseUniqueHeadersOption");

/** What of `http` the old module names re-export. */
export interface LegacyHttpSource {
  readonly Agent: unknown; readonly globalAgent: unknown; readonly ClientRequest: unknown; readonly IncomingMessage: unknown; readonly OutgoingMessage: unknown;
  readonly validateHeaderName: unknown; readonly validateHeaderValue: unknown; readonly STATUS_CODES: unknown; readonly Server: unknown; readonly ServerResponse: unknown;
  readonly _connectionListener: unknown;
}
/**
 * Node's deprecated `_http_*` modules, with the names this runtime can serve. Left out because nothing here stands
 * behind them: the parser binding and its pool (`HTTPParser`, `parsers`, `freeParser`, `prepareError`, `isLenient`),
 * the internal symbols (`kIncomingMessage`, `kSkipPendingData`, `kHighWaterMark`, `kUniqueHeaders`, `kServerResponse`,
 * `kConnectionsCheckingInterval`) and the server internals (`httpServerPreClose`, `setupConnectionsTracking`,
 * `storeHTTPOptions`).
 */
export function createLegacyHttpModules(http: LegacyHttpSource) {
  return {
    _http_agent: { Agent: http.Agent, globalAgent: http.globalAgent },
    _http_client: { ClientRequest: http.ClientRequest },
    _http_common: { _checkInvalidHeaderChar: checkInvalidHeaderChar, _checkIsHttpToken: checkIsHttpToken, chunkExpression: /(?:^|\W)chunked(?:$|\W)/i, continueExpression: /(?:^|\W)100-continue(?:$|\W)/i, CRLF: "\r\n", methods: [...METHODS] },
    _http_incoming: { IncomingMessage: http.IncomingMessage, readStart, readStop },
    _http_outgoing: { parseUniqueHeadersOption, validateHeaderName: http.validateHeaderName, validateHeaderValue: http.validateHeaderValue, OutgoingMessage: http.OutgoingMessage },
    _http_server: { STATUS_CODES: http.STATUS_CODES, Server: http.Server, ServerResponse: http.ServerResponse, _connectionListener: http._connectionListener },
  };
}
