import { beforeAll, describe, expect, it } from "vitest";
import { clearRefusedNodeApi, refusedNodeApi } from "./node-capability.js";
import { controls, rows } from "./node-controls.test-support.js";
import { call, loaderOver, member, outcome, revive, tree, UNDEFINED } from "./node-module.test-support.js";
import { record } from "../../decode.js";

const recorded = controls("node-module-api.controls.json");
const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(record(recorded["env"], "env")).map(([name, value]) => [name, typeof value === "string" ? value : undefined]));
const warnings: string[][] = [];
const owner = { env, execPath: String(recorded["execPath"]), argv: ["/usr/local/bin/node", "/workspace/app/main.js"], emitWarning: (message: string, type: string) => { warnings.push([type, message]); } };
let Module: unknown;
beforeAll(async () => { Module = (await loaderOver(tree(recorded["tree"]), { process: owner })).Module; });
const parents = record(recorded["parents"], "parents");

describe("module search paths, as Node 24.18.1 computes them", () => {
  it("publishes globalPaths from NODE_PATH, HOME and the executable's prefix", () => {
    expect(member(Module, "globalPaths")).toEqual(recorded["globalPaths"]);
  });

  it.each(rows(recorded["lookups"]))("_resolveLookupPaths($request, $parent)", row => {
    const result = outcome(() => call(Module, "_resolveLookupPaths", revive(row["request"]), revive(parents[String(row["parent"])])));
    expect(result).toEqual("error" in row ? { error: row["error"] } : { value: row["value"] });
  });

  it("answers with its own list, not the published copy", () => {
    const first = call(Module, "_resolveLookupPaths", "x", undefined);
    expect({ same: first === call(Module, "_resolveLookupPaths", "x", undefined), copy: first !== member(Module, "globalPaths") }).toEqual(recorded["lookupIdentity"]);
  });

  it("recomputes globalPaths from the current environment in _initPaths", () => {
    const saved = { ...env };
    try {
      for (const row of rows(recorded["initPaths"])) {
        delete env["HOME"]; delete env["NODE_PATH"]; Object.assign(env, row["env"]);
        const before: unknown = member(Module, "globalPaths"), result = call(Module, "_initPaths");
        const now: unknown = member(Module, "globalPaths");
        expect({ env: row["env"], result: result === undefined ? UNDEFINED : result, globalPaths: now, replaced: before !== now, lookup: call(Module, "_resolveLookupPaths", "x", undefined) }).toEqual(row);
      }
      const published: unknown = member(Module, "globalPaths");
      if (Array.isArray(published)) published.push("/mutated");
      expect(call(Module, "_resolveLookupPaths", "x", undefined)).toEqual(recorded["mutatedLookup"]);
    } finally {
      delete env["HOME"]; delete env["NODE_PATH"]; Object.assign(env, saved); call(Module, "_initPaths");
    }
  });
});

describe("Module._findPath over the loader's own resolution", () => {
  it.each(rows(recorded["finds"]))("_findPath($request, $paths)", row => {
    const result = outcome(() => call(Module, "_findPath", revive(row["request"]), revive(row["paths"]), false));
    expect(result).toEqual("error" in row ? { error: row["error"] } : { value: row["value"] });
  });

  it("fills _pathCache as Node does and answers from it", () => {
    const expected = record(recorded["pathCache"], "path cache"), cache = record(member(Module, "_pathCache"), "_pathCache");
    for (const row of rows(recorded["finds"])) outcome(() => call(Module, "_findPath", revive(row["request"]), revive(row["paths"]), false));
    expect(Object.getPrototypeOf(cache) === null).toBe(expected["nullPrototype"]);
    expect(Object.keys(cache).filter(key => key.includes("/workspace")).map(key => [key, cache[key]])).toEqual(expected["entries"]);
    Reflect.set(cache, "./poison\0/workspace/app", "/poisoned.js");
    expect(call(Module, "_findPath", "./poison", ["/workspace/app"])).toBe(expected["poisoned"]);
  });
});

describe("module.findPackageJSON", () => {
  it.each(rows(recorded["findPackageJSON"]))("findPackageJSON($specifier, $base)", row => {
    const base = revive(row["base"]);
    const result = outcome(() => base === undefined ? call(Module, "findPackageJSON", row["specifier"]) : call(Module, "findPackageJSON", row["specifier"], base));
    expect(result).toEqual("error" in row ? { error: row["error"] } : { value: row["value"] });
  });

  it("takes URL objects and checks its arguments as Node does", () => {
    expect({
      none: outcome(() => call(Module, "findPackageJSON")), symbol: outcome(() => call(Module, "findPackageJSON", Symbol("s"))),
      url: outcome(() => call(Module, "findPackageJSON", new URL("file:///workspace/app/lib/util.js"))),
      baseUrl: outcome(() => call(Module, "findPackageJSON", "main-pkg", new URL("file:///workspace/app/main.js"))),
    }).toEqual(recorded["findPackageJSONOther"]);
  });
});

