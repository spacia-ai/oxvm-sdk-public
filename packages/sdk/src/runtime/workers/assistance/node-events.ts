/// <reference lib="esnext.disposable" />
import type Emitter from "events/";
import type { NodeAsyncHooks } from "./node-async-hooks.js";
import { createEventEmitterAsyncResource } from "./node-event-resource.js";
import { createNodeAbortListeners } from "./node-abort-listener.js";
import { invalidArgType } from "./node-arg-type.js";
import { createEventIteration } from "./node-events-on.ts";
import { invalidInstance, named, outOfRange, validateAbortSignal, validateFunction, validateNumber } from "./node-util-validators.ts";

/** Node's `events` builtin is the EventEmitter class; the vendored emitter
 * lacks the listener inspection statics undici and Next consult. Platform
 * event targets never expose their listeners, and Node's listener limit is a
 * warning threshold, so those answer an empty list and accept a limit. */
interface EmitterLike {
  listeners(name: string | symbol): unknown[];
  getMaxListeners(): number;
  setMaxListeners(count: number): unknown;
}

function isEmitter(value: unknown): value is EmitterLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "listeners") === "function"
    && typeof Reflect.get(value, "getMaxListeners") === "function" && typeof Reflect.get(value, "setMaxListeners") === "function";
}

function isEventTarget(value: unknown): value is object {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "addEventListener") === "function";
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function invalid(value: unknown, name = "emitter"): never {
  throw invalidInstance(name, "EventEmitter or EventTarget", value);
}

/** Node's `events.errorMonitor`: its listeners see an 'error' before the 'error' listeners and do not handle it. */
const errorMonitor = Symbol("events.errorMonitor");
/** Node's `events.captureRejectionSymbol`: the method of an emitter that receives its listeners' rejections. */
const captureRejectionSymbol = Symbol.for("nodejs.rejection");

type Tick = (callback: () => void) => void;
const microtask: Tick = callback => { queueMicrotask(callback); };

/** What the processes of one worker share with the emitter class they share. */
interface Rejections {
  /** `events.captureRejections`: whether an emitter constructed now captures. */
  byDefault: boolean;
  /** The process's `nextTick`: Node reports a rejection one tick after it is observed. */
  tick: Tick;
  /** `require("events")`: the class, constructed with Node's options. */
  readonly module: NodeEmitterClass;
}
/** The class as Node declares it: its constructor reads an options object, which the vendored declaration omits. */
export type NodeEmitterClass = typeof Emitter & (new (options?: unknown) => Emitter);
function isEmit(value: unknown): value is (this: Emitter, type: string | symbol, ...args: unknown[]) => boolean { return typeof value === "function"; }
function readsOptions(value: typeof Emitter): value is NodeEmitterClass { return typeof value === "function"; }
const installed = new WeakMap<typeof Emitter, Rejections>();

function invalidBoolean(name: string, value: unknown): TypeError {
  const error = invalidArgType(name, "boolean", value, () => "[Object: null prototype] {}");
  error.message = error.message.replace("\" argument must", "\" property must");
  return error;
}

/**
 * The vendored emitter predates `errorMonitor` and `captureRejections`, and every stream and socket extends it, so its
 * own `emit` and `init` learn them once: an emitter that captures nothing still dispatches through the vendored `emit`.
 */
