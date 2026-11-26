import { readFileSync } from "node:fs";
import { record } from "../../decode.js";

/** Controls recorded from Node 24.18.1 by the recorder script each file embeds under `recorder`
 * (`docker run --rm -v "$PWD":/rec:ro node:24.18.1-alpine node /rec/<recorder>.cjs`). */
export function loadControls(file: string): Record<string, unknown> {
  const control = record(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")), "Node 24 controls");
  if (record(control["node"], "pinned Node")["version"] !== "v24.18.1") throw new TypeError("Controls were not recorded from Node v24.18.1");
  return control;
}
export function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError("not a list"); return value; }
export function row(value: unknown): Record<string, unknown> { return record(value, "control row"); }

function token(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const name: unknown = Reflect.get(value, "$");
  return typeof name === "string" ? name : undefined;
}
/** Values JSON cannot carry are recorded as `{ "$": kind }`. */
export function decodeValue(value: unknown): unknown {
  switch (token(value)) {
    case "undefined": return undefined;
    case "NaN": return Number.NaN;
    case "Infinity": return Infinity;
    case "bigint": return BigInt(String(Reflect.get(Object(value), "v")));
    case "symbol": return Symbol("s");
    case "fn": return function fn(): void { /* a callable argument */ };
    case undefined: return value;
    default: return value;
  }
}
export function encodeValue(value: unknown): unknown {
  if (value === undefined) return { $: "undefined" };
  if (typeof value === "number" && Number.isNaN(value)) return { $: "NaN" };
  if (value === Infinity) return { $: "Infinity" };
  if (typeof value === "function") return { $: "fn" };
  return value;
}
export function errorRow(error: unknown, constructorName = true): Record<string, unknown> {
  if (!(error instanceof Error)) throw new TypeError("not an error");
  const base = { name: error.name, code: encodeValue(Reflect.get(error, "code")), message: error.message };
  return constructorName ? { ...base, ctor: error.constructor.name } : base;
}
/** What a call did, in the recorder's shape: `{ value }` or `{ error }`. */
export function outcome(run: () => unknown, constructorName = true): Record<string, unknown> {
  try { return { value: encodeValue(run()) }; } catch (error) { return { error: errorRow(error, constructorName) }; }
}
export function recorded(control: Record<string, unknown>): Record<string, unknown> {
  return "error" in control ? { error: control["error"] } : { value: control["value"] };
}
/** A function's own `name` and `length`, under the recorder's keys. */
export function shape(target: unknown): { fname: unknown; length: unknown } {
  const fname: unknown = Reflect.get(Object(target), "name"), length: unknown = Reflect.get(Object(target), "length");
  return { fname, length };
}
/** A value as the recorder's JSON output carries it. */
export function json(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
