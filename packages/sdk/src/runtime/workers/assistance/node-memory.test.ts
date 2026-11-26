import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { createAsyncContext } from "./async-context.js";
import { installPromiseContext } from "./promise-context.js";
import { createNodeV8, nodeV8Memory } from "./node-memory.ts";
import { nodeSqlite } from "./node-sqlite.ts";

// Recorded from the real binary by the script embedded in node-inspector.controls.json (docker run --rm node:24.18.1-alpine node rec-inspector.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-memory.controls.json", import.meta.url), "utf8")), "v8 controls");
const v8 = record(control["v8"], "v8"), sqlite = record(control["sqlite"], "sqlite");

/** The recorder's own description of an object's properties and of a call's outcome. */
function shape(target: object): Record<string, unknown> {
  return Object.fromEntries(Reflect.ownKeys(target).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), value: unknown = descriptor?.value;
    return [String(key), [typeof value, typeof value === "function" ? value.name : null, typeof value === "function" ? value.length : null, descriptor?.enumerable, descriptor?.writable, descriptor?.configurable]];
  }));
}
function outcome(run: () => unknown): unknown {
  try { const value = run(); return { ok: value === undefined ? "$undefined" : typeof value === "function" ? "function" : value }; }
  catch (error) { if (!(error instanceof Error)) throw error; const code: unknown = Reflect.get(error, "code"); return { error: { name: error.name, code, message: error.message } }; }
}
function refusal(run: () => unknown): unknown {
  try { run(); } catch (error) { return error instanceof VMError ? [error.code, error.detail?.["api"]] : error; }
  return "no throw";
}
function method(target: unknown, name: string): (...args: unknown[]) => unknown {
  const fn: unknown = Reflect.get(Object(target), name);
  if (typeof fn !== "function") throw new TypeError(`no ${name}`);
  return (...args) => { const result: unknown = Reflect.apply(fn, target, args); return result; };
}
const turn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

describe("node v8 builtin: what Node.js v24.18.1 answers outside a snapshot build and without coverage", () => {
  it("has every export of Node's module", () => {
    const names: unknown = v8["keys"];
    if (!Array.isArray(names)) throw new TypeError("no keys");
    expect(names.map(String).filter(name => !Object.keys(nodeV8Memory).includes(name))).toEqual([]);
    const others = record(v8["others"], "others");
    for (const name of ["getCppHeapStatistics", "queryObjects", "GCProfiler", "startCpuProfile"]) {
      const value: unknown = Reflect.get(nodeV8Memory, name);
      expect(typeof value === "function" ? [typeof value, value.name, value.length] : undefined, name).toEqual(others[name]);
    }
  });

  it("answers the startup snapshot API as a process that builds none", () => {
    const snapshot = nodeV8Memory.startupSnapshot, recorded = record(v8["startupSnapshot"], "startupSnapshot");
    expect(Object.keys(snapshot)).toEqual(recorded["keys"]);
    expect(shape(snapshot)).toEqual(recorded["shape"]);
    expect(outcome(() => snapshot.isBuildingSnapshot())).toEqual(recorded["isBuildingSnapshot"]);
    for (const name of ["addSerializeCallback", "addDeserializeCallback", "setDeserializeMainFunction"]) expect(outcome(() => method(snapshot, name)(() => undefined)), name).toEqual(recorded[name]);
    expect(outcome(() => method(snapshot, "addSerializeCallback")(1))).toEqual(recorded["addSerializeCallbackBad"]);
    expect(outcome(() => method(snapshot, "setDeserializeMainFunction")())).toEqual(recorded["setDeserializeMainFunctionBad"]);
  });

  it("has no coverage to take or stop", () => {
    const recorded = record(v8["coverage"], "coverage");
    expect(outcome(() => { nodeV8Memory.takeCoverage(); })).toEqual(recorded["take"]);
    expect(outcome(() => { nodeV8Memory.stopCoverage(); })).toEqual(recorded["stop"]);
    expect([[nodeV8Memory.takeCoverage.name, nodeV8Memory.takeCoverage.length], [nodeV8Memory.stopCoverage.name, nodeV8Memory.stopCoverage.length]]).toEqual(recorded["shapes"]);
  });

  it("refuses the heap queries and profilers a browser cannot serve", () => {
    expect(refusal(() => method(nodeV8Memory, "getCppHeapStatistics")())).toEqual(["FEATURE_NOT_AVAILABLE", "v8.getCppHeapStatistics"]);
    expect(refusal(() => method(nodeV8Memory, "queryObjects")(Object))).toEqual(["FEATURE_NOT_AVAILABLE", "v8.queryObjects"]);
    expect(refusal(() => method(nodeV8Memory, "startCpuProfile")())).toEqual(["FEATURE_NOT_AVAILABLE", "v8.startCpuProfile"]);
    expect(refusal(() => Reflect.construct(nodeV8Memory.GCProfiler, []))).toEqual(["FEATURE_NOT_AVAILABLE", "v8.GCProfiler"]);
    // Without the process's promise lifecycle there is nothing to hook.
    expect(refusal(() => method(nodeV8Memory.promiseHooks, "onInit")(() => undefined))).toEqual(["FEATURE_NOT_AVAILABLE", "v8.promiseHooks.onInit"]);
  });
});

