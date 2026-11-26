/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/histogram.js and lib/internal/perf/event_loop_delay.js
 * (Histogram, RecordableHistogram, ELDHistogram, createHistogram) and from src/histogram.cc (the counters kept
 * around the HDR histogram).
 * Copyright Node.js contributors. All rights reserved.
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
import { HdrHistogram, INT64_MAX } from "./node-perf-hdr.ts";
import { inspectValue, invalidInstance, named, outOfRange, validateInteger, validateNumber, validateObject } from "./node-util-validators.ts";

/** A repeating timer of the process; the handle may offer `unref()`. */
export interface HistogramTimers {
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}
/** What a histogram measures time with: a monotonic clock in milliseconds, and the process's timers. */
export interface HistogramPorts {
  readonly now: () => number;
  readonly timers?: HistogramTimers;
}

interface State {
  readonly hdr: HdrHistogram;
  readonly kind: "recordable" | "interval";
  readonly nanoseconds: () => bigint;
  count: number;
  exceeds: number;
  /** The time of the previous `recordDelta`, zero before the first. */
  previous: bigint;
  map: Map<number, number | bigint>;
}
interface Interval { readonly timers: HistogramTimers; readonly resolution: number; enabled: boolean; handle: unknown }

const states = new WeakMap<object, State>();
const intervals = new WeakMap<object, Interval>();
let constructing: State | undefined;

function coded<Failure extends Error>(error: Failure, code: string): Failure { return Object.assign(error, { code }); }
function illegalConstructor(): TypeError { return coded(new TypeError("Illegal constructor"), "ERR_ILLEGAL_CONSTRUCTOR"); }
function invalidThis(type: string): TypeError { return coded(new TypeError(`Value of "this" must be of type ${type}`), "ERR_INVALID_THIS"); }
function stateOf(value: unknown, type: string, kind?: State["kind"]): State {
  const state = typeof value === "object" && value !== null ? states.get(value) : undefined;
  if (state === undefined || (kind !== undefined && state.kind !== kind)) throw invalidThis(type);
  return state;
}
function adopt(target: object): void {
  if (constructing === undefined) throw illegalConstructor();
  states.set(target, constructing);
  constructing = undefined;
}
function checkedPercentile(percentile: unknown): number {
  validateNumber(percentile, "percentile");
  if (Number.isNaN(percentile) || percentile <= 0 || percentile > 100) throw outOfRange("percentile", "> 0 && <= 100", percentile);
  return percentile;
}
function recordInto(state: State, value: bigint): void {
  if (state.hdr.record(value)) state.count += 1;
  else state.exceeds += 1;
}
/** Node's `RecordDelta`: the time since the previous call, recorded from the second call on. */
function recordDelta(state: State): void {
  const time = state.nanoseconds();
  if (state.previous > 0n) recordInto(state, time > state.previous ? time - state.previous : 0n);
  state.previous = time;
}

