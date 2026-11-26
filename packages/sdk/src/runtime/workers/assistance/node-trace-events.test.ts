import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { nodeUtil } from "./node-util.js";
import { createNodeTraceEvents, traceEventsUnavailable } from "./node-trace-events.js";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node rec-trace.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-trace-events.controls.json", import.meta.url), "utf8")), "trace_events controls");
const tracing = record(control["tracing"], "tracing");

/** The recorder's own description of an object's properties and of a call's outcome. */
function shape(target: object): Record<string, unknown> {
  return Object.fromEntries(Reflect.ownKeys(target).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), value: unknown = descriptor?.value;
    return [String(key), [typeof value, typeof value === "function" ? value.name : null, typeof value === "function" ? value.length : null, descriptor?.enumerable, descriptor?.writable ?? null, descriptor?.configurable, typeof descriptor?.get, typeof descriptor?.set]];
  }));
}
function outcome(run: () => unknown): unknown {
  try { const value = run(); return { ok: value === undefined ? "$undefined" : value }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const code: unknown = Reflect.get(error, "code");
    return { error: { name: error.name, ...(code === undefined ? {} : { code }), message: error.message, ctor: error.constructor.name } };
  }
}
/** The recorder's invalid arguments, which JSON cannot carry. */
const invalid: Record<string, unknown[]> = {
  noArgs: [], undef: [undefined], nul: [null], num: [1], str: ["x"], arr: [[]], fn: [() => undefined], noCats: [{}], catsStr: [{ categories: "a" }], catsNull: [{ categories: null }],
  catsObj: [{ categories: {} }], empty: [{ categories: [] }], nonString: [{ categories: [1, {}] }], emptyString: [{ categories: [""] }], sym: [{ categories: [Symbol("x")] }],
};

