import { beforeAll, describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { controls } from "./node-controls.test-support.js";
import { loaderOver, tree } from "./node-module.test-support.js";

const recorded = controls("node-module-hooks.controls.json"), expected = record(recorded["results"], "results");
let results: Record<string, unknown>;
beforeAll(async () => {
  const builtins = { buffer: { Buffer }, fs: { readFileSync: () => "" }, path: { sep: "/" } };
  const { loader } = await loaderOver(tree(recorded["tree"]), { cwd: "/workspace/h", builtins });
  // The recorded scenarios are one CommonJS program; it runs here unchanged.
  results = record(await loader.require("/workspace/h/entry.cjs"), "scenario results");
});

/**
 * What this loader words differently without a hook being involved: Node's `MODULE_NOT_FOUND` lists the require
 * stack, V8 words CommonJS syntax errors and a module's missing `module` (this loader parses with Babel first), and
 * the missing JSON import attribute is worded by the existing import path. Those compare by class and code.
 */
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value !== "object" || value === null) return value;
  const entry = record(value, "entry");
  if (entry["code"] === "MODULE_NOT_FOUND" || entry["code"] === "ERR_IMPORT_ATTRIBUTE_MISSING") return { name: entry["name"], code: entry["code"] };
  if ((entry["name"] === "SyntaxError" && !String(entry["message"]).includes("JSON")) || entry["name"] === "ReferenceError") return { name: entry["name"] };
  return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, comparable(item)]));
}

describe("module.registerHooks, against Node 24.18.1", () => {
  it.each(["requireC", "requireCAgain", "requireResolve", "requireJson", "requireEsm", "importF", "importAgain", "metaResolve", "afterDeregister"])("hands the hooks what Node does: %s", name => {
    expect(results[name]).toEqual(expected[name]);
  });

  it("runs the last registered hook first and stops running a deregistered one", () => {
    expect([results["order"], results["orderAfterDeregister"], results["orderNone"]]).toEqual([expected["order"], expected["orderAfterDeregister"], expected["orderNone"]]);
  });

  // Node 24.18.1 overflows its stack when a resolve hook passes a `node:` specifier on to the next step for `require`.
  const requireCases = Object.keys(record(expected["custom"], "custom")).filter(name => name !== "alias-path");
  it.each(requireCases)("lets a hook answer require(%s) itself", name => {
    expect(comparable(record(results["custom"], "custom")[name])).toEqual(comparable(record(expected["custom"], "custom")[name]));
  });
  it("resolves a `node:` specifier a hook passes on, where Node 24.18.1 overflows its stack", () => {
    expect(record(results["custom"], "custom")["alias-path"]).toEqual({ value: "<path>" });
  });
  it.each(Object.keys(record(expected["customImport"], "customImport")))("lets a hook answer import(%s) itself", name => {
    expect(record(results["customImport"], "customImport")[name]).toEqual(record(expected["customImport"], "customImport")[name]);
  });

  /** Answers this loader gives differently, each for the reason stated. */
  const differing: Readonly<Record<string, string>> = Object.fromEntries(["replace", "commonjs", "null-source", "array-buffer"].map(name =>
    [`import ${name}.mjs`, "Node 24.18.1 fails an imported .mjs a hook calls CommonJS with ERR_REQUIRE_CYCLE_MODULE; here it runs as the CommonJS the hook said it is"]));
  const answers = record(expected["answers"], "answers");
  for (const door of ["require", "import"] as const) {
    it.each(Object.keys(record(answers[door], door)))(`takes a load hook's answer for ${door}: %s`, name => {
      const mine = record(record(results["answers"], "answers")[door], door)[name], theirs = record(answers[door], door)[name];
      if (`${door} ${name}` in differing) expect(record(theirs, "recorded")["error"]).toMatchObject({ code: "ERR_REQUIRE_CYCLE_MODULE" });
      else expect(comparable(mine)).toEqual(comparable(theirs));
    });
  }
});
