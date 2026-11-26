import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { createNodeInspector, nodeInspector } from "./node-inspector.js";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node rec-inspector.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-inspector.controls.json", import.meta.url), "utf8")), "inspector controls");
const recorded = record(control["inspector"], "inspector"), promises = record(control["promises"], "promises");

/** The recorder's own description of an object's properties and of a call's outcome. */
function shape(target: object): Record<string, unknown> {
  return Object.fromEntries(Reflect.ownKeys(target).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), value: unknown = descriptor?.value;
    return [String(key), [typeof value, typeof value === "function" ? value.name : null, typeof value === "function" ? value.length : null, descriptor?.enumerable, descriptor?.writable, descriptor?.configurable]];
  }));
}
function outcome(run: () => unknown): unknown {
  try { const value = run(); return { ok: value === undefined ? "$undefined" : value }; }
  catch (error) { if (!(error instanceof Error)) throw error; const code: unknown = Reflect.get(error, "code"); return { error: { name: error.name, code, message: error.message } }; }
}
function method(target: object, name: string): (...args: unknown[]) => unknown {
  const fn: unknown = Reflect.get(target, name);
  if (typeof fn !== "function") throw new TypeError(`no ${name}`);
  return (...args) => { const result: unknown = Reflect.apply(fn, {}, args); return result; };
}
function refused(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof VMError ? error.code : String(error); }
  return "no throw";
}

describe("node inspector builtin", () => {
  it("reports no inspector url and refuses sessions explicitly", () => {
    expect(nodeInspector.url()).toBeUndefined();
    expect(() => { nodeInspector.open(); }).toThrow(/inspector/u);
    expect(() => { Reflect.construct(nodeInspector.Session, []); }).toThrow(/inspector/u);
    expect(() => { nodeInspector.close(); }).not.toThrow();
  });

  it("has Node's exports with Node's names, lengths and property shapes", () => {
    const { module } = createNodeInspector();
    expect(Object.keys(module)).toEqual(recorded["keys"]);
    expect(shape(module)).toEqual(recorded["shape"]);
    expect(shape(module.Network)).toEqual(recorded["Network"]);
    expect(shape(module.DOMStorage)).toEqual(recorded["DOMStorage"]);
    expect(shape(module.NetworkResources)).toEqual(recorded["NetworkResources"]);
    const console = record(recorded["console"], "console");
    expect(Object.keys(module.console)).toEqual(console["keys"]);
    expect(shape(module.console)).toEqual(console["shape"]);
    const session = record(recorded["Session"], "Session");
    expect([module.Session.name, module.Session.length]).toEqual([session["name"], session["length"]]);
    expect(shape(module.Session.prototype)).toEqual(session["proto"]);
  });

  it("does nothing for protocol events after checking their parameters, as Node does with no inspector attached", () => {
    const warnings: string[] = [];
    const { module } = createNodeInspector({ emitWarning: message => { warnings.push(message); } });
    const calls = record(recorded["calls"], "calls");
    const actual: Record<string, unknown> = {
      url: outcome(() => module.url()), close: outcome(() => { module.close(); }), waitForDebugger: outcome(() => module.waitForDebugger()),
      "Network.requestWillBeSent()": outcome(() => { module.Network["requestWillBeSent"]?.(); }), "Network.requestWillBeSent({})": outcome(() => { module.Network["requestWillBeSent"]?.({ requestId: "1" }); }),
      "Network.requestWillBeSent(null)": outcome(() => { module.Network["requestWillBeSent"]?.(null); }), "Network.requestWillBeSent(1)": outcome(() => { module.Network["requestWillBeSent"]?.(1); }), "Network.requestWillBeSent([])": outcome(() => { module.Network["requestWillBeSent"]?.([]); }),
      "Network.loadingFailed('x')": outcome(() => { module.Network["loadingFailed"]?.("x"); }), "DOMStorage.domStorageItemAdded()": outcome(() => { module.DOMStorage["domStorageItemAdded"]?.(); }), "DOMStorage.registerStorage(1)": outcome(() => { module.DOMStorage["registerStorage"]?.(1); }),
      "NetworkResources.put": outcome(() => method(module.NetworkResources, "put")("u", "d")), "NetworkResources.put()": outcome(() => method(module.NetworkResources, "put")()),
    };
    expect(actual).toEqual(calls);
    // Node warns once per call that the experimental option is off.
    expect(warnings.map(message => ["Warning", message])).toEqual(control["warnings"]);
    expect(outcome(() => method(module.console, "log")("to the inspector only"))).toEqual(record(recorded["console"], "console")["call"]);
  });

  it("keeps opening an inspector and every session operation refused", () => {
    const { module, promises: promised } = createNodeInspector();
    expect(refused(() => method(module, "open")(9229))).toBe("FEATURE_NOT_AVAILABLE");
    expect(refused(() => new module.Session())).toBe("FEATURE_NOT_AVAILABLE");
    expect(refused(() => new promised.Session())).toBe("FEATURE_NOT_AVAILABLE");
    for (const name of ["connect", "connectToMainThread", "post", "disconnect"]) expect(refused(() => method(module.Session.prototype, name)()), name).toBe("FEATURE_NOT_AVAILABLE");
  });

  it("offers inspector/promises as the same module with a promise session", async () => {
    const { module, promises: promised } = createNodeInspector();
    expect(Object.keys(promised)).toEqual(promises["keys"]);
    expect(shape(promised)).toEqual(promises["shape"]);
    const same = Object.fromEntries(Object.keys(promised).map(key => [key, Reflect.get(promised, key) === Reflect.get(module, key)]));
    expect(same).toEqual(promises["same"]);
    const session = record(promises["Session"], "Session");
    expect([promised.Session.name, promised.Session.length, Object.getPrototypeOf(promised.Session) === module.Session]).toEqual([session["name"], session["length"], session["extends"]]);
    expect(shape(promised.Session.prototype)).toEqual(session["proto"]);
    // The promise form of the refusal: a rejection, never a throw.
    const pending = method(promised.Session.prototype, "post")("Runtime.enable");
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(VMError);
  });
});
