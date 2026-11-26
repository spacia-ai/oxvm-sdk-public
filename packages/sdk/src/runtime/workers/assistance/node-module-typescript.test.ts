import { beforeAll, describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { controls, rows } from "./node-controls.test-support.js";
import { toolchain, revive } from "./node-module.test-support.js";
import { createStripTypeScriptTypes } from "./node-module-typescript.js";

const recorded = controls("node-module-typescript.controls.json");
const warnings: (string | null)[][] = [];
let strip: (code: unknown, options?: unknown) => string;
beforeAll(async () => {
  const { compiler } = await toolchain();
  strip = createStripTypeScriptTypes({ warn: (message, type) => { warnings.push([type, message, null]); }, transform: (source, options) => compiler.transform(source, options) });
});
function outcome(call: () => unknown): Record<string, unknown> {
  try { return { value: call() }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const code: unknown = Reflect.get(error, "code");
    return { error: { name: error.constructor.name, code, message: error.message } };
  }
}
const cases = (name: string): [string, Record<string, unknown>][] => Object.entries(record(recorded[name], name)).map(([title, row]) => [title, record(row, title)]);

describe("module.stripTypeScriptTypes, against Node 24.18.1", () => {
  // `import type A = B.C` is an error to TypeScript and to Babel; SWC, and so Node, erases it.
  it.each(cases("strip").filter(([title]) => title !== "typeImportEquals"))("erases types in place: %s", (_title, row) => {
    const expected = "error" in row ? { error: row["error"] } : { value: row["value"] };
    expect(outcome(() => strip(row["input"]))).toEqual(expected);
  });

  it.each(cases("errors"))("refuses syntax that needs code generation in strip mode: %s", (_title, row) => {
    expect(outcome(() => strip(row["input"]))).toEqual(row["strip"]);
  });

  it.each(cases("transform"))("transforms with the pinned compiler: %s", (_title, row) => {
    expect(outcome(() => strip(row["input"], { mode: "transform" }))).toEqual({ value: row["value"] });
  });

  // Node's SWC build leaves decorators as written; the pinned one lowers them.
  it.each(cases("errors").filter(([title, row]) => title !== "decorators" && "value" in record(row["transform"], "transform")))("generates code in transform mode: %s", (_title, row) => {
    expect(outcome(() => strip(row["input"], { mode: "transform" }))).toEqual(row["transform"]);
  });

  it("appends the source URL or an inline source map as Node does", () => {
    for (const row of rows(recorded["options"])) {
      expect({ options: row["options"], ...outcome(() => strip("const a: number = 1;\n", row["options"])) }).toEqual(row);
    }
  });

  it("checks its arguments as Node does", () => {
    for (const row of rows(recorded["validation"])) {
      const input: unknown = JSON.parse(String(row["args"]));
      const given = (Array.isArray(input) ? input : []).map(value => value === "<fn>" ? () => undefined : typeof value === "object" && value !== null && Reflect.get(value, "type") === "Buffer" ? Buffer.from("x") : revive(value));
      expect({ args: row["args"], ...outcome(() => strip(given[0], ...given.slice(1, 2))) }).toEqual(row);
    }
  });

  it("warns once that the API is experimental", () => {
    expect(warnings).toEqual(recorded["warnings"]);
  });
});