export class Histogram {
  constructor() { adopt(this); }
  get count(): number { return stateOf(this, "Histogram").count; }
  get countBigInt(): bigint { return BigInt(stateOf(this, "Histogram").count); }
  get min(): number { return Number(stateOf(this, "Histogram").hdr.min()); }
  get minBigInt(): bigint { return stateOf(this, "Histogram").hdr.min(); }
  get max(): number { return Number(stateOf(this, "Histogram").hdr.max()); }
  get maxBigInt(): bigint { return stateOf(this, "Histogram").hdr.max(); }
  get mean(): number { return stateOf(this, "Histogram").hdr.mean(); }
  get exceeds(): number { return stateOf(this, "Histogram").exceeds; }
  get exceedsBigInt(): bigint { return BigInt(stateOf(this, "Histogram").exceeds); }
  get stddev(): number { return stateOf(this, "Histogram").hdr.stddev(); }
  percentile(percentile: unknown): number {
    const state = stateOf(this, "Histogram");
    return Number(state.hdr.percentile(checkedPercentile(percentile)));
  }
  percentileBigInt(percentile: unknown): bigint {
    const state = stateOf(this, "Histogram");
    return state.hdr.percentile(checkedPercentile(percentile));
  }
  /** Node hands out the same map each time, filled anew. */
  get percentiles(): Map<number, number | bigint> {
    const state = stateOf(this, "Histogram");
    state.map.clear();
    state.hdr.percentiles((percentile, value) => { state.map.set(percentile, Number(value)); });
    return state.map;
  }
  get percentilesBigInt(): Map<number, number | bigint> {
    const state = stateOf(this, "Histogram");
    state.map.clear();
    state.hdr.percentiles((percentile, value) => { state.map.set(percentile, value); });
    return state.map;
  }
  reset(): void {
    const state = stateOf(this, "Histogram");
    state.hdr.reset();
    state.count = 0;
    state.exceeds = 0;
    state.previous = 0n;
  }
  toJSON(): Record<string, unknown> {
    return { count: this.count, min: this.min, max: this.max, mean: this.mean, exceeds: this.exceeds, stddev: this.stddev, percentiles: Object.fromEntries(this.percentiles) };
  }
  /** `util.inspect` passes itself as the third argument. */
  [Symbol.for("nodejs.util.inspect.custom")](depth: unknown, options: unknown, ...rest: unknown[]): unknown {
    const inspect = rest[0];
    if (typeof depth === "number" && depth < 0) return this;
    const shown = { min: this.min, max: this.max, mean: this.mean, exceeds: this.exceeds, stddev: this.stddev, count: this.count, percentiles: this.percentiles };
    if (typeof inspect !== "function") return `Histogram ${inspectValue(shown)}`;
    const given: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "depth") : undefined;
    const text: unknown = Reflect.apply(inspect, undefined, [shown, { ...(typeof options === "object" ? options : {}), depth: typeof given === "number" ? given - 1 : null }]);
    return `Histogram ${String(text)}`;
  }
}
named(Histogram, "Histogram");

export class RecordableHistogram extends Histogram {
  record(val: unknown): void {
    const state = stateOf(this, "RecordableHistogram", "recordable");
    if (typeof val === "bigint") {
      if (val < 1n || val > INT64_MAX) throw coded(new RangeError("value is out of range"), "ERR_OUT_OF_RANGE");
      recordInto(state, val);
      return;
    }
    validateInteger(val, "val", 1);
    recordInto(state, BigInt(val));
  }
  recordDelta(): void { recordDelta(stateOf(this, "RecordableHistogram", "recordable")); }
  add(other: unknown): void {
    const state = stateOf(this, "RecordableHistogram", "recordable");
    if (other === undefined || other === null) throw new TypeError(`Cannot read properties of ${String(other)} (reading 'Symbol(kRecordable)')`);
    const from = typeof other === "object" ? states.get(other) : undefined;
    if (from?.kind !== "recordable") throw invalidInstance("other", "RecordableHistogram", other);
    state.count += from.count;
    state.exceeds += from.exceeds;
    if (from.previous > state.previous) state.previous = from.previous;
    state.hdr.add(from.hdr);
  }
}
named(RecordableHistogram, "RecordableHistogram");

/** Node's `ELDHistogram`, the class of `monitorEventLoopDelay()`. */
export class IntervalHistogram extends Histogram {
  enable(): boolean {
    const interval = intervals.get(this), state = states.get(this);
    if (interval === undefined || state === undefined) throw invalidThis("ELDHistogram");
    if (interval.enabled) return false;
    interval.enabled = true;
    // Node's timer repeats every `resolution` milliseconds and records the time between two of its turns:
    // the resolution plus how late the loop ran it.
    interval.handle = interval.timers.setInterval(() => { recordDelta(state); }, interval.resolution);
    // The monitor never keeps the process alive.
    const unref: unknown = typeof interval.handle === "object" && interval.handle !== null ? Reflect.get(interval.handle, "unref") : undefined;
    if (typeof unref === "function") Reflect.apply(unref, interval.handle, []);
    return true;
  }
  disable(): boolean {
    const interval = intervals.get(this);
    if (interval === undefined) throw invalidThis("ELDHistogram");
    if (!interval.enabled) return false;
    interval.enabled = false;
    interval.timers.clearInterval(interval.handle);
    interval.handle = undefined;
    return true;
  }
  [Symbol.dispose](): void { this.disable(); }
}
named(IntervalHistogram, "ELDHistogram");

