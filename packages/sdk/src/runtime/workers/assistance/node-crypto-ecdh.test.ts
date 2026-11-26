import { readFileSync } from "node:fs";
import { Buffer } from "buffer/";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { call, evaluator, expected, list, outcome, rows, text } from "./node-crypto-dh.test-support.js";
import { createCryptoEcdh } from "./node-crypto-ecdh.js";

/** Recorded from Node.js v24.18.1 by the script under the file's `recorder` key. */
const controls = record(JSON.parse(readFileSync(new URL("./node-crypto-ecdh.controls.json", import.meta.url), "utf8")), "ECDH controls");
const vectors = record(controls["vectors"], "vectors");
const supported = list(controls["supported"], "supported").map(name => text(name, "curve"));
const crypto = createCryptoEcdh();
const FORMATS = ["uncompressed", "compressed", "hybrid"] as const;

describe("node:crypto ECDH against Node's vectors", () => {
  it("lists exactly the curves computed here, in Node's order", () => {
    const all = list(controls["curves"], "curves");
    expect(all).toHaveLength(82);
    expect(crypto.getCurves()).toEqual(all.filter(name => supported.includes(text(name, "curve"))));
    expect(crypto.getCurves()).not.toBe(crypto.getCurves());
  });
  it.each(supported)("%s: fixed private keys give Node's public keys in every format and encoding", curve => {
    const keys = rows(record(vectors[curve], curve)["keys"], "keys");
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      const ecdh = crypto.createECDH(curve);
      call(ecdh, "setPrivateKey", key["private"], "hex");
      expect(call(ecdh, "getPrivateKey", "hex")).toBe(key["privateOut"]);
      for (const format of FORMATS) expect(call(ecdh, "getPublicKey", "hex", format)).toBe(key[format]);
      expect(call(ecdh, "getPublicKey", "base64")).toBe(key["base64"]);
      expect(call(ecdh, "getPublicKey", "base64url", "compressed")).toBe(key["base64url"]);
      expect(call(ecdh, "getPublicKey", "latin1", "compressed")).toBe(key["latin1"]);
      // Every form converts to every other.
      for (const from of FORMATS) for (const to of FORMATS) expect(crypto.ECDH.convertKey(key[from], curve, "hex", "hex", to)).toBe(key[to]);
    }
  });
  it.each(supported)("%s: shared secrets equal Node's from either side and for every form of the peer's key", curve => {
    const entry = record(vectors[curve], curve);
    const keys = rows(entry["keys"], "keys");
    const secrets = rows(entry["secrets"], "secrets");
    expect(secrets.length).toBeGreaterThan(10);
    for (const row of secrets) {
      const a = keys[Number(row["a"])], b = keys[Number(row["b"])];
      if (a === undefined || b === undefined) throw new TypeError("Missing key");
      const left = crypto.createECDH(curve), right = crypto.createECDH(curve);
      call(left, "setPrivateKey", a["private"], "hex");
      call(right, "setPrivateKey", b["private"], "hex");
      for (const format of FORMATS) expect(call(left, "computeSecret", b[format], "hex", "hex")).toBe(row["secret"]);
      expect(call(right, "computeSecret", a["compressed"], "hex", "hex")).toBe(row["secret"]);
    }
    // The X coordinate keeps the field's length when it starts with a zero byte.
    const zero = record(entry["leadingZero"], "leadingZero");
    const peer = keys[Number(zero["peer"])];
    if (peer === undefined) throw new TypeError("Missing key");
    const ecdh = crypto.createECDH(curve);
    call(ecdh, "setPrivateKey", zero["private"], "hex");
    expect(text(zero["secret"], "secret").startsWith("00")).toBe(true);
    expect(call(ecdh, "computeSecret", peer["uncompressed"], "hex", "hex")).toBe(zero["secret"]);
  });
  it.each(supported)("%s: generated pairs agree on a secret", curve => {
    const alice = crypto.createECDH(curve), bob = crypto.createECDH(curve);
    const fromAlice = call(alice, "generateKeys", "hex", "compressed"), fromBob = call(bob, "generateKeys");
    const secret = call(alice, "computeSecret", fromBob, null, "hex");
    expect(call(bob, "computeSecret", fromAlice, "hex", "hex")).toBe(secret);
    expect(text(secret, "secret")).toHaveLength(2 * Math.ceil(text(record(vectors[curve], curve)["order"], "order").length / 2));
  });
});

describe("node:crypto ECDH behaves as Node's", () => {
  const cases = rows(controls["cases"], "cases");
  it.each(cases.map(row => [text(row["label"], "label"), row] as const))("%s", (_label, row) => {
    const run = evaluator("crypto, Buffer, V", text(row["expr"], "expr"));
    expect(outcome(() => run(createCryptoEcdh(), Buffer, vectors))).toEqual(expected(row));
  });
  it("warns once about ecdh.setPublicKey (DEP0031)", () => {
    const warnings: unknown[] = [];
    const warned = createCryptoEcdh((message, type, code) => { warnings.push({ name: type, code, message }); });
    const key = rows(record(vectors["prime256v1"], "curve")["keys"], "keys")[4];
    call(warned.createECDH("prime256v1"), "setPublicKey", key?.["compressed"], "hex");
    call(warned.createECDH("prime256v1"), "setPublicKey", key?.["compressed"], "hex");
    expect(warnings).toEqual(controls["warnings"]);
    expect(warnings).toHaveLength(1);
  });
  it("refuses the curves Node has and this implementation lacks", () => {
    expect(() => crypto.createECDH("secp224r1")).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
    expect(() => crypto.ECDH.convertKey(Buffer.from([0]), "brainpoolP256r1")).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
    const all = list(controls["curves"], "curves").map(name => text(name, "curve"));
    for (const name of all) if (!supported.includes(name)) expect(() => crypto.createECDH(name)).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
  });
});
