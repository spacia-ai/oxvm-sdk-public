import { deprecate, format, inspect } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { EventEmitter } from "./node-streams.js";
import { createNodeEvents } from "./node-events.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";

describe("node events builtin", () => {
  it("is the EventEmitter class with Node's listener inspection statics", () => {
    const { module: events, restore } = createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect }));
    onTestFinished(restore);
    // The module is the class behind a constructor that reads Node's options: same prototype, same statics.
    expect(events.prototype).toBe(EventEmitter.prototype);
    expect(events.EventEmitter).toBe(events);
    expect(new events()).toBeInstanceOf(EventEmitter);
    expect(new EventEmitter()).toBeInstanceOf(events);
    expect(new events().constructor).toBe(events);
    expect(createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect })).module).toBe(events);
    expect([events.name, typeof events]).toEqual(["EventEmitter", "function"]);
    expect(Object.keys(events)).toContain("EventEmitterAsyncResource");
    expect(Object.keys(events)).toContain("getEventListeners");
    const emitter = new EventEmitter();
    const listener = (): void => undefined;
    emitter.on("data", listener);
    expect(events.getEventListeners(emitter, "data")).toEqual([listener]);
    const defaultLimit: unknown = Reflect.get(EventEmitter, "defaultMaxListeners");
    expect(events.getMaxListeners(emitter)).toBe(defaultLimit);
    events.setMaxListeners(1500, emitter);
    expect(events.getMaxListeners(emitter)).toBe(1500);
    const signal = new AbortController().signal;
    signal.addEventListener("abort", listener);
    // Platform event targets do not expose their listeners; Node's limit is a warning threshold only, kept per target.
    expect(events.getEventListeners(signal, "abort")).toEqual([]);
    expect(events.getMaxListeners(signal)).toBe(0);
    expect(events.getMaxListeners(new EventTarget())).toBe(defaultLimit);
    expect(() => { events.setMaxListeners(1500, signal); }).not.toThrow();
    expect(events.getMaxListeners(signal)).toBe(1500);
  });
});

// Every expectation below was recorded from `require("events")` of the real binary: docker run --rm node:24.18.1-alpine node.
function builtin() {
  const events = createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect }), callback => { process.nextTick(callback); });
  onTestFinished(events.restore);
  return events.module;
}
const turn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
const message = (value: unknown): unknown => value instanceof Error ? value.message : value;
function thrown(callback: () => unknown): unknown {
  try { callback(); } catch (error) { return error instanceof Error ? [error.name, Reflect.get(error, "code"), error.message] : error; }
  return "no throw";
}
function rejected(text: string): Promise<never> {
  return Promise.reject(new Error(text));
}
/** A listener whose answer the emitter may inspect; the emitter's own listener type answers nothing. */
function answering(listener: (...args: unknown[]) => unknown): (...args: unknown[]) => void {
  return listener;
}
/** A rejection nothing captures, kept from reaching the test runner. */
function ignored(text: string): Promise<never> {
  const promise = rejected(text);
  promise.catch(() => undefined);
  return promise;
}

