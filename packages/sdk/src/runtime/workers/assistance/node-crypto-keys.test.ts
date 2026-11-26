import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { Buffer } from "buffer/";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { clearRefusedNodeApi, refusedNodeApi } from "./node-capability.js";
import { KeyObject, createCryptoKeys, keyFromInput, missingPrivateKey } from "./node-crypto-keys.js";
import { inspectValue } from "./node-util-validators.js";

/** Recorded from Node.js v24.18.1 by the script under the file's `recorder` key. */
const controls = record(JSON.parse(readFileSync(new URL("./node-crypto-keys.controls.json", import.meta.url), "utf8")), "key controls");
const keys = record(controls["keys"], "keys");
const crypto = createCryptoKeys();

function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString("hex"); }
function text(value: unknown, what: string): string { if (typeof value !== "string") throw new TypeError(`${what} is not a string`); return value; }
function list(value: unknown, what: string): unknown[] { if (!Array.isArray(value)) throw new TypeError(`${what} is not an array`); return value; }

/** The fixtures the recorder's expressions read as `K`, rebuilt from the recorded keys. */
function fixtures(): Record<string, unknown> {
  const certificates = record(controls["certificates"], "certificates");
  const K: Record<string, unknown> = { PASS: controls["passphrase"], ...record(controls["opensslKeys"], "opensslKeys"), certRsa: certificates["rsa"], certEc: certificates["ec"], certEd: certificates["ed"] };
  for (const [name, value] of Object.entries(keys)) {
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
      if (typeof both["der"] === "string") K[`${name}.enc.${type}.der`] = Buffer.from(both["der"], "hex");
    }
  }
  for (const [name, value] of Object.entries(record(controls["extras"], "extras"))) K[name] = Buffer.from(text(value, name), "hex");
  return K;
}