function installRejections(EventEmitter: typeof Emitter): Rejections {
  const existing = installed.get(EventEmitter);
  if (existing !== undefined) return existing;
  /** Node's `kCapture`, kept off the emitter so that inspecting one shows no extra key. */
  const capturing = new WeakSet<object>();
  let everCaptured = false;
  const vendored: unknown = Reflect.get(EventEmitter.prototype, "emit");
  if (!isEmit(vendored)) throw new TypeError("EventEmitter has no emit");
  const original = vendored;

  function report(emitter: Emitter, error: unknown, type: string | symbol, args: readonly unknown[]): void {
    const handler: unknown = Reflect.get(emitter, captureRejectionSymbol);
    if (typeof handler === "function") { Reflect.apply(handler, emitter, [error, type, ...args]); return; }
    // An 'error' listener that rejects is not captured again, or it would report to itself forever.
    const captured = capturing.delete(emitter);
    try { emitter.emit("error", error); }
    finally { if (captured) capturing.add(emitter); }
  }
  function watch(emitter: Emitter, result: unknown, type: string | symbol, args: readonly unknown[]): void {
    if (result === undefined || result === null) return;
    try {
      const then: unknown = Reflect.get(Object(result), "then");
      if (typeof then === "function") Reflect.apply(then, result, [undefined, (error: unknown): void => { state.tick(() => { report(emitter, error, type, args); }); }]);
    } catch (error) { emitter.emit("error", error); }
  }
  function emit(this: Emitter, type: string | symbol, ...args: unknown[]): boolean {
    // The common case, every stream chunk included: no monitor to tell and nothing captured.
    if (type !== "error" && !everCaptured) return original.call(this, type, ...args);
    const events: unknown = Reflect.get(this, "_events");
    const listeners = typeof events === "object" && events !== null ? events : undefined;
    if (type === "error" && listeners !== undefined && Reflect.get(listeners, errorMonitor) !== undefined) this.emit(errorMonitor, ...args);
    const handler: unknown = everCaptured && listeners !== undefined && capturing.has(this) ? Reflect.get(listeners, type) : undefined;
    // No listener, or nothing to capture: the vendored emit dispatches, answers false or throws the unhandled 'error'.
    if (typeof handler === "function") watch(this, Reflect.apply(handler, this, args), type, args);
    else if (isList(handler)) {
      // A copy: a listener may remove itself or its neighbours.
      for (const listener of [...handler]) if (typeof listener === "function") watch(this, Reflect.apply(listener, this, args), type, args);
    } else return Reflect.apply(original, this, [type, ...args]);
    return true;
  }
  // The bundle renames functions; programs read this one's name.
  Object.defineProperty(emit, "name", { value: "emit" });
  Object.defineProperty(EventEmitter.prototype, "emit", { value: emit, writable: true, configurable: true, enumerable: true });

  const adopt = (emitter: object): void => { capturing.add(emitter); everCaptured = true; };
  const init: unknown = Reflect.get(EventEmitter, "init");
  if (typeof init === "function") {
    // Every construction passes here, a subclass that never saw the builtin included.
    const initialize = function (this: object, options?: unknown): void {
      if (state.byDefault) adopt(this);
      Reflect.apply(init, this, [options]);
    };
    Object.defineProperty(initialize, "name", { value: "" });
    Reflect.set(EventEmitter, "init", initialize);
  }

  /** Node reads the option only when it is truthy, and only then insists on a boolean. */
  const wanted = (options: unknown): boolean => {
    const value: unknown = options === undefined || options === null ? undefined : Reflect.get(Object(options), "captureRejections");
    const asked = Boolean(value);
    if (!asked) return false;
    if (typeof value !== "boolean") throw invalidBoolean("options.captureRejections", value);
    return true;
  };
  // The vendored constructor takes no arguments, so the options are read around it. Prototype, statics and
  // `instanceof` are the class's own.
  const module = new Proxy(EventEmitter, {
    construct(target, args, newTarget): object {
      const capture = wanted(args[0]);
      const emitter: unknown = Reflect.construct(target, args, newTarget);
      if (typeof emitter !== "object" || emitter === null) throw new TypeError("EventEmitter did not construct an object");
      if (capture) adopt(emitter);
      return emitter;
    },
    apply(target, self: unknown, args): unknown {
      const capture = wanted(args[0]);
      const result: unknown = Reflect.apply(target, self, args);
      if (capture && typeof self === "object" && self !== null) adopt(self);
      return result;
    },
  });
  Object.defineProperty(EventEmitter.prototype, "constructor", { value: module, writable: true, configurable: true, enumerable: false });
  if (!readsOptions(module)) throw new TypeError("EventEmitter is not a constructor");
  const state: Rejections = { byDefault: false, tick: microtask, module };
  installed.set(EventEmitter, state);
  return state;
}

/**
 * @param nextTick the process's `nextTick`; a captured rejection is reported through it, as Node does. Without one
 * the report is a microtask, which runs it earlier than Node relative to other promise reactions.
 */
