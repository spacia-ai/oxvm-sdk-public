import { expect, it } from "vitest";
import { string } from "../../decode.js";
import { createNodeUtil } from "./node-util.js";
import { getCallSites } from "./node-util-extras.js";
import { nodeUtilTypes } from "./node-util-types.js";
import { decodeValue, encodeValue, list, loadControls, outcome, recorded, row, shape } from "./node-util-node24.test-support.js";

const control = loadControls("./node-util-node24.controls.json");
const warnings: unknown[][] = [];
const util = createNodeUtil({ noDeprecation: false, emitWarning: (...args: unknown[]) => { warnings.push(args); } });

it("exports every recorded util member with Node's name and length", () => {
  for (const value of list(control["functions"])) {
    const c = row(value), name = string(c["name"], "name"), fn: unknown = Reflect.get(util, name);
    expect(typeof fn, name).toBe("function");
    expect(shape(fn), name).toEqual({ fname: c["fname"], length: c["length"] });
  }
});

it("copies with the deprecated _extend and tests arrays with the deprecated isArray, warning once each", () => {
  const target = { a: 1 };
  const results = [
    { r: util._extend(target, { b: 2, a: 3 }), same: util._extend(target, {}) === target },
    { r: util._extend({ a: 1 }, null) }, { r: util._extend({ a: 1 }, "str") }, { r: util._extend({ a: 1 }, [7, 8]) }, { r: encodeValue(util._extend(undefined, undefined)) },
    { r: util._extend(5, 6) }, outcome(() => util._extend(undefined, { a: 1 })),
  ];
  expect(results).toEqual(control["extend"]);
  expect([[], {}, "a", null, new Array<unknown>(3), { length: 0 }].map(value => util.isArray(value))).toEqual(control["isArray"]);
  expect(warnings.map(([message, name, code]) => ({ name, code, message }))).toEqual(control["warnings"]);
});

function outer(): ReturnType<typeof getCallSites> { return inner(); }
function inner(): ReturnType<typeof getCallSites> { return getCallSites(); }

it("reports call sites in Node's record shape, starting at the caller", () => {
  const expected = row(control["callSites"]), sites = outer(), first = sites[0];
  if (first === undefined) throw new TypeError("no call site");
  expect(Object.keys(first)).toEqual(expected["keys"]);
  expect(Object.getPrototypeOf(first)).toBeNull();
  expect(Object.fromEntries(Object.entries(first).map(([key, value]) => [key, typeof value]))).toEqual(expected["types"]);
  expect(sites.slice(0, 2).map(site => site.functionName)).toEqual(expected["names"]);
  expect(first.scriptName).toContain("node-util-extras.test");
  expect(first.lineNumber).toBeGreaterThan(0);
  expect(first.column).toBe(first.columnNumber);
  expect(getCallSites(1)).toHaveLength(1);
  expect((function a() { return (function b() { return (function c() { return getCallSites(3).map(site => site.functionName); })(); })(); })()).toEqual(expected["n3"]);
  expect(Array.isArray(getCallSites({ sourceMap: false }))).toBe(true);
  for (const value of list(control["callSiteErrors"])) {
    const c = row(value), args = list(c["args"]).map(decodeValue);
    expect(outcome(() => getCallSites(...args).length > 0), JSON.stringify(c["args"])).toEqual(recorded(c));
  }
  const before = [Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), Error.stackTraceLimit];
  getCallSites(5);
  expect([Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), Error.stackTraceLimit]).toEqual(before);
});

it("reports no call sites in an engine without Error.captureStackTrace", () => {
  const capture = Object.getOwnPropertyDescriptor(Error, "captureStackTrace");
  if (capture === undefined) throw new TypeError("this test needs V8");
  Reflect.deleteProperty(Error, "captureStackTrace");
  try { expect(getCallSites()).toEqual([]); } finally { Object.defineProperty(Error, "captureStackTrace", capture); }
});

it("converts signal names to exit codes with Node's validation", () => {
  for (const value of list(control["signalExit"])) {
    const c = row(value);
    expect(outcome(() => util.convertProcessSignalToExitCode(decodeValue(c["arg"]))), JSON.stringify(c["arg"])).toEqual(recorded(c));
  }
});

it("hands out ordinary abort controllers and signals, and accepts any setTraceSigInt argument", () => {
  const expected = row(control["abort"]), controller = util.transferableAbortController(), signal = new AbortController().signal;
  const actual = { ctrlIsAbortController: controller instanceof AbortController, signalIsAbortSignal: controller.signal instanceof AbortSignal, aborted: controller.signal.aborted,
    fresh: util.transferableAbortController() !== controller, sameSignal: util.transferableAbortSignal(signal) === signal,
    afterAbort: (controller.abort("why"), [controller.signal.aborted, controller.signal.reason]),
    errors: list(expected["errors"]).map(value => { const c = row(value); return { arg: c["arg"], ...outcome(() => { util.transferableAbortSignal(decodeValue(c["arg"])); return true; }) }; }) };
  expect(actual).toEqual(expected);
  for (const value of list(control["traceSigInt"])) { const c = row(value); expect(outcome(() => { util.setTraceSigInt(decodeValue(c["arg"])); })).toEqual(recorded(c)); }
});

it("recognises Float16Array only by its real brand", () => {
  const expected = row(control["float16"]), constructor: unknown = Reflect.get(globalThis, "Float16Array");
  expect([nodeUtilTypes.isFloat16Array.name, nodeUtilTypes.isFloat16Array.length]).toEqual([expected["name"], expected["length"]]);
  expect([new Float32Array(2), { [Symbol.toStringTag]: "Float16Array" }, null, undefined, "Float16Array"].map(value => nodeUtilTypes.isFloat16Array(value))).toEqual([false, false, false, false, false]);
  if (typeof constructor !== "function") return;
  const real: unknown = Reflect.construct(constructor, [2]), prototype: unknown = Reflect.get(constructor, "prototype");
  const fake: unknown = Object.create(typeof prototype === "object" ? prototype : null);
  expect([nodeUtilTypes.isFloat16Array(real), nodeUtilTypes.isFloat16Array(new Float32Array(2)), nodeUtilTypes.isFloat16Array({ [Symbol.toStringTag]: "Float16Array" }), nodeUtilTypes.isFloat16Array(null), nodeUtilTypes.isFloat16Array(fake)]).toEqual(expected["cases"]);
});
