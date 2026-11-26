// What the signature and RSA encryption tests share: the fixed keys of node-crypto-keys.controls.json, the
// recorders' serialization of results and failures, and one `crypto` object made of the modules under test.
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { Buffer } from "buffer/";
import * as stream from "readable-stream";
import { record } from "../../decode.js";
import { nodeConstantsModule } from "./node-constants.ts";
import { createCryptoKeys } from "./node-crypto-keys.ts";
import { createCryptoMisc } from "./node-crypto-misc.ts";
import { createCryptoRsaCrypt } from "./node-crypto-rsa-crypt.ts";
import { createCryptoSign } from "./node-crypto-sign.ts";

export function controlsOf(name: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")), name);
}
export function text(value: unknown, what: string): string { if (typeof value !== "string") throw new TypeError(`${what} is not a string`); return value; }
export function rows(value: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} is not an array`);
  return value.map((row: unknown) => record(row, what));
}
export function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString("hex"); }

/** The fixtures the recorders' expressions read as `K`. */
export function fixtures(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const source = controlsOf("node-crypto-keys.controls.json");
  const K: Record<string, unknown> = { PASS: source["passphrase"], ...extra };
  for (const [name, value] of Object.entries(record(source["keys"], "keys"))) {
    const entry = record(value, name);
    for (const half of ["public", "private"]) {
      for (const [type, encoded] of Object.entries(record(entry[half], half))) {
        if (type === "jwk") { K[`${name}.${half}.jwk`] = structuredClone(encoded); continue; }
        const both = record(encoded, type);
        const key = half === "public" && type === "pkcs1" ? "pkcs1pub" : type;
        K[`${name}.${key}.pem`] = both["pem"];
        K[`${name}.${key}.der`] = Buffer.from(text(both["der"], "der"), "hex");
      }
    }
    for (const [type, encoded] of Object.entries(record(entry["encrypted"], "encrypted"))) {
      const both = record(encoded, type);
      if (typeof both["pem"] === "string") K[`${name}.enc.${type}.pem`] = both["pem"];
    }
  }
  return K;
}

/** The recorders' serialization of a result, applied to this implementation's result. */
export function serialized(value: unknown): unknown {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "function") return { function: value.name };
  if (Buffer.isBuffer(value)) return { buffer: hex(value) };
  if (Array.isArray(value)) return value.map(serialized);
  if (typeof value !== "object") throw new TypeError("Unexpected result");
  return { object: Object.fromEntries(Object.entries(value).map(([name, member]) => [name, serialized(member)])) };
}
export function failure(error: unknown): { throws: Record<string, unknown> } {
  if (typeof error !== "object" || error === null) return { throws: { thrown: String(error) } };
  const constructor: unknown = Reflect.get(error, "constructor");
  const result: Record<string, unknown> = { name: Reflect.get(error, "name"), ctor: typeof constructor === "function" ? constructor.name : undefined, message: Reflect.get(error, "message") };
  for (const name of ["code", "library", "reason", "function", "opensslErrorStack"]) { const member: unknown = Reflect.get(error, name); if (member !== undefined) result[name] = member; }
  result["keys"] = Object.keys(error);
  return { throws: result };
}
export function outcome(work: () => unknown): unknown {
  try { return { value: serialized(work()) }; }
  catch (error) { return failure(error); }
}
export function expected(row: Record<string, unknown>): unknown { return "throws" in row ? { throws: row["throws"] } : { value: row["value"] }; }
export function isRefusal(result: unknown): boolean {
  const thrown: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "throws") : undefined;
  return typeof thrown === "object" && thrown !== null && Reflect.get(thrown, "code") === "FEATURE_NOT_AVAILABLE";
}

export function evaluator(parameters: string, expression: string): (...values: unknown[]) => unknown {
  const compiled: unknown = runInThisContext(`(function (${parameters}) { return (${expression}); })`);
  if (typeof compiled !== "function") throw new TypeError("Expression did not compile");
  return (...values) => { const result: unknown = Reflect.apply(compiled, undefined, values); return result; };
}

/** `node:crypto` as far as these modules and their neighbours make it, with the callbacks of the asynchronous forms held until `drain`. */
export function harness() {
  const queued: (() => void)[] = []; let held = 0, released = 0;
  const ports = { retain: () => { held += 1; return () => { released += 1; }; }, dispatch: (callback: () => void) => { queued.push(callback); } };
  const keys = createCryptoKeys();
  const misc = createCryptoMisc(ports, { keyBytes: keys.keyBytes });
  const crypto = { ...keys, createHash: misc.createHash, constants: misc.constants, ...createCryptoSign(ports, keys), ...createCryptoRsaCrypt(keys) };
  return { crypto, constants: nodeConstantsModule, stream, counts: (): [number, number] => [held, released], drain: () => { for (const callback of queued.splice(0)) callback(); } };
}
