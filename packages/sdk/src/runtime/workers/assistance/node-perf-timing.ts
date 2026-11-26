/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/perf/event_loop_utilization.js, lib/internal/perf/timerify.js
 * and lib/internal/perf/nodetiming.js.
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
import { isRecordableHistogram, type RecordableHistogram } from "./node-perf-histogram.ts";
import { invalidInstance, named, templateText, validateFunction, validateObject } from "./node-util-validators.ts";

/** The milestones of one process, in milliseconds since the platform's time origin. */
export interface ProcessMilestones {
  readonly now: () => number;
  /** When the process's built-ins were ready. */
  readonly bootstrapComplete: number;
  /** When the process's event loop took its first turn; -1 until then, as in Node. */
  readonly loopStart: () => number;
}

export interface LoopUtilization { idle: number; active: number; utilization: number }

function truthy(value: unknown): boolean { return Boolean(value); }
/** A property of a value a program passed in, read as JavaScript reads `value.key`. */
function member(value: unknown, key: string): number {
  if (value === undefined || value === null) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
  const found: unknown = Reflect.get(Object(value), key);
  return typeof found === "number" ? found : Number(found);
}

/**
 * `performance.eventLoopUtilization`. A browser worker cannot see how long its event loop waited, so the loop
 * counts as busy since it started: `idle` is 0 and `active` is the time since the loop's first turn. The forms
 * that take earlier results subtract exactly as Node does.
 */
export function createEventLoopUtilization(milestones: ProcessMilestones): (util1?: unknown, util2?: unknown) => LoopUtilization {
  const idleTime = 0;
  function eventLoopUtilization(util1?: unknown, util2?: unknown): LoopUtilization {
    const loopStart = milestones.loopStart();
    if (loopStart <= 0) return { idle: 0, active: 0, utilization: 0 };
    if (truthy(util2)) {
      const idle = member(util1, "idle") - member(util2, "idle"), active = member(util1, "active") - member(util2, "active");
      return { idle, active, utilization: active / (idle + active) };
    }
    const active = milestones.now() - loopStart - idleTime;
    if (!truthy(util1)) return { idle: idleTime, active, utilization: active / (idleTime + active) };
    const idleDelta = idleTime - member(util1, "idle"), activeDelta = active - member(util1, "active");
    return { idle: idleDelta, active: activeDelta, utilization: activeDelta / (idleDelta + activeDelta) };
  }
  return named(eventLoopUtilization, "eventLoopUtilization");
}

function isThenableWithFinally(value: unknown): value is { finally(callback: () => void): unknown } {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof Reflect.get(value, "finally") === "function";
}

/**
 * `perf_hooks.timerify`. Each call's duration goes to the histogram option. Node also queues a 'function'
 * performance entry for observers; the platform's PerformanceObserver takes no entries from JavaScript, so none
 * is produced here.
 */
export function createTimerify(now: () => number): (fn: unknown, options?: unknown) => (...args: unknown[]) => unknown {
  function timerify(fn: unknown, options: unknown = {}): (...args: unknown[]) => unknown {
    validateFunction(fn, "fn");
    const target = fn;
    validateObject(options, "options");
    const histogram: unknown = Reflect.get(options, "histogram");
    let recorder: RecordableHistogram | undefined;
    if (histogram !== undefined) {
      if (!isRecordableHistogram(histogram)) throw invalidInstance("options.histogram", "RecordableHistogram", histogram);
      recorder = histogram;
    }
    const complete = (start: number): void => {
      // The platform's clock is coarser than Node's: a call it measures as zero is recorded as one nanosecond,
      // the least a histogram accepts.
      recorder?.record(Math.max(1, Math.ceil((now() - start) * 1e6)));
    };
    function timerified(this: unknown, ...args: unknown[]): unknown {
      const constructing = typeof new.target === "function", start = now();
      const result: unknown = constructing ? Reflect.construct(target, args, target) : Reflect.apply(target, this, args);
      if (!constructing && isThenableWithFinally(result)) return result.finally(() => { complete(start); });
      complete(start);
      return result;
    }
    const length: unknown = Reflect.get(fn, "length");
    Object.defineProperties(timerified, {
      length: { configurable: false, enumerable: true, value: length },
      name: { configurable: false, enumerable: true, value: `timerified ${templateText(Reflect.get(fn, "name"))}` },
    });
    return timerified;
  }
  return named(timerify, "timerify");
}

/**
 * `performance.nodeTiming`. The worker's realm is the process's Node and V8, so both start at the time origin;
 * the environment and the bootstrap are complete when the process's built-ins are. The loop's idle time and
 * libuv's counters cannot be observed and read 0.
 */
export function createNodeTiming(milestones: ProcessMilestones, entryPrototype: object | null): object {
  class PerformanceNodeTiming {
    toJSON(): Record<string, unknown> {
      const read = (name: string): unknown => Reflect.get(this, name);
      return { name: "node", entryType: "node", startTime: read("startTime"), duration: read("duration"), nodeStart: read("nodeStart"), v8Start: read("v8Start"),
        bootstrapComplete: read("bootstrapComplete"), environment: read("environment"), loopStart: read("loopStart"), loopExit: read("loopExit"), idleTime: read("idleTime") };
    }
  }
  named(PerformanceNodeTiming, "PerformanceNodeTiming");
  Object.setPrototypeOf(PerformanceNodeTiming.prototype, entryPrototype);
  const timing = new PerformanceNodeTiming();
  const value = (fixed: unknown): PropertyDescriptor => ({ enumerable: true, configurable: true, value: fixed });
  const getter = (get: () => unknown): PropertyDescriptor => ({ enumerable: true, configurable: true, get });
  Object.defineProperties(timing, {
    name: value("node"), entryType: value("node"), startTime: value(0), duration: getter(() => milestones.now()),
    nodeStart: getter(() => 0), v8Start: getter(() => 0), environment: getter(() => milestones.bootstrapComplete),
    loopStart: getter(() => milestones.loopStart()), loopExit: getter(() => -1), bootstrapComplete: getter(() => milestones.bootstrapComplete),
    idleTime: getter(() => 0), uvMetricsInfo: getter(() => ({ loopCount: 0, events: 0, eventsWaiting: 0 })),
  });
  return timing;
}
