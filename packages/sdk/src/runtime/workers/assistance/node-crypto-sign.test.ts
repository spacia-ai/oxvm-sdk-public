import { Buffer } from "buffer/";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { clearRefusedNodeApi } from "./node-capability.js";
import { controlsOf, evaluator, expected, failure, fixtures, harness, hex, isRefusal, outcome, rows, serialized, text } from "./node-crypto-sign.test-support.ts";

/** Recorded from Node.js v24.18.1 (OpenSSL 3.5.7) by the script under the file's `recorder` key. */
const controls = controlsOf("node-crypto-sign.controls.json");
const { crypto, constants, stream, counts, drain } = harness();
const K = fixtures(record(controls["extraKeys"], "extraKeys"));
const D = Buffer.from(text(controls["data"], "data"), "hex");

/** Digests pinned Node signs with and nothing here computes: the refusal is a typed error, never a wrong signature. */
const NOT_COMPUTED = new Set(["sm3", "md5-sha1"]);
/**
 * Recorded behaviour this implementation refuses instead of reproducing: SM3 and MD5-SHA1 (no implementation), and
 * RSA_X931_PADDING, an ANSI X9.31 signature scheme OpenSSL still has and nothing here implements.
 */
const REFUSED = new Set(["createSign('sm3')", "createSign('md5-sha1')", "sign rsa padding X931", "verify rsa padding X931", "x931 one-shot"]);
/** An ECDSA signature in DER is 68 to 72 bytes on a 256-bit curve, whatever made it: only that it is one can be compared. */
function withoutDerLength(value: unknown): unknown { return typeof value === "number" && value >= 68 && value <= 72 ? "DER ECDSA signature length" : value; }
function comparable(result: unknown): unknown {
  const value: unknown = typeof result === "object" && result !== null && "value" in result ? result.value : undefined;
  return value === undefined ? result : { value: withoutDerLength(value) };
}
function options(value: unknown): Record<string, unknown> {
  const given = { ...record(value, "options") };
  if (typeof given["context"] === "string") given["context"] = Buffer.from(given["context"], "hex");
  return given;
}
function bytes(value: unknown, what: string): Buffer { return Buffer.from(text(value, what), "hex"); }
function algorithmOf(row: Record<string, unknown>): string | null | undefined {
  const algorithm = row["algorithm"];
  return typeof algorithm === "string" ? algorithm : "algorithm" in row ? null : undefined;
}
const label = (row: Record<string, unknown>): string => `${text(row["key"], "key")} ${String(row["algorithm"])} ${JSON.stringify(row["options"] ?? [row["signOptions"], row["verifyOptions"]]).slice(0, 90)}`;

describe("recorded behaviour of sign, verify, Sign and Verify", () => {
  const cases = rows(controls["cases"], "cases");
  it.each(cases.map(row => [text(row["label"], "label"), row] as const))("%s", (name, row) => {
    clearRefusedNodeApi();
    const run = evaluator("crypto, Buffer, K, C, D, stream", text(row["expr"], "expr"));
    const actual = outcome(() => run(crypto, Buffer, K, constants, D, stream));
    if (REFUSED.has(name)) { expect(isRefusal(actual)).toBe(true); clearRefusedNodeApi(); return; }
    expect(comparable(actual)).toEqual(comparable(expected(row)));
  });
});

