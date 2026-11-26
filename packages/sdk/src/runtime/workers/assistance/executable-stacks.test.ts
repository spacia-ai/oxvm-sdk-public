import { afterEach, expect, it } from "vitest";
import { installCallSites } from "./call-sites.ts";
import type { ExecutableSources } from "./executable-sources.ts";
import { installExecutableStacks } from "./executable-stacks.ts";

/** Sources that place every frame of this test file, and every compiled guest URL, at one original position. */
function sourcesAt(path: string, line: number, column: number): ExecutableSources {
  const sources: unknown = {
    find: (url: string) => url.includes("executable-stacks.test") || url.startsWith("oxidevm:compiled/")
      ? { path, role: "module", origin: { originalSource: path, generatedLine: 0, generatedColumn: 0, originalLine: line - 1, originalColumn: column - 1 } } : undefined,
  };
  if (!isSources(sources)) throw new TypeError("Invalid sources");
  return sources;
}
function isSources(value: unknown): value is ExecutableSources { return typeof value === "object" && value !== null && "find" in value; }

function call(site: unknown, name: string): unknown {
  const fn: unknown = typeof site === "object" && site !== null ? Reflect.get(site, name) : undefined;
  if (typeof fn !== "function") throw new TypeError(`Missing call-site method ${name}`);
  const result: unknown = Reflect.apply(fn, site, []);
  return result;
}
function frames(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`No structured frames: ${String(value)}`);
  const list: readonly unknown[] = value;
  return list;
}

const restore: (() => void)[] = [];
afterEach(() => { for (const reset of restore.splice(0).reverse()) reset(); });

it("hands a program's stack formatter call sites that name the program's own files", () => {
  // The `resolve` package's caller(): install a formatter, read `new Error().stack`, ask a frame for its file.
  const stacks = installExecutableStacks(sourcesAt("/workspace/app/main.js", 5, 3), globalThis);
  restore.push(stacks.restore);
  const original: unknown = Reflect.get(Error, "prepareStackTrace");
  Error.prepareStackTrace = (_error, sites) => sites;
  const stack = frames(new Error("probe").stack);
  Reflect.set(Error, "prepareStackTrace", original);
  const top = stack[0];
  expect([call(top, "getFileName"), call(top, "getScriptNameOrSourceURL"), call(top, "getLineNumber"), call(top, "getColumnNumber")]).toEqual(["/workspace/app/main.js", "/workspace/app/main.js", 5, 3]);
  // A module's frame is not an eval frame, though the engine evaluated its text.
  expect([call(top, "isEval"), call(top, "getEvalOrigin")]).toEqual([false, undefined]);
  expect(String(call(top, "toString"))).toContain("/workspace/app/main.js:5:3");
  // What the engine alone knows still comes from the engine.
  expect(typeof call(top, "isConstructor")).toBe("boolean");
  expect(typeof call(top, "isNative")).toBe("boolean");
  // A frame outside the program keeps the engine's own answers.
  const outside = stack.find(site => !String(call(site, "getFileName")).startsWith("/workspace/"));
  expect(outside === undefined || call(outside, "getLineNumber") !== 5 || call(outside, "getFileName") !== "/workspace/app/main.js").toBe(true);
});

it("goes back to its own formatting when the program puts back what it read", () => {
  const stacks = installExecutableStacks(sourcesAt("/workspace/app/main.js", 5, 3), globalThis);
  restore.push(stacks.restore);
  const original: unknown = Reflect.get(Error, "prepareStackTrace");
  const custom = (): string => "custom";
  Error.prepareStackTrace = custom;
  expect(new Error("one").stack).toBe("custom");
  expect(stacks.program()).toBeTypeOf("function");
  // Reading back and assigning the value read keeps the same program formatter.
  Reflect.set(Error, "prepareStackTrace", Reflect.get(Error, "prepareStackTrace"));
  expect(new Error("two").stack).toBe("custom");
  Reflect.set(Error, "prepareStackTrace", original);
  expect(stacks.program()).toBeUndefined();
  const text = new Error("three").stack;
  expect(text).toMatch(/^Error: three\n {4}at /u);
  expect(text).toContain("/workspace/app/main.js:5:3");
  for (const value of [undefined, null, 1]) { Reflect.set(Error, "prepareStackTrace", value); expect(new Error("four").stack).toMatch(/^Error: four\n/u); }
});