describe("the module built-in's remaining Node 24 surface", () => {
  it("has Node's names, arities and property attributes", () => {
    for (const [name, shape] of Object.entries(record(recorded["shapes"], "shapes"))) {
      const descriptor = descriptorOf(name), value: unknown = descriptor?.value;
      expect({ member: name, name: member(value, "name"), length: member(value, "length"), enumerable: descriptor?.enumerable, writable: descriptor?.writable, configurable: descriptor?.configurable })
        .toEqual({ member: name, ...record(shape, "shape") });
    }
    const wrap = record(recorded["wrap"], "wrap");
    expect({ wrapper: member(Module, "wrapper"), wrapped: call(Module, "wrap", "X"),
      enumerable: ["wrap", "wrapper"].map(name => descriptorOf(name)?.enumerable) }).toEqual(wrap);
  });

  it("publishes frozen, prototype-less constants", () => {
    const constants: unknown = member(Module, "constants"), status: unknown = member(constants, "compileCacheStatus");
    expect({ value: { compileCacheStatus: { ...record(status, "status") } }, frozen: [Object.isFrozen(constants), Object.isFrozen(status)], nullPrototype: [Object.getPrototypeOf(constants) === null, Object.getPrototypeOf(status) === null] })
      .toEqual(recorded["constants"]);
  });

  it("answers the compile cache as Node does when the cache is disabled", () => {
    const expected = record(recorded["compileCache"], "compile cache");
    for (const row of rows(expected["enable"])) expect({ args: row["args"], ...outcome(() => call(Module, "enableCompileCache", ...argumentsOf(row))) }).toEqual(row);
    expect(outcome(() => call(Module, "getCompileCacheDir"))).toEqual(expected["directory"]);
    for (const row of rows(expected["flush"])) expect({ args: row["args"], ...outcome(() => call(Module, "flushCompileCache", ...argumentsOf(row))) }).toEqual(row);
  });

  it("checks module.register's arguments as Node does, then looks for the hooks module", () => {
    for (const row of rows(recorded["register"])) {
      const expected = record(row["error"], "error"), mine = outcome(() => call(Module, "register", ...argumentsOf(row)));
      // The loader words a missing module in its own way (node-module-register.test.ts covers what register() then does).
      if (expected["code"] === "ERR_MODULE_NOT_FOUND") expect(record(mine["error"], "error")).toMatchObject({ name: expected["name"], code: "ERR_MODULE_NOT_FOUND" });
      else expect({ args: row["args"], ...mine }).toEqual(row);
    }
    clearRefusedNodeApi();
    expect(outcome(() => call(Module, "register", "./hooks.mjs", "file:///workspace/app/main.js"))["error"]).toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
    expect(refusedNodeApi()).toBeUndefined();
  });

  it("validates registerHooks and returns an object with deregister on its prototype", () => {
    for (const row of rows(recorded["registerHooks"])) {
      const input = argumentsOf(row).map(value => typeof value === "object" && value !== null && Reflect.get(value, "resolve") === "fn" ? { ...value, resolve: () => undefined } : value);
      expect({ args: row["args"], ...outcome(() => {
        const hooks = record(call(Module, "registerHooks", ...input), "hooks"), deregister = member(hooks, "deregister"), prototype: unknown = Object.getPrototypeOf(hooks);
        return { keys: Object.keys(hooks), prototype: member(member(prototype, "constructor"), "name"), name: member(deregister, "name"), length: member(deregister, "length"),
          own: Object.hasOwn(hooks, "deregister"), result: call(hooks, "deregister") ?? UNDEFINED, again: call(hooks, "deregister") ?? UNDEFINED };
      }) }).toEqual(row);
    }
  });

  it("runs _preloadModules from a dummy parent in the working directory", () => {
    for (const row of rows(recorded["preload"])) expect({ args: row["args"], ...outcome(() => call(Module, "_preloadModules", ...argumentsOf(row))) }).toEqual(row);
    const expected = record(recorded["preloaded"], "preloaded"), seen = record(Reflect.get(globalThis, "__preloaded"), "preload record");
    Reflect.deleteProperty(globalThis, "__preloaded");
    expect({ id: seen["id"], paths: seen["paths"], loaded: seen["loaded"] }).toEqual({ id: expected["id"], paths: expected["paths"], loaded: expected["loaded"] });
  });

  it("rejects a runMain entry that is not a string with Node's error, and syncBuiltinESMExports takes any arguments", () => {
    for (const row of rows(recorded["runMainErrors"])) expect({ args: row["args"], ...outcome(() => call(Module, "runMain", ...argumentsOf(row))) }).toEqual(row);
    expect([outcome(() => call(Module, "syncBuiltinESMExports")), outcome(() => call(Module, "syncBuiltinESMExports", 1, 2))]).toEqual(recorded["sync"]);
  });
});

function descriptorOf(name: string): PropertyDescriptor | undefined {
  return (typeof Module === "object" && Module !== null) || typeof Module === "function" ? Reflect.getOwnPropertyDescriptor(Module, name) : undefined;
}
function argumentsOf(row: Record<string, unknown>): unknown[] {
  const input: unknown = row["args"];
  return Array.isArray(input) ? input.map(revive) : [];
}