describe("signatures Node made verify here, and deterministic ones are made byte for byte", () => {
  const vectors = rows(controls["vectors"], "vectors");
  it.each(vectors.map((row, index) => [`${String(index)} ${label(row)}`, row] as const))("%s", (_name, row) => {
    const algorithm = algorithmOf(row), given = options(row["options"]), name = text(row["key"], "key");
    const priv = { key: K[`${name}.pkcs8.pem`], ...given }, pub = { key: K[`${name}.spki.pem`], ...given };
    const made = outcome(() => crypto.sign(algorithm, D, priv));
    if (typeof algorithm === "string" && NOT_COMPUTED.has(algorithm)) { expect(isRefusal(made)).toBe(true); return; }
    if (row["sign"] !== undefined) expect(made).toEqual({ throws: row["sign"] });
    else {
      const recorded = bytes(row["signature"], "signature");
      expect(crypto.verify(algorithm, D, pub, recorded)).toBe(true);
      expect(crypto.verify(algorithm, Buffer.from("other data"), pub, recorded)).toBe(false);
      const mine = crypto.sign(algorithm, D, priv);
      if (mine === undefined) throw new TypeError("No signature");
      if (row["deterministic"] === true) expect(hex(mine)).toBe(hex(recorded));
      else {
        expect(crypto.verify(algorithm, D, pub, mine)).toBe(true);
        if (given["dsaEncoding"] === "ieee-p1363" || !name.startsWith("p") && !name.startsWith("k")) expect(mine.length).toBe(recorded.length);
      }
    }
    if (typeof algorithm !== "string") return;
    const streamed = outcome(() => crypto.createSign(algorithm).update(D).sign(priv));
    if (row["streamSign"] !== undefined) { expect(streamed).toEqual({ throws: row["streamSign"] }); return; }
    const recorded = bytes(row["streamed"], "streamed");
    expect(crypto.createVerify(algorithm).update(D).verify(pub, recorded)).toBe(true);
    expect(crypto.createVerify(algorithm).update("other data").verify(pub, recorded)).toBe(false);
    if (row["deterministic"] === true) expect(streamed).toEqual({ value: { buffer: hex(recorded) } });
    else expect(crypto.createVerify(algorithm).update(D).verify(pub, crypto.createSign(algorithm).update(D).sign(priv))).toBe(true);
  });
});

describe("which options accept a signature", () => {
  const table = rows(controls["verifyTable"], "verifyTable");
  it.each(table.map((row, index) => [`${String(index)} ${label(row)}`, row] as const))("%s", (_name, row) => {
    const algorithm = algorithmOf(row), pub = { key: K[`${text(row["key"], "key")}.spki.pem`], ...options(row["verifyOptions"]) }, signature = bytes(row["signature"], "signature");
    expect(outcome(() => crypto.verify(algorithm, D, pub, signature))).toEqual(row["oneShot"]);
    if (typeof algorithm === "string") expect(outcome(() => crypto.createVerify(algorithm).update(D).verify(pub, signature))).toEqual(row["streamed"]);
  });
  const mangled = rows(controls["mangled"], "mangled");
  it.each(mangled.map(row => [`${text(row["key"], "key")} ${text(row["label"], "label")}`, row] as const))("mangled ECDSA signature: %s", (_name, row) => {
    const pub = { key: K[`${text(row["key"], "key")}.spki.pem`], dsaEncoding: row["dsaEncoding"] }, signature = bytes(row["signature"], "signature");
    expect(outcome(() => crypto.verify("sha256", D, pub, signature))).toEqual(row["oneShot"]);
    expect(outcome(() => crypto.createVerify("sha256").update(D).verify(pub, signature))).toEqual(row["streamed"]);
  });
});

describe("callback forms", () => {
  const cases = rows(controls["asyncCases"], "asyncCases");
  it.each(cases.map(row => [text(row["label"], "label"), row] as const))("%s", (_name, row) => {
    const calls: unknown[] = [];
    let returned = false;
    const before = counts();
    const callback = function (this: unknown, ...values: unknown[]): void {
      const constructor: unknown = typeof this === "object" && this !== null ? Reflect.get(this, "constructor") : undefined;
      // The recorder's callback is sloppy-mode code: called without a receiver it sees the global object.
      calls.push({ receiver: typeof constructor === "function" ? constructor.name : this === undefined ? "Object" : typeof this, args: values.map(value => value instanceof Error ? failure(value) : serialized(value)), isBuffer: values.map(value => Buffer.isBuffer(value)), afterReturn: returned });
    };
    const result = outcome(() => evaluator("crypto, Buffer, K, C, D, cb", text(row["expr"], "expr"))(crypto, Buffer, K, constants, D, callback));
    returned = true;
    expect(calls).toEqual([]);
    drain();
    expect(result).toEqual("throws" in row ? { throws: row["throws"] } : { value: row["returned"] });
    expect(calls).toEqual(row["calls"]);
    const after = counts();
    // Every job that started kept the process alive until its callback ran.
    expect(after[0] - before[0]).toBe(calls.length);
    expect(after[1] - before[1]).toBe(calls.length);
  });
});
