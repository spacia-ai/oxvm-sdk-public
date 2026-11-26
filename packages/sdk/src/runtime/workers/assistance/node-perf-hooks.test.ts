import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { createNodePerfHooks } from "./node-perf-hooks.js";
import { isHistogram } from "./node-perf-histogram.ts";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node rec-perf.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-perf-hooks.controls.json", import.meta.url), "utf8")), "perf_hooks controls");
function callable(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== "function") throw new TypeError("not a function");
  return (...args) => { const result: unknown = Reflect.apply(value, undefined, args); return result; };
}
function method(target: unknown, name: string, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(Object(target), name);
  if (typeof fn !== "function") throw new TypeError(`no ${name}`);
  const result: unknown = Reflect.apply(fn, target, args);
  return result;
}
function failure(run: () => unknown): unknown {
  try { return { ok: run() }; }
  catch (error) { if (!(error instanceof Error)) throw error; const code: unknown = Reflect.get(error, "code"); return { error: { name: error.name, code, message: error.message } }; }
}
/** A process whose clock and timers the test drives; `performance` is a stand-in the additions can be defined on. */
function harness() {
  let time = 100, next = 1;
  const intervals = new Map<number, { readonly callback: () => void; unrefs: number }>();
  const performance = { now: (): number => time, timeOrigin: 1_700_000_000_000 };
  const restores: (() => void)[] = [];
  const globals = { Performance: globalThis.Performance, performance, PerformanceObserver: globalThis.PerformanceObserver, PerformanceEntry: globalThis.PerformanceEntry, PerformanceMark: globalThis.PerformanceMark,
    PerformanceMeasure: globalThis.PerformanceMeasure, PerformanceObserverEntryList: globalThis.PerformanceObserverEntryList, PerformanceResourceTiming: globalThis.PerformanceResourceTiming };
  const module = createNodePerfHooks(globals, {
    timers: {
      setInterval: (callback: () => void): unknown => { const id = next++; const entry = { callback, unrefs: 0 }; intervals.set(id, entry); return { id, unref(): void { entry.unrefs += 1; } }; },
      clearInterval: (handle: unknown): void => { const id: unknown = typeof handle === "object" && handle !== null ? Reflect.get(handle, "id") : undefined; if (typeof id === "number") intervals.delete(id); },
    },
    install: restore => { restores.push(restore); },
  });
  return { module, performance, intervals, restores, advance: (ms: number): void => { time += ms; }, turn: (): void => { for (const entry of [...intervals.values()]) entry.callback(); } };
}

