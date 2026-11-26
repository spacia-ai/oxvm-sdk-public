import { Buffer } from "buffer";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { createAsyncContext } from "./async-context.js";
import { refusedNodeApi } from "./node-capability.ts";
import { controls, decoded, list, outcome, plain, rows } from "./node-controls.test-support.ts";
import { createNodeHttp2 } from "./node-http2.js";
import { createNodeHttp2Settings, sensitiveHeaders } from "./node-http2-settings.ts";
import { decodeHttp2Headers } from "./node-http2-wire.js";

// Recorded from `require("http2")` of node:24.18.1-alpine; the recorder is embedded in the control file.
const control = controls("node-http2-settings.controls.json");
const warnings: string[] = [];
const http2 = createNodeHttp2Settings(message => { warnings.push(message); });
/** The recorder's arguments, with its typed arrays. */
function argument(value: unknown): unknown {
  const kind: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "$") : undefined;
  if (kind === "u16") return new Uint16Array(list(Reflect.get(Object(value), "v")).map(Number));
  if (kind === "dataview") return new DataView(new ArrayBuffer(6));
  if (kind === "arraybuffer") return new ArrayBuffer(6);
  return decoded(value);
}
function failure(call: () => unknown, shape: (value: unknown) => unknown): Record<string, unknown> {
  const result = outcome(call, shape, ["actual", "min", "max"]), error = result["error"];
  if (typeof error !== "object" || error === null) return result;
  const actual: unknown = Reflect.get(error, "actual"), max: unknown = Reflect.get(error, "max");
  return { error: { ...error, ...(typeof actual === "number" && Number.isNaN(actual) ? { actual: { $: "NaN" } } : {}), ...(max === undefined && "min" in error ? { max: { $: "undefined" } } : {}) } };
}
const expected = (row: Record<string, unknown>): unknown => row["error"] === undefined ? { value: row["value"] } : { error: row["error"] };

it("was recorded from pinned Node", () => { expect(record(control["node"], "node")["version"]).toBe("v24.18.1"); });

it("has Node's names, lengths and symbol, and is served by createNodeHttp2", () => {
  const surface = record(control["surface"], "surface");
  expect([http2.getPackedSettings.name, http2.getPackedSettings.length]).toEqual(surface["packed"]);
  expect([http2.getUnpackedSettings.name, http2.getUnpackedSettings.length]).toEqual(surface["unpacked"]);
  expect([http2.performServerHandshake.name, http2.performServerHandshake.length]).toEqual(surface["handshake"]);
  expect([typeof sensitiveHeaders, String(sensitiveHeaders), Symbol.keyFor(sensitiveHeaders) === undefined]).toEqual(surface["sensitive"]);
  const module = createNodeHttp2({ spawnService: () => { throw new Error("no child in this test"); } }, createAsyncContext(), () => () => undefined);
  expect(module.sensitiveHeaders).toBe(sensitiveHeaders);
  expect(module.getPackedSettings({ headerTableSize: 1 })?.toString("hex")).toBe("000100000001");
});

it("packs settings byte for byte, with Node's validation order and errors", () => {
  const cases = rows(control["pack"]);
  expect(cases.length).toBeGreaterThanOrEqual(60);
  for (const row of cases) {
    const args = list(row["args"]).map(argument);
    // The recorder read `.toString` of what Node returned; Node returns undefined when nghttp2 refuses a value.
    const refused = record(row["error"] ?? {}, "error")["message"] === "Cannot read properties of undefined (reading 'toString')";
    const actual = failure(() => args.length === 0 ? http2.getPackedSettings() : http2.getPackedSettings(args[0]), value => value === undefined ? undefined : { isBuffer: Buffer.isBuffer(value), hex: Buffer.isBuffer(value) ? value.toString("hex") : null });
    if (refused) expect(actual, JSON.stringify(row["args"])).toEqual({ value: undefined });
    else expect(actual, JSON.stringify(row["args"])).toEqual(expected(row));
  }
});

it("warns when maxHeaderSize overrides maxHeaderListSize", () => {
  const counts = list(control["warningCases"]).map(settings => { warnings.length = 0; http2.getPackedSettings(settings); return [...warnings]; });
  expect(counts).toEqual([["settings.maxHeaderSize overwrite settings.maxHeaderListSize"], ["settings.maxHeaderSize overwrite settings.maxHeaderListSize"], [], []]);
  expect(list(list(control["warnings"])[1])).toEqual(counts[1]);
});

it("unpacks settings from any typed array and validates on request", () => {
  for (const row of rows(control["unpack"])) {
    const args = list(row["args"]).map(argument);
    expect(failure(() => args.length === 0 ? http2.getUnpackedSettings() : args.length === 1 ? http2.getUnpackedSettings(args[0]) : http2.getUnpackedSettings(args[0], args[1]), value => {
      const settings = record(value, "settings"), custom = settings["customSettings"];
      return plain({ keys: Object.keys(settings), settings, proto: Object.getPrototypeOf(value) === Object.prototype, customProto: custom === undefined ? null : Object.getPrototypeOf(custom) === Object.prototype });
    }), JSON.stringify(row["args"])).toEqual(expected(row));
  }
  const settings = { headerTableSize: 9, enablePush: false, maxConcurrentStreams: 7, initialWindowSize: 5, maxFrameSize: 16385, maxHeaderListSize: 3, enableConnectProtocol: true, customSettings: { 99: 1 } };
  expect(http2.getUnpackedSettings(http2.getPackedSettings(settings))).toEqual({ ...settings, maxHeaderSize: 3 });
});

it("refuses a server session over an existing socket", () => {
  expect(() => http2.performServerHandshake({}, 5)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(() => http2.performServerHandshake({})).toThrow(VMError);
  expect(refusedNodeApi()).toEqual({ kind: "unavailable-builtin", detail: "node:http2.performServerHandshake" });
});

it("sends headers listed as sensitive like any other: the list itself never reaches the wire", () => {
  expect(decodeHttp2Headers({ ":path": "/", cookie: "secret", [sensitiveHeaders]: ["cookie"] })).toEqual({ ":path": "/", cookie: "secret" });
});
