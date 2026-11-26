import { Buffer } from "buffer/";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { clearRefusedNodeApi } from "./node-capability.js";
import { controlsOf, evaluator, expected, fixtures, harness, hex, isRefusal, outcome, rows, text } from "./node-crypto-sign.test-support.ts";

/** Recorded from Node.js v24.18.1 (OpenSSL 3.5.7) by the script under the file's `recorder` key. */
const controls = controlsOf("node-crypto-rsa-crypt.controls.json");
const { crypto, constants } = harness();
const K = fixtures();
const M = Buffer.from("fast path secret");

/** OAEP digests OpenSSL has and the RSA primitives here do not: refused with a typed error, never computed wrongly. */
const NOT_COMPUTED = new Set(["blake2b512", "blake2s256", "sm3", "md5-sha1"]);
function options(value: unknown): Record<string, unknown> {
  const given = { ...record(value, "options") };
  if (typeof given["oaepLabel"] === "string") given["oaepLabel"] = Buffer.from(given["oaepLabel"], "hex");
  return given;
}
function operation(name: unknown): (key: unknown, buffer: unknown) => Buffer {
  if (name !== "publicEncrypt" && name !== "privateDecrypt" && name !== "privateEncrypt" && name !== "publicDecrypt") throw new TypeError("Unknown operation");
  return crypto[name];
}

describe("recorded behaviour of publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt", () => {
  const cases = rows(controls["cases"], "cases");
  it.each(cases.map(row => [text(row["label"], "label"), row] as const))("%s", (_name, row) => {
    clearRefusedNodeApi();
    const run = evaluator("crypto, Buffer, K, C, M", text(row["expr"], "expr"));
    expect(outcome(() => run(crypto, Buffer, K, constants, M))).toEqual(expected(row));
  });
});

describe("what Node encrypted decrypts here, and deterministic output is made byte for byte", () => {
  const vectors = rows(controls["vectors"], "vectors");
  it.each(vectors.map((row, index) => [`${String(index)} ${text(row["operation"], "operation")} ${text(row["key"], "key")} ${JSON.stringify(row["options"])} ${String(text(row["message"], "message").length / 2)} bytes`, row] as const))("%s", (_name, row) => {
    const given = options(row["options"]), name = text(row["key"], "key"), message = Buffer.from(text(row["message"], "message"), "hex");
    const forward = operation(row["operation"]), back = operation(row["inverse"]);
    const usesPrivate = row["operation"] === "privateEncrypt";
    const first = { key: K[`${name}.${usesPrivate ? "pkcs8" : "spki"}.pem`], ...given }, second = { key: K[`${name}.${usesPrivate ? "spki" : "pkcs8"}.pem`], ...given };
    const made = outcome(() => forward(first, message));
    if (typeof given["oaepHash"] === "string" && NOT_COMPUTED.has(given["oaepHash"])) { expect(isRefusal(made)).toBe(true); return; }
    if (row["throws"] !== undefined) { expect(made).toEqual({ throws: row["throws"] }); return; }
    const recorded = Buffer.from(text(row["output"], "output"), "hex");
    // What Node made, read back here: its plaintext, or the failure Node itself reports for it.
    expect(outcome(() => back(second, recorded))).toEqual(row["back"]);
    const mine = forward(first, message);
    expect(mine.length).toBe(recorded.length);
    if (row["deterministic"] === true) expect(hex(mine)).toBe(hex(recorded));
    else expect(outcome(() => back(second, mine))).toEqual(row["back"]);
  });
});
