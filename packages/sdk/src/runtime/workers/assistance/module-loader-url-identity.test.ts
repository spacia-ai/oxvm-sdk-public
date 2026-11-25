import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { initializeCompiler, type AssistanceCompiler } from "./compiler.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { moduleIdentity } from "./module-files.js";

let compiler: AssistanceCompiler | undefined, system = "";
beforeAll(async () => {
  const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
  compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  system = await readFile(require.resolve("systemjs/dist/s.js"), "utf8");
});

/** Resolves as the guest file owner does: a file URL's query and fragment become part of the module's identity. */
function loader(sources: Readonly<Record<string, string>>) {
  if (compiler === undefined) throw new Error("Compiler is not initialized");
  const reads: string[] = [], asked: (readonly [string, string])[] = [], globals: Record<string, unknown> = { runs: [] as string[] };
  Reflect.set(globalThis, "__identity", globals);
  const made = createLocalModuleLoader(compiler, system, {
    resolve(request, parent) {
      asked.push([request, parent]);
      if (request.startsWith("file:")) { const url = new URL(request); return moduleIdentity(fileURLToPath(url), url.search + url.hash); }
      return request.startsWith(".") ? posix.join(posix.dirname(parent), request) : request;
    },
    read(path) {
      reads.push(path);
      const source = sources[path];
      if (source === undefined) throw Object.assign(new Error(`Cannot find module '${path}'`), { code: "ERR_MODULE_NOT_FOUND" });
      return { source, format: path.endsWith(".cjs") ? "commonjs" : path.endsWith(".json") ? "json" : "module" };
    },
  });
  return { loader: made, reads, asked, runs: globals["runs"] };
}
const CONFIG = "globalThis.__identity.runs.push(import.meta.url); import { shared } from './shared.js'; export { shared }; export const url = import.meta.url; export const filename = import.meta.filename; export const dirname = import.meta.dirname; export const state = {}; export const sibling = import.meta.resolve('./shared.js'); export const again = () => import('./shared.js'); export default function configured() { return import.meta.url; }";
const SOURCES = { "/workspace/eslint.config.js": CONFIG, "/workspace/shared.js": "globalThis.__identity.runs.push('shared'); export const shared = {};" };

it("loads one module per distinct query or fragment, each seeing its own URL", async () => {
  const { loader: made, reads, runs } = loader(SOURCES);
  const first = await made.import("file:///workspace/eslint.config.js?mtime=1");
  const same = await made.import("file:///workspace/eslint.config.js?mtime=1");
  const second = await made.import("file:///workspace/eslint.config.js?mtime=2");
  const fragment = await made.import("file:///workspace/eslint.config.js#part");
  const plain = await made.import("file:///workspace/eslint.config.js");
  const path = await made.import("/workspace/eslint.config.js");
  expect(same).toBe(first);
  expect(path).toBe(plain);
  expect(new Set([first["state"], second["state"], fragment["state"], plain["state"]]).size).toBe(4);
  expect([first["url"], second["url"], fragment["url"], plain["url"]]).toEqual(["file:///workspace/eslint.config.js?mtime=1", "file:///workspace/eslint.config.js?mtime=2",
    "file:///workspace/eslint.config.js#part", "file:///workspace/eslint.config.js"]);
  // The file is the same one, and what it imports is shared.
  expect([first["filename"], first["dirname"], first["sibling"]]).toEqual(["/workspace/eslint.config.js", "/workspace", "file:///workspace/shared.js"]);
  expect(second["shared"]).toBe(first["shared"]);
  expect(runs).toEqual(["shared", "file:///workspace/eslint.config.js?mtime=1", "file:///workspace/eslint.config.js?mtime=2", "file:///workspace/eslint.config.js#part", "file:///workspace/eslint.config.js"]);
  expect(new Set(reads)).toEqual(new Set(["/workspace/eslint.config.js", "/workspace/shared.js"]));
});

it("resolves a queried module's own imports against its file and reports its source text", async () => {
  const { loader: made, asked } = loader(SOURCES);
  const namespace = await made.import("file:///workspace/eslint.config.js?mtime=7");
  const again: unknown = namespace["again"], configured: unknown = namespace["default"];
  if (typeof again !== "function" || typeof configured !== "function") throw new Error("missing exports");
  expect(await Reflect.apply(again, undefined, [])).toMatchObject({ shared: namespace["shared"] });
  expect(Reflect.apply(configured, undefined, [])).toBe("file:///workspace/eslint.config.js?mtime=7");
  expect(asked.filter(([request]) => request === "./shared.js").every(([, parent]) => parent === "/workspace/eslint.config.js")).toBe(true);
});

it("imports a static file URL with a query, and CommonJS or JSON behind one", async () => {
  const { loader: made } = loader({ ...SOURCES,
    "/workspace/entry.js": "import a from 'file:///workspace/value.cjs?x=1'; import b from 'file:///workspace/value.cjs?x=2'; import data from 'file:///workspace/data.json?v=1' with { type: 'json' }; import { url } from 'file:///workspace/eslint.config.js?static=1'; export { a, b, data, url };",
    "/workspace/value.cjs": "module.exports = { made: Symbol('once') };", "/workspace/data.json": '{"value":9}' });
  const namespace = await made.import("/workspace/entry.js");
  // Node keeps one CommonJS module per file however it is imported.
  expect(namespace["a"]).toBe(namespace["b"]);
  expect(namespace["data"]).toEqual({ value: 9 });
  expect(namespace["url"]).toBe("file:///workspace/eslint.config.js?static=1");
});

it("does not take an identity a program wrote for one the resolver issued", async () => {
  const { loader: made, reads } = loader(SOURCES);
  await expect(made.import("/workspace/eslint.config.js\0?forged")).rejects.toThrow();
  expect(() => made.require("/workspace/eslint.config.js\0?forged")).toThrow();
  expect(reads).toEqual([]);
  await expect(made.import("file:///workspace/missing.js?x=1")).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
});