describe("node perf_hooks builtin", () => {
  it("exposes the platform performance clock and observer classes", () => {
    const module = createNodePerfHooks(globalThis);
    expect(module["performance"]).toBe(globalThis.performance);
    expect(module["PerformanceObserver"]).toBe(globalThis.PerformanceObserver);
    expect(module["PerformanceEntry"]).toBe(globalThis.PerformanceEntry);
    expect(typeof Reflect.get(module["performance"] ?? {}, "now")).toBe("function");
  });

  it("refuses the loop-delay monitor without the process's timers instead of returning a fake", () => {
    const module = createNodePerfHooks(globalThis);
    const monitor = module["monitorEventLoopDelay"];
    expect(typeof monitor).toBe("function");
    if (typeof monitor === "function") expect(() => { Reflect.apply(monitor, undefined, []); }).toThrow(/monitorEventLoopDelay/u);
    try { callable(monitor)(); } catch (error) { expect(error).toBeInstanceOf(VMError); }
    // Histograms need no timer.
    expect(isHistogram(callable(module["createHistogram"])())).toBe(true);
  });

  it("has Node's exports, constants and function shapes", () => {
    const { module } = harness();
    const names: unknown = control["exports"];
    if (!Array.isArray(names)) throw new TypeError("no exports");
    expect(Object.keys(module).sort()).toEqual(names.map(String).sort());
    expect(module["constants"]).toEqual(control["constants"]);
    const descriptor = Object.getOwnPropertyDescriptor(module, "constants");
    expect([descriptor?.enumerable, descriptor?.configurable, descriptor?.writable]).toEqual([true, false, false]);
    expect(Object.isFrozen(module["constants"])).toBe(control["constantsFrozen"]);
    const timerify = record(control["timerify"], "timerify"), elu = record(control["elu"], "elu");
    for (const [name, wanted] of [["timerify", [timerify["timerifyName"], timerify["timerifyLength"]]], ["eventLoopUtilization", [elu["name"], elu["length"]]], ["createHistogram", ["createHistogram", 0]], ["monitorEventLoopDelay", ["monitorEventLoopDelay", 0]]] as const) {
      const fn = module[name];
      expect(typeof fn === "function" ? [fn.name, fn.length] : undefined, name).toEqual(wanted);
    }
  });

  it("keeps the platform's Performance class but fails its construction with Node's coded error", () => {
    const { module, performance } = harness();
    const Performance = module["Performance"], recorded = record(control["Performance"], "Performance");
    if (typeof Performance !== "function") throw new TypeError("no Performance");
    expect([Performance.name, Performance.length]).toEqual([recorded["name"], recorded["length"]]);
    expect(failure(() => Reflect.construct(Performance, []))).toEqual(recorded["construct"]);
    expect(globalThis.performance instanceof Performance).toBe(true);
    expect(module["performance"]).toBe(performance);
  });

  it("reports loop utilization as all active once the loop has turned, with Node's arithmetic for earlier results", () => {
    const { module, advance, turn, intervals } = harness();
    const utilization = callable(module["eventLoopUtilization"]), recorded = record(control["elu"], "elu");
    // Before the loop's first turn, as in Node's main script.
    expect(utilization()).toEqual(control["syncElu"]);
    expect([...intervals.values()].map(entry => entry.unrefs)).toEqual([1]);
    advance(5); turn();
    expect(intervals.size).toBe(0);
    advance(40);
    expect(utilization()).toEqual({ idle: 0, active: 40, utilization: 1 });
    const a = { idle: 10, active: 30, utilization: 0.75 }, b = { idle: 4, active: 6, utilization: 0.6 };
    expect(utilization(a, b)).toEqual(recorded["two"]);
    expect(utilization(b, a)).toEqual(recorded["twoSwapped"]);
    expect(utilization(a, a)).toEqual({ idle: 0, active: 0, utilization: NaN });
    expect(failure(() => utilization(undefined, b))).toEqual(recorded["util2Truthy"]);
    expect(utilization("x")).toEqual({ idle: NaN, active: NaN, utilization: NaN });
    expect(utilization({})).toEqual({ idle: NaN, active: NaN, utilization: NaN });
    expect(Object.keys(record(utilization(null), "result"))).toEqual(recorded["util1Null"]);
    const earlier = utilization(); advance(25);
    expect(utilization(earlier)).toEqual({ idle: 0, active: 25, utilization: 1 });
    expect(utilization(utilization(), earlier)).toEqual({ idle: 0, active: 25, utilization: 1 });
  });

  it("counts the loop as started at once when it has no timer to see the first turn with", () => {
    const utilization = callable(createNodePerfHooks(globalThis)["eventLoopUtilization"]);
    const result = record(utilization(), "result");
    expect([result["idle"], typeof result["active"]]).toEqual([0, "number"]);
  });

  it("wraps a function as timerify does and records each call into the histogram", async () => {
    const { module, advance } = harness();
    const timerify = callable(module["timerify"]), recorded = record(control["timerify"], "timerify"), errors = record(recorded["errors"], "errors");
    function add(a: number, b: number): number { advance(2); return a + b; }
    class K { constructor(readonly x: number) {} }
    const wrapped = timerify(add);
    if (typeof wrapped !== "function") throw new TypeError("not wrapped");
    expect([wrapped.name, wrapped.length]).toEqual([recorded["name"], recorded["length"]]);
    expect(Object.getOwnPropertyDescriptor(wrapped, "name")).toEqual(recorded["nameDesc"]);
    expect(Object.getOwnPropertyDescriptor(wrapped, "length")).toEqual(recorded["lengthDesc"]);
    expect(callable(wrapped)(2, 3)).toBe(recorded["result"]);
    expect(Reflect.get(Object(timerify(() => 1)), "name")).toBe(recorded["anon"]);
    expect(Reflect.get(Object(timerify(wrapped)), "name")).toBe(recorded["twice"]);
    const TimedK = timerify(K);
    if (typeof TimedK !== "function") throw new TypeError("not wrapped");
    const constructed: unknown = Reflect.construct(TimedK, [5]);
    expect([constructed instanceof K, constructed instanceof K ? constructed.x : undefined]).toEqual([true, 5]);
    const receiver = method({ self: timerify(function (this: unknown) { return this; }), tag: "x" }, "self");
    expect(Reflect.get(Object(receiver), "tag")).toBe("x");
    const histogram = callable(module["createHistogram"])();
    if (!isHistogram(histogram)) throw new TypeError("no histogram");
    const timed = callable(timerify(add, { histogram }));
    timed(1, 1); timed(1, 1);
    expect([histogram.count, histogram.min, histogram.max]).toEqual([recorded["histCountSync"], 1999872, 2000895]);
    const later = callable(timerify(async (value: number) => { await Promise.resolve(); advance(7); return value; }, { histogram }));
    const pending = later(7);
    expect(pending instanceof Promise).toBe(recorded["asyncIsPromise"]);
    expect(histogram.count).toBe(2);
    expect(await pending).toBe(recorded["asyncValue"]);
    expect([histogram.count, histogram.max]).toEqual([recorded["histCountAfterAsync"], 7000063]);
    // The platform's clock can measure a call as zero; a histogram accepts nothing below one.
    callable(timerify(() => 0, { histogram }))();
    expect([histogram.count, histogram.min]).toEqual([4, 1]);
    expect(failure(() => timerify(1))).toEqual(errors["fn"]);
    expect(failure(() => timerify(add, 1))).toEqual(errors["options"]);
    expect(failure(() => timerify(add, null))).toEqual(errors["optionsNull"]);
    expect(failure(() => timerify(add, { histogram: {} }))).toEqual(errors["histogram"]);
    expect(failure(() => timerify(add, { histogram: callable(module["monitorEventLoopDelay"])() }))).toEqual(errors["eld"]);
    expect(failure(() => callable(timerify(() => { throw new RangeError("boom"); }))())).toEqual(errors["throws"]);
  });

  it("defines Node's additions on the platform performance object and removes them again", () => {
    const { module, performance, restores, advance, turn } = harness();
    const recorded = record(control["nodeTiming"], "nodeTiming");
    const timing: unknown = Reflect.get(performance, "nodeTiming");
    if (typeof timing !== "object" || timing === null) throw new TypeError("no nodeTiming");
    expect(Object.keys(timing)).toEqual(recorded["keys"]);
    const own = record(recorded["own"], "own");
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(timing))) {
      const wanted = record(own[name], name);
      expect([descriptor.enumerable, descriptor.configurable, descriptor.get === undefined ? typeof descriptor.value : "getter"], name).toEqual([wanted["enumerable"], wanted["configurable"], wanted["kind"]]);
    }
    expect([timing.constructor.name, timing instanceof globalThis.PerformanceEntry]).toEqual([recorded["ctor"], recorded["isEntry"]]);
    const prototype: unknown = Object.getPrototypeOf(timing);
    if (typeof prototype !== "object" || prototype === null) throw new TypeError("no prototype");
    expect(Reflect.ownKeys(prototype).filter(key => typeof key === "string")).toEqual(["constructor", "toJSON"]);
    expect(Reflect.get(timing, "loopStart")).toBe(control["syncLoopStart"]);
    advance(5); turn(); advance(20);
    const json = method(timing, "toJSON");
    expect(Object.keys(record(json, "json"))).toEqual(Object.keys(record(recorded["json"], "json")));
    expect(json).toEqual({ name: "node", entryType: "node", startTime: 0, duration: 125, nodeStart: 0, v8Start: 0, bootstrapComplete: 100, environment: 100, loopStart: 105, loopExit: -1, idleTime: 0 });
    expect(Reflect.get(timing, "uvMetricsInfo")).toEqual({ loopCount: 0, events: 0, eventsWaiting: 0 });
    expect(Object.keys(record(recorded["uv"], "uv"))).toEqual(["loopCount", "events", "eventsWaiting"]);
    expect(Reflect.get(performance, "eventLoopUtilization")).toBe(module["eventLoopUtilization"]);
    expect(Reflect.get(performance, "timerify")).toBe(module["timerify"]);
    const whole = record(method(performance, "toJSON"), "toJSON");
    expect(Object.keys(whole)).toEqual(control["toJSONKeys"]);
    expect([whole["nodeTiming"], whole["timeOrigin"], whole["eventLoopUtilization"]]).toEqual([timing, 1_700_000_000_000, { idle: 0, active: 20, utilization: 1 }]);
    expect(Object.keys(performance)).toEqual(["now", "timeOrigin"]);
    for (const restore of restores) restore();
    expect(Reflect.ownKeys(performance)).toEqual(["now", "timeOrigin"]);
  });

  it("monitors the loop delay through the process's timers", () => {
    const { module, intervals, advance, turn } = harness();
    turn();
    const monitor = callable(module["monitorEventLoopDelay"])({ resolution: 20 });
    if (!isHistogram(monitor)) throw new TypeError("no monitor");
    expect(method(monitor, "enable")).toBe(true);
    expect([...intervals.values()].map(entry => entry.unrefs)).toEqual([1]);
    advance(20); turn(); advance(21); turn();
    expect([monitor.count, monitor.min > 20_900_000, monitor.max < 21_100_000]).toEqual([1, true, true]);
  });
});
