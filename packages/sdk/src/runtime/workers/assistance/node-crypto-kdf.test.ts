import { Buffer as NativeBuffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { createCryptoKdf } from "./node-crypto-kdf.ts";

// Recorded from the real binary by the script under "recorder" (docker run --rm -m 1g node:24.18.1-alpine node record-kdf.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-crypto-kdf.controls.json", import.meta.url), "utf8")), "crypto kdf controls");
const list = (name: string): readonly Readonly<Record<string, unknown>>[] => {
  const value = control[name];
  if (!Array.isArray(value)) throw new TypeError(`${name} is not a list`);
  return value.map((entry: unknown) => record(entry, name));
};
/** Stand-ins for the key objects another module owns. */
class SecretKey { constructor(readonly bytes: Uint8Array) {} }
class PrivateKey { readonly type = "private"; }
function keyBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof PrivateKey) throw Object.assign(new TypeError("Invalid key object type private, expected secret."), { code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE" });
  return value instanceof SecretKey ? value.bytes : undefined;
}
function harness() {
  const queued: (() => void)[] = []; let held = 0, released = 0;
  const kdf = createCryptoKdf({ retain: () => { held += 1; return () => { released += 1; }; }, dispatch: callback => { queued.push(callback); } }, { keyBytes });
  return { kdf, queued, counts: () => [held, released], drain: () => { for (const callback of queued.splice(0)) callback(); } };
}
/** The recorder's tagged argument form. */
function dec(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dec);
  if (value === null || typeof value !== "object") return value;
  const tagged = record(value, "argument"), bytes = (key: string): Uint8Array => Uint8Array.from(NativeBuffer.from(String(tagged[key]), "hex"));
  if ("$hex" in tagged) return NativeBuffer.from(bytes("$hex"));
  if ("$ab" in tagged) return bytes("$ab").buffer;
  if ("$sab" in tagged) { const source = bytes("$sab"), shared = new SharedArrayBuffer(source.length); new Uint8Array(shared).set(source); return shared; }
  if ("$u16" in tagged) return new Uint16Array(Array.isArray(tagged["$u16"]) ? tagged["$u16"].map(Number) : []);
  if ("$f64" in tagged) return new Float64Array(Array.isArray(tagged["$f64"]) ? tagged["$f64"].map(Number) : []);
  if ("$dv" in tagged) return new DataView(bytes("$dv").buffer);
  if ("$num" in tagged) return Number(tagged["$num"]);
  if ("$undefined" in tagged) return undefined;
  if ("$repeat" in tagged) { const repeat: unknown = tagged["$repeat"], parts: unknown[] = Array.isArray(repeat) ? repeat : []; return String(parts[0]).repeat(Number(parts[1])); }
  if ("$alloc" in tagged) return new Uint8Array(Number(tagged["$alloc"]));
  if ("$fn" in tagged) return () => undefined;
  if ("$secret" in tagged) return new SecretKey(bytes("$secret"));
  if ("$private" in tagged) return new PrivateKey();
  return Object.fromEntries(Object.entries(tagged).map(([key, entry]) => [key, dec(entry)]));
}
const args = (entry: Readonly<Record<string, unknown>>): unknown[] => { const decoded = dec(entry["args"]); return Array.isArray(decoded) ? decoded : []; };
/** A result as the recorder wrote it: hex, or length and SHA-256 when long. */
function text(value: unknown): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : undefined;
  if (bytes === undefined) throw new TypeError("not bytes");
  return bytes.length > 128 ? `${String(bytes.length)}:sha256:${createHash("sha256").update(bytes).digest("hex")}` : NativeBuffer.from(bytes).toString("hex");
}
const kind = (value: unknown): string => value instanceof ArrayBuffer ? "ArrayBuffer" : typeof value === "object" && value !== null ? value.constructor.name : typeof value;
function failure(error: unknown): unknown {
  if (!(error instanceof Error)) return { thrown: String(error) };
  return { name: error.name, constructor: error.constructor.name, code: record(error, "error")["code"] ?? null, message: error.message, keys: Object.keys(error) };
}
type Kdf = ReturnType<typeof createCryptoKdf>;
const SYNC = ["pbkdf2Sync", "scryptSync", "hkdfSync", "argon2Sync"] as const, ASYNC = ["pbkdf2", "scrypt", "hkdf", "argon2"] as const;
const call = (kdf: Kdf, name: string, values: unknown[]): unknown => {
  const sync = SYNC.find(candidate => candidate === name), later = ASYNC.find(candidate => candidate === name);
  if (sync !== undefined) return Reflect.apply(kdf[sync], undefined, values);
  if (later !== undefined) return Reflect.apply(kdf[later], undefined, values);
  throw new TypeError(name);
};

it("was recorded from pinned Node", () => {
  expect([control["node"], control["openssl"]]).toEqual(["v24.18.1", "3.5.7"]);
});