describe("node trace_events builtin (Node 24.18.1 controls)", () => {
  it("has Node's exports and no enabled category at start", () => {
    const module = createNodeTraceEvents();
    expect(Object.keys(module)).toEqual(control["keys"]);
    expect(shape(module)).toEqual(control["shape"]);
    expect(outcome(() => module.getEnabledCategories())).toEqual(control["initial"]);
  });

  it("validates createTracing's options as Node does", () => {
    const module = createNodeTraceEvents(), expected = record(control["validation"], "validation");
    expect(Object.keys(invalid)).toEqual(Object.keys(expected));
    for (const [name, args] of Object.entries(invalid)) {
      expect(outcome(() => { const created = module.createTracing(args[0]); return { categories: created.categories, enabled: created.enabled }; }), name).toEqual(expected[name]);
    }
  });

  it("returns a Tracing object with Node's class shape, getters and inspection", () => {
    const module = createNodeTraceEvents();
    const created = module.createTracing({ categories: ["node.perf", "v8", "node.perf"] });
    const prototype: unknown = Object.getPrototypeOf(created);
    if (typeof prototype !== "object" || prototype === null) throw new TypeError("no prototype");
    const Constructor: unknown = created.constructor;
    if (typeof Constructor !== "function") throw new TypeError("no constructor");
    expect([Constructor.name, Constructor.length]).toEqual([tracing["ctor"], tracing["ctorLength"]]);
    expect(shape(prototype)).toEqual(tracing["protoShape"]);
    expect(Reflect.ownKeys(created)).toEqual(tracing["ownKeys"]);
    expect(Object.prototype.toString.call(created)).toBe(tracing["tag"]);
    expect(nodeUtil.inspect(created)).toBe(tracing["inspect"]);
    expect(nodeUtil.inspect(created, { depth: -1 })).toBe(tracing["inspectDepthNeg"]);
    expect(nodeUtil.inspect({ t: created }, { depth: 0 })).toBe(tracing["inspectNested"]);
    expect(JSON.stringify(created)).toBe(tracing["json"]);
    expect([created.categories, created.enabled]).toEqual([tracing["categories"], tracing["enabled"]]);
    expect(outcome(() => { const direct: unknown = Reflect.construct(Constructor, [["a"]]); if (typeof direct !== "object" || direct === null) throw new TypeError("no instance"); const c: unknown = Reflect.get(direct, "categories"), e: unknown = Reflect.get(direct, "enabled"); return { c, e }; })).toEqual(tracing["newDirect"]);
    expect(outcome(() => { const called: unknown = Reflect.apply(Constructor, undefined, [["a"]]); return called; })).toEqual(tracing["callDirect"]);
    expect(outcome(() => { Object.assign(created, { enabled: true }); })).toEqual(tracing["setEnabled"]);
    expect(outcome(() => { Object.assign(created, { categories: "x" }); })).toEqual(tracing["setCats"]);
    // Node aborts the whole process when the class is constructed without an array; here it throws.
    expect(() => { Reflect.construct(Constructor, []); }).toThrow(TypeError);
    const detached = record(control["detached"], "detached"), enable: unknown = Reflect.get(prototype, "enable"), accessor = Object.getOwnPropertyDescriptor(prototype, "enabled");
    const getter: unknown = accessor === undefined ? undefined : Reflect.get(accessor, "get");
    if (typeof enable !== "function" || typeof getter !== "function") throw new TypeError("no methods");
    expect(outcome(() => { const result: unknown = Reflect.apply(enable, {}, []); return result; })).toEqual(detached["enable"]);
    expect(outcome(() => { const result: unknown = Reflect.apply(getter, {}, []); return result; })).toEqual(detached["enabledGet"]);
    expect(outcome(() => nodeUtil.inspect(prototype))).toEqual(detached["inspectProto"]);
    const custom: unknown = Reflect.get(prototype, Symbol.for("nodejs.util.inspect.custom")), expected = record(control["customInspect"], "customInspect");
    if (typeof custom !== "function") throw new TypeError("no custom inspect");
    const self: unknown = Reflect.apply(custom, created, [-1, {}]);
    expect(self).toBe(created);
    expect(expected["neg"]).toEqual({ ok: {} });
    const inspected = (...args: unknown[]): unknown => outcome(() => { const result: unknown = Reflect.apply(custom, created, args); return result; });
    expect(inspected(0, {})).toEqual(expected["zero"]);
    expect(inspected(2, { depth: 0 })).toEqual(expected["ctx"]);
    expect(inspected(2, 1)).toEqual(expected["badCtx"]);
  });

  it("reports the sorted union of the enabled objects' categories, each held until its last holder is disabled", () => {
    const module = createNodeTraceEvents(), seen: unknown[] = [];
    const enabled = (): unknown => outcome(() => module.getEnabledCategories());
    const t = module.createTracing({ categories: ["node.perf", "v8", "node.perf"] });
    seen.push(["enable", outcome(() => { t.enable(); }), t.enabled, enabled()]);
    seen.push(["enable again", outcome(() => { t.enable(); }), t.enabled, enabled()]);
    const u = module.createTracing({ categories: ["v8", "node.async_hooks", "custom"] });
    seen.push(["u created", null, u.enabled, enabled()]);
    u.enable(); seen.push(["u enable", null, u.enabled, enabled()]);
    t.disable(); seen.push(["t disable", null, t.enabled, enabled()]);
    seen.push(["t disable again", outcome(() => { t.disable(); }), t.enabled, enabled()]);
    u.disable(); seen.push(["u disable", null, u.enabled, enabled()]);
    const w = module.createTracing({ categories: ["b", "a", "b", " c "] }); w.enable(); seen.push(["w", w.categories, w.enabled, enabled()]);
    const z = module.createTracing({ categories: ["z", "a"] }); z.enable(); seen.push(["z", z.categories, z.enabled, enabled()]);
    expect(seen).toEqual(control["sequence"]);
    w.disable(); z.disable();
    const empty = record(control["emptyCategory"], "emptyCategory"), blank = module.createTracing({ categories: [""] });
    blank.enable();
    expect(enabled()).toEqual({ ok: empty["enabledAlone"] });
    const first = module.createTracing({ categories: ["a", "a"] }), second = module.createTracing({ categories: ["a"] });
    first.enable(); second.enable(); first.disable();
    expect(enabled()).toEqual({ ok: empty["sharedCategoryAfterOneDisable"] });
    second.disable();
    expect(enabled()).toEqual({ ok: empty["afterBothDisabled"] });
  });

  it("keeps the enabled set per process and warns past ten enabled objects", () => {
    const warnings: string[] = [];
    const module = createNodeTraceEvents({ emitWarning: message => { warnings.push(message); } }), other = createNodeTraceEvents();
    const many = Array.from({ length: 12 }, (_, index) => module.createTracing({ categories: [`m${String(index)}`] }));
    for (const item of many) item.enable();
    expect(module.getEnabledCategories()).toBe(control["manyCategories"]);
    expect(other.getEnabledCategories()).toBeUndefined();
    expect(warnings.map(message => ({ name: "Warning", message }))).toEqual(control["warnings"]);
    const unavailable = traceEventsUnavailable();
    expect({ name: unavailable.name, code: Reflect.get(unavailable, "code") === "ERR_TRACE_EVENTS_UNAVAILABLE" ? "ERR_TRACE_EVENTS_UNAVAILABLE" : "", message: unavailable.message }).toEqual(control["worker"]);
  });
});
