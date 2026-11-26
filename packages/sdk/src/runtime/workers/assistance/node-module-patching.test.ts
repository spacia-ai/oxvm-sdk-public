import { beforeAll, describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { controls } from "./node-controls.test-support.js";
import { loaderOver, tree } from "./node-module.test-support.js";

const recorded = controls("node-module-patching.controls.json"), expected = record(recorded["results"], "results");
let results: Record<string, unknown>;
beforeAll(async () => {
  const path = { sep: "/", basename: function basename(): string { return "original"; } };
  const { loader } = await loaderOver(tree(recorded["tree"]), { cwd: "/workspace/p", builtins: { path } });
  // The recorded scenarios are one CommonJS program; it runs here unchanged.
  results = record(await loader.require("/workspace/p/entry.cjs"), "scenario results");
  Reflect.deleteProperty(globalThis, "__runs");
  Reflect.deleteProperty(globalThis, "__count");
});

describe("programs that replace the module loader's functions, against Node 24.18.1", () => {
  it.each([
    ["Module._resolveFilename answers require, nested require and require.resolve", "resolveFilename"],
    ["Module._load answers require and nested require", "load"],
    ["Module._findPath is what resolution asks", "findPath"],
    ["Module._resolveLookupPaths adds a search directory", "lookupPaths"],
    ["Module._extensions handlers load the files they name", "extension"],
    ["Module.prototype.require sees every require", "prototypeRequire"],
    ["Module._cache entries can be deleted to load a module again", "cache"],
  ])("%s", (_title, name) => { expect(results[name]).toEqual(expected[name]); });

  it("loads the entry runMain names as the main module, once, and an ES module entry asynchronously", () => {
    expect(results["runMain"]).toEqual(expected["runMain"]);
  });

  it("re-reads a built-in's replaced functions into its ES module bindings in syncBuiltinESMExports", () => {
    expect(results["sync"]).toEqual(expected["sync"]);
  });

  it("exports the module built-in's functions by name to ES modules", () => {
    expect(results["named"]).toEqual(expected["named"]);
  });
});
