import hostProcess from "node:process";
import { deprecate, format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";
import { controls, plain, rows } from "./node-controls.test-support.ts";
import { createNodeDomain, deferNodeDomain, rejectionDomain } from "./node-domain.ts";
import { createNodeEvents } from "./node-events.ts";
import { deliverProcessException, type ExceptionOrigin } from "./node-exceptions.js";
import { createProcessExtras } from "./node-process-extras.ts";
import { NodeProcess } from "./node-process.ts";
import { createNodeStatfs } from "./node-statfs.js";
import { EventEmitter } from "./node-streams.ts";
import { installPromiseContext } from "./promise-context.js";
import { ProcessScheduler } from "./process-scheduler.js";
import { createProcessTimers } from "./process-timers.js";
import { installSchedulingContext } from "./scheduling-context.js";

const recorded = controls("node-domain.controls.json");
const prelude = String(recorded["prelude"]);
const parameters = ["require", "process", "out", "setTimeout", "setInterval", "clearInterval", "setImmediate", "queueMicrotask"];
const nativeTimeout = globalThis.setTimeout.bind(globalThis);

/** What this runtime answers where it is known to differ from the recording, and why. */
const deviations: Readonly<Record<string, { readonly why: string; readonly events: unknown }>> = {
  "immediate handle carries the domain": {
    why: "the scheduler's Immediate resource is its queued callback, not the handle a program holds, so the handle gets no `domain` property",
    events: [[false, null]],
  },
};

class Exit extends Error { constructor(readonly code: number) { super(`exit ${String(code)}`); } }
const fileSystem = { type: 1n, blockSize: 4096n, blocks: 1n, freeBlocks: 1n, availableBlocks: 1n, files: 1n, freeFiles: 1n, nameLength: 255n, fragmentSize: 4096n, flags: 0n, id: [0, 0] };

/** One fast-path process, built from the real owners: scheduler, timers, promise context, events, exceptions. */
async function run(body: string, lazy = false): Promise<{ code: number; events: unknown }> {
  const context = createAsyncContext(), restore: (() => void)[] = [], events: unknown[] = [];
  let pending = 0, ended: number | undefined, seen: unknown[] | undefined;
  const failures: unknown[] = [];
  const guard = (work: () => void): void => {
    try { work(); } catch (error) { if (error instanceof Exit) ended ??= error.code; else failures.push(error); }
  };
  const scheduler = new ProcessScheduler(context, error => { if (error instanceof Exit) ended ??= error.code; else failures.push(error); });
  const process = Object.assign(new NodeProcess(code => { throw new Exit(code); }, "24.18.1", undefined, scheduler.nextTick), { nextTick: scheduler.nextTick, env: {} });
  const extras = createProcessExtras({
    process, now: () => 0, memory: () => ({ total: 1, free: 1 }), mainModule: () => undefined, readFile: () => "", format, writeError: () => undefined,
    fatal: error => exception(error, "uncaughtException"),
  });
  Object.defineProperties(process, extras.descriptors);
  const exception = (error: unknown, origin: ExceptionOrigin, promise?: Promise<unknown>): boolean =>
    deliverProcessException(process, error, origin, () => undefined, undefined, promise, () => extras.captureCallback());
  scheduler.setExceptionHandler(error => exception(error, "uncaughtException"));
  // The worker's `unhandledrejection` and `error` events, played by the host's; the test runner's own listeners step aside.
  const rejected = (reason: unknown, promise: Promise<unknown>): void => { guard(() => { scheduler.run(() => exception(reason, "unhandledRejection", promise)); }); };
  const uncaught = (error: unknown): void => { guard(() => { scheduler.run(() => exception(error, "uncaughtException")); }); };
  const hostListeners = (["unhandledRejection", "uncaughtException"] as const).map(name => {
    const listeners = hostProcess.rawListeners(name);
    hostProcess.removeAllListeners(name);
    return { name, listeners };
  });
  hostProcess.on("unhandledRejection", rejected);
  hostProcess.on("uncaughtException", uncaught);
  try {
    restore.push(installPromiseContext(context, globalThis));
    const realm = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, queueMicrotask: globalThis.queueMicrotask };
    restore.push(installSchedulingContext(context, realm));
    const timers = createProcessTimers(globalThis, context, callback => { scheduler.enqueue(callback); });
    restore.push(() => { timers.dispose(); });
    const asyncHooks = createNodeAsyncHooks(context, { deprecate, format, inspect });
    const emitters = createNodeEvents(EventEmitter, asyncHooks, scheduler.nextTick);
    restore.push(emitters.restore);
    const deps = { events: emitters.module, createHook: (callbacks: unknown) => asyncHooks.createHook(callbacks), process, install: (reset: () => void) => { restore.push(reset); } };
    let domain: object | undefined = lazy ? deferNodeDomain(deps) : undefined;
    const statfs = createNodeStatfs({ statfs: () => fileSystem, statfsAsync: () => Promise.resolve(fileSystem) },
      { retain: () => { pending += 1; return () => { pending -= 1; }; }, dispatch: callback => { scheduler.enqueue(callback); }, context });
    const builtins: Record<string, () => unknown> = {
      domain: () => domain ??= createNodeDomain(deps), events: () => emitters.module, async_hooks: () => asyncHooks, fs: () => ({ statfs: statfs.statfs }),
    };
    const require = (name: string): unknown => { const builtin = builtins[name]; if (builtin === undefined) throw new Error(`no ${name}`); return builtin(); };
    const program: unknown = Reflect.construct(Function, [...parameters, prelude + body]);
    if (typeof program !== "function") throw new TypeError("not a program");
    const out = (value: unknown): void => { events.push(plain(value)); };
    // The recorder's own 'exit' listener, registered before the program's, is where it reads the events.
    process.on("exit", () => { seen ??= [...events]; });
    guard(() => {
      try { scheduler.run(() => { Reflect.apply(program, undefined, [require, process, out, timers.setTimeout, timers.setInterval, timers.clear, scheduler.setImmediate, realm.queueMicrotask]); }); }
      catch (error) { if (!scheduler.handleException(error)) throw error; }
    });
    const busy = (): boolean => scheduler.hasPending || timers.hasReferences || pending !== 0;
    for (let quiet = 0; ended === undefined && failures.length === 0 && quiet < 2;) {
      await new Promise<void>(resolve => { nativeTimeout(resolve, 2); });
      quiet = busy() ? 0 : quiet + 1;
    }
    if (failures.length !== 0) throw failures[0];
    if (ended === undefined) guard(() => { process.emit("beforeExit", 0); });
    // Node's 'exit' for a drained process; the recorder reads its events there.
    if (ended === undefined) guard(() => { process.emit("exit", 0); ended = 0; });
    return { code: ended ?? 0, events: seen ?? events };
  } finally {
    scheduler.dispose();
    context.resources.dispose();
    for (const reset of restore.reverse()) reset();
    hostProcess.removeListener("unhandledRejection", rejected);
    hostProcess.removeListener("uncaughtException", uncaught);
    for (const { name, listeners } of hostListeners) {
      for (const listener of listeners) if (typeof listener === "function") hostProcess.on(name, (...args: unknown[]) => { Reflect.apply(listener, hostProcess, args); });
    }
  }
}