describe("v8.promiseHooks on the process's promise lifecycle", () => {
  function hooked() {
    const context = createAsyncContext(), restore = installPromiseContext(context, globalThis);
    return { hooks: createNodeV8({ promises: context.resources }).promiseHooks, dispose: (): void => { restore(); context.resources.dispose(); } };
  }
  const recorded = record(v8["promiseHooks"], "promiseHooks");

  it("has Node's functions and validates hooks as Node does", () => {
    const { hooks, dispose } = hooked();
    try {
      expect(Object.keys(hooks)).toEqual(recorded["keys"]);
      expect(shape(hooks)).toEqual(recorded["shape"]);
      const errors = record(recorded["errors"], "errors");
      const actual: Record<string, unknown> = {
        "createHook()": outcome(() => hooks.createHook()), "createHook({})": outcome(() => typeof hooks.createHook({})), "createHook({init:1})": outcome(() => hooks.createHook({ init: 1 })),
        "onInit(1)": outcome(() => hooks.onInit(1)), "onInit()": outcome(() => method(hooks, "onInit")()), "onSettled('x')": outcome(() => hooks.onSettled("x")), "onBefore(null)": outcome(() => hooks.onBefore(null)), "onAfter({})": outcome(() => hooks.onAfter({})),
        "onInit(fn)": outcome(() => { const stop = hooks.onInit(() => undefined); const type = typeof stop; stop(); return type; }),
        "createHook({before:async})": outcome(() => hooks.createHook({ before: async function before(): Promise<void> { await Promise.resolve(); } })),
      };
      // Node's message for a null argument quotes its own source expression.
      const { "createHook(null)": destructure, ...comparable } = errors;
      expect(actual).toEqual(comparable);
      expect(record(record(destructure, "createHook(null)")["error"], "error")["name"]).toBe("TypeError");
      expect(() => hooks.createHook(null)).toThrow(TypeError);
    } finally { dispose(); }
  });

  it("reports init with its parent, the reaction's before and after, and each settlement", async () => {
    const { hooks, dispose } = hooked();
    try {
      const log: string[] = [];
      const stop = hooks.createHook({ init: (_promise: unknown, parent: unknown) => { log.push(parent === undefined ? "init" : "init+parent"); }, before: () => { log.push("before"); }, after: () => { log.push("after"); }, settled: () => { log.push("settled"); } });
      const first = Promise.withResolvers<undefined>();
      const chained = first.promise.then(() => { log.push("reaction"); });
      log.push("sync done");
      first.resolve(undefined);
      await turn();
      stop();
      // Node's own sequence for the same chain starts ["init", "init+parent", "sync done", "settled", …, "before", "reaction", "settled", "after"]:
      // here the reaction's promise settles after its `after`.
      const node: unknown = recorded["chain"];
      if (!Array.isArray(node)) throw new TypeError("no chain");
      expect(node.slice(0, 4)).toEqual(log.slice(0, 4));
      expect(log.filter(entry => entry !== "init" && entry !== "init+parent").slice(0, 6)).toEqual(["sync done", "settled", "before", "reaction", "after", "settled"]);
      const count = log.length;
      void chained.then(() => undefined);
      await turn();
      expect(log.length).toBe(count);
      expect(recorded["stopped"]).toBe(true);
    } finally { dispose(); }
  });

  it("runs the hooks of one kind in the order they were installed until each is stopped", () => {
    const { hooks, dispose } = hooked();
    try {
      const log: string[] = [];
      const stopFirst = hooks.onInit(() => { log.push("init 1"); }), stopSecond = hooks.onInit(() => { log.push("init 2"); }), stopSettled = hooks.onSettled(() => { log.push("settled"); });
      void Promise.resolve(5);
      stopFirst();
      void new Promise(() => undefined);
      stopSecond(); stopSettled();
      void new Promise<void>(resolve => { resolve(); });
      expect(log).toEqual(recorded["order"]);
    } finally { dispose(); }
  });
});

describe("node:sqlite: Node's exports with no database behind them", () => {
  it("has Node's exports, constants and constructor guards", () => {
    expect(Object.keys(nodeSqlite)).toEqual(sqlite["keys"]);
    expect(shape(nodeSqlite)).toEqual(sqlite["shape"]);
    expect(nodeSqlite.constants).toEqual(sqlite["constants"]);
    expect(Object.isFrozen(nodeSqlite.constants)).toBe(sqlite["constantsFrozen"]);
    const classes = record(sqlite["classes"], "classes");
    for (const name of ["StatementSync", "Session"] as const) {
      const recorded = record(classes[name], name), Class = nodeSqlite[name];
      expect([Class.name, Class.length]).toEqual([recorded["name"], recorded["length"]]);
      expect(outcome(() => Reflect.construct(Class, [])), name).toEqual(recorded["construct"]);
      expect(outcome(() => Class()), name).toEqual(recorded["call"]);
    }
    const backup = record(sqlite["backup"], "backup");
    expect([nodeSqlite.backup.name, nodeSqlite.backup.length]).toEqual([backup["name"], backup["length"]]);
    expect(outcome(() => nodeSqlite.backup())).toEqual(backup["noArgs"]);
  });

  it("refuses to open or back up a database", () => {
    expect(refusal(() => Reflect.construct(nodeSqlite.DatabaseSync, [":memory:"]))).toEqual(["FEATURE_NOT_AVAILABLE", "sqlite.DatabaseSync"]);
    expect(refusal(() => nodeSqlite.backup({}, "/tmp/copy.db"))).toEqual(["FEATURE_NOT_AVAILABLE", "sqlite.backup"]);
  });
});
