/**
 * Replays the cases of a `*.controls.json` written by the recorder those files embed: the same argument
 * notation, and the same summary of what a call returned, threw or handed its callback.
 */
import { readFileSync } from "node:fs";
import { Buffer } from "buffer/";
import { record } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { CryptoPorts } from "./node-crypto-ports.js";

export type Json = Record<string, unknown>;
export interface ControlCase { readonly id: string; readonly fn: string; readonly args: readonly unknown[]; readonly result: Json }

export function loadControls(file: string): { readonly document: Json; readonly cases: readonly ControlCase[] } {
  const document = record(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")), file);
  const cases = document["cases"];
  if (!Array.isArray(cases)) throw new TypeError(`${file} has no cases`);
  return { document, cases: cases.map((value: unknown): ControlCase => {
    const item = record(value, "case"), { id, fn, args } = item;
    if (typeof id !== "string" || typeof fn !== "string" || !Array.isArray(args)) throw new TypeError("Malformed case");
    return { id, fn, args, result: record(item["result"], id) };
  }) };
}

function bytes(hex: unknown): Uint8Array {
  if (typeof hex !== "string") throw new TypeError("Missing hex");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
/** The recorder's `decode`. */
export function decodeArgument(value: unknown, callback: (...args: unknown[]) => void): unknown {
  if (Array.isArray(value)) return value.map(item => decodeArgument(item, callback));
  if (value === null || typeof value !== "object") return value;
  const tag: unknown = Reflect.get(value, "$");
  if (typeof tag === "string") {
    switch (tag) {
      case "undefined": return undefined;
      case "cb": return callback;
      case "fn": return function () { return undefined; };
      case "sym": return Symbol("s");
      case "big": return BigInt(String(Reflect.get(value, "v")));
      case "buffer": return Buffer.from(bytes(Reflect.get(value, "hex")));
      case "u8": return bytes(Reflect.get(value, "hex"));
      case "u16": return new Uint16Array(bytes(Reflect.get(value, "hex")).buffer);
      case "ab": return bytes(Reflect.get(value, "hex")).buffer;
      case "dv": return new DataView(bytes(Reflect.get(value, "hex")).buffer);
      default: throw new TypeError(`Unknown argument tag ${tag}`);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeArgument(item, callback)]));
}

function details(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]: [string, unknown]) => [key, typeof item === "bigint" ? `${String(item)}n` : item]));
}
const constructorName = (value: object): unknown => { const made: unknown = Reflect.get(value, "constructor"); return typeof made === "function" ? made.name : undefined; };

/** The recorder's `summary`; `isKeyObject` stands for `instanceof crypto.KeyObject`. */
export function summarize(value: unknown, isKeyObject: (value: unknown) => boolean): Json {
  const again = (item: unknown): Json => summarize(item, isKeyObject);
  if (value === undefined) return { t: "undefined" };
  if (value === null) return { t: "null" };
  if (typeof value === "bigint") return { t: "bigint", bits: value === 0n ? 0 : value.toString(2).length };
  if (typeof value === "string") return { t: "string", line: value.split("\n")[0] };
  if (typeof value !== "object") return { t: typeof value, v: value };
  if (value instanceof Error) {
    const out: Json = { t: "error", name: value.name, message: value.message };
    if (value instanceof VMError) return { t: "refused", code: value.code };
    for (const key of ["code", "library", "reason", "opensslErrorStack"]) { const item: unknown = Reflect.get(value, key); if (item !== undefined) out[key] = item; }
    out["own"] = Object.keys(value);
    return out;
  }
  if (value instanceof ArrayBuffer) return { t: "ArrayBuffer", bytes: value.byteLength };
  if (Buffer.isBuffer(value)) return { t: "Buffer" };
  if (isKeyObject(value)) {
    const type: unknown = Reflect.get(value, "type");
    const out: Json = { t: "KeyObject", ctor: constructorName(value), type };
    if (type === "secret") out["size"] = Reflect.get(value, "symmetricKeySize");
    else { out["akt"] = Reflect.get(value, "asymmetricKeyType"); out["details"] = details(Reflect.get(value, "asymmetricKeyDetails")); }
    return out;
  }
  if ("publicKey" in value && "privateKey" in value) return { t: "pair", keys: Object.keys(value), publicKey: again(value.publicKey), privateKey: again(value.privateKey) };
  const kty: unknown = Reflect.get(value, "kty");
  if (typeof kty === "string") { const crv: unknown = Reflect.get(value, "crv"); return { t: "jwk", kty, ...(crv === undefined ? {} : { crv }), keys: Object.keys(value).sort() }; }
  return { t: "object", ctor: constructorName(value) };
}

/** Ports whose dispatch is a later macrotask, counting holds and recording how long each turn ran. */
export function testPorts(): CryptoPorts & { readonly held: () => number; readonly turns: number[] } {
  let held = 0;
  const turns: number[] = [];
  return {
    retain: () => { held += 1; let released = false; return () => { if (!released) { released = true; held -= 1; } }; },
    dispatch: callback => { setTimeout(() => { const start = performance.now(); try { callback(); } finally { turns.push(performance.now() - start); } }, 0); },
    held: () => held, turns,
  };
}

export interface Replayed { readonly returned?: Json; readonly threw?: Json; readonly callback?: Json; readonly warnings?: unknown[] }
/** Runs one case against an implementation, as the recorder runs it against Node. */
export async function replay(item: ControlCase, operation: unknown, isKeyObject: (value: unknown) => boolean, warnings: unknown[][] = []): Promise<Replayed> {
  if (typeof operation !== "function") throw new TypeError(`${item.fn} is not a function`);
  const result: { returned?: Json; threw?: Json; callback?: Json; warnings?: unknown[] } = {};
  let sync = true, settle: (() => void) | undefined;
  const called = new Promise<void>(resolve => { settle = resolve; });
  const callback = function (this: unknown, ...args: unknown[]): void {
    // The recorder's callback is a sloppy function: an undefined receiver shows there as the global object.
    const receiver = this === undefined ? "Object" : this === null ? "null" : typeof this === "object" ? constructorName(this) : typeof this;
    result.callback = { sync, this: receiver, args: args.map(arg => summarize(arg, isKeyObject)) };
    settle?.();
  };
  const args = item.args.map(arg => decodeArgument(arg, callback));
  let expectsCallback = args.includes(callback);
  warnings.length = 0;
  try { result.returned = summarize(Reflect.apply(operation, undefined, args), isKeyObject); }
  catch (error) { result.threw = summarize(error, isKeyObject); expectsCallback = false; }
  sync = false;
  if (expectsCallback) await called;
  if (warnings.length > 0) result.warnings = [...warnings];
  return result;
}
