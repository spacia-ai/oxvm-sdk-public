/*!
 * Adapted from Node.js v24.18.1 lib/events.js (`on`, `once`, `eventTargetAgnosticAddListener`,
 * `eventTargetAgnosticRemoveListener`, `listenersController`).
 * Copyright Joyent, Inc. and other Node contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/// <reference lib="esnext.disposable" />
import { invalidInstance, named, validateInteger, validateObject } from "./node-util-validators.ts";

type Listener = (...args: unknown[]) => void;
type AddAbortListener = (signal: unknown, listener: unknown) => Disposable;
interface IterResult { value: unknown; done: boolean }
/** The iterator of `events.on`: `throw` ends it and answers nothing, as Node's does. */
export interface EventIterator {
  next(): Promise<IterResult>;
  return(): Promise<IterResult>;
  throw(err: unknown): undefined;
  [Symbol.asyncIterator](): EventIterator;
}
interface Waiting { readonly resolve: (result: IterResult) => void; readonly reject: (error: unknown) => void }

/** %AsyncIteratorPrototype%, reached as Node reaches it: through an async generator function. */
function asyncIteratorPrototype(): object | null {
  const generatorFunction: unknown = Object.getPrototypeOf(async function* () { /* Only its prototype chain is read. */ });
  const generator: unknown = typeof generatorFunction === "object" && generatorFunction !== null ? Reflect.get(generatorFunction, "prototype") : undefined;
  const prototype: unknown = typeof generator === "object" && generator !== null ? Object.getPrototypeOf(generator) : undefined;
  return typeof prototype === "object" ? prototype : null;
}
const AsyncIteratorPrototype = asyncIteratorPrototype();
const watermarkData = Symbol("kWatermarkData");

/** `target.name` as JavaScript reads it: a missing target is the engine's own TypeError. */
function member(target: unknown, name: string): unknown {
  if (target === undefined || target === null) throw new TypeError(`Cannot read properties of ${String(target)} (reading '${name}')`);
  const value: unknown = Reflect.get(Object(target), name);
  return value;
}
/** `target.name(...args)`: a missing method is the engine's own TypeError. */
function invoke(target: unknown, name: string, args: readonly unknown[]): void {
  const method = member(target, name);
  if (typeof method !== "function") throw new TypeError(`emitter.${name} is not a function`);
  Reflect.apply(method, target, args);
}
function truthy(value: unknown): boolean { return Boolean(value); }
function addListener(emitter: unknown, name: unknown, listener: Listener, once: boolean): void {
  if (typeof member(emitter, "on") === "function") {
    invoke(emitter, once ? "once" : "on", [name, listener]);
    return;
  }
  const add = member(emitter, "addEventListener");
  if (typeof add !== "function") throw invalidInstance("emitter", "EventEmitter", emitter);
  Reflect.apply(add, emitter, [name, listener, once ? { once: true } : undefined]);
}
function removeListener(emitter: unknown, name: unknown, listener: Listener): void {
  const remove = member(emitter, "removeListener");
  if (typeof remove === "function") { Reflect.apply(remove, emitter, [name, listener]); return; }
  const removeEvent = member(emitter, "removeEventListener");
  if (typeof removeEvent !== "function") throw invalidInstance("emitter", "EventEmitter", emitter);
  Reflect.apply(removeEvent, emitter, [name, listener]);
}
/** Node's `validateAbortSignal`: absent, or an object that has `aborted`. */
function signalOf(options: object): AbortSignal | undefined {
  const signal: unknown = Reflect.get(options, "signal");
  if (signal === undefined) return undefined;
  if (signal === null || typeof signal !== "object" || !("aborted" in signal)) throw invalidInstance("options.signal", "AbortSignal", signal);
  // What Node checks is the property; the platform's class is what programs pass.
  if (!(signal instanceof AbortSignal)) throw invalidInstance("options.signal", "AbortSignal", signal);
  return signal;
}
function abortError(signal: AbortSignal | undefined): Error {
  const cause: unknown = signal?.reason;
  return Object.assign(new Error("The operation was aborted", { cause }), { name: "AbortError", code: "ABORT_ERR" });
}
function watermark(options: object, name: string, legacy: string, fallback: number): number {
  const value: unknown = Reflect.get(options, name) ?? Reflect.get(options, legacy) ?? fallback;
  validateInteger(value, `options.${name}`, 1);
  return value;
}
function result(value: unknown, done: boolean): IterResult { return { value, done }; }

/**
 * `events.on` and `events.once`. Neither holds the process: a `next()` that waits for an event is a promise only
 * the emitter settles, and Node also exits while one is pending and nothing else is.
 */
