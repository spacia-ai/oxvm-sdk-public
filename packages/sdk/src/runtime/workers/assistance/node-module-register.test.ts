import * as workerThreads from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { lateFailureOf } from "../../js-process/late-failure.js";
import { createGuestModules } from "./guest-modules.js";
import { createLocalModuleLoader } from "./module-loader.js";
import { list, controls } from "./node-controls.test-support.js";
import { linuxFiles, toolchain, tree, type Tree } from "./node-module.test-support.js";

const recorded = controls("node-module-register.controls.json"), expected = record(recorded["results"], "results"), files = tree(recorded["tree"]);
const ROOT = "/workspace/r", LOG = `${ROOT}/log.txt`;

/** A fresh process's loader over the recorded tree. The log is the one file the scenarios share with their hooks. */
async function loaderOver(source: Tree) {
  const tools = await toolchain(), linux = linuxFiles(source);
  let log = "";
  const fs = {
    appendFileSync(path: string, text: string): void { if (path === LOG) log += text; },
    writeFileSync(path: string, text: string): void { if (path === LOG) log = text; },
    readFileSync: (path: string): string => path === LOG ? log : linux.readFileSync(path),
  };
  const roots = [{ kind: "dependencies", path: `${ROOT}/node_modules` }] as const;
  const modules = createGuestModules(linux, { generation: 1n, profile: "node24-bun1-v1", roots, runtime: "node", moduleSearchPaths: [] });
  return createLocalModuleLoader(tools.compiler, tools.system, modules, { buffer: { Buffer }, fs, worker_threads: workerThreads }, ROOT, { readSource: path => linux.readFileSync(path) });
}
/** Runs a recorded scenario, one CommonJS program, unchanged. */
async function scenario(name: string): Promise<{ readonly mine: Record<string, unknown>; readonly theirs: Record<string, unknown> }> {
  const loader = await loaderOver(files);
  return { mine: record(await loader.require(`${ROOT}/${name}.cjs`), name), theirs: record(expected[name], name) };
}
/** A program of this test's own, next to the recorded files. */
async function program(extra: Readonly<Record<string, string>>, entry: string): Promise<unknown> {
  const loader = await loaderOver({ files: new Map([...files.files, ...Object.entries(extra).map(([name, text]) => [`${ROOT}/${name}`, text] as const)]), links: files.links });
  const result: unknown = await loader.require(`${ROOT}/${entry}`);
  return result;
}
const step = (results: Record<string, unknown>, name: string): Record<string, unknown> => record(results[name], name);
const lines = (value: unknown): string[] => list(value).map(String);
const synchronous = (log: readonly string[]): string[] => log.filter(line => line.startsWith("S."));
const registered = (log: readonly string[]): string[] => log.filter(line => !line.startsWith("S."));
/** This loader words a missing module in its own way, and the host's V8 words an uncloneable function. */
function comparable(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const entry = record(value, "entry");
  if (entry["code"] === "ERR_MODULE_NOT_FOUND" || entry["name"] === "DOMException") return { name: entry["name"], code: entry["code"] };
  return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, comparable(item)]));
}

