import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { nodePunycode } from "./node-punycode.ts";

// Recorded from `require("punycode")` of the real binary (`docker run --rm node:24.18.1-alpine node --no-deprecation`):
// every row is one call with its return value or the error it threw.
const control = record(JSON.parse(readFileSync(new URL("./node-punycode.controls.json", import.meta.url), "utf8")), "punycode controls");
const surface = record(control["surface"], "surface");
const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new TypeError("not a list"); return value; };

function target(name: string): unknown {
  let value: unknown = nodePunycode;
  for (const part of name.split(".")) value = typeof value === "object" && value !== null ? Reflect.get(value, part) : undefined;
  return value;
}
function invoke(name: string, input: unknown): { output: unknown } | { error: Record<string, unknown> } {
  const callee = target(name);
  if (typeof callee !== "function") throw new TypeError(`punycode.${name} is not a function`);
  try { return { output: Reflect.apply(callee, undefined, [input]) }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message, code: Reflect.get(error, "code") ?? null } };
  }
}

it("was recorded from pinned Node", () => {
  expect(control["node"]).toEqual({ version: "v24.18.1", arch: "x64", platform: "linux" });
});

it("exports exactly Node's punycode surface", () => {
  expect(nodePunycode.version).toBe("2.1.0");
  expect(nodePunycode.version).toBe(surface["version"]);
  expect(Object.keys(nodePunycode)).toEqual(surface["keys"]);
  expect(Object.keys(nodePunycode.ucs2)).toEqual(surface["ucs2Keys"]);
  const functions = list(surface["functions"]);
  expect(functions).toHaveLength(6);
  for (const row of functions) {
    const [path, name, length] = list(row);
    const callee = target(string(path, "path"));
    expect(typeof callee).toBe("function");
    expect([path, Reflect.get(Object(callee), "name"), Reflect.get(Object(callee), "length")]).toEqual([path, name, length]);
  }
});

it("replays every recorded conversion and failure", () => {
  const rows = list(control["rows"]);
  expect(rows).toHaveLength(119);
  let failures = 0;
  for (const value of rows) {
    const row = record(value, "row"), call = string(row["call"], "call");
    const result = invoke(call, row["input"]);
    if ("error" in row) { failures++; expect({ call, input: row["input"], error: "error" in result ? result.error : undefined }).toEqual({ call, input: row["input"], error: row["error"] }); }
    else expect({ call, input: row["input"], ...result }).toEqual({ call, input: row["input"], output: row["output"] });
  }
  expect(failures).toBe(22);
});

it("words its range errors as Node does", () => {
  expect(() => nodePunycode.decode("99999999")).toThrow(new RangeError("Overflow: input needs wider integers to process"));
  expect(() => nodePunycode.decode("ü-abc")).toThrow(new RangeError("Illegal input >= 0x80 (not a basic code point)"));
  expect(() => nodePunycode.decode("abc-!")).toThrow(new RangeError("Invalid input"));
  expect(nodePunycode.toASCII("mañana.com")).toBe("xn--maana-pta.com");
  expect(nodePunycode.toUnicode("xn--maana-pta.com")).toBe("mañana.com");
});

it("treats values that are not strings as Node's unvalidated code does", () => {
  // V8 words these type errors with the local variable's name, which a minified build renames: only the kind is compared.
  for (const value of list(surface["loose"])) {
    const row = record(value, "loose"), result = invoke(string(row["call"], "call"), row["input"]);
    if ("error" in row) expect("error" in result ? result.error["name"] : undefined).toBe(record(row["error"], "error")["name"]);
    else expect(result).toEqual({ output: row["output"] });
  }
});
