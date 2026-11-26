import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createAsyncContext } from "./async-context.js";
import { refusedNodeApi } from "./node-capability.ts";
import { controls, decoded, list, outcome, rows } from "./node-controls.test-support.ts";
import { createHttpExtras, createLegacyHttpModules } from "./node-http-extras.ts";
import { createHttpClients } from "./node-http-client.ts";
import { HttpOutgoing } from "./node-http-outgoing.js";
import { createHttpServers } from "./node-http-server.ts";
import { createHttpValidators } from "./node-http-validators.ts";
import { createNodeNet } from "./node-net.ts";

// Recorded from `require("http")` and the `_http_*` modules of node:24.18.1-alpine; the recorder is embedded.
const control = controls("node-http-extras.controls.json");
const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
const parser = new WebAssembly.Module(new Uint8Array(wasm));
const expected = (row: Record<string, unknown>): unknown => row["error"] === undefined ? { value: row["value"] } : { error: row["error"] };

function fixture(requestBytes: string) {
  const context = createAsyncContext(), output: Uint8Array[] = [];
  const listener = { kind: "socket", fd: 1, local: { address: "127.0.0.1", port: 3000 }, peer: null } as const;
  const accepted = { ...listener, fd: 2, peer: { address: "127.0.0.1", port: 1234 } } as const;
  const accept = Promise.withResolvers<AssistanceResult>(), read = Promise.withResolvers<AssistanceResult>();
  let accepts = 0, reads = 0;
  const net = createNodeNet({ retain: () => () => undefined, callSync: () => accepted,
    call(operation) {
      if (operation.kind === "socket-listen") return Promise.resolve(listener);
      if (operation.kind === "socket-accept") return ++accepts === 1 ? Promise.resolve(accepted) : accept.promise;
      if (operation.kind === "socket-read") return ++reads === 1 ? Promise.resolve({ kind: "data", bytes: new TextEncoder().encode(requestBytes) }) : read.promise;
      if (operation.kind === "socket-write") { output.push(operation.bytes); return Promise.resolve({ kind: "written", count: operation.bytes.length }); }
      if (operation.kind === "socket-close") {
        if (operation.fd === 1) accept.resolve({ kind: "error", errno: 9, code: "EBADF", syscall: "accept", path: null, destination: null });
        else read.resolve({ kind: "data", bytes: new Uint8Array() });
      }
      return Promise.resolve({ kind: "unit" });
    },
  }, context);
  const http = { OutgoingMessage: HttpOutgoing, ...createHttpValidators((template, ...values) => [template, ...values].join(" ")), ...createHttpServers(net, parser, context), ...createHttpClients(net, parser, context) };
  return { http, net, output };
}

it("was recorded from pinned Node", () => { expect(record(control["node"], "node")["version"]).toBe("v24.18.1"); });

it("validates a proxy environment as Node does, is a no-op without a proxy, and refuses to install one", () => {
  const { setGlobalProxyFromEnv } = createHttpExtras(() => ({}));
  expect([setGlobalProxyFromEnv.name, setGlobalProxyFromEnv.length]).toEqual(Object.values(record(control["setGlobalProxyFromEnv"], "surface")));
  for (const row of rows(control["proxy"])) {
    const recorded = record(expected(row), "expected"), name = JSON.stringify(row["env"]);
    const actual = outcome(() => { const restore = setGlobalProxyFromEnv(row["env"]); restore(); return { type: typeof restore, name: restore.name, length: restore.length, back: undefined }; });
    if (recorded["error"] !== undefined) {
      // undici's own refusal of a proxy without a scheme is not reproduced: the call is refused before undici is reached.
      if (record(recorded["error"], "error")["code"] === "UND_ERR_INVALID_ARG") expect(record(actual["error"], name)["code"], name).toBe("FEATURE_NOT_AVAILABLE");
      else expect(actual, name).toEqual(recorded);
    } else if (record(recorded["value"], "value")["name"] === "restore") expect(record(actual["error"], name)["code"], name).toBe("FEATURE_NOT_AVAILABLE");
    else expect(actual["value"], name).toEqual({ type: "function", name: "", length: 0, back: undefined });
  }
  for (const row of rows(control["proxyLoose"])) expect(outcome(() => typeof setGlobalProxyFromEnv(decoded(row["arg"])))).toEqual(expected(row));
  // The default is the process's own environment, and a refused proxy is remembered as a late failure.
  const proxied = createHttpExtras(() => ({ HTTPS_PROXY: "http://proxy:3128" }));
  expect(() => proxied.setGlobalProxyFromEnv()).toThrow(VMError);
  expect(refusedNodeApi()).toEqual({ kind: "unavailable-builtin", detail: "node:http.setGlobalProxyFromEnv" });
  expect(typeof createHttpExtras(() => ({ NO_PROXY: "x" })).setGlobalProxyFromEnv()).toBe("function");
});