export function createNodeEvents(EventEmitter: typeof Emitter, hooks: NodeAsyncHooks, nextTick?: Tick) {
  const aborts = createNodeAbortListeners();
  const rejections = installRejections(EventEmitter);
  const tick = nextTick ?? microtask;
  rejections.tick = tick;
  const defaultMaxListeners = (): number => { const value: unknown = Reflect.get(EventEmitter, "defaultMaxListeners"); return typeof value === "number" ? value : 10; };
  /** Node keeps a warning threshold on each event target; the platform's targets have nowhere to keep one. */
  const targetLimits = new WeakMap<object, number>();
  const iteration = createEventIteration(aborts.addAbortListener);
  /** Node's `setMaxListeners` is an anonymous function with two defaulted parameters. */
  const setMaxListeners = function (count: unknown = defaultMaxListeners(), ...targets: unknown[]): void {
    validateNumber(count, "setMaxListeners");
    if (Number.isNaN(count) || count < 0) throw outOfRange("setMaxListeners", ">= 0", count);
    if (targets.length === 0) { Reflect.set(EventEmitter, "defaultMaxListeners", count); return; }
    for (const target of targets) {
      if (isEmitter(target)) target.setMaxListeners(count);
      else if (isEventTarget(target)) targetLimits.set(target, count);
      else invalid(target, "eventTargets");
    }
  };
  const statics = {
    EventEmitter: rejections.module,
    errorMonitor,
    captureRejectionSymbol,
    usingDomains: false,
    addAbortListener: named((signal: unknown, listener: unknown): Disposable => {
      // Node's wording of the two argument errors; the listener owner then does the work.
      validateAbortSignal(signal, "signal");
      validateFunction(listener, "listener");
      return aborts.addAbortListener(signal, listener);
    }, "addAbortListener"),
    on: iteration.on,
    once: iteration.once,
    listenerCount(target: unknown, name: string | symbol): number {
      const count: unknown = Reflect.get(Object(target), "listenerCount");
      if (typeof count === "function") { const listeners: unknown = Reflect.apply(count, target, [name]); return typeof listeners === "number" ? listeners : 0; }
      // A platform event target does not say how many listeners it has.
      if (isEventTarget(target)) return 0;
      return invalid(target);
    },
    EventEmitterAsyncResource: createEventEmitterAsyncResource(EventEmitter, hooks),
    getEventListeners(target: unknown, name: string | symbol): unknown[] {
      if (isEmitter(target)) return target.listeners(name);
      if (isEventTarget(target)) return [];
      return invalid(target);
    },
    getMaxListeners(target: unknown): number {
      if (isEmitter(target)) return target.getMaxListeners();
      // Node's own abort signals start at 0, which means no limit; other targets at the default.
      if (isEventTarget(target)) return targetLimits.get(target) ?? (target instanceof AbortSignal ? 0 : defaultMaxListeners());
      return invalid(target);
    },
    setMaxListeners: named(setMaxListeners, ""),
  };
  /** Node's accessor pair: the switch validates what it is given. */
  const switches = {
    get captureRejections(): boolean { return rejections.byDefault; },
    set captureRejections(value: unknown) {
      if (typeof value !== "boolean") throw invalidBoolean("EventEmitter.captureRejections", value);
      rejections.byDefault = value;
    },
  };
  // Defined from own descriptors, never read: a placeholder left by the missing-export guard records every read.
  for (const [name, value] of Object.entries(statics)) {
    const existing = Object.getOwnPropertyDescriptor(EventEmitter, name);
    if (existing === undefined || existing.enumerable !== true) Object.defineProperty(EventEmitter, name, { value, configurable: true, writable: true, enumerable: true });
  }
  Object.defineProperty(EventEmitter, "captureRejections", { ...Object.getOwnPropertyDescriptor(switches, "captureRejections"), configurable: true, enumerable: true });
  // The class now carries the statics; read them back through a checked view
  // instead of asserting the augmented type.
  const augmented: unknown = EventEmitter;
  if (typeof augmented !== "function" || typeof Reflect.get(augmented, "getEventListeners") !== "function") {
    throw new TypeError("EventEmitter statics were not installed");
  }
  const restore = (): void => {
    aborts.restore();
    rejections.byDefault = false;
    if (rejections.tick === tick) rejections.tick = microtask;
  };
  return { module: Object.assign(rejections.module, statics, switches), restore };
}