export function isHistogram(value: unknown): value is Histogram {
  return typeof value === "object" && value !== null && states.has(value);
}
export function isRecordableHistogram(value: unknown): value is RecordableHistogram {
  return typeof value === "object" && value !== null && states.get(value)?.kind === "recordable";
}

function newState(kind: State["kind"], lowest: bigint, highest: bigint, figures: number, now: () => number): State {
  return { hdr: new HdrHistogram(lowest, highest, figures), kind, nanoseconds: () => BigInt(Math.round(now() * 1e6)), count: 0, exceeds: 0, previous: 0n, map: new Map() };
}

export interface NodeHistograms {
  readonly createHistogram: (options?: unknown) => RecordableHistogram;
  /** Absent without the process's timers. */
  readonly monitorEventLoopDelay?: (options?: unknown) => IntervalHistogram;
}

export function createNodeHistograms(ports: HistogramPorts): NodeHistograms {
  function createHistogram(options: unknown = {}): RecordableHistogram {
    validateObject(options, "options");
    const given = (name: string, fallback: number): unknown => { const value: unknown = Reflect.get(options, name); return value === undefined ? fallback : value; };
    const lowest = given("lowest", 1), highest = given("highest", Number.MAX_SAFE_INTEGER), figures = given("figures", 3);
    if (typeof lowest !== "bigint") validateInteger(lowest, "options.lowest", 1, Number.MAX_SAFE_INTEGER);
    // Node multiplies the two as they are: a bigint beside a number is the engine's own error.
    if ((typeof lowest === "bigint") !== (typeof highest === "bigint")) throw new TypeError("Cannot mix BigInt and other types, use explicit conversions");
    if (typeof highest !== "bigint") validateInteger(highest, "options.highest", 2 * Number(lowest), Number.MAX_SAFE_INTEGER);
    else if (highest < 2n * BigInt(lowest)) throw coded(new RangeError(`The property 'options.highest' is invalid. Received ${String(highest)}n`), "ERR_INVALID_ARG_VALUE");
    validateInteger(figures, "options.figures", 1, 5);
    const low = BigInt(lowest), high = BigInt(highest);
    // Node's native layer aborts on these; a 64-bit range is all the histogram has.
    if (low < 1n || high > INT64_MAX) throw coded(new RangeError("value is out of range"), "ERR_OUT_OF_RANGE");
    constructing = newState("recordable", low, high, figures, ports.now);
    try { return new RecordableHistogram(); } finally { constructing = undefined; }
  }
  const timers = ports.timers;
  if (timers === undefined) return { createHistogram };
  const monitorEventLoopDelay = (options: unknown = {}): IntervalHistogram => {
    validateObject(options, "options");
    const given: unknown = Reflect.get(options, "resolution"), resolution = given === undefined ? 10 : given;
    validateInteger(resolution, "options.resolution", 1);
    // Node's native histogram for the loop delay: nanoseconds from 1000 up, three figures.
    constructing = newState("interval", 1000n, INT64_MAX, 3, ports.now);
    try {
      const histogram = new IntervalHistogram();
      intervals.set(histogram, { timers, resolution, enabled: false, handle: undefined });
      return histogram;
    } finally { constructing = undefined; }
  };
  return { createHistogram, monitorEventLoopDelay };
}