describe("node:domain against Node.js v24.18.1", () => {
  const cases = rows(recorded["cases"]);
  it("has at least thirty recorded scenarios", () => {
    expect(recorded["node"]).toBe("v24.18.1");
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
  for (const entry of cases) {
    const name = String(entry["name"]), deviation = deviations[name];
    it(`${name}${deviation === undefined ? "" : " (known difference)"}`, async () => {
      const result = await run(String(entry["body"]));
      expect(result.code).toBe(entry["code"]);
      // An exit with code 7 emits no 'exit' in Node, so the recorder saw no events.
      if (entry["events"] !== null) expect(result.events).toEqual(deviation === undefined ? entry["events"] : deviation.events);
      if (deviation !== undefined) expect(deviation.events, deviation.why).not.toEqual(entry["events"]);
    });
  }
});

describe("node:domain in this runtime", () => {
  const body = (name: string): string => String(rows(recorded["cases"]).find(entry => entry["name"] === name)?.["body"]);

  it("answers the same through the deferred module once an export is read", async () => {
    for (const name of ["module shape", "timer error reaches the domain", "nested run and the stack", "emitter error goes to its domain"]) {
      const entry = rows(recorded["cases"]).find(candidate => candidate["name"] === name);
      expect((await run(body(name), true)).events, name).toEqual(entry?.["events"]);
    }
  });

  it("leaves the process and the shared emitter class untouched until an export is read, and restores them", async () => {
    const before = [Object.getOwnPropertyDescriptor(EventEmitter.prototype, "emit")?.value, Reflect.get(EventEmitter, "init")];
    const result = await run(`
      const EventEmitter = require('events'); const emit = EventEmitter.prototype.emit, init = EventEmitter.init, set = process.setUncaughtExceptionCaptureCallback;
      const domain = require('domain');
      out(['domain' in process, EventEmitter.usingDomains, EventEmitter.prototype.emit === emit, EventEmitter.init === init, process.setUncaughtExceptionCaptureCallback === set, 'domain' in new EventEmitter()]);
      out(['create' in domain, 'active' in domain, 'domain' in process, EventEmitter.usingDomains]);
      out(typeof domain.create);
      out([Object.keys(domain), desc(domain, 'create'), desc(domain, 'active'), 'domain' in process, EventEmitter.usingDomains, EventEmitter.prototype.emit === emit, EventEmitter.init === init]);
    `, true);
    expect(result.events).toEqual([
      [false, false, true, true, true, false],
      [true, true, false, false],
      "function",
      [["_stack", "Domain", "createDomain", "create", "active"], { e: true, c: true, w: true, get: "undefined", set: "undefined" }, { e: true, c: true, w: true, get: "undefined", set: "undefined" }, true, true, false, false],
    ]);
    expect([Object.getOwnPropertyDescriptor(EventEmitter.prototype, "emit")?.value, Reflect.get(EventEmitter, "init")]).toEqual(before);
    expect(Reflect.get(EventEmitter, "usingDomains")).toBe(false);
  });

  it("honours a promise's domain only when it is a real domain", async () => {
    expect(rejectionDomain(undefined)).toBeUndefined();
    expect(rejectionDomain(Object.assign(Promise.resolve(), { domain: { emit: () => true } }))).toBeUndefined();
    const result = await run(`
      const domain = require('domain'); const d = domain.create();
      process.on('unhandledRejection', (r) => out(['process', r.message]));
      d.on('error', (er) => out(['domain', er.message]));
      const forged = Promise.reject(new Error('forged')); forged.domain = { emit() { out('forged emit'); return true; } };
      let reject; const late = new Promise((_, r) => { reject = r; }); d.run(() => reject(new Error('rejected in a domain, created outside')));
    `);
    // The second line is the documented difference: Node records the domain active at the rejection.
    expect(result.events).toEqual([["process", "forged"], ["process", "rejected in a domain, created outside"]]);
  });
});
