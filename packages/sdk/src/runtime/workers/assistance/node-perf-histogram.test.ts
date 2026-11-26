import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { createNodeHistograms, Histogram, IntervalHistogram, isHistogram, RecordableHistogram } from "./node-perf-histogram.ts";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node rec-hist.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-perf-histogram.controls.json", import.meta.url), "utf8")), "histogram controls");
const list = (value: unknown, name: string): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value)) throw new TypeError(`${name} is not a list`);
  return value.map((entry: unknown) => record(entry, name));
};
/** The recorder's own serialisation. Its snapshot holds the one map both percentile getters return, last filled by toJSON. */
const enc = (value: unknown): unknown => typeof value === "bigint" ? { $bigint: String(value) } : typeof value === "number" && !Number.isFinite(value) ? { $number: String(value) } : value;
function ser(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? [...item].map(([key, entry]: [unknown, unknown]) => [enc(key), enc(entry)]) : enc(item));
  const parsed: unknown = JSON.parse(text);
  return parsed;
}
const PERCENTILES = [0.001, 1, 10, 25, 50, 75, 90, 95, 99, 99.9, 99.99, 100];
function snap(h: Histogram): unknown {
  return ser({ count: h.count, countBigInt: h.countBigInt, min: h.min, minBigInt: h.minBigInt, max: h.max, maxBigInt: h.maxBigInt, mean: h.mean, stddev: h.stddev, exceeds: h.exceeds, exceedsBigInt: h.exceedsBigInt,
    percentile: PERCENTILES.map(p => [p, h.percentile(p)]), percentileBigInt: PERCENTILES.map(p => [p, h.percentileBigInt(p)]), percentiles: h.percentiles, percentilesBigInt: h.percentilesBigInt, toJSON: h.toJSON() });
}
function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw new TypeError("values are not a list");
  return value.map((entry: unknown) => { if (typeof entry !== "number") throw new TypeError("not a number"); return entry; });
}
function fakeClock() {
  let time = 1000;
  const intervals = new Map<number, { readonly callback: () => void; unrefs: number }>();
  let next = 1;
  return {
    advance: (ms: number): void => { time += ms; },
    now: (): number => time,
    intervals,
    timers: {
      setInterval: (callback: () => void): unknown => { const id = next++; const entry = { callback, unrefs: 0 }; intervals.set(id, entry); return { id, unref(): void { entry.unrefs += 1; } }; },
      clearInterval: (handle: unknown): void => { const id: unknown = typeof handle === "object" && handle !== null ? Reflect.get(handle, "id") : undefined; if (typeof id === "number") intervals.delete(id); },
    },
  };
}
const sets = list(control["sets"], "sets");
const byName = (name: unknown): Readonly<Record<string, unknown>> => { const found = sets.find(set => set["name"] === name); if (found === undefined) throw new TypeError("unknown set"); return found; };
function filled(set: Readonly<Record<string, unknown>>): RecordableHistogram {
  const { createHistogram } = createNodeHistograms({ now: () => 0 });
  const histogram = set["options"] === null ? createHistogram() : createHistogram(set["options"]);
  for (const value of numbers(set["values"])) histogram.record(value);
  return histogram;
}
/** Calls a method of `owner` on another receiver. */
function call(owner: object, name: string, receiver: unknown, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(owner, name);
  if (typeof fn !== "function") throw new TypeError(`no ${name}`);
  const result: unknown = Reflect.apply(fn, receiver, args);
  return result;
}
function failure(run: () => unknown): unknown {
  try { return { ok: ser(run()) }; }
  catch (error) { if (!(error instanceof Error)) throw error; const code: unknown = Reflect.get(error, "code"); return { error: { name: error.name, code, message: error.message, ctor: error.constructor.name } }; }
}