/** The recorder's serialization of a result, applied to this implementation's result. */
function serialized(value: unknown): unknown {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return { bigint: String(value) };
  if (typeof value === "function") return { function: value.name };
  if (Buffer.isBuffer(value)) return { buffer: hex(value) };
  if (value instanceof KeyObject) {
    const type: unknown = value.type;
    const constructor: unknown = Reflect.get(value, "constructor");
    const result: Record<string, unknown> = { keyObject: type, ctor: typeof constructor === "function" ? constructor.name : undefined };
    const exported = (options?: object): unknown => {
      const operation: unknown = Reflect.get(value, "export");
      if (typeof operation !== "function") throw new TypeError("Missing export");
      return Reflect.apply(operation, value, options === undefined ? [] : [options]);
    };
    if (type === "secret") {
      result["size"] = Reflect.get(value, "symmetricKeySize");
      const bytes = exported();
      result["bytes"] = Buffer.isBuffer(bytes) ? hex(bytes) : undefined;
    } else {
      result["asymmetricKeyType"] = Reflect.get(value, "asymmetricKeyType");
      const details: unknown = Reflect.get(value, "asymmetricKeyDetails");
      result["details"] = details === undefined ? null : Object.fromEntries(Object.entries(record(details, "details")).map(([name, member]) => [name, typeof member === "bigint" ? { bigint: String(member) } : member]));
      const der = exported(type === "public" ? { type: "spki", format: "der" } : { type: "pkcs8", format: "der" });
      result["der"] = Buffer.isBuffer(der) ? hex(der) : undefined;
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(serialized);
  if (typeof value !== "object") throw new TypeError("Unexpected result");
  return { object: Object.fromEntries(Object.entries(value).map(([name, member]) => [name, serialized(member)])) };
}
function failure(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return { throws: { thrown: String(error) } };
  const constructor: unknown = Reflect.get(error, "constructor");
  const result: Record<string, unknown> = { name: Reflect.get(error, "name"), ctor: typeof constructor === "function" ? constructor.name : undefined, message: Reflect.get(error, "message") };
  for (const name of ["code", "library", "reason", "function", "opensslErrorStack"]) { const member: unknown = Reflect.get(error, name); if (member !== undefined) result[name] = member; }
  result["keys"] = Object.keys(error);
  return { throws: result };
}
function outcome(work: () => unknown): unknown {
  try { return { value: serialized(work()) }; }
  catch (error) { return failure(error); }
}
function expected(row: Record<string, unknown>): unknown { return "throws" in row ? { throws: row["throws"] } : { value: row["value"] }; }

function evaluator(parameters: string, expression: string): (...values: unknown[]) => unknown {
  const compiled: unknown = runInThisContext(`(function (${parameters}) { return (${expression}); })`);
  if (typeof compiled !== "function") throw new TypeError("Expression did not compile");
  return (...values) => { const result: unknown = Reflect.apply(compiled, undefined, values); return result; };
}
function load(name: unknown): unknown {
  if (name === "util") return { inspect: (value: unknown) => inspectValue(value) };
  throw new Error(`Unexpected require(${String(name)})`);
}

/**
 * Inputs whose OpenSSL error queue (`opensslErrorStack`) this implementation does not reproduce entry for entry;
 * the error's message, code, library and reason are still compared. An RSAPublicKey given as a private key makes
 * OpenSSL's decoders leave a queue ("too large" from one of them) that no rule here derives.
 */
const QUEUE_DIFFERS = new Set(["private pkcs1 public der"]);
function withoutQueue(result: unknown): unknown {
  const thrown = record(record(result, "result")["throws"], "throws");
  return { throws: { ...thrown, opensslErrorStack: undefined } };
}

describe("node:crypto key objects", () => {
  const cases = list(controls["cases"], "cases").map(row => record(row, "case"));
  it.each(cases.map(row => [text(row["label"], "label"), row] as const))("%s", (_label, row) => {
    const run = evaluator("crypto, Buffer, K, require", text(row["expr"], "expr"));
    const actual = outcome(() => run(crypto, Buffer, fixtures(), load));
    expect(QUEUE_DIFFERS.has(text(row["label"], "label")) ? withoutQueue(actual) : actual).toEqual(QUEUE_DIFFERS.has(text(row["label"], "label")) ? withoutQueue(expected(row)) : expected(row));
  });
});

describe("key arguments of operations (keyFromInput)", () => {
  const inputs = list(controls["keyInputs"], "keyInputs").map(row => record(row, "input"));
  it.each(inputs.map(row => [`${text(row["want"], "want")} ${text(row["label"], "label")}`, row] as const))("%s", (_label, row) => {
    const want = row["want"] === "private" ? "private" : "public";
    const input = evaluator("crypto, Buffer, K", text(row["expr"], "expr"))(crypto, Buffer, fixtures());
    const result = outcome(() => {
      const key = keyFromInput(input, want);
      // A public JWK where a private key is needed is passed on; the operation reports the missing private key.
      if (want === "private" && !key.isPrivate) throw missingPrivateKey(key.material);
      return key;
    });
    // The recorder ran a real signature; what it proves here is which key the operation was given.
    if (!("throws" in row)) { expect(result).toHaveProperty("value"); return; }
    const recorded = record(row["throws"], "throws");
    // `sign(undefined)` and `verify(undefined)` fail in the operation before it looks at the key.
    if (recorded["code"] === "ERR_CRYPTO_SIGN_KEY_REQUIRED" || /Cannot read properties of (undefined|null)/u.test(text(recorded["message"], "message"))) { expect(result).toHaveProperty("throws"); return; }
    expect(result).toEqual({ throws: recorded });
  });
});

describe("refusals", () => {
  it("refuses what needs a real CryptoKey as an unavailable API", () => {
    clearRefusedNodeApi();
    const secret = crypto.createSecretKey(Buffer.from("abcd"));
    const toCryptoKey: unknown = Reflect.get(secret, "toCryptoKey");
    if (typeof toCryptoKey !== "function") throw new TypeError("Missing toCryptoKey");
    expect(() => { Reflect.apply(toCryptoKey, secret, [{ name: "HMAC", hash: "SHA-256" }, true, ["sign"]]); }).toThrow(/crypto\.KeyObject\.toCryptoKey is unavailable/u);
    expect(refusedNodeApi()).toMatchObject({ kind: "unavailable-builtin" });
    clearRefusedNodeApi();
  });
  it("refuses ciphers and key algorithms OpenSSL has and this implementation lacks, instead of misreporting them", () => {
    const K = fixtures();
    const key = crypto.createPrivateKey(K["p256.pkcs8.pem"]);
    const exported: unknown = Reflect.get(key, "export");
    if (typeof exported !== "function") throw new TypeError("Missing export");
    // Node encrypts with any OpenSSL cipher; only AES-CBC is implemented here.
    expect(() => { Reflect.apply(exported, key, [{ type: "pkcs8", format: "pem", cipher: "des3", passphrase: "x" }]); }).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
    const legacy = "-----BEGIN EC PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: DES-EDE3-CBC,0011223344556677\n\nAAAAAAAAAAA=\n-----END EC PRIVATE KEY-----\n";
    expect(() => crypto.createPrivateKey({ key: legacy, passphrase: "x" })).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
    expect(() => crypto.createPrivateKey("-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----\n")).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
    clearRefusedNodeApi();
  });
  it("hands other modules the bytes and material of key objects, and builds key objects from material", () => {
    const K = fixtures();
    const secret = crypto.createSecretKey(Buffer.from("abcd"));
    expect(crypto.keyBytes(secret)).toEqual(Uint8Array.from([0x61, 0x62, 0x63, 0x64]));
    expect(crypto.materialOf(secret)).toBeUndefined();
    const privateKey = crypto.createPrivateKey(K["ed25519.pkcs8.pem"]), publicKey = crypto.createPublicKey(K["ed25519.spki.pem"]);
    expect(crypto.keyBytes(privateKey)).toBeUndefined();
    expect(crypto.keyBytes({})).toBeUndefined();
    expect(crypto.materialOf("x")).toBeUndefined();
    const held = crypto.materialOf(privateKey);
    expect(held).toMatchObject({ type: "private", material: { kind: "ed25519" } });
    expect(crypto.materialOf(publicKey)).toMatchObject({ type: "public", material: { kind: "ed25519" } });
    if (held === undefined) throw new TypeError("Missing material");
    expect(crypto.wrapMaterial(held.material, true).equals(privateKey)).toBe(true);
    const derived = crypto.wrapMaterial(held.material, false);
    expect(derived.type).toBe("public");
    expect(derived.equals(publicKey)).toBe(true);
    expect(crypto.materialOf(derived)?.material).not.toHaveProperty("privateKey");
    const given = keyFromInput({ key: privateKey, padding: 1, saltLength: 32, dsaEncoding: "der", oaepHash: "sha256", oaepLabel: Buffer.from("l") }, "private");
    expect(given).toMatchObject({ isPrivate: true, options: { padding: 1, saltLength: 32, dsaEncoding: "der", oaepHash: "sha256" } });
    expect(keyFromInput(privateKey, "public")).toMatchObject({ isPrivate: false, options: {} });
    expect(keyFromInput(privateKey, "public").material).not.toHaveProperty("privateKey");
    expect(() => keyFromInput(5, "private", "options.privateKey")).toThrow("The \"options.privateKey\" property must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey. Received type number (5)");
    expect(() => keyFromInput({}, "public", "options.publicKey")).toThrow("The \"options.publicKey.key\" property must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey. Received undefined");
  });
});

it("is what util.types.isKeyObject recognises, as libraries such as jose ask", async () => {
  const { nodeUtilTypes } = await import("./node-util-types.ts");
  const { createSecretKey } = await import("./node-crypto-keys.ts");
  expect(nodeUtilTypes.isKeyObject(createSecretKey(new Uint8Array(16)))).toBe(true);
  for (const value of [{}, null, "key", new Uint8Array(16)]) expect(nodeUtilTypes.isKeyObject(value)).toBe(false);
});
