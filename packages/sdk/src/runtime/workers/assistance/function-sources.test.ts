import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler, type AssistanceCompiler } from "./compiler.js";
import { FunctionSources, installFunctionSources } from "./function-sources.js";
import { createLocalModuleLoader } from "./module-loader.js";

let compiler: AssistanceCompiler | undefined, system = "";
beforeAll(async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
});
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

async function load(source: string): Promise<Record<string, unknown>> {
  if (compiler === undefined) throw new Error("Compiler is not initialized");
  const loader = createLocalModuleLoader(compiler, system, { resolve: path => path, read: () => ({ format: "module", source }) });
  restore = installFunctionSources(globalThis, loader.functionSources);
  const namespace: unknown = await loader.import("/workspace/eval.mjs");
  if (typeof namespace !== "object" || namespace === null) throw new Error("Module has no namespace");
  return Object.fromEntries(Object.entries(namespace));
}
const text = (value: unknown): string => Function.prototype.toString.call(value);
const member = (owner: unknown, name: string): unknown => {
  if ((typeof owner !== "object" && typeof owner !== "function") || owner === null) throw new Error("No owner");
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  const getter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, "get"), value: unknown = descriptor?.value;
  return getter ?? value;
};

it("reports a module function's own source text, whatever the lowering did to it", async () => {
  const functions = {
    plain: "function plain(specifier) {\n  // keeps comments\n  if (import.meta.resolve) return new URL(import.meta.resolve(specifier));\n  return new URL(specifier, import.meta.url);\n}",
    declared: "async function declared(a) { await a; return import('./x.js'); }",
    named: "async function inner(a)  {  await a;  }",
    arrow: "async (a) => { await a; }",
    short: "a => a +  1",
    awaited: "async a => await a",
    generator: "async function* generator() { yield 1; }",
    strict: "function strict() { 'use strict'; return this; }",
    defaulted: "function defaulted(a = () => { return 1; }) { return a; }",
  };
  const klass = "class Shape extends Object {\n  static async make() { return new Shape(); }\n  async area() { await 0; return 1; }\n  get name() { return 'shape'; }\n  *[Symbol.iterator]() { yield 1; }\n}";
  const record = "{ async method() { await 1; }, get value() { return 1; }, plain() { return 2; } }";
  const namespace = await load([
    `export ${functions.plain}`, `export ${functions.declared}`, `export const named = ${functions.named};`, `export const arrow = ${functions.arrow};`,
    `export const short = ${functions.short};`, `export const awaited = ${functions.awaited};`, `export ${functions.generator}`, `export ${functions.strict}`,
    `export ${functions.defaulted}`, `export ${klass}`, `export const record = ${record};`,
  ].join("\n"));
  for (const [name, source] of Object.entries(functions)) expect(text(namespace[name]), name).toBe(source);
  const Shape = namespace["Shape"], prototype = member(Shape, "prototype");
  expect(text(Shape)).toBe(klass);
  expect(text(member(Shape, "make"))).toBe("async make() { return new Shape(); }");
  expect(text(member(prototype, "area"))).toBe("async area() { await 0; return 1; }");
  expect(text(member(prototype, "name"))).toBe("get name() { return 'shape'; }");
  expect(text(member(prototype, "constructor"))).toBe(klass);
  expect(text(member(namespace["record"], "method"))).toBe("async method() { await 1; }");
  expect(text(member(namespace["record"], "value"))).toBe("get value() { return 1; }");
  expect(text(member(namespace["record"], "plain"))).toBe("plain() { return 2; }");
});

it("keeps the functions working: strictness, defaults, results and the native async prototype", async () => {
  const namespace = await load([
    "export function strict() { 'use strict'; return this; }",
    "export const short = a => a + 1;",
    "export const object = () => ({ a: 1 });",
    "export const awaited = async a => await a;",
    "export class Counter { static count = Counter.name.length; async next() { return ++Counter.count; } }",
    "export const AsyncFunction = (async function () {}).constructor === (async () => {}).constructor;",
    "export const empty = async function () {};",
  ].join("\n"));
  const call = (name: string, ...args: unknown[]): unknown => { const value = namespace[name]; if (typeof value !== "function") throw new Error(name); return Reflect.apply(value, undefined, args); };
  expect(call("strict")).toBeUndefined();
  expect(call("short", 2)).toBe(3);
  expect(call("object")).toEqual({ a: 1 });
  await expect(call("awaited", Promise.resolve(7))).resolves.toBe(7);
  expect(member(namespace["Counter"], "count")).toBe(7);
  expect(namespace["AsyncFunction"]).toBe(true);
  expect(text(namespace["empty"]).replace(/\s+/gu, "")).toBe("asyncfunction(){}");
});

it("looks like the intrinsic and leaves other functions alone", async () => {
  await load("export const x = 1;");
  const replaced: unknown = Reflect.get(Function.prototype, "toString");
  expect([Reflect.get(Object(replaced), "name"), Reflect.get(Object(replaced), "length")]).toEqual(["toString", 0]);
  expect(text(replaced)).toBe("function toString() { [native code] }");
  expect(text(Math.max)).toBe("function max() { [native code] }");
  expect(() => text({})).toThrow(TypeError);
  const local = function local() { return "oxidevm:source:zz:0:5"; };
  expect(text(local)).toContain("oxidevm:source:zz:0:5");
});

it("serves only registered text, in bounds, and stops registering past its budget", () => {
  const sources = new FunctionSources(64);
  const marker = sources.register("function a() { return 1; } function b() {}");
  expect(marker).toBe("oxidevm:source:1:");
  expect(sources.text(`function a() { "${marker ?? ""}0:26"; return 1; }`)).toBe("function a() { return 1; }");
  // The widest marker is the function's own; a nested function's marker lies inside it.
  expect(sources.text(`function a(x = () => ("${marker ?? ""}3:9", 1)) { "${marker ?? ""}0:26"; }`)).toBe("function a() { return 1; }");
  // Overlapping ranges have no single owner.
  expect(sources.text(`function a() { "${marker ?? ""}0:26"; "${marker ?? ""}20:40"; }`)).toBeUndefined();
  for (const forged of ["oxidevm:source:1:0:999", "oxidevm:source:1:9:3", "oxidevm:source:2:0:5", "oxidevm:source:1:x:5", "oxidevm:source:1:0:", "oxidevm:source:1:00000000000000000000:5"]) {
    expect(sources.text(`function a() { "${forged}"; }`), forged).toBeUndefined();
  }
  expect(sources.text("function a() {}")).toBeUndefined();
  expect(sources.register("x".repeat(40))).toBeUndefined();
  expect(sources.register("y".repeat(10))).toBe("oxidevm:source:2:");
});