it("re-exports the browser's event classes and no WebSocket", () => {
  class CloseEvent { readonly kind = "close"; }
  class MessageEvent { readonly kind = "message"; }
  const extras = createHttpExtras(() => ({}), { CloseEvent, MessageEvent, WebSocket: class WebSocket { readonly kind = "socket"; } });
  expect(extras.CloseEvent).toBe(CloseEvent);
  expect(extras.MessageEvent).toBe(MessageEvent);
  expect("WebSocket" in extras).toBe(false);
  expect(Object.keys(createHttpExtras(() => ({}), {}))).toEqual(["setGlobalProxyFromEnv"]);
});

it("serves the old module names from the http module's own values", () => {
  const { http } = fixture("");
  const legacy = createLegacyHttpModules(http), modules = record(control["modules"], "modules");
  const missing: Record<string, string[]> = {};
  for (const [name, exports] of Object.entries(legacy)) {
    const recorded = list(modules[name]).map(row => list(row));
    for (const [key, value] of Object.entries(exports)) {
      const row = recorded.find(entry => entry[0] === key);
      expect(row, `${name}.${key}`).toBeDefined();
      expect(typeof value, `${name}.${key}`).toBe(row?.[1]);
    }
    missing[name] = recorded.map(row => String(row[0])).filter(key => !(key in exports));
  }
  expect(missing).toEqual({ _http_agent: [], _http_client: [], _http_common: ["freeParser", "parsers", "kIncomingMessage", "HTTPParser", "isLenient", "prepareError", "kSkipPendingData"], _http_incoming: [],
    _http_outgoing: ["kHighWaterMark", "kUniqueHeaders"], _http_server: ["setupConnectionsTracking", "storeHTTPOptions", "kServerResponse", "httpServerPreClose", "kConnectionsCheckingInterval"] });
  expect(legacy._http_agent.globalAgent).toBe(http.globalAgent);
  expect(legacy._http_server.Server).toBe(http.Server);
  expect(legacy._http_outgoing.OutgoingMessage).toBe(HttpOutgoing);
  const common = record(control["common"], "common"), shared = legacy._http_common;
  expect([shared.CRLF, String(shared.chunkExpression), String(shared.continueExpression)]).toEqual([common["CRLF"], common["chunkExpression"], common["continueExpression"]]);
  expect(list(common["token"]).map(row => [list(row)[0], shared._checkIsHttpToken(list(row)[0])])).toEqual(common["token"]);
  expect(list(common["invalidChar"]).map(row => [list(row)[0], shared._checkInvalidHeaderChar(list(row)[0])])).toEqual(common["invalidChar"]);
  expect([undefined, null, 1].map(value => outcome(() => shared._checkIsHttpToken(value)))).toEqual(common["tokenLoose"]);
  expect([undefined, null, 1].map(value => outcome(() => shared._checkInvalidHeaderChar(value)))).toEqual(common["charLoose"]);
  expect([shared._checkIsHttpToken.name, shared._checkInvalidHeaderChar.name, legacy._http_incoming.readStart.name, legacy._http_incoming.readStop.name]).toEqual(["checkIsHttpToken", "checkInvalidHeaderChar", "readStart", "readStop"]);
  expect([...shared.methods].sort()).toEqual(http.METHODS);
  for (const row of rows(record(control["outgoing"], "outgoing")["unique"])) {
    expect(outcome(() => { const unique = legacy._http_outgoing.parseUniqueHeadersOption(decoded(row["arg"])); return unique === null ? null : typeof unique; }), JSON.stringify(row["arg"])).toEqual(expected(row));
  }
  expect([...legacy._http_outgoing.parseUniqueHeadersOption(["A", "b"]) ?? []]).toEqual(["a", "b"]);
  const calls: string[] = [], stream = { readable: true, _paused: false, resume() { calls.push("resume"); }, pause() { calls.push("pause"); } };
  legacy._http_incoming.readStart(stream); legacy._http_incoming.readStart({ ...stream, _paused: true }); legacy._http_incoming.readStart(null); legacy._http_incoming.readStop(stream); legacy._http_incoming.readStop(undefined);
  expect(calls).toEqual(["resume", "pause"]);
});

it("exposes the listener an http.Server uses, which serves HTTP for a plain net.Server too", async () => {
  const { http, net, output } = fixture("GET /plain HTTP/1.1\r\nHost: local\r\n\r\n");
  const recorded = record(control["connectionListener"], "listener");
  expect([http._connectionListener.name, http._connectionListener.length]).toEqual([recorded["name"], recorded["length"]]);
  const done = Promise.withResolvers<undefined>();
  const server = net.createServer({ allowHalfOpen: true });
  server.on("connection", http._connectionListener);
  server.on("request", (request: unknown, response: unknown) => {
    if (!(request instanceof http.IncomingMessage) || !(response instanceof http.ServerResponse)) throw new TypeError("HTTP objects required");
    request.resume(); response.sendDate = false; response.end(request.url);
    response.on("finish", () => { request.socket.destroy(); server.close(() => { done.resolve(undefined); }); });
  });
  server.listen(3000); await done.promise;
  expect(Buffer.concat(output).toString()).toContain("HTTP/1.1 200 OK\r\n");
  expect(Buffer.concat(output).toString()).toContain("/plain");
  expect(() => { Reflect.apply(http._connectionListener, {}, [null]); }).toThrow(TypeError);
});
