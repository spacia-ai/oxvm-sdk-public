import { expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { SYSTEM_ERROR_MESSAGES, SYSTEM_ERROR_NUMBERS } from "./node-system-errors.js";
import { createSystemErrors } from "./node-util-system.js";
import { decodeValue, encodeValue, errorRow, list, loadControls, outcome, recorded, row, shape } from "./node-util-node24.test-support.js";

const control = loadControls("./node-util-node24.controls.json");
const errors = createSystemErrors();

it("holds pinned Node's system error map, in Node's order, and agrees with the libuv message controls", () => {
  expect([...errors.getSystemErrorMap()]).toEqual(control["systemErrorMap"]);
  expect(errors.getSystemErrorMap()).toBe(errors.getSystemErrorMap());
  expect(createSystemErrors().getSystemErrorMap()).not.toBe(errors.getSystemErrorMap());
  const libuv = list(loadControls("./node-system-errors.controls.json")["errors"]).map(value => record(value, "error"));
  expect(Object.keys(SYSTEM_ERROR_NUMBERS).sort()).toEqual(Object.keys(SYSTEM_ERROR_MESSAGES).sort());
  for (const entry of libuv) expect(SYSTEM_ERROR_NUMBERS[string(entry["code"], "code")]).toBe(entry["errno"]);
});

it("names and describes errno values as Node does, with Node's validation", () => {
  for (const value of list(control["systemErrorName"])) { const c = row(value); expect(outcome(() => errors.getSystemErrorName(decodeValue(c["arg"]))), JSON.stringify(c["arg"])).toEqual(recorded(c)); }
  for (const value of list(control["systemErrorMessage"])) { const c = row(value); expect(outcome(() => errors.getSystemErrorMessage(decodeValue(c["arg"]))), JSON.stringify(c["arg"])).toEqual(recorded(c)); }
});

function exception(error: Error): Record<string, unknown> {
  return { name: error.name, message: error.message, keys: Object.keys(error), props: Object.fromEntries(Object.keys(error).map(key => [key, encodeValue(Reflect.get(error, key))])),
    ctorIsError: error.constructor === Error, isError: error instanceof Error, stackHead: String(error.stack).split("\n")[0] };
}
it("builds _errnoException and _exceptionWithHostPort errors with Node's fields", () => {
  for (const [name, make] of [["errnoException", errors._errnoException], ["exceptionWithHostPort", errors._exceptionWithHostPort]] as const) {
    for (const value of list(control[name])) {
      const c = row(value), args = list(c["args"]).map(decodeValue);
      let result: Record<string, unknown>;
      try { result = { result: exception(make(...args)) }; } catch (error) { result = { error: errorRow(error) }; }
      expect(result, JSON.stringify(c["args"])).toEqual("error" in c ? { error: c["error"] } : { result: c["result"] });
    }
  }
  const error = (function caller() { return errors._errnoException(-2, "open"); })();
  expect(String(error.stack).split("\n")[1]).toContain("caller");
});

it("keeps Node's function names and lengths", () => {
  for (const value of list(control["functions"])) {
    const c = row(value), fn: unknown = Reflect.get(errors, string(c["name"], "name"));
    if (fn === undefined) continue;
    expect(shape(fn), string(c["name"], "name")).toEqual({ fname: c["fname"], length: c["length"] });
  }
});
