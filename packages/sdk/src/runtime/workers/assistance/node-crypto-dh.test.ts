import { readFileSync } from "node:fs";
import { Buffer } from "buffer/";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { bitLength, bytesToBigInt, modPow } from "./node-crypto-bigint.js";
import { createCryptoDh } from "./node-crypto-dh.js";
import { call, evaluator, expected, failure, integer, outcome, rows, serialized, text } from "./node-crypto-dh.test-support.js";
import { createCryptoEcdh } from "./node-crypto-ecdh.js";
import { createCryptoKeys } from "./node-crypto-keys.js";
import type { CryptoPorts } from "./node-crypto-ports.js";
import { isProbablePrime } from "./node-crypto-primes.js";

/** Recorded from Node.js v24.18.1 by the script under the file's `recorder` key. */
const controls = record(JSON.parse(readFileSync(new URL("./node-crypto-dh.controls.json", import.meta.url), "utf8")), "DH controls");
const V = record(controls["V"], "V"), K = record(controls["K"], "K");
const groups = record(V["groups"], "groups"), custom = record(V["custom"], "custom");

/** A process whose later turns run when the test says so. */
function process() {
  const queue: (() => void)[] = [];
  let retained = 0;
  const ports: CryptoPorts = { retain: () => { retained += 1; return () => { retained -= 1; }; }, dispatch: callback => { queue.push(callback); } };
  const keys = createCryptoKeys();
  const crypto = { ...createCryptoDh(ports, keys), ...createCryptoEcdh(), createPrivateKey: keys.createPrivateKey, createPublicKey: keys.createPublicKey, createSecretKey: keys.createSecretKey };
  return { crypto, retained: () => retained, turn: () => { for (const callback of queue.splice(0)) callback(); } };
}
const { crypto } = process();
const entropy = (bytes: Uint8Array): void => { bytes.set(globalThis.crypto.getRandomValues(new Uint8Array(bytes.length))); };
function number(hex: unknown): bigint { return bytesToBigInt(Buffer.from(text(hex, "hex"), "hex")); }
function bits(key: unknown): number { if (!Buffer.isBuffer(key)) throw new TypeError("Not a buffer"); return bitLength(bytesToBigInt(key)); }

/** Fixed private keys of one prime and generator: Node's public keys and secrets, and its padding. */
function checkVectors(prime: unknown, generator: number, vectors: Record<string, unknown>): void {
  const keys = rows(vectors["keys"], "keys");
  const make = (privateKey: unknown): object => { const dh = crypto.createDiffieHellman(prime, "hex", generator); call(dh, "setPrivateKey", privateKey, "hex"); return dh; };
  for (const key of keys) {
    const dh = make(key["private"]);
    expect(call(dh, "generateKeys", "hex")).toBe(key["public"]);
    expect(call(dh, "getPublicKey", "hex")).toBe(key["public"]);
    expect(call(dh, "getPrivateKey", "hex")).toBe(key["private"]);
  }
  const secrets = rows(vectors["secrets"], "secrets");
  expect(secrets).toHaveLength(10);
  for (const row of secrets) {
    const a = keys[integer(row["a"], "a")], b = keys[integer(row["b"], "b")];
    if (a === undefined || b === undefined) throw new TypeError("Missing key");
    expect(call(make(a["private"]), "computeSecret", b["public"], "hex", "hex")).toBe(row["secret"]);
    expect(call(make(b["private"]), "computeSecret", a["public"], "hex", "hex")).toBe(row["secret"]);
  }
  // A secret with leading zero bytes keeps the prime's length; a public key shorter than the prime is not padded.
  const zero = record(vectors["leadingZero"], "leadingZero");
  const peer = keys[integer(zero["peer"], "peer")];
  expect(text(zero["secret"], "secret").startsWith("00")).toBe(true);
  expect(text(zero["secret"], "secret")).toHaveLength(text(prime, "prime").length);
  expect(call(make(zero["private"]), "computeSecret", peer?.["public"], "hex", "hex")).toBe(zero["secret"]);
  const short = record(vectors["shortPublic"], "shortPublic");
  expect(text(short["public"], "public").length).toBeLessThan(text(prime, "prime").length);
  expect(call(make(short["private"]), "generateKeys", "hex")).toBe(short["public"]);
}