describe("node events statics added in Node 12-13", () => {
  it("exposes them on the module, which is the class, with Node's property shapes", () => {
    const events = builtin();
    const shape = (name: string): unknown[] => {
      const found = Object.getOwnPropertyDescriptor(EventEmitter, name);
      return [typeof found?.value, typeof found?.get, typeof found?.set, found?.enumerable];
    };
    expect(shape("errorMonitor")).toEqual(["symbol", "undefined", "undefined", true]);
    expect(shape("captureRejectionSymbol")).toEqual(["symbol", "undefined", "undefined", true]);
    expect(shape("usingDomains")).toEqual(["boolean", "undefined", "undefined", true]);
    expect(shape("captureRejections")).toEqual(["undefined", "function", "function", true]);
    expect(Object.keys(events)).toEqual(expect.arrayContaining(["errorMonitor", "captureRejectionSymbol", "captureRejections", "usingDomains"]));
    expect([events.errorMonitor.description, Symbol.keyFor(events.errorMonitor)]).toEqual(["events.errorMonitor", undefined]);
    expect(events.captureRejectionSymbol).toBe(Symbol.for("nodejs.rejection"));
    expect([events.usingDomains, events.captureRejections]).toEqual([false, false]);
    expect(Reflect.get(events.EventEmitter, "errorMonitor")).toBe(events.errorMonitor);
    expect(builtin().errorMonitor).toBe(events.errorMonitor);
    expect([EventEmitter.prototype.emit.name, EventEmitter.prototype.emit.length]).toEqual(["emit", 1]);
  });

  it("shows an error to errorMonitor listeners first without handling it", () => {
    const events = builtin();
    const emitter = new events(), seen: unknown[] = [], boom = new Error("boom");
    emitter.on(events.errorMonitor, (...args) => seen.push(["monitor", ...args.map(message)]));
    let caught: unknown;
    try { emitter.emit("error", boom, "extra"); } catch (error) { caught = error; }
    expect(caught).toBe(boom);
    expect(seen).toEqual([["monitor", "boom", "extra"]]);
    emitter.on("error", (...args) => seen.push(["error", ...args.map(message)]));
    expect(emitter.emit("error", boom, 2)).toBe(true);
    expect(seen).toEqual([["monitor", "boom", "extra"], ["monitor", "boom", 2], ["error", "boom", 2]]);
    expect(emitter.listenerCount(events.errorMonitor)).toBe(1);
  });

  it("treats errorMonitor as an ordinary event for once, direct emits and throwing listeners", () => {
    const events = builtin();
    const once = new events();
    let calls = 0;
    once.once(events.errorMonitor, () => { calls++; });
    once.on("error", () => undefined);
    once.emit("error", new Error("a"));
    once.emit("error", new Error("b"));
    expect(calls).toBe(1);
    const direct = new events(), order: unknown[] = [];
    direct.on(events.errorMonitor, value => order.push(value));
    expect(direct.emit(events.errorMonitor, 1)).toBe(true);
    expect(() => direct.emit("error", "str")).toThrow();
    expect(order).toEqual([1, "str"]);
    const throwing = new events();
    throwing.on(events.errorMonitor, () => { throw new Error("from monitor"); });
    throwing.on("error", () => order.push("unreached"));
    expect(() => throwing.emit("error", new Error("orig"))).toThrow("from monitor");
    expect(order).toEqual([1, "str"]);
    // An emitter built by a class that never saw the builtin, such as a stream, is monitored too.
    const plain = new EventEmitter(), plainSeen: unknown[] = [];
    plain.on(events.errorMonitor, error => plainSeen.push(message(error)));
    expect(() => plain.emit("error", new Error("plain"))).toThrow("plain");
    expect(plainSeen).toEqual(["plain"]);
  });

  it("validates the captureRejections switch and constructor option as Node does", () => {
    const events = builtin();
    const property = (name: string, received: string): unknown[] => ["TypeError", "ERR_INVALID_ARG_TYPE", `The "${name}" property must be of type boolean. Received ${received}`];
    const cases: [unknown, string][] = [[1, "type number (1)"], ["x", "type string ('x')"], [null, "null"], [undefined, "undefined"], [{}, "an instance of Object"]];
    for (const [value, received] of cases) {
      expect(thrown(() => Reflect.set(events, "captureRejections", value))).toEqual(property("EventEmitter.captureRejections", received));
    }
    expect(events.captureRejections).toBe(false);
    // Node validates the option only when it is truthy.
    expect(thrown(() => new events({ captureRejections: 1 }))).toEqual(property("options.captureRejections", "type number (1)"));
    expect(thrown(() => new events({ captureRejections: "x" }))).toEqual(property("options.captureRejections", "type string ('x')"));
    expect(thrown(() => new events({ captureRejections: {} }))).toEqual(property("options.captureRejections", "an instance of Object"));
    for (const value of [null, 0, "", false, true, undefined]) expect(thrown(() => new events({ captureRejections: value }))).toBe("no throw");
    for (const options of [null, 5, "s", undefined]) expect(thrown(() => new events(options))).toBe("no throw");
  });

  it("routes a captured rejection to 'error' one tick after the rejection is observed", async () => {
    const events = builtin();
    const emitter = new events({ captureRejections: true }), seen: unknown[] = [];
    emitter.on("x", answering((a, b) => rejected(`rej ${String(a)}${String(b)}`)));
    emitter.on("error", (...args) => seen.push(["error", args.length, message(args[0])]));
    expect(emitter.emit("x", 1, 2)).toBe(true);
    expect(seen).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
    await turn();
    expect(seen).toEqual([["error", 1, "rej 12"]]);
  });

  it("prefers the emitter's nodejs.rejection handler and passes the event and its arguments", async () => {
    const events = builtin();
    const emitter = new events({ captureRejections: true }), got: unknown[] = [];
    Reflect.set(emitter, Symbol.for("nodejs.rejection"), function (this: unknown, error: unknown, name: unknown, ...args: unknown[]) { got.push([this === emitter, message(error), name, args]); });
    emitter.on("error", () => got.push("error listener"));
    emitter.on("y", answering(() => rejected("r1")));
    emitter.on("y", answering(() => rejected("r2")));
    emitter.on("y", () => ({ then(_: unknown, reject: (error: Error) => void) { reject(new Error("thenable")); } }));
    emitter.on("y", () => 5);
    emitter.on("y", answering(() => Promise.resolve(1)));
    emitter.emit("y", "a", "b");
    await turn();
    expect(got).toEqual([[true, "thenable", "y", ["a", "b"]], [true, "r1", "y", ["a", "b"]], [true, "r2", "y", ["a", "b"]]]);
  });

  it("leaves rejections alone unless the emitter captures them", async () => {
    const events = builtin();
    const seen: unknown[] = [];
    for (const emitter of [new events(), new events({ captureRejections: false }), new EventEmitter()]) {
      emitter.on("z", answering(() => ignored("not captured")));
      emitter.on("error", () => seen.push("error"));
      expect(emitter.emit("z")).toBe(true);
    }
    await turn();
    expect(seen).toEqual([]);
  });

  it("does not capture the rejection of an 'error' listener it is routing to", async () => {
    const events = builtin();
    const emitter = new events({ captureRejections: true });
    let calls = 0;
    emitter.on("error", answering(() => { calls++; return ignored("again"); }));
    emitter.on("w", answering(() => rejected("first")));
    emitter.emit("w");
    await turn();
    await turn();
    expect(calls).toBe(1);
    // Capture is back on afterwards.
    emitter.emit("w");
    await turn();
    expect(calls).toBe(2);
  });

  it("gives each emitter the module default it was constructed under", async () => {
    const events = builtin();
    events.captureRejections = true;
    expect([events.captureRejections, Reflect.get(events.EventEmitter, "captureRejections")]).toEqual([true, true]);
    // A plain subclass of the shared class, as a stream is, follows the default as well.
    const during = new events(), stream = new EventEmitter(), falsy = new events({ captureRejections: false });
    events.captureRejections = false;
    const after = new events(), seen: unknown[] = [];
    for (const [name, emitter] of [["during", during], ["stream", stream], ["falsy", falsy]] as const) {
      emitter.on("error", error => seen.push(`${name}:${String(message(error))}`));
      emitter.on("q", answering(() => rejected("captured")));
      emitter.emit("q");
    }
    after.on("error", () => seen.push("after"));
    after.on("q", answering(() => ignored("not captured")));
    after.emit("q");
    await turn();
    expect(seen).toEqual(["during:captured", "stream:captured", "falsy:captured"]);
  });

  it("captures for subclasses, once listeners, symbol events and the legacy call form", async () => {
    const events = builtin();
    const seen: unknown[] = [];
    class Sub extends events {
      constructor() { super({ captureRejections: true }); }
      [Symbol.for("nodejs.rejection")](error: unknown, name: unknown, ...args: unknown[]): void { seen.push(["sub", message(error), String(name), args]); }
    }
    const sub = new Sub(), event = Symbol("ev");
    sub.once(event, answering(value => rejected(`once ${String(value)}`)));
    sub.emit(event, 9);
    await turn();
    expect(seen).toEqual([["sub", "once 9", "Symbol(ev)", [9]]]);
    expect(sub).toBeInstanceOf(EventEmitter);
    // A `then` getter that throws is reported as 'error' at once.
    const getter = new events({ captureRejections: true });
    getter.on("error", error => seen.push(`then-getter:${String(message(error))}`));
    getter.on("k", () => ({ get then(): never { throw new Error("getter"); } }));
    expect(getter.emit("k")).toBe(true);
    expect(seen.at(-1)).toBe("then-getter:getter");
    const legacy: unknown = Reflect.apply(events, Object.create(EventEmitter.prototype), [{ captureRejections: true }]);
    expect(legacy).toBeUndefined();
    function Old(this: InstanceType<typeof EventEmitter>): void { Reflect.apply(events, this, [{ captureRejections: true }]); }
    Object.setPrototypeOf(Old.prototype, EventEmitter.prototype);
    const old: unknown = Reflect.construct(Old, []);
    if (!(old instanceof EventEmitter)) throw new Error("not an emitter");
    old.on("error", error => seen.push(`legacy:${String(message(error))}`));
    old.on("k", answering(() => rejected("call form")));
    old.emit("k");
    await turn();
    expect(seen.at(-1)).toBe("legacy:call form");
  });

  it("throws a captured rejection as an unhandled 'error' when nothing listens", async () => {
    const events = builtin();
    const ticks: (() => void)[] = [];
    const manual = createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect }), callback => { ticks.push(callback); });
    onTestFinished(manual.restore);
    const emitter = new events({ captureRejections: true });
    emitter.on("k", answering(() => rejected("nolistener")));
    emitter.emit("k");
    await turn();
    expect(ticks).toHaveLength(1);
    expect(() => { ticks[0]?.(); }).toThrow("nolistener");
  });

  it("returns the module default to off when the process is restored", () => {
    const first = createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect }));
    first.module.captureRejections = true;
    first.restore();
    expect(builtin().captureRejections).toBe(false);
  });
});