for (const name of SYNC) {
  it(`${name} derives the bytes pinned Node derives`, () => {
    const { kdf } = harness(), differences: unknown[] = [];
    for (const entry of list(name)) {
      const result = call(kdf, name, args(entry)), actual = { args: entry["args"], type: kind(result), hex: text(result) };
      if (JSON.stringify(actual) !== JSON.stringify(entry)) differences.push({ expected: entry, actual });
    }
    expect(differences).toEqual([]);
    expect(list(name).length).toBeGreaterThanOrEqual(19);
  }, 120_000);
  it(`${name} refuses what pinned Node refuses, in its order and words`, () => {
    const { kdf } = harness(), differences: unknown[] = [];
    for (const entry of list(`${name}Errors`)) {
      let actual: unknown = { args: entry["args"], returned: true };
      try { call(kdf, name, args(entry)); } catch (error) { actual = { args: entry["args"], error: failure(error) }; }
      if (JSON.stringify(actual) !== JSON.stringify(entry)) differences.push({ expected: entry, actual });
    }
    expect(differences).toEqual([]);
    expect(list(`${name}Errors`).length).toBeGreaterThanOrEqual(20);
  });
}

it("refuses the Argon2 tag lengths its library cannot produce, rather than returning a shorter tag", () => {
  const { kdf } = harness();
  expect(list("argon2SyncUnsupported")).toHaveLength(3);
  for (const entry of list("argon2SyncUnsupported")) {
    let thrown: unknown;
    try { call(kdf, "argon2Sync", args(entry)); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(VMError);
    expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  }
  expect(() => kdf.pbkdf2Sync("p", "s", 1, 8, "sm3")).toThrow(VMError);
  expect(() => kdf.hkdfSync("md5-sha1", "k", "s", "i", 8)).toThrow(VMError);
});

it("pins the names and lengths programs can read", () => {
  const { kdf } = harness();
  expect(Object.fromEntries(Object.entries(kdf).map(([name, operation]) => [name, { name: operation.name, length: operation.length }]))).toEqual(control["functions"]);
});

it("validates the callback forms at once and throws what Node throws before queueing", () => {
  const { kdf, queued, counts } = harness(), differences: unknown[] = [];
  for (const entry of list("asyncThrows")) {
    let actual: unknown = { name: entry["name"], args: entry["args"], returned: true };
    try { call(kdf, String(entry["name"]), args(entry)); } catch (error) { actual = { name: entry["name"], args: entry["args"], error: failure(error) }; }
    if (JSON.stringify(actual) !== JSON.stringify(entry)) differences.push({ expected: entry, actual });
  }
  expect(differences).toEqual([]);
  expect([queued.length, counts()]).toEqual([0, [0, 0]]);
});

it("derives in a later turn while holding the process, and calls back as Node does", () => {
  const { kdf, queued, counts, drain } = harness(), differences: unknown[] = [];
  for (const entry of list("asyncCalls")) {
    let actual: unknown = "not called";
    const returned = call(kdf, String(entry["name"]), [...args(entry), function (this: unknown, ...results: unknown[]) {
      const [error, value] = results, shared = { name: entry["name"], args: entry["args"], returned: null, arity: results.length, receiver: kind(this) };
      actual = error === null ? { ...shared, type: kind(value), hex: text(value) } : { ...shared, error: failure(error) };
    }]);
    // Nothing ran yet: the process is held and the work waits in its queue.
    const [held = 0, released = 0] = counts();
    expect([returned, actual, queued.length, held - released]).toEqual([undefined, "not called", 1, 1]);
    drain();
    if (JSON.stringify(actual) !== JSON.stringify(entry)) differences.push({ expected: entry, actual });
  }
  expect(differences).toEqual([]);
  expect(counts()).toEqual([9, 9]);
});

it("derives from the bytes it was given, whatever the caller writes afterwards", () => {
  const { kdf, drain } = harness();
  const password = new Uint8Array([1, 2, 3]), salt = new Uint8Array([4, 5, 6, 7, 8, 9, 10, 11]), seen: string[] = [];
  const keep = (_error: unknown, value: unknown): void => { seen.push(text(value)); };
  kdf.pbkdf2(password, salt, 2, 16, "sha256", keep); kdf.scrypt(password, salt, 16, { N: 16 }, keep); kdf.hkdf("sha256", password, salt, salt, 16, keep);
  kdf.argon2("argon2id", { message: password, nonce: salt, parallelism: 1, tagLength: 16, memory: 8, passes: 1 }, keep);
  const expected = [text(kdf.pbkdf2Sync(password, salt, 2, 16, "sha256")), text(kdf.scryptSync(password, salt, 16, { N: 16 })), text(kdf.hkdfSync("sha256", password, salt, salt, 16)),
    text(kdf.argon2Sync("argon2id", { message: password, nonce: salt, parallelism: 1, tagLength: 16, memory: 8, passes: 1 }))];
  password.fill(0); salt.fill(0);
  drain();
  expect(seen).toEqual(expected);
});

it("lets a callback's own failure reach the process's dispatcher after the hold is released", () => {
  const { kdf, queued, counts } = harness();
  kdf.pbkdf2("p", "s", 1, 8, "sha256", () => { throw new Error("from the program"); });
  expect(() => queued[0]?.()).toThrow("from the program");
  expect(counts()).toEqual([1, 1]);
});
