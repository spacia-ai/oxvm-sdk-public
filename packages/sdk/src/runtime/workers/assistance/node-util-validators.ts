/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/errors.js and lib/internal/validators.js
 * (ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE and the validators built on them).
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import inspection from "node-inspect-extracted";
import { record } from "../../decode.ts";
import { invalidArgType } from "./node-arg-type.ts";

const inspectOperation: unknown = record(inspection, "Node inspection exports")["inspect"];
/** `util.inspect` as Node's error messages call it. */
export function inspectValue(value: unknown, options?: { readonly depth: -1 }): string {
  if (typeof inspectOperation !== "function") throw new TypeError("Missing util.inspect");
  const text: unknown = Reflect.apply(inspectOperation, undefined, options === undefined ? [value] : [value, options]);
  if (typeof text !== "string") throw new TypeError("Invalid util.inspect result");
  return text;
}

/** How a name is addressed: a dotted name is a property of an options object. */
function kind(name: string): "property" | "argument" { return name.includes(".") ? "property" : "argument"; }

/** Node's wording of the value an argument received (`determineSpecificType`), taken from the one implementation. */
function received(value: unknown): string {
  const prefix = "The \"v\" argument must be of type t. ";
  return invalidArgType("v", "t", value, inspectValue).message.slice(prefix.length);
}

/** ERR_INVALID_ARG_TYPE for a primitive type name (`of type number`). */
export function invalidType(name: string, expected: string, value: unknown): TypeError {
  return Object.assign(new TypeError(`The "${name}" ${kind(name)} must be of type ${expected}. ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
}
/** ERR_INVALID_ARG_TYPE for a class name (`an instance of AbortSignal`). */
export function invalidInstance(name: string, expected: string, value: unknown): TypeError {
  return Object.assign(new TypeError(`The "${name}" ${kind(name)} must be an instance of ${expected}. ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
}
/** ERR_INVALID_ARG_VALUE; Node shortens the inspected value to 128 characters. */
export function invalidValue(name: string, value: unknown, reason = "is invalid"): TypeError {
  const inspected = inspectValue(value);
  return Object.assign(new TypeError(`The ${kind(name)} '${name}' ${reason}. Received ${inspected.length > 128 ? `${inspected.slice(0, 128)}...` : inspected}`), { code: "ERR_INVALID_ARG_VALUE" });
}
function separated(digits: string): string {
  let result = "", index = digits.length;
  const start = digits.startsWith("-") ? 1 : 0;
  for (; index >= start + 4; index -= 3) result = `_${digits.slice(index - 3, index)}${result}`;
  return `${digits.slice(0, index)}${result}`;
}
/** ERR_OUT_OF_RANGE; integers beyond 2^32 are written with numeric separators. */
export function outOfRange(name: string, range: string, value: unknown): RangeError {
  const shown = typeof value === "number" && Number.isInteger(value) && Math.abs(value) > 2 ** 32 ? separated(String(value))
    : typeof value === "bigint" ? `${value > 2n ** 32n || value < -(2n ** 32n) ? separated(String(value)) : String(value)}n` : inspectValue(value);
  return Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${shown}`), { code: "ERR_OUT_OF_RANGE" });
}

export function validateNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number") throw invalidType(name, "number", value);
}
export function validateInteger(value: unknown, name: string, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  validateNumber(value, name);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < minimum || value > maximum) throw outOfRange(name, `>= ${String(minimum)} && <= ${String(maximum)}`, value);
}
export function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw invalidType(name, "boolean", value);
}
export function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw invalidType(name, "string", value);
}
export function validateFunction(value: unknown, name: string): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== "function") throw invalidType(name, "function", value);
}
/** Node's default `validateObject`: null, arrays and functions are refused. */
export function validateObject(value: unknown, name: string): asserts value is object {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw invalidType(name, "object", value);
}
export function validateAbortSignal(value: unknown, name: string): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) throw invalidInstance(name, "AbortSignal", value);
}

/** A template literal's conversion: every value but a symbol becomes its string. */
export function templateText(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  return String(value);
}
/** A primitive as an engine's own error messages quote it. */
export function primitiveText(value: unknown): string { return typeof value === "symbol" ? value.toString() : String(value); }
/** Pins a function's or class's `name`, which production minification would otherwise change. */
export function named<Target extends object>(target: Target, name: string): Target {
  Object.defineProperty(target, "name", { value: name, configurable: true });
  return target;
}
