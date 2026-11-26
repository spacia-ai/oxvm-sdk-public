import { Buffer as NativeBuffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { nodeConstantsModule } from "./node-constants.ts";
import { createCryptoMisc, digestFor, hashFor, SUPPORTED_HASHES } from "./node-crypto-misc.ts";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node --no-deprecation record-misc.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-crypto-misc.controls.json", import.meta.url), "utf8")), "crypto misc controls");
const list = (name: string): readonly Readonly<Record<string, unknown>>[] => {
  const value = control[name];
  if (!Array.isArray(value)) throw new TypeError(`${name} is not a list`);
  return value.map((entry: unknown) => record(entry, name));
};
function harness(keyBytes?: (value: unknown) => Uint8Array | undefined) {
  const queued: (() => void)[] = []; let held = 0, released = 0;
  const crypto = createCryptoMisc({ retain: () => { held += 1; return () => { released += 1; }; }, dispatch: callback => { queued.push(callback); } }, keyBytes === undefined ? {} : { keyBytes });
  return { crypto, queued, counts: () => [held, released], drain: () => { for (const callback of queued.splice(0)) callback(); } };
}
/** The recorder's own serialisation of a result. */
function ser(value: unknown): unknown {
  if (value === undefined) return { $: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $: "number", text: String(value) };
  if (typeof value === "function") return { $: "function", name: value.name };
  if (Array.isArray(value)) return value.map(ser);
  if (value instanceof ArrayBuffer) return { $: "ArrayBuffer", hex: NativeBuffer.from(value).toString("hex") };
  if (value instanceof Uint8Array) return { $: value.constructor.name, hex: NativeBuffer.from(value).toString("hex") };
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return { $: "object", entries: Object.entries(value).map(([key, entry]) => [key, ser(entry)]) };
  return { $: "instance", name: typeof value === "object" ? value.constructor.name : typeof value };
}
function failure(error: unknown, fields: readonly string[]): unknown {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const own = record(error, "error");
  return Object.fromEntries(fields.map(field => [field, field === "constructor" ? error.constructor.name : field === "name" ? error.name : field === "message" ? error.message : field === "keys" ? Object.keys(error) : own[field] ?? null]));
}
function evaluate(expression: string, crypto: object): unknown {
  const compiled: unknown = runInThisContext(`(function (c, B) { return (${expression}); })`);
  if (typeof compiled !== "function") throw new TypeError("not a function");
  return Reflect.apply(compiled, undefined, [crypto, NativeBuffer]);
}

it("was recorded from pinned Node", () => {
  expect([control["node"], control["openssl"]]).toEqual(["v24.18.1", "3.5.7"]);
});

it("answers every recorded expression as pinned Node does: results, error classes, codes and messages", () => {
  const { crypto, drain } = harness();
  const differences: unknown[] = [];
  for (const entry of list("cases")) {
    const expression = String(entry["expression"]);
    let actual: unknown;
    try { actual = { expression, value: ser(evaluate(expression, crypto)) }; }
    catch (error) { actual = { expression, error: failure(error, Object.keys(record(entry["error"] ?? {}, "error"))) }; }
    drain();
    if (JSON.stringify(actual) !== JSON.stringify(entry)) differences.push({ expected: entry, actual });
  }
  expect(differences).toEqual([]);
  expect(list("cases").length).toBeGreaterThan(180);
});

it("resolves every digest name as OpenSSL does, for Hash, hash and Hmac", () => {
  const { crypto } = harness();
  const input = String(control["input"]), differences: unknown[] = [];
  let computed = 0;
  for (const entry of list("digests")) {
    const name = String(entry["name"]), digest = digestFor(name);
    const attempt = (work: () => unknown, expected: unknown): void => {
      const wanted = record(expected, "outcome");
      let actual: unknown;
      try { actual = { hex: work() }; computed += 1; }
      catch (error) {
        if (digest?.kind === "unsupported") { expect(error).toBeInstanceOf(VMError); expect(error).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" }); return; }
        actual = { error: failure(error, Object.keys(record(wanted["error"] ?? {}, "error"))) };
      }
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) differences.push({ name, expected: wanted, actual });
    };
    attempt(() => crypto.createHash(name).update(input).digest("hex"), entry["hash"]);
    attempt(() => crypto.hash(name, input), entry["oneShot"]);
    attempt(() => crypto.createHmac(name, "key").update(input).digest("hex"), entry["hmac"]);
  }
  expect(differences).toEqual([]);
  expect(computed).toBeGreaterThan(200);
});

it("lists exactly the hashes it computes, in Node's order", () => {
  const { crypto } = harness();
  const recorded = control["getHashes"];
  if (!Array.isArray(recorded)) throw new TypeError("getHashes");
  // SM3 and MD5-SHA1 are the only digests of pinned Node without an implementation here.
  expect(crypto.getHashes()).toEqual(recorded.filter(name => !["RSA-SM3", "md5-sha1", "sm3", "sm3WithRSAEncryption"].includes(String(name))));
  expect(crypto.getHashes()).toEqual(SUPPORTED_HASHES);
  for (const name of crypto.getHashes()) {
    expect(typeof crypto.createHash(name).update("x").digest("hex")).toBe("string");
    expect(digestFor(name)?.kind === "xof" ? undefined : typeof hashFor(name)).toBe(digestFor(name)?.kind === "xof" ? undefined : "function");
  }
  expect(hashFor("shake128")).toBeUndefined();
  expect(hashFor("nope")).toBeUndefined();
  expect(hashFor("RSA-SHA256")).toBe(hashFor("sha256"));
  const copy = crypto.getHashes(); copy.length = 0;
  expect(crypto.getHashes()).toHaveLength(48);
});

it("fills asynchronously in a later turn, holding the process, and binds Node's job as the receiver", () => {
  const { crypto, queued, counts, drain } = harness();
  const buffer = new Uint8Array(64), seen: unknown[] = [];
  const fill: (...values: unknown[]) => unknown = crypto.randomFill;
  const returned = Reflect.apply(fill, undefined, [buffer, 8, 48, function (this: unknown, error: unknown, value: unknown) { seen.push(error, value === buffer, typeof this === "object" && this !== null ? this.constructor.name : this); }]);
  expect(returned).toBeUndefined();
  expect([buffer.every(byte => byte === 0), queued.length, counts(), seen]).toEqual([true, 1, [1, 0], []]);
  drain();
  expect(seen).toEqual([null, true, "RandomBytesJob"]);
  expect(counts()).toEqual([1, 1]);
  expect([...buffer.subarray(0, 8), ...buffer.subarray(56)].every(byte => byte === 0)).toBe(true);
  expect(buffer.subarray(8, 56).some(byte => byte !== 0)).toBe(true);
  // Elements, not bytes, for a wider typed array; whole buffers for an ArrayBuffer, a DataView and shared memory.
  const words = new Uint32Array(8), plain = new ArrayBuffer(32), view = new DataView(new ArrayBuffer(32)), shared = new SharedArrayBuffer(70_000);
  let calls = 0;
  crypto.randomFill(words, 2, 4, () => { calls += 1; }); crypto.randomFill(plain, () => { calls += 1; }); crypto.randomFill(view, () => { calls += 1; }); crypto.randomFill(shared, () => { calls += 1; });
  crypto.randomFill(words, 7, () => { calls += 1; });
  drain();
  expect(calls).toBe(5);
  expect([words[0], words[1], words[6]]).toEqual([0, 0, 0]);
  expect(words.subarray(2, 6).some(word => word !== 0) && words[7] !== 0).toBe(true);
  expect(new Uint8Array(plain).some(byte => byte !== 0) && new Uint8Array(view.buffer).some(byte => byte !== 0)).toBe(true);
  expect(new Uint8Array(shared).subarray(65_536).some(byte => byte !== 0)).toBe(true);
  expect(crypto.randomFillSync(new Uint8Array(100_000)).subarray(99_000).some(byte => byte !== 0)).toBe(true);
});

it("makes version 7 UUIDs: the time first, then random bits", () => {
  const { crypto } = harness();
  const before = Date.now(), made = Array.from({ length: 300 }, () => crypto.randomUUIDv7()), after = Date.now();
  expect(new Set(made).size).toBe(300);
  for (const uuid of made) {
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    const time = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
    expect(time).toBeGreaterThanOrEqual(before); expect(time).toBeLessThanOrEqual(after);
  }
  // The first 48 bits never go backwards while the clock does not.
  const times = made.map(uuid => uuid.slice(0, 13));
  expect([...times].sort()).toEqual(times);
});

it("refuses FIPS mode instead of claiming it, unlike pinned Node on Alpine", () => {
  const { crypto } = harness();
  // Recorded: setFips(true) succeeds there and getFips() answers 1. No FIPS provider exists here, so saying 1 would be false.
  expect(list("setFipsSequence")[1]).toEqual({ value: true, fips: 1 });
  let thrown: unknown;
  try { crypto.setFips(true); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: "ERR_CRYPTO_FIPS_UNAVAILABLE", message: "Cannot set FIPS mode in a non-FIPS build." });
  expect(() => { crypto.setFips(1); }).toThrow();
  expect(crypto.getFips()).toBe(0);
});