describe("module.register, against Node 24.18.1", () => {
  it("loads the hooks module, initializes it with its data and runs its hooks for every later import", async () => {
    const { mine, theirs } = await scenario("basic");
    for (const name of ["require", "again", "typescript", "shared"]) expect(mine[name]).toEqual(theirs[name]);
    // Node blocks `register()` until an asynchronous `initialize` settles; here the next import waits for it instead.
    expect(step(mine, "register")).toEqual({ returned: "undefined", log: ["T.init {\"n\":1} shared=1"] });
    expect(step(theirs, "register")["log"]).toEqual(["T.init {\"n\":1} shared=1", "T.init done"]);
    expect(step(mine, "graph")).toEqual({ value: step(theirs, "graph")["value"], log: ["T.init done", ...lines(step(theirs, "graph")["log"])] });
  });

  it("transpiles TypeScript through a load hook, redirects a bare specifier and keeps the hooks' own module instances", async () => {
    const { mine } = await scenario("basic");
    expect(step(mine, "typescript")).toMatchObject({ value: 9, area: 4 });
    expect(step(mine, "graph")["value"]).toBe("myx1realfunction");
    // The hooks module bumped its own copy of shared.mjs to 1; the program's copy starts from 0.
    expect(step(mine, "shared")["value"]).toBe(1);
  });

  describe("with two registrations and module.registerHooks", () => {
    const exact = ["shared", "virtualB", "virtualA", "required", "afterDeregister"];
    it("runs the last registered hooks first, inside the synchronous hooks, and loads the second hooks module through the first", async () => {
      const { mine, theirs } = await scenario("lifo");
      for (const name of [...exact, "virtualS", "alias"]) expect(step(mine, name)["value"]).toEqual(step(theirs, name)["value"]);
      // The second registration loads through the first one's hooks: it is finished by the first import, not by `register()`.
      expect([...lines(mine["registered"]), ...registered(lines(step(mine, "shared")["log"]))]).toEqual([...lines(theirs["registered"]), ...registered(lines(step(theirs, "shared")["log"]))]);
      // Each side sees Node's calls in Node's order. The registered chain is asked before the synchronous hooks that
      // wrap it run, so the two sides interleave differently.
      for (const name of exact) {
        const own = lines(step(mine, name)["log"]), node = lines(step(theirs, name)["log"]);
        expect(synchronous(own)).toEqual(synchronous(node));
        if (name !== "shared") expect(registered(own)).toEqual(registered(node));
      }
      // `require` never reaches the registered hooks; Node hands a .cjs file's load hook `format: "commonjs"`, which
      // the synchronous hooks here leave out.
      expect(registered(lines(step(mine, "required")["log"]))).toEqual([]);
    });
    it("asks the registered chain once more than Node when a synchronous hook answers alone or changes the request", async () => {
      const { mine, theirs } = await scenario("lifo");
      const parent = "parent=file:///workspace/r/lifo.cjs";
      expect(step(theirs, "virtualS")["log"]).toEqual(["S.resolve virtual:S"]);
      expect(step(mine, "virtualS")["log"]).toEqual([`B.resolve virtual:S ${parent}`, `A.resolve virtual:S ${parent}`, "S.resolve virtual:S"]);
      const own = lines(step(mine, "alias")["log"]), node = lines(step(theirs, "alias")["log"]);
      expect(registered(own)).toEqual([`B.resolve alias:g ${parent}`, `A.resolve alias:g ${parent}`, ...registered(node)]);
      // The synchronous hook runs again once the registered chain has answered the request it changed.
      expect(synchronous(own)).toEqual(["S.resolve alias:g", ...synchronous(node)]);
    });
  });

  it.each(Object.keys(record(expected["errors"], "errors")))("gives a hook's answer or Node's error: %s", async name => {
    const { mine, theirs } = await scenario("errors");
    expect(comparable(mine[name])).toEqual(comparable(theirs[name]));
  });

  it("resolves the hooks module as Node does and reports what fails before any hook is registered from register()", async () => {
    const { mine, theirs } = await scenario("registering");
    const immediate = ["missing", "missingPackage", "bareDefaultParent", "relativeDefaultParent", "pathParent", "throws", "initThrows", "uncloneable", "none", "commonjs"];
    for (const name of immediate) expect(comparable(mine[name])).toEqual(comparable(theirs[name]));
    // Once hooks are registered, a later hooks module loads through them: its `initialize` has run by the next import.
    const later = ["package", "optionsForm", "urlObjects", "directoryParent", "absolute", "tla"];
    const logged = (results: Record<string, unknown>): string[] => [...later.flatMap(name => lines(step(results, name)["log"])), ...lines(results["finalLog"])];
    for (const name of later) expect(step(mine, name)["value"]).toEqual(step(theirs, name)["value"]);
    expect(logged(mine)).toEqual(logged(theirs));
    for (const name of ["virtual:C", "virtual:P", "virtual:TLA"]) expect(mine[name]).toEqual(theirs[name]);
  });

  it("gives a rejected initialize to the next import, where Node throws it from register()", async () => {
    const { mine, theirs } = await scenario("rejecting");
    expect(step(theirs, "register")["error"]).toEqual({ name: "RangeError", message: "initialize rejected" });
    expect(mine).toEqual({ register: { value: "undefined" }, first: { error: { name: "RangeError", message: "initialize rejected" } }, second: theirs["second"] });
  });

  it("moves the transfer list's ports to the hooks and copies their data", async () => {
    const { mine, theirs } = await scenario("ports");
    expect(mine).toEqual(theirs);
  });

  describe("a synchronous load, which cannot wait for the hooks", () => {
    it("skips them for the files Node loads itself, as Node's own require() does", async () => {
      const { mine, theirs } = await scenario("requiring");
      expect(mine).toEqual(theirs);
    });

    const refusal = (subject: string) => ({ kind: "unavailable-builtin", detail: `node:module.register: ${subject}` });
    const caught = "error => ({ message: error.message, error })";
    it("refuses a file only a load hook could make loadable, in require() and in a required ES module's imports", async () => {
      const result = record(await program({ "refused.cjs": `
        const { register } = require('node:module');
        register('./hooks/upper.mjs', 'file:///workspace/r/refused.cjs');
        const attempt = call => { try { return { value: call() }; } catch (error) { return { error }; } };
        module.exports = { direct: attempt(() => require('./note.txt')), nested: attempt(() => require('./uses-note.mjs')), plain: attempt(() => require('./plain.js')) };` }, "refused.cjs"), "result");
      expect(lateFailureOf(step(result, "direct")["error"])).toEqual(refusal("require() through asynchronous hooks"));
      expect(lateFailureOf(step(result, "nested")["error"])).toEqual(refusal("require() through asynchronous hooks"));
      expect(result["plain"]).toEqual({ value: "plain" });
    });

    it("answers import.meta.resolve() without the hooks and refuses what only they could resolve", async () => {
      const result = list(await program({
        "meta-plain.mjs": "export default import.meta.resolve('./x.js');",
        "meta-virtual.mjs": "export default import.meta.resolve('virtual:A');",
        "meta.cjs": `
        const { register } = require('node:module');
        register('./hooks/A.mjs', 'file:///workspace/r/meta.cjs', { data: 'a' });
        module.exports = Promise.all([import('./meta-plain.mjs').then(ns => ns.default), import('./meta-virtual.mjs').then(ns => ns.default, ${caught})]);` }, "meta.cjs"));
      expect(result[0]).toBe("file:///workspace/r/x.js");
      expect(lateFailureOf(record(result[1], "refusal")["error"])).toEqual(refusal("import.meta.resolve() through asynchronous hooks"));
    });
  });

  it("hands a hook Node's TypeScript formats and refuses to run what the chain leaves as TypeScript", async () => {
    const result = record(await program({
      "hooks/watch.mjs": `
        const seen = [];
        export function initialize(data) { data.port.onmessage = () => data.port.postMessage(seen); }
        export async function load(url, context, nextLoad) { const loaded = await nextLoad(url, context); seen.push([url.slice(url.lastIndexOf('/') + 1), loaded.format, String(loaded.source).length > 0]); return loaded; }`,
      "typed.mts": "export const value: number = 1;", "typed.cts": "exports.value = 1 as number;",
      "watch.cjs": `
        const { register } = require('node:module'), { MessageChannel } = require('node:worker_threads');
        const { port1, port2 } = new MessageChannel();
        register('./hooks/watch.mjs', 'file:///workspace/r/watch.cjs', { data: { port: port2 }, transferList: [port2] });
        module.exports = (async () => {
          const errors = [];
          for (const name of ['./typed.mts', './typed.cts', './app.ts']) errors.push(await import(name).then(() => 'loaded', error => error));
          const seen = await new Promise(done => { port1.onmessage = event => { port1.close(); done(event.data); }; port1.postMessage('report'); });
          return { errors, seen };
        })();` }, "watch.cjs"), "result");
    expect(result["seen"]).toEqual([["typed.mts", "module-typescript", true], ["typed.cts", "commonjs-typescript", true], ["app.ts", "module-typescript", true]]);
    expect(list(result["errors"]).map(lateFailureOf)).toEqual(["module-typescript", "commonjs-typescript", "module-typescript"].map(format =>
      ({ kind: "unavailable-builtin", detail: `node:module.register: a load hook's "${format}" format` })));
  });
});
