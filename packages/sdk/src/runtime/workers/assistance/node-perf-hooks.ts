import { VMError } from "../../errors.ts";
import { unavailableNodeApi } from "./node-capability.ts";
import { createNodeHistograms, type HistogramTimers } from "./node-perf-histogram.ts";
import { createEventLoopUtilization, createNodeTiming, createTimerify, type ProcessMilestones } from "./node-perf-timing.ts";
import { named } from "./node-util-validators.ts";

const PLATFORM_EXPORTS = ["performance", "PerformanceObserver", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
  "PerformanceObserverEntryList", "PerformanceResourceTiming"] as const;

/** What `perf_hooks` takes from its process. Every port is optional; see each for what its absence means. */
export interface PerfHooksPorts {
  /** A monotonic clock in milliseconds since the platform's time origin. Default: the platform's `performance.now()`. */
  readonly now?: () => number;
  /**
   * The process's own timers (their handles offer `unref()`), for `monitorEventLoopDelay` and to see the event
   * loop's first turn. Without them `monitorEventLoopDelay` is refused and the loop counts as started at once.
   */
  readonly timers?: HistogramTimers;
  /**
   * Given, Node's additions (`eventLoopUtilization`, `nodeTiming`, `timerify`, Node's `toJSON`) are defined on
   * the platform's `performance` object, which is also the program's global, and this receives the undo.
   * Not given, that object is left as the platform made it.
   */
  readonly install?: (restore: () => void) => void;
}

function platformClock(performance: unknown): () => number {
  return () => {
    const now: unknown = Reflect.get(Object(performance), "now");
    const value: unknown = typeof now === "function" ? Reflect.apply(now, performance, []) : undefined;
    if (typeof value !== "number") throw new VMError("FEATURE_NOT_AVAILABLE", "perf_hooks is unavailable: the platform lacks performance.now");
    return value;
  };
}

/** Node's `Performance` is the platform's class, except that constructing it fails with Node's coded error. */
function nodePerformanceClass(platform: unknown): unknown {
  if (typeof platform !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "perf_hooks is unavailable: the platform lacks Performance", { builtin: "perf_hooks", missing: "Performance" });
  return new Proxy(platform, {
    construct(): never { throw Object.assign(new TypeError("Illegal constructor"), { code: "ERR_ILLEGAL_CONSTRUCTOR" }); },
  });
}

function defineAdditions(performance: object, additions: Readonly<Record<string, unknown>>): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(additions)) {
    previous.set(name, Object.getOwnPropertyDescriptor(performance, name));
    Object.defineProperty(performance, name, { configurable: true, enumerable: false, writable: true, value });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(performance, name);
      else Object.defineProperty(performance, name, descriptor);
    }
  };
}

/**
 * The `perf_hooks` builtin: the platform's performance clock and observer classes, with Node's histograms,
 * loop-delay monitor, loop utilization, `timerify` and `nodeTiming` beside them.
 */
export function createNodePerfHooks(globals: unknown, ports: PerfHooksPorts = {}): Readonly<Record<string, unknown>> {
  if (typeof globals !== "object" || globals === null) throw new VMError("FEATURE_NOT_AVAILABLE", "perf_hooks requires the platform's global scope");
  const module: Record<string, unknown> = { Performance: nodePerformanceClass(Reflect.get(globals, "Performance")) };
  for (const name of PLATFORM_EXPORTS) {
    const value: unknown = Reflect.get(globals, name);
    if (value === undefined || value === null) {
      throw new VMError("FEATURE_NOT_AVAILABLE", `perf_hooks is unavailable: the platform lacks ${name}`, { builtin: "perf_hooks", missing: name });
    }
    module[name] = value;
  }
  const performance: unknown = module["performance"], entryClass: unknown = module["PerformanceEntry"];
  const now = ports.now ?? platformClock(performance), timers = ports.timers;
  const bootstrapComplete = now();
  let loopStart = timers === undefined ? bootstrapComplete : -1;
  if (timers !== undefined) {
    const handle: unknown = timers.setInterval(() => { loopStart = now(); timers.clearInterval(handle); }, 1);
    const unref: unknown = typeof handle === "object" && handle !== null ? Reflect.get(handle, "unref") : undefined;
    if (typeof unref === "function") Reflect.apply(unref, handle, []);
  }
  const milestones: ProcessMilestones = { now, bootstrapComplete, loopStart: () => loopStart };
  const histograms = createNodeHistograms({ now, ...(timers === undefined ? {} : { timers }) });
  const eventLoopUtilization = createEventLoopUtilization(milestones), timerify = createTimerify(now);
  const entryPrototype: unknown = typeof entryClass === "function" ? Reflect.get(entryClass, "prototype") : undefined;
  const nodeTiming = createNodeTiming(milestones, typeof entryPrototype === "object" ? entryPrototype : null);
  if (ports.install !== undefined && typeof performance === "object" && performance !== null) {
    const platform = performance;
    const toJSON = function toJSON(): Record<string, unknown> {
      return { nodeTiming, timeOrigin: Reflect.get(platform, "timeOrigin"), eventLoopUtilization: eventLoopUtilization() };
    };
    ports.install(defineAdditions(platform, { eventLoopUtilization, nodeTiming, timerify, toJSON: named(toJSON, "toJSON") }));
  }
  module["monitorEventLoopDelay"] = named(histograms.monitorEventLoopDelay ?? ((): never => unavailableNodeApi("perf_hooks.monitorEventLoopDelay")), "monitorEventLoopDelay");
  module["eventLoopUtilization"] = eventLoopUtilization;
  module["timerify"] = timerify;
  module["createHistogram"] = named(histograms.createHistogram, "createHistogram");
  // Node's own object: plain and unfrozen, held by a property that cannot be replaced.
  Object.defineProperty(module, "constants", { enumerable: true, configurable: false, writable: false, value: {
    NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16,
    NODE_PERFORMANCE_GC_FLAGS_NO: 0, NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2, NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
    NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8, NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
    NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32, NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
  } });
  return Object.freeze(module);
}