it("keys an Hmac from a secret key object through the injected resolver", () => {
  const secret = { type: "secret" }, other = { type: "private" };
  const { crypto } = harness(value => value === secret ? Uint8Array.of(0x6b) : undefined);
  expect(crypto.createHmac("sha256", secret).update("a").digest("hex")).toBe(crypto.createHmac("sha256", "k").update("a").digest("hex"));
  expect(() => crypto.createHmac("sha256", other)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  // The resolver's own refusal (a private key) reaches the caller.
  const refusing = harness(() => { throw Object.assign(new TypeError("Invalid key object type private, expected secret."), { code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE" }); });
  expect(() => refusing.crypto.createHmac("sha256", other)).toThrow(expect.objectContaining({ code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE" }));
});

it("is a stream: written data is hashed and the digest is read", async () => {
  const { crypto } = harness();
  const read = (stream: ReturnType<typeof crypto.createHash> | ReturnType<typeof crypto.createHmac>): Promise<string> => new Promise(resolve => {
    stream.on("data", chunk => { resolve(chunk instanceof Uint8Array ? NativeBuffer.from(chunk).toString("hex") : String(chunk)); });
  });
  const hash = crypto.createHash("sha256"), pending = read(hash);
  hash.write("a"); hash.end(new Uint8Array([98]));
  expect(await pending).toBe(crypto.hash("sha256", "ab"));
  const mac = crypto.createHmac("sha256", "k"), signed = read(mac);
  mac.end("a");
  expect(await signed).toBe("78da91511e675587f5b9df78bedebaf5560da2abb88162ee875dcdf744951d9e");
  // A stream that has given its digest has none left.
  expect(() => hash.digest()).toThrow(expect.objectContaining({ code: "ERR_CRYPTO_HASH_FINALIZED" }));
});

it("resolves the default cipher list on first read and lets a program replace it", () => {
  const first = harness().crypto.constants, second = harness().crypto.constants;
  expect(Object.getOwnPropertyDescriptor(first, "defaultCipherList")).toMatchObject({ enumerable: true, configurable: true });
  expect(first["defaultCipherList"]).toBe(nodeConstantsModule.defaultCoreCipherList);
  expect(Object.getOwnPropertyDescriptor(first, "defaultCipherList")).toEqual({ value: nodeConstantsModule.defaultCoreCipherList, writable: true, enumerable: true, configurable: true });
  second["defaultCipherList"] = "X";
  expect(Object.getOwnPropertyDescriptor(second, "defaultCipherList")).toEqual({ value: "X", writable: true, enumerable: true, configurable: true });
  // One process's replacement is not another's.
  expect(first["defaultCipherList"]).not.toBe("X");
});