export function createEventIteration(addAbortListener: AddAbortListener) {
  function on(emitter: unknown, event: unknown, options: unknown = {}): EventIterator {
    validateObject(options, "options");
    const signal = signalOf(options);
    if (signal?.aborted === true) throw abortError(signal);
    const highWatermark = watermark(options, "highWaterMark", "highWatermark", Number.MAX_SAFE_INTEGER);
    const lowWatermark = watermark(options, "lowWaterMark", "lowWatermark", 1);
    const unconsumedEvents: unknown[] = [], unconsumedPromises: Waiting[] = [];
    const listeners: (readonly [unknown, unknown, Listener])[] = [];
    let paused = false, error: unknown = null, finished = false;
    let abortDisposable: Disposable | undefined;

    const listen = (target: unknown, name: unknown, handler: Listener): void => {
      addListener(target, name, handler, false);
      listeners.push([target, name, handler]);
    };
    const closeHandler = (): Promise<IterResult> => {
      abortDisposable?.[Symbol.dispose]();
      for (let entry = listeners.pop(); entry !== undefined; entry = listeners.pop()) removeListener(entry[0], entry[1], entry[2]);
      finished = true;
      paused = false;
      const done = result(undefined, true);
      for (let waiting = unconsumedPromises.shift(); waiting !== undefined; waiting = unconsumedPromises.shift()) waiting.resolve(done);
      return Promise.resolve(done);
    };
    const eventHandler = (value: unknown[]): void => {
      const waiting = unconsumedPromises.shift();
      if (waiting !== undefined) { waiting.resolve(result(value, false)); return; }
      unconsumedEvents.push(value);
      if (!paused && unconsumedEvents.length > highWatermark) {
        paused = true;
        invoke(emitter, "pause", []);
      }
    };
    const errorHandler = (failure: unknown): void => {
      const waiting = unconsumedPromises.shift();
      if (waiting === undefined) error = failure;
      else waiting.reject(failure);
      void closeHandler();
    };

    const iterator: EventIterator & { readonly [watermarkData]: object } = {
      next(): Promise<IterResult> {
        // First, all unread events.
        if (unconsumedEvents.length !== 0) {
          const value = unconsumedEvents.shift();
          if (paused && unconsumedEvents.length < lowWatermark) {
            invoke(emitter, "resume", []);
            paused = false;
          }
          return Promise.resolve(result(value, false));
        }
        // Then the error, once: after 'error' nothing listens.
        if (truthy(error)) {
          const rejected = Promise.withResolvers<IterResult>(), fail: (reason: unknown) => void = rejected.reject;
          fail(error);
          error = null;
          return rejected.promise;
        }
        if (finished) return closeHandler();
        return new Promise<IterResult>((resolve, reject) => { unconsumedPromises.push({ resolve, reject }); });
      },
      return(): Promise<IterResult> { return closeHandler(); },
      throw(err: unknown): undefined {
        if (!(err instanceof Error)) throw invalidInstance("EventEmitter.AsyncIterator", "Error", err);
        errorHandler(err);
        return undefined;
      },
      [Symbol.asyncIterator](): EventIterator { return iterator; },
      [watermarkData]: {
        get size(): number { return unconsumedEvents.length; },
        get low(): number { return lowWatermark; },
        get high(): number { return highWatermark; },
        get isPaused(): boolean { return paused; },
      },
    };
    Object.setPrototypeOf(iterator, AsyncIteratorPrototype);

    listen(emitter, event, (...args) => { eventHandler(args); });
    if (event !== "error" && typeof member(emitter, "on") === "function") listen(emitter, "error", errorHandler);
    const closeEvents: unknown = Reflect.get(options, "close");
    const count: unknown = closeEvents === undefined || closeEvents === null ? 0 : Reflect.get(Object(closeEvents), "length");
    if (typeof count === "number") {
      for (let index = 0; index < count; index++) listen(emitter, Reflect.get(Object(closeEvents), index), () => { void closeHandler(); });
    }
    if (signal !== undefined) abortDisposable = addAbortListener(signal, () => { errorHandler(abortError(signal)); });
    return iterator;
  }

  async function once(emitter: unknown, name: unknown, options: unknown = {}): Promise<unknown[]> {
    validateObject(options, "options");
    const signal = signalOf(options);
    if (signal?.aborted === true) throw abortError(signal);
    return new Promise<unknown[]>((resolve, reject) => {
      const fail: (reason: unknown) => void = reject;
      const errorListener: Listener = failure => {
        invoke(emitter, "removeListener", [name, resolver]);
        if (signal !== undefined) removeListener(signal, "abort", abortListener);
        fail(failure);
      };
      const resolver: Listener = (...args) => {
        const remove = member(emitter, "removeListener");
        if (typeof remove === "function") Reflect.apply(remove, emitter, ["error", errorListener]);
        if (signal !== undefined) removeListener(signal, "abort", abortListener);
        resolve(args);
      };
      const abortListener: Listener = () => {
        removeListener(emitter, name, resolver);
        removeListener(emitter, "error", errorListener);
        fail(abortError(signal));
      };
      addListener(emitter, name, resolver, true);
      // An EventTarget has no 'error' event semantics; only emitters are watched for one.
      if (name !== "error" && typeof member(emitter, "once") === "function") invoke(emitter, "once", ["error", errorListener]);
      if (signal !== undefined) addListener(signal, "abort", abortListener, true);
    });
  }
  return { on: named(on, "on"), once: named(once, "once") };
}