describe("perf_hooks histograms against Node.js v24.18.1", () => {
  it.each(sets.map(set => [String(set["name"]), set] as const))("matches every statistic and the percentiles map for the %s inputs", (_name, set) => {
    expect(snap(filled(set))).toEqual(set["result"]);
  });

  it("adds another histogram slot by slot, as hdr_add does", () => {
    for (const scenario of list(control["adds"], "adds")) {
      const a = filled(byName(scenario["a"])), b = filled(byName(scenario["b"]));
      expect(call(a, "add", a, b), String(scenario["a"])).toBeUndefined();
      expect(snap(a), `${String(scenario["a"])}+${String(scenario["b"])}`).toEqual(scenario["result"]);
    }
  });

  it("records bigints, takes bigint bounds and resets", () => {
    const { createHistogram } = createNodeHistograms({ now: () => 0 });
    const h = createHistogram(); h.record(5n); h.record(12345678901234n);
    const before = record(snap(h), "before"); h.reset();
    const recorded = record(control["bigint"], "bigint");
    // The recorder serialised both snapshots after the reset, and they share the histogram's one map.
    const maps = { percentiles: record(recorded["after"], "after")["percentiles"], percentilesBigInt: record(recorded["after"], "after")["percentilesBigInt"] };
    expect({ before: { ...before, ...maps }, after: snap(h) }).toEqual(recorded);
    expect(ser([...filled({ options: null, values: [5, 12345678901234] }).percentilesBigInt])).toEqual([[0, { $bigint: "5" }], [50, { $bigint: "5" }], [75, { $bigint: "12343736008704" }], [100, { $bigint: "12343736008704" }]]);
    const bounded = createHistogram({ lowest: 1n, highest: 1000n, figures: 2 }); bounded.record(10); bounded.record(999); bounded.record(5000);
    expect(snap(bounded)).toEqual(control["bigintOptions"]);
  });

  it("validates in Node's order with Node's errors", () => {
    const { createHistogram, monitorEventLoopDelay } = createNodeHistograms({ now: () => 0, timers: fakeClock().timers });
    if (monitorEventLoopDelay === undefined) throw new TypeError("no monitor");
    const h = createHistogram();
    const cases: Record<string, () => unknown> = {
      "options:null": () => createHistogram(null), "options:1": () => createHistogram(1), "options:array": () => createHistogram([]), "options:fn": () => createHistogram(() => 0),
      "lowest:0": () => createHistogram({ lowest: 0 }), "lowest:str": () => createHistogram({ lowest: "1" }), "lowest:1.5": () => createHistogram({ lowest: 1.5 }),
      "highest:1": () => createHistogram({ highest: 1 }), "highest:<2*lowest": () => createHistogram({ lowest: 10, highest: 19 }), "highest:str": () => createHistogram({ highest: "x" }),
      "highest:bigint-small": () => createHistogram({ lowest: 10n, highest: 19n }), "highest:bigint-mixed": () => createHistogram({ lowest: 10, highest: 19n }),
      "figures:0": () => createHistogram({ figures: 0 }), "figures:6": () => createHistogram({ figures: 6 }), "figures:str": () => createHistogram({ figures: "3" }), "figures:2.5": () => createHistogram({ figures: 2.5 }), "figures:bigint": () => createHistogram({ figures: 3n }),
      "order": () => createHistogram({ lowest: 0, highest: 0, figures: 0 }),
      "record:0": () => { h.record(0); }, "record:-1": () => { h.record(-1); }, "record:1.5": () => { h.record(1.5); }, "record:str": () => { h.record("1"); }, "record:none": () => { call(h, "record", h); }, "record:NaN": () => { h.record(NaN); }, "record:big": () => { h.record(2 ** 60); }, "record:-1n": () => { h.record(-1n); },
      "record:0n": () => { h.record(0n); }, "record:2n**70n": () => { h.record(2n ** 70n); }, "record:2**53": () => { h.record(2 ** 53); },
      "record:this": () => { call(h, "record", {}, 1); }, "recordDelta:this": () => { call(h, "recordDelta", {}); }, "add:this": () => { call(h, "add", {}, h); }, "add:other": () => { h.add({}); }, "add:none": () => { call(h, "add", h); },
      "percentile:0": () => h.percentile(0), "percentile:-1": () => h.percentile(-1), "percentile:101": () => h.percentile(101), "percentile:str": () => h.percentile("50"), "percentile:NaN": () => h.percentile(NaN), "percentile:none": () => call(h, "percentile", h), "percentile:Infinity": () => h.percentile(Infinity),
      "percentileBigInt:0": () => h.percentileBigInt(0), "percentileBigInt:str": () => h.percentileBigInt("x"),
      "count:this": () => { const getter: unknown = Reflect.get(Object.getOwnPropertyDescriptor(Histogram.prototype, "count") ?? {}, "get"); const result: unknown = typeof getter === "function" ? Reflect.apply(getter, {}, []) : undefined; return result; },
      "percentile:this": () => call(h, "percentile", {}, 50), "reset:this": () => { call(h, "reset", {}); },
      "new Histogram": () => new Histogram(), "new RecordableHistogram": () => new RecordableHistogram(),
      "monitor:options:null": () => monitorEventLoopDelay(null), "monitor:resolution:0": () => monitorEventLoopDelay({ resolution: 0 }), "monitor:resolution:str": () => monitorEventLoopDelay({ resolution: "1" }), "monitor:resolution:1.5": () => monitorEventLoopDelay({ resolution: 1.5 }), "monitor:resolution:-1": () => monitorEventLoopDelay({ resolution: -1 }), "monitor:options:1": () => monitorEventLoopDelay(1),
      "record:return": () => call(h, "record", h, 3) === undefined, "reset:return": () => call(h, "reset", h) === undefined, "recordDelta:return": () => call(h, "recordDelta", h) === undefined,
    };
    const recorded = record(control["errors"], "errors");
    for (const [name, run] of Object.entries(cases)) expect(failure(run), name).toEqual(recorded[name]);
  });

  it("has Node's classes, names, lengths and property shapes", () => {
    const shape = record(control["shape"], "shape");
    const describeOwn = (target: object): Record<string, unknown> => Object.fromEntries(Reflect.ownKeys(target).map(key => {
      const d = Object.getOwnPropertyDescriptor(target, key); if (d === undefined) throw new TypeError("no descriptor");
      const value: unknown = d.value, getter: unknown = Reflect.get(d, "get"), fn: unknown = getter ?? value;
      return [String(key), { enumerable: d.enumerable, configurable: d.configurable, writable: d.writable ?? null, kind: getter === undefined ? typeof value : "getter", name: typeof fn === "function" ? fn.name : null, length: typeof fn === "function" ? fn.length : null, setter: d.set !== undefined }];
    }));
    // Node's structured-clone hooks are internal symbols a program cannot name.
    const withoutMessaging = (value: unknown): unknown => Object.fromEntries(Object.entries(record(value, "proto")).filter(([key]) => !key.startsWith("Symbol(messaging_")));
    const recordable = record(shape["recordable"], "recordable"), histogram = record(shape["histogram"], "histogram"), interval = record(shape["interval"], "interval");
    expect([RecordableHistogram.name, RecordableHistogram.length]).toEqual([recordable["name"], recordable["length"]]);
    expect(describeOwn(RecordableHistogram.prototype)).toEqual(withoutMessaging(recordable["proto"]));
    expect([Histogram.name, Histogram.length]).toEqual([histogram["name"], histogram["length"]]);
    expect(describeOwn(Histogram.prototype)).toEqual(withoutMessaging(histogram["proto"]));
    expect([IntervalHistogram.name, IntervalHistogram.length]).toEqual([interval["name"], interval["length"]]);
    expect(describeOwn(IntervalHistogram.prototype)).toEqual(interval["proto"]);
    expect(Object.getPrototypeOf(RecordableHistogram.prototype)).toBe(Histogram.prototype);
    expect(Object.getPrototypeOf(IntervalHistogram.prototype)).toBe(Histogram.prototype);
    const { createHistogram } = createNodeHistograms({ now: () => 0 });
    const h = createHistogram();
    expect(isHistogram(h)).toBe(true);
    expect(h.percentiles).toBe(h.percentiles);
    const shown = shape["inspect"];
    if (!Array.isArray(shown)) throw new TypeError("no inspect");
    expect(inspect(h)).toBe(shown[0]);
    h.record(5); h.record(9);
    expect(inspect(h)).toBe(shown[2]);
  });

  it("records the time between recordDelta calls in nanoseconds, from the second call on", () => {
    const clock = fakeClock();
    const h = createNodeHistograms({ now: clock.now }).createHistogram();
    h.recordDelta();
    expect(h.count).toBe(0);
    clock.advance(2.5);
    h.recordDelta();
    expect([h.count, h.min, h.max]).toEqual([1, 2498560, 2500607]);
    expect(control["recordDelta"]).toEqual({ first: null, countAfterFirst: 0, countAfterSecond: 1, minPositive: true });
  });

  it("monitors the loop with an unreferenced repeating timer and records the time between its turns", () => {
    const clock = fakeClock();
    const { monitorEventLoopDelay } = createNodeHistograms({ now: clock.now, timers: clock.timers });
    if (monitorEventLoopDelay === undefined) throw new TypeError("no monitor");
    const monitor = monitorEventLoopDelay({ resolution: 10 });
    const interval = record(record(control["shape"], "shape")["interval"], "interval");
    expect([monitor.enable(), monitor.enable()]).toEqual([true, false]);
    const [timer] = [...clock.intervals.values()];
    if (timer === undefined) throw new TypeError("no timer");
    expect(timer.unrefs).toBe(1);
    // The first turn only sets the reference time; later turns record the interval, lateness included.
    clock.advance(10); timer.callback();
    expect(monitor.count).toBe(0);
    clock.advance(10); timer.callback();
    clock.advance(35); timer.callback();
    expect([monitor.count, monitor.min, monitor.max, monitor.exceeds]).toEqual([2, 9994240, 35028991, 0]);
    expect([monitor.disable(), monitor.disable()]).toEqual([true, false]);
    expect(clock.intervals.size).toBe(0);
    expect([true, false, true, false]).toEqual(interval["enable"]);
    // Node keeps the reference time across a pause: the first turn after it records the whole gap.
    clock.advance(300); monitor.enable();
    const [resumed] = [...clock.intervals.values()];
    if (resumed === undefined) throw new TypeError("no timer");
    clock.advance(10); resumed.callback();
    expect([monitor.count, monitor.max]).toEqual([3, 310116351]);
    monitor[Symbol.dispose]();
    expect(clock.intervals.size).toBe(0);
    monitor.reset();
    const empty = record(interval["empty"], "empty");
    expect([monitor.count, monitor.min, monitor.max, monitor.percentile(50)]).toEqual([0, empty["min"], 0, 511]);
    expect(failure(() => new IntervalHistogram())).toEqual(record(control["shape"], "shape")["new Interval"]);
    expect(failure(() => call(monitor, "enable", {}))).toEqual(record(control["shape"], "shape")["interval.enable:this"]);
    expect(failure(() => call(monitor, "disable", {}))).toEqual(record(control["shape"], "shape")["interval.disable:this"]);
  });

  it("has no monitor without the process's timers", () => {
    expect(createNodeHistograms({ now: () => 0 }).monitorEventLoopDelay).toBeUndefined();
  });
});