it("restores the realm's own property", () => {
  const before = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  installExecutableStacks(sourcesAt("/workspace/app/main.js", 1, 1), globalThis).restore();
  expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")).toEqual(before);
});

it("serves a program's formatter from `stack` in a realm whose engine never calls one", () => {
  // SpiderMonkey: `stack` is an accessor on Error.prototype that answers with text.
  const text = [
    "caller@oxidevm:compiled/5/%2Fworkspace%2Fnode_modules%2Fresolve%2Flib%2Fcaller.js:9:21",
    "resolveSync@oxidevm:compiled/14/%2Fworkspace%2Fnode_modules%2Fresolve%2Flib%2Fsync.js:93:48",
    "@oxidevm:compiled/1/%2Fworkspace%2Frun.cjs:41:21",
    "load@http://localhost:1/assets/process.worker.js:614:14057",
    "",
  ].join("\n");
  class ForeignError { message = "probe"; name = "Error"; static stackTraceLimit = 10; toString(): string { return `${this.name}: ${this.message}`; } }
  // As in SpiderMonkey, assigning `stack` gives the error its own property.
  Object.defineProperty(ForeignError.prototype, "stack", { configurable: true, enumerable: false, get: () => text,
    set(this: object, value: unknown) { Object.defineProperty(this, "stack", { configurable: true, writable: true, enumerable: false, value }); } });
  const realm = { Error: ForeignError };
  const stacks = installExecutableStacks(sourcesAt("/workspace/run.cjs", 7, 2), realm);
  const sites = installCallSites(realm);
  try {
    // With no program formatter the stack reads as Node's does, naming the program's files.
    expect(Reflect.get(new ForeignError(), "stack")).toBe([
      "Error: probe", "    at caller (/workspace/run.cjs:7:2)", "    at resolveSync (/workspace/run.cjs:7:2)", "    at /workspace/run.cjs:7:2",
      "    at load (http://localhost:1/assets/process.worker.js:614:14057)",
    ].join("\n"));
    Reflect.set(ForeignError, "prepareStackTrace", (_error: unknown, list: unknown) => list);
    const error = new ForeignError();
    const stack = frames(Reflect.get(error, "stack"));
    expect(stack).toHaveLength(4);
    expect([call(stack[2], "getFileName"), call(stack[2], "getLineNumber"), call(stack[2], "getColumnNumber")]).toEqual(["/workspace/run.cjs", 7, 2]);
    expect(call(stack[1], "getFunctionName")).toBe("resolveSync");
    expect(call(stack[3], "getFileName")).toBe("http://localhost:1/assets/process.worker.js");
    // The engine formats once; so does this.
    expect(Reflect.get(error, "stack")).toBe(stack);
    Reflect.set(ForeignError, "stackTraceLimit", 2);
    expect(frames(Reflect.get(new ForeignError(), "stack"))).toHaveLength(2);
    // captureStackTrace reads the engine's text itself and calls the formatter once (the `depd` package's way).
    const target = {};
    const capture: unknown = Reflect.get(ForeignError, "captureStackTrace");
    if (typeof capture !== "function") throw new TypeError("captureStackTrace was not installed");
    Reflect.set(ForeignError, "stackTraceLimit", 10);
    Reflect.apply(capture, ForeignError, [target]);
    const capturedSites = frames(Reflect.get(target, "stack"));
    expect(capturedSites.length).toBeGreaterThan(1);
    expect(call(capturedSites[1], "getFileName")).toBe("/workspace/run.cjs");
    // A program may still assign its own stack.
    const assigned = new ForeignError();
    Reflect.set(assigned, "stack", "mine");
    expect(Reflect.get(assigned, "stack")).toBe("mine");
  } finally { sites(); stacks.restore(); }
  expect(Object.getOwnPropertyDescriptor(ForeignError.prototype, "stack")?.get?.call(new ForeignError())).toBe(text);
});
