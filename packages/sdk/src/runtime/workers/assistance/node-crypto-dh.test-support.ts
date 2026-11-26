// Shared by the Diffie-Hellman and ECDH tests: the recorders' serialization of results and failures, applied to
// this implementation, and the evaluation of the recorded expressions.
import { runInThisContext } from "node:vm";
import { Buffer } from "buffer/";
import { record } from "../../decode.js";

export function text(value: unknown, what: string): string { if (typeof value !== "string") throw new TypeError(`${what} is not a string`); return value; }
export function list(value: unknown, what: string): unknown[] { if (!Array.isArray(value)) throw new TypeError(`${what} is not an array`); return value; }
export function integer(value: unknown, what: string): number { if (typeof value !== "number") throw new TypeError(`${what} is not a number`); return value; }

export function serialized(value: unknown): unknown {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "function") return { function: value.name };
  if (Buffer.isBuffer(value)) return { buffer: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(serialized);
  if (typeof value !== "object") throw new TypeError("Unexpected result");
  return { object: Object.fromEntries(Object.entries(value).map(([name, member]) => [name, serialized(member)])) };
}
export function failure(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { thrown: String(error) };
  const constructor: unknown = Reflect.get(error, "constructor");
  const result: Record<string, unknown> = { name: Reflect.get(error, "name"), ctor: typeof constructor === "function" ? constructor.name : undefined, message: Reflect.get(error, "message") };
  for (const name of ["code", "library", "reason", "opensslErrorStack"]) { const member: unknown = Reflect.get(error, name); if (member !== undefined) result[name] = member; }
  result["keys"] = Object.keys(error);
  return result;
}
export function outcome(work: () => unknown): unknown {
  try { return { value: serialized(work()) }; }
  catch (error) { return { throws: failure(error) }; }
}
export function expected(row: Record<string, unknown>): unknown { return "throws" in row ? { throws: row["throws"] } : { value: row["value"] }; }
export function evaluator(parameters: string, expression: string): (...values: unknown[]) => unknown {
  const compiled: unknown = runInThisContext(`(function (${parameters}) { return (${expression}); })`);
  if (typeof compiled !== "function") throw new TypeError("Expression did not compile");
  return (...values) => { const result: unknown = Reflect.apply(compiled, undefined, values); return result; };
}
export function rows(value: unknown, what: string): Record<string, unknown>[] { return list(value, what).map(row => record(row, what)); }
/** Calls a method of an object of this implementation. */
export function call(target: unknown, method: string, ...args: unknown[]): unknown {
  if (typeof target !== "object" && typeof target !== "function" || target === null) throw new TypeError("Not an object");
  const operation: unknown = Reflect.get(target, method);
  if (typeof operation !== "function") throw new TypeError(`Missing ${method}`);
  const result: unknown = Reflect.apply(operation, target, args);
  return result;
}
