import { readFileSync } from "node:fs";
import { record } from "../../decode.js";

/** Reads a `*.controls.json` recorded from real Node next to the tests. */
export function controls(name: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")), name);
}
export function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError("not a list"); return value; }
export function rows(value: unknown): Record<string, unknown>[] { return list(value).map(row => record(row, "row")); }
/** The recorder writes what JSON cannot hold as `{ $: kind }`. */
export function decoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decoded);
  if (typeof value !== "object" || value === null) return value;
  const kind: unknown = Reflect.get(value, "$");
  if (kind === "undefined") return undefined;
  if (kind === "symbol") return Symbol("s");
  if (kind === "NaN") return NaN;
  if (kind === "Infinity") return Infinity;
  if (kind === "-Infinity") return -Infinity;
  if (kind === "bigint") return BigInt(String(Reflect.get(value, "v")));
  if (kind === "fn") return function fn() { return undefined; };
  if (kind === "buffer") return Buffer.from(String(Reflect.get(value, "hex")), "hex");
  if (kind === "u8") return new Uint8Array(Buffer.from(String(Reflect.get(value, "hex")), "hex"));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decoded(item)]));
}
/** A call's outcome in the recorder's shape: `{ value }` or `{ error: { name, code, message, ctor } }`. */
export function outcome(call: () => unknown, shape: (value: unknown) => unknown = value => value, extra: readonly string[] = []): Record<string, unknown> {
  try { return { value: shape(call()) }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const more = Object.fromEntries(extra.flatMap(key => Reflect.get(error, key) === undefined ? [] : [[key, Reflect.get(error, key)]]));
    const code: unknown = Reflect.get(error, "code") ?? null;
    return { error: { name: error.name, code, message: error.message, ctor: error.constructor.name, ...more } };
  }
}
/** What JSON keeps of a value, which is what a control file holds. */
export function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return copy;
}