describe("node:crypto Diffie-Hellman against Node's vectors", () => {
  it.each(["modp1", "modp5", "modp14"])("%s: fixed private keys give Node's public keys and secrets", name => {
    const group = record(groups[name], name);
    checkVectors(group["prime"], 2, record(group["vectors"], "vectors"));
  });
  it.each([["2", 2], ["2", 5], ["3", 2], ["3", 5], ["5", 2], ["5", 5]] as const)("custom 512-bit safe prime made for generator %s, used with generator %i", (made, generator) => {
    const entry = record(custom[made], "custom");
    expect(text(entry["prime"], "prime")).toHaveLength(128);
    checkVectors(entry["prime"], generator, record(record(entry["vectors"], "vectors")[String(generator)], "vectors"));
  });
  it.each(Object.keys(groups))("%s: the group has Node's parameters and private exponents of OpenSSL's size", name => {
    const group = record(groups[name], name), exponent = record(group["exponent"], "exponent");
    const dh = crypto.getDiffieHellman(name);
    expect(call(dh, "getPrime", "hex")).toBe(group["prime"]);
    expect(call(dh, "getGenerator", "hex")).toBe(group["generator"]);
    expect(Reflect.get(dh, "verifyError")).toBe(group["verifyError"]);
    const max = integer(exponent["max"], "max"), primeBits = bitLength(number(group["prime"]));
    const fixed = exponent["min"] === max;
    // OpenSSL: two bits less than the prime, top bit set (modp1, modp2); at most N bits for the groups it knows by name.
    expect(max).toBe(fixed ? primeBits - 2 : { modp5: 200, modp14: 225, modp15: 275, modp16: 325, modp17: 375, modp18: 400 }[name]);
    let longest = 0;
    for (let run = 0; run < (primeBits > 4096 ? 2 : 12); run += 1) {
      const other = crypto.getDiffieHellman(name);
      const publicKey = call(other, "generateKeys"), size = bits(call(other, "getPrivateKey"));
      if (fixed) expect(size).toBe(max); else { expect(size).toBeLessThanOrEqual(max); expect(size).toBeGreaterThan(max - 40); }
      longest = Math.max(longest, size);
      if (run > 0) continue;
      // Both sides agree, and the public key is g^x mod p.
      const mine = call(dh, "generateKeys");
      if (!Buffer.isBuffer(mine) || !Buffer.isBuffer(publicKey)) throw new TypeError("Not a buffer");
      expect(bytesToBigInt(mine)).toBe(modPow(2n, bytesToBigInt(Buffer.from(text(call(dh, "getPrivateKey", "hex"), "private"), "hex")), number(group["prime"])));
      const secret = call(dh, "computeSecret", publicKey, null, "hex");
      expect(call(other, "computeSecret", mine, null, "hex")).toBe(secret);
      expect(text(secret, "secret")).toHaveLength(2 * integer(group["publicLength"], "publicLength"));
    }
    if (!fixed) expect(longest).toBeGreaterThan(max - 8);
  });
  it("draws the private exponent as OpenSSL does for parameters given as numbers", () => {
    const sizes = (prime: unknown, generator: number, runs: number): { min: number; max: number; odd: number } => {
      let min = Infinity, max = 0, odd = 0;
      for (let run = 0; run < runs; run += 1) {
        const dh = crypto.createDiffieHellman(prime, "hex", generator);
        call(dh, "generateKeys");
        const key = call(dh, "getPrivateKey");
        if (!Buffer.isBuffer(key)) throw new TypeError("Not a buffer");
        min = Math.min(min, bits(key)); max = Math.max(max, bits(key)); odd += (key[key.length - 1] ?? 0) & 1;
      }
      return { min, max, odd };
    };
    const modp14 = record(groups["modp14"], "modp14");
    // The numbers of a group OpenSSL knows by name get its short exponent; with another generator they do not.
    expect(integer(record(modp14["customExponent"], "exponent")["max"], "max")).toBe(225);
    expect(sizes(modp14["prime"], 2, 12).max).toBeLessThanOrEqual(225);
    expect(record(modp14["customExponentGenerator5"], "exponent")).toMatchObject({ min: 2046, max: 2046 });
    expect(sizes(modp14["prime"], 5, 2)).toMatchObject({ min: 2046, max: 2046 });
    expect(integer(record(record(V["ffdhe2048"], "ffdhe2048")["exponent"], "exponent")["max"], "max")).toBe(225);
    expect(sizes(record(V["ffdhe2048"], "ffdhe2048")["prime"], 2, 12).max).toBeLessThanOrEqual(225);
    for (const made of ["2", "3", "5"]) {
      const entry = record(custom[made], "custom");
      for (const generator of [2, 3, 5]) {
        const recorded = record(record(entry["exponent"], "exponent")[String(generator)], "exponent");
        expect(recorded).toMatchObject({ min: 510, max: 510 });
        const ours = sizes(entry["prime"], generator, 12);
        expect(ours).toMatchObject({ min: 510, max: 510 });
        // Generator 2 with bit 2 of the prime clear: OpenSSL clears the lowest bit of the exponent.
        const even = generator === 2 && (number(entry["prime"]) & 4n) === 0n;
        expect(recorded["odd"] === 0).toBe(even);
        expect(ours.odd === 0).toBe(even);
      }
    }
    expect((number(record(custom["3"], "custom")["prime"]) & 4n) === 0n).toBe(true);
  }, 30_000);
  it("generates safe primes with the residues OpenSSL chooses for the generator", () => {
    for (const row of rows(V["generated"], "generated")) {
      const size = integer(row["bits"], "bits"), generator = integer(row["generator"], "generator");
      expect(row).toMatchObject({ verifyError: 0, bitLength: size, mod12: 11, safe: true });
      expect(row).toMatchObject(row["generatorOut"] === "02" ? { mod24: 23 } : row["generatorOut"] === "05" ? { mod60: 59 } : {});
      if (size > 520) continue;
      const dh = crypto.createDiffieHellman(size, generator);
      const prime = number(call(dh, "getPrime", "hex"));
      expect(call(dh, "getGenerator", "hex")).toBe(row["generatorOut"]);
      expect(Object.getOwnPropertyDescriptor(dh, "verifyError")).toEqual({ value: 0, writable: false, enumerable: true, configurable: false });
      expect(bitLength(prime)).toBe(size);
      expect(Number(prime % 24n)).toBe(row["generatorOut"] === "02" ? 23 : Number(prime % 24n));
      expect(Number(prime % 60n)).toBe(row["generatorOut"] === "05" ? 59 : Number(prime % 60n));
      expect(Number(prime % 12n)).toBe(11);
      expect(isProbablePrime(prime, 16, entropy) && isProbablePrime(prime >> 1n, 16, entropy)).toBe(true);
      expect(text(call(dh, "generateKeys", "hex"), "key").length).toBeGreaterThan(100);
    }
  });
  it("reports DH_check's flags as verifyError", () => {
    expect(V["constants"]).toEqual({ DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_CHECK_P_NOT_PRIME: 1, DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8 });
    const table = rows(V["verifyError"], "verifyError");
    expect(table.length).toBeGreaterThan(170);
    for (const row of table) {
      const generator = typeof row["generator"] === "number" ? row["generator"] : Buffer.from(text(record(row["generator"], "generator")["hex"], "hex"), "hex");
      const result = outcome(() => Reflect.get(crypto.createDiffieHellman(Buffer.from(text(row["prime"], "prime"), "hex"), generator), "verifyError"));
      expect([row["label"], result]).toEqual([row["label"], typeof row["verifyError"] === "number" ? { value: row["verifyError"] } : row["verifyError"]]);
    }
  });
  it("puts off the primality tests of a large unknown prime until verifyError is read", () => {
    const dh = crypto.createDiffieHellman(Buffer.from((number(record(groups["modp14"], "modp14")["prime"]) + 2n).toString(16), "hex"));
    expect(Object.keys(dh)).toEqual(["verifyError"]);
    expect(Object.getOwnPropertyDescriptor(dh, "verifyError")).toMatchObject({ enumerable: true, configurable: true });
    expect(Reflect.get(dh, "verifyError")).toBe(1);
    expect(Object.getOwnPropertyDescriptor(dh, "verifyError")).toEqual({ value: 1, writable: false, enumerable: true, configurable: false });
  });
  it("refuses the peers OpenSSL refuses for the groups it knows by name", () => {
    const makers: Record<string, () => object> = {
      "modp14 group": () => crypto.getDiffieHellman("modp14"), "modp14 custom": () => crypto.createDiffieHellman(record(groups["modp14"], "modp14")["prime"], "hex"),
      "modp14 custom g=5": () => crypto.createDiffieHellman(record(groups["modp14"], "modp14")["prime"], "hex", 5), "modp5 group": () => crypto.getDiffieHellman("modp5"),
      "modp2 group": () => crypto.getDiffieHellman("modp2"), "ffdhe2048 custom": () => crypto.createDiffieHellman(record(V["ffdhe2048"], "ffdhe2048")["prime"], "hex"),
      "custom 512": () => crypto.createDiffieHellman(record(custom["2"], "custom")["prime"], "hex"),
    };
    let refused = 0;
    for (const row of rows(V["residues"], "residues")) {
      for (const [name, make] of Object.entries(makers)) {
        const dh = make();
        call(dh, "generateKeys");
        const result = outcome(() => { const secret = call(dh, "computeSecret", Buffer.from([integer(row["y"], "y")])); return Buffer.isBuffer(secret) ? secret.length : secret; });
        expect([row["y"], name, result]).toEqual([row["y"], name, row[name]]);
        if ("throws" in record(row[name], name)) refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(5);
  });
});

describe("node:crypto Diffie-Hellman behaves as Node's", () => {
  const cases = rows(controls["cases"], "cases");
  it.each(cases.map(row => [text(row["label"], "label"), row] as const))("%s", (_label, row) => {
    const run = evaluator("crypto, Buffer, V, K", text(row["expr"], "expr"));
    expect(outcome(() => run(process().crypto, Buffer, V, K))).toEqual(expected(row));
  });

  const asyncCases = rows(controls["asyncCases"], "asyncCases");
  it.each(asyncCases.map(row => [text(row["label"], "label"), row] as const))("callback form: %s", (_label, row) => {
    const host = process();
    const start = evaluator("crypto, Buffer, V, K", `(() => { const priv = n => crypto.createPrivateKey(K[n + '.private']), pub = n => crypto.createPublicKey(K[n + '.public']); return (cb => crypto.diffieHellman(${text(row["expr"], "expr")}, cb)); })()`)(host.crypto, Buffer, V, K);
    if (typeof start !== "function") throw new TypeError("Not a function");
    const result: Record<string, unknown> = {};
    let returned = false;
    try {
      const value: unknown = Reflect.apply(start, undefined, [function (this: unknown, ...args: unknown[]): void {
        const [error, secret] = args;
        const constructor: unknown = typeof this === "object" && this !== null ? Reflect.get(this, "constructor") : undefined;
        result["callback"] = { beforeReturn: !returned, argumentCount: args.length, receiver: typeof constructor === "function" ? constructor.name : undefined,
          ...(error !== null && error !== undefined ? { error: failure(error) } : { error: serialized(error), secret: serialized(secret) }) };
      }]);
      returned = true;
      result["returned"] = serialized(value);
      // The work happens in a later turn, and the process is kept alive until then.
      expect(result["callback"]).toBeUndefined();
      expect(host.retained()).toBe(1);
      host.turn();
      expect(host.retained()).toBe(0);
    } catch (error) { result["throws"] = failure(error); }
    expect(result).toEqual(Object.fromEntries(Object.entries(row).filter(([name]) => name !== "label" && name !== "expr")));
  });
});
