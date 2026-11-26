import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { bitLength, bytesToBigInt, gcd, type Entropy } from "./node-crypto-bigint.ts";
import {
  RsaError, digestLength, generateRsaKey, generateRsaKeySteps, hashBytes, mgf1, modulusLength, oaepDecrypt, oaepEncrypt, pkcs1v15Decrypt, pkcs1v15Encrypt,
  pkcs1v15Recover, pkcs1v15Sign, pkcs1v15Verify, pssMaxSaltLength, pssSign, pssVerify, rawPrivate, rawPublic, rsaPrivateOp, rsaPublicOp,
  type HashName, type RsaPrivateNumbers,
} from "./node-crypto-rsa.ts";

// Everything in the controls file was produced by real Node 24.18.1 (OpenSSL 3.5) with the recorder stored
// under its "recorder" key: keys as numbers, signatures, ciphertexts, the bytes implicit rejection returns,
// the error each failure raises, and a survey of the keys OpenSSL generates.
const control = record(JSON.parse(readFileSync(new URL("./node-crypto-rsa.controls.json", import.meta.url), "utf8")), "rsa controls");
const rows = (name: string): Record<string, unknown>[] => {
  const value = control[name];
  if (!Array.isArray(value)) throw new Error(`${name} is not a list`);
  return value.map((row: unknown, index) => record(row, `${name}[${String(index)}]`));
};
const text = (row: Record<string, unknown>, key: string): string => string(row[key], key);
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const big = (hex: string): bigint => BigInt(`0x${hex}`);

const HASH_NAMES: readonly HashName[] = ["sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "md5", "ripemd160"];
function hashName(value: string): HashName {
  const found = HASH_NAMES.find(name => name === value);
  if (found === undefined) throw new Error(`unknown hash ${value}`);
  return found;
}

const keyTable = record(control["keys"], "keys");
function key(name: string): RsaPrivateNumbers {
  const row = record(keyTable[name], `key ${name}`);
  const part = (field: string): bigint => big(text(row, field));
  return { n: part("n"), e: part("e"), d: part("d"), p: part("p"), q: part("q"), dp: part("dp"), dq: part("dq"), qi: part("qi") };
}

const message = bytes(string(control["message"], "message"));

// A fixed pseudo-random stream, so every test is repeatable.
function seeded(seed: number): Entropy {
  let state = seed >>> 0 || 1;
  return target => {
    for (let index = 0; index < target.length; index += 1) {
      state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      target[index] = state & 0xff;
    }
  };
}
// Hands out the given bytes on the first draw (the salt, seed or padding), then the fixed stream (blinding).
function scripted(first: Uint8Array, rest: Entropy = seeded(7)): Entropy {
  let used = false;
  return target => {
    if (used) { rest(target); return; }
    used = true;
    expect(target.length).toBe(first.length);
    target.set(first);
  };
}
function failure(run: () => unknown): RsaError {
  try { run(); }
  catch (error) { if (error instanceof RsaError) return error; throw error; }
  throw new Error("expected an RsaError");
}
const nodeBehaviour = record(control["nodeBehaviour"], "nodeBehaviour");
const nodeReason = (name: string): string => text(record(nodeBehaviour[name], name), "reason");
const nodeReturned = (name: string): string => text(record(nodeBehaviour[name], name), "returned");

describe("RSA primitives against Node 24 vectors", () => {
  it("was recorded from pinned Node", () => {
    expect(control["node"]).toEqual({ version: "v24.18.1", openssl: "3.5.7" });
    expect(string(control["recorder"], "recorder")).toContain("generateKeyPairSync");
  });

  it("reads keys whose numbers are consistent, and inverts the public operation with and without blinding", () => {
    for (const name of Object.keys(keyTable)) {
      const k = key(name);
      expect(k.p * k.q).toBe(k.n);
      expect(k.p > k.q).toBe(true);
      expect((k.qi * k.q) % k.p).toBe(1n);
      const value = bytesToBigInt(hashBytes("sha512", message)) % k.n;
      const opened = rsaPrivateOp(k, value);
      expect(rsaPublicOp(k, opened)).toBe(value);
      expect(rsaPrivateOp(k, value, seeded(3))).toBe(opened);
    }
    const k = key("2048");
    expect(failure(() => rsaPublicOp(k, k.n)).reason).toBe("data-too-large-for-modulus");
    expect(failure(() => rsaPrivateOp(k, k.n + 1n)).reason).toBe("data-too-large-for-modulus");
    expect(failure(() => rsaPrivateOp(k, -1n)).detail).toBe("data too large for modulus");
  });

  it("recovers from a wrong CRT parameter through the full exponent (fault check)", () => {
    const k = key("1024");
    const broken: RsaPrivateNumbers = { ...k, dp: k.dp ^ 4n };
    expect(rsaPrivateOp(broken, 0x1234567n)).toBe(rsaPrivateOp(k, 0x1234567n));
    expect(rsaPrivateOp({ ...k, qi: k.qi + 2n }, 0x1234567n, seeded(5))).toBe(rsaPrivateOp(k, 0x1234567n));
  });

  it("names its error class and carries OpenSSL's reason text", () => {
    const error = new RsaError("bad-padding", "invalid padding");
    expect(RsaError.name).toBe("RsaError");
    expect(error.name).toBe("RsaError");
    expect(error).toBeInstanceOf(Error);
    expect([error.reason, error.detail, error.message]).toEqual(["bad-padding", "invalid padding", "RSA: invalid padding"]);
  });

  it("hashes with every supported algorithm", () => {
    expect(hexOf(hashBytes("sha256", new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hexOf(hashBytes("sha3-256", new Uint8Array()))).toBe("a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
    expect(hexOf(hashBytes("ripemd160", new Uint8Array()))).toBe("9c1185a5c5e9fc54612808977ee8f548b2258d31");
    expect(HASH_NAMES.map(name => digestLength(name))).toEqual([20, 28, 32, 48, 64, 28, 32, 28, 32, 48, 64, 16, 20]);
    for (const name of HASH_NAMES) expect(hashBytes(name, message)).toHaveLength(digestLength(name));
  });
});

describe("PKCS#1 v1.5 signatures", () => {
  const vectors = rows("pkcs1");

  it("produces Node's signature bytes for every hash and for 1024 to 4096-bit keys", () => {
    expect(new Set(vectors.map(row => text(row, "hash")))).toEqual(new Set(HASH_NAMES));
    expect(new Set(vectors.map(row => text(row, "key")))).toEqual(new Set(["1024", "1025", "2048", "3072", "4096", "e3"]));
    for (const row of vectors) {
      const k = key(text(row, "key"));
      const hash = hashName(text(row, "hash"));
      const digest = hashBytes(hash, message);
      expect(row["verified"]).toBe(true);
      expect(hexOf(pkcs1v15Sign(k, hash, digest)), `${text(row, "key")} ${hash}`).toBe(text(row, "signature"));
      expect(hexOf(pkcs1v15Sign(k, hash, digest, seeded(11)))).toBe(text(row, "signature"));
      expect(pkcs1v15Verify(k, hash, digest, bytes(text(row, "signature")))).toBe(true);
      // The recovered block is the DigestInfo: it ends with the digest.
      const recovered = pkcs1v15Recover(k, bytes(text(row, "signature")));
      expect(hexOf(recovered.subarray(recovered.length - digest.length))).toBe(hexOf(digest));
    }
  });

  it("rejects tampered signatures, the wrong hash, the wrong key and signatures of the wrong size", () => {
    const k = key("2048");
    const digest = hashBytes("sha256", message);
    const signature = pkcs1v15Sign(k, "sha256", digest);
    for (const position of [0, 1, 100, 255]) {
      const tampered = signature.slice();
      tampered[position] = (tampered[position] ?? 0) ^ 1;
      expect(pkcs1v15Verify(k, "sha256", digest, tampered)).toBe(false);
    }
    expect(pkcs1v15Verify(k, "sha256", hashBytes("sha256", bytes("00")), signature)).toBe(false);
    expect(pkcs1v15Verify(k, "sha3-256", digest, signature)).toBe(false);
    expect(pkcs1v15Verify(k, "sha512-256", digest, signature)).toBe(false);
    expect(pkcs1v15Verify(k, "sha1", digest, signature)).toBe(false);
    expect(pkcs1v15Verify(key("other"), "sha256", digest, signature)).toBe(false);
    // Node answers false for all three (nodeBehaviour "verify short signature", "verify long signature", "verify signature >= n").
    expect([nodeReturned("verify short signature"), nodeReturned("verify long signature"), nodeReturned("verify signature >= n")]).toEqual(["false", "false", "false"]);
    expect(pkcs1v15Verify(k, "sha256", digest, signature.subarray(1))).toBe(false);
    expect(pkcs1v15Verify(k, "sha256", digest, Uint8Array.from([0, ...signature]))).toBe(false);
    expect(pkcs1v15Verify(k, "sha256", digest, bytes((k.n + 5n).toString(16)))).toBe(false);
    expect(pkcs1v15Verify(k, "sha256", digest, new Uint8Array(256))).toBe(false);
  });

  it("refuses a digest of the wrong length or one too big for the key, as OpenSSL does", () => {
    const small = key("512");
    expect(failure(() => pkcs1v15Sign(small, "sha512", hashBytes("sha512", message))).detail).toBe(nodeReason("sign sha512 with 512-bit key"));
    expect(failure(() => pkcs1v15Sign(small, "sha384", hashBytes("sha384", message))).detail).toBe(nodeReason("sign sha384 with 512-bit key"));
    expect(failure(() => pkcs1v15Sign(small, "sha512", hashBytes("sha512", message))).reason).toBe("key-too-small");
    expect(pkcs1v15Sign(small, "sha256", hashBytes("sha256", message))).toHaveLength(64);
    expect(failure(() => pkcs1v15Sign(small, "sha256", new Uint8Array(31))).reason).toBe("invalid-digest-length");
    expect(pkcs1v15Verify(small, "sha512", hashBytes("sha512", message), new Uint8Array(64))).toBe(false);
  });

  it("matches privateEncrypt and publicDecrypt for raw payloads", () => {
    for (const row of rows("privateEncrypt")) {
      const k = key(text(row, "key"));
      const payload = bytes(text(row, "message"));
      expect(hexOf(pkcs1v15Sign(k, null, payload))).toBe(text(row, "signature"));
      expect(hexOf(pkcs1v15Sign(k, null, payload, seeded(2)))).toBe(text(row, "signature"));
      expect(hexOf(pkcs1v15Recover(k, bytes(text(row, "signature"))))).toBe(text(row, "message"));
      expect(pkcs1v15Verify(k, null, payload, bytes(text(row, "signature")))).toBe(true);
      // Node itself fails publicDecrypt when the payload is empty ("RSA lib"); the block is still well formed.
      const recovered = record(row["recovered"], "recovered");
      if (payload.length === 0) expect(recovered["code"]).toBe("ERR_OSSL_RSA_LIB");
      else expect(recovered["returned"]).toBe(text(row, "message"));
    }
    const k = key("2048");
    expect(failure(() => pkcs1v15Sign(k, null, new Uint8Array(246))).detail).toBe(nodeReason("privateEncrypt too long"));
    expect(pkcs1v15Sign(k, null, new Uint8Array(245))).toHaveLength(256);
  });

  it("reports each malformed type 1 block with OpenSSL's reason", () => {
    const k = key("2048");
    const sign = (block: Uint8Array): Uint8Array => rawPrivate(k, block);
    const block = (lead: number, type: number, padding: readonly number[], tail: readonly number[]): Uint8Array => Uint8Array.from([lead, type, ...padding, ...tail]);
    const ff = (count: number): number[] => Array.from({ length: count }, () => 0xff);
    const cases: readonly (readonly [string, Uint8Array])[] = [
      ["publicDecrypt lead byte not zero", sign(block(1, 1, ff(250), [0, 1, 2, 3]))],
      ["publicDecrypt block type 2", sign(block(0, 2, ff(250), [0, 1, 2, 3]))],
      ["publicDecrypt bad fixed header", sign(block(0, 1, [...ff(100), 0x7f, ...ff(149)], [0, 1, 2, 3]))],
      ["publicDecrypt no separator", sign(block(0, 1, ff(254), []))],
      ["publicDecrypt seven pad bytes", sign(block(0, 1, ff(7), [0, ...Array.from({ length: 246 }, () => 7)]))],
      ["publicDecrypt garbage", new Uint8Array(256).fill(0x42)],
      ["publicDecrypt value >= n", bytes((k.n + 1n).toString(16))],
      ["publicDecrypt longer than modulus", new Uint8Array(257).fill(1)],
      ["publicDecrypt shorter (value 2)", Uint8Array.of(2)],
    ];
    for (const [name, signature] of cases) expect(failure(() => pkcs1v15Recover(k, signature)).detail, name).toBe(nodeReason(name));
    expect(failure(() => pkcs1v15Recover(k, new Uint8Array(256).fill(0x42))).reason).toBe("bad-padding");
    expect(hexOf(pkcs1v15Recover(k, sign(block(0, 1, ff(8), [0, ...Array.from({ length: 245 }, () => 7)]))))).toBe(nodeReturned("publicDecrypt eight pad bytes"));
  });
});

describe("PSS signatures", () => {
  const vectors = rows("pss");
  const saltLengthOf = (row: Record<string, unknown>, k: RsaPrivateNumbers, hash: HashName): number => {
    const salt = row["salt"];
    if (salt === "digest") return digestLength(hash);
    if (salt === "max") return pssMaxSaltLength(k, hash);
    if (typeof salt !== "number") throw new Error("salt");
    return salt;
  };

  it("verifies every Node-made signature, with the salt length given and detected", () => {
    expect(vectors.length).toBeGreaterThan(50);
    expect(new Set(vectors.map(row => row["salt"]))).toEqual(new Set(["digest", 0, "max", 20, 32, 28]));
    expect(vectors.filter(row => text(row, "hash") !== text(row, "mgf"))).toHaveLength(5);
    for (const row of vectors) {
      const k = key(text(row, "key"));
      const hash = hashName(text(row, "hash"));
      const mgf = hashName(text(row, "mgf"));
      const digest = hashBytes(hash, message);
      const signature = bytes(text(row, "signature"));
      const saltLength = saltLengthOf(row, k, hash);
      const label = `${text(row, "key")} ${hash} ${mgf} ${String(row["salt"])}`;
      expect(row["verifiedAuto"]).toBe(true);
      expect(pssVerify(k, hash, mgf, "auto", digest, signature), label).toBe(true);
      expect(pssVerify(k, hash, mgf, saltLength, digest, signature), label).toBe(true);
      expect(pssVerify(k, hash, mgf, saltLength + 1, digest, signature), label).toBe(false);
      if (hash !== mgf) expect(pssVerify(k, hash, hash, "auto", digest, signature), label).toBe(false);
    }
  });

  it("reproduces Node's signature bytes when given the salt Node drew", () => {
    for (const row of vectors) {
      const k = key(text(row, "key"));
      const hash = hashName(text(row, "hash"));
      const mgf = hashName(text(row, "mgf"));
      const digest = hashBytes(hash, message);
      const saltLength = saltLengthOf(row, k, hash);
      // Open the signature and unmask the data block; the salt is its tail.
      const encodedBits = bitLength(k.n) - 1;
      const encodedLength = Math.ceil(encodedBits / 8);
      const encoded = rawPublic(k, bytes(text(row, "signature"))).subarray(modulusLength(k) - encodedLength);
      const data = encoded.slice(0, encodedLength - digestLength(hash) - 1);
      const mask = mgf1(mgf, encoded.subarray(data.length, encodedLength - 1), data.length);
      const salt = data.map((byte, index) => byte ^ (mask[index] ?? 0)).subarray(data.length - saltLength);
      const entropy = saltLength === 0 ? seeded(9) : scripted(salt);
      expect(hexOf(pssSign(k, hash, mgf, saltLength, digest, entropy)), `${text(row, "key")} ${hash} ${String(row["salt"])}`).toBe(text(row, "signature"));
    }
  });

  it("round-trips its own signatures and rejects altered ones", () => {
    const digest = hashBytes("sha256", message);
    for (const name of ["1024", "1025", "2048", "3072", "4096"]) {
      const k = key(name);
      for (const saltLength of [0, 20, 32, pssMaxSaltLength(k, "sha256")]) {
        const signature = pssSign(k, "sha256", "sha1", saltLength, digest, seeded(saltLength + 1));
        expect(signature).toHaveLength(modulusLength(k));
        expect(pssVerify(k, "sha256", "sha1", "auto", digest, signature)).toBe(true);
        expect(pssVerify(k, "sha256", "sha1", saltLength, digest, signature)).toBe(true);
        expect(pssVerify(k, "sha256", "sha256", "auto", digest, signature)).toBe(false);
        expect(pssVerify(k, "sha256", "sha1", "auto", hashBytes("sha256", new Uint8Array()), signature)).toBe(false);
        expect(pssVerify(key("other"), "sha256", "sha1", "auto", digest, signature)).toBe(false);
        const tampered = signature.slice();
        tampered[signature.length - 1] = (tampered[signature.length - 1] ?? 0) ^ 1;
        expect(pssVerify(k, "sha256", "sha1", "auto", digest, tampered)).toBe(false);
        expect(pssVerify(k, "sha256", "sha1", "auto", digest, signature.subarray(1))).toBe(false);
      }
    }
    // Two different salts give two different signatures of the same digest.
    const k = key("2048");
    expect(hexOf(pssSign(k, "sha256", "sha256", 32, digest, seeded(1)))).not.toBe(hexOf(pssSign(k, "sha256", "sha256", 32, digest, seeded(2))));
    expect(pssVerify(k, "sha256", "sha256", "auto", digest, bytes((k.n + 1n).toString(16)))).toBe(false);
    expect(pssVerify(k, "sha256", "sha256", "auto", digest, new Uint8Array(256))).toBe(false);
  });

  it("limits the salt as OpenSSL does", () => {
    const k = key("2048");
    const digest = hashBytes("sha256", message);
    expect(pssMaxSaltLength(k, "sha256")).toBe(222);
    expect(nodeReturned("pss sign salt longest")).toBe("512");
    expect(pssSign(k, "sha256", "sha256", 222, digest, seeded(1))).toHaveLength(256);
    expect(failure(() => pssSign(k, "sha256", "sha256", 223, digest, seeded(1))).detail).toBe(nodeReason("pss sign salt too long"));
    expect(failure(() => pssSign(key("1024"), "sha512", "sha512", 64, hashBytes("sha512", message), seeded(1))).detail).toBe(nodeReason("pss sign sha512 digest salt with 1024-bit key"));
    expect(failure(() => pssSign(key("512"), "sha512", "sha512", 0, hashBytes("sha512", message), seeded(1))).detail).toBe(nodeReason("pss sign sha512 with 512-bit key"));
    expect(failure(() => pssSign(k, "sha256", "sha256", 223, digest, seeded(1))).reason).toBe("data-too-large");
    expect(failure(() => pssSign(k, "sha256", "sha256", -1, digest, seeded(1))).reason).toBe("invalid-salt-length");
    expect(failure(() => pssSign(k, "sha256", "sha256", 1.5, digest, seeded(1))).reason).toBe("invalid-salt-length");
    expect(failure(() => pssSign(k, "sha256", "sha256", 32, new Uint8Array(20), seeded(1))).reason).toBe("invalid-digest-length");
    expect(pssVerify(key("512"), "sha512", "sha512", "auto", hashBytes("sha512", message), new Uint8Array(64))).toBe(false);
    expect(nodeReturned("pss verify wrong fixed salt length")).toBe("false");
  });
});

describe("OAEP", () => {
  const vectors = rows("oaep");

  it("decrypts Node-made ciphertexts for sha1, sha256 and sha512, with and without a label", () => {
    expect(new Set(vectors.map(row => text(row, "hash")))).toEqual(new Set(["sha1", "sha256", "sha512"]));
    expect(vectors.some(row => text(row, "label") !== "")).toBe(true);
    for (const row of vectors) {
      const k = key(text(row, "key"));
      const hash = hashName(text(row, "hash"));
      const ciphertext = bytes(text(row, "ciphertext"));
      expect(hexOf(oaepDecrypt(k, hash, hash, bytes(text(row, "label")), ciphertext))).toBe(text(row, "message"));
      expect(hexOf(oaepDecrypt(k, hash, hash, bytes(text(row, "label")), ciphertext, seeded(4)))).toBe(text(row, "message"));
    }
    // A ciphertext sent without its leading zero byte decrypts in Node too.
    const short = vectors.filter(row => row["short"] === true);
    expect(short).toHaveLength(1);
    expect(short.map(row => bytes(text(row, "ciphertext")).length)).toEqual([127]);
  });

  it("reproduces Node's ciphertext bytes when given the seed Node drew", () => {
    for (const row of vectors) {
      if (row["short"] === true) continue;
      const k = key(text(row, "key"));
      const hash = hashName(text(row, "hash"));
      const size = digestLength(hash);
      const block = rawPrivate(k, bytes(text(row, "ciphertext")));
      const seedMask = mgf1(hash, block.subarray(1 + size), size);
      const seed = block.slice(1, 1 + size).map((byte, index) => byte ^ (seedMask[index] ?? 0));
      expect(hexOf(oaepEncrypt(k, hash, hash, bytes(text(row, "label")), bytes(text(row, "message")), scripted(seed)))).toBe(text(row, "ciphertext"));
    }
  });

  it("round-trips with a separate MGF1 hash and fails alike on every decoding error", () => {
    const k = key("2048");
    const label = bytes("0102");
    const ciphertext = oaepEncrypt(k, "sha256", "sha1", label, message.subarray(0, 40), seeded(21));
    expect(ciphertext).toHaveLength(256);
    expect(hexOf(oaepDecrypt(k, "sha256", "sha1", label, ciphertext))).toBe(hexOf(message.subarray(0, 40)));
    const wrong: readonly (() => unknown)[] = [
      () => oaepDecrypt(k, "sha256", "sha256", label, ciphertext),
      () => oaepDecrypt(k, "sha1", "sha1", label, ciphertext),
      () => oaepDecrypt(k, "sha256", "sha1", new Uint8Array(), ciphertext),
      () => oaepDecrypt(key("other"), "sha256", "sha1", label, ciphertext.subarray(1)),
      () => oaepDecrypt(k, "sha256", "sha1", label, new Uint8Array(256).fill(0x42)),
      () => oaepDecrypt(k, "sha256", "sha1", label, new Uint8Array(256)),
      () => oaepDecrypt(key("512"), "sha512", "sha512", label, new Uint8Array(64)),
    ];
    for (const run of wrong) {
      const error = failure(run);
      expect([error.reason, error.detail]).toEqual(["oaep-decoding", nodeReason("oaep decrypt garbage")]);
    }
    expect(nodeReason("oaep decrypt wrong label")).toBe("oaep decoding error");
    expect(failure(() => oaepDecrypt(k, "sha1", "sha1", label, bytes((k.n + 1n).toString(16)))).detail).toBe(nodeReason("oaep decrypt value >= n"));
    expect(failure(() => oaepDecrypt(k, "sha1", "sha1", label, new Uint8Array(257).fill(1))).detail).toBe(nodeReason("oaep decrypt longer than modulus"));
    expect(failure(() => oaepEncrypt(k, "sha256", "sha256", label, new Uint8Array(191), seeded(1))).detail).toBe(nodeReason("oaep encrypt too long"));
    expect(oaepEncrypt(k, "sha256", "sha256", label, new Uint8Array(190), seeded(1))).toHaveLength(256);
    expect(failure(() => oaepEncrypt(key("1024"), "sha512", "sha512", label, new Uint8Array(), seeded(1))).detail).toBe(nodeReason("oaep encrypt sha512 with 1024-bit key"));
    expect(failure(() => oaepEncrypt(k, "sha256", "sha256", label, new Uint8Array(191), seeded(1))).reason).toBe("data-too-large");
  });
});

describe("PKCS#1 v1.5 encryption", () => {
  const vectors = rows("pkcs1Encryption");

  it("decrypts Node-made ciphertexts and reproduces them from the padding Node drew", () => {
    expect(vectors).toHaveLength(12);
    for (const row of vectors) {
      const k = key(text(row, "key"));
      const ciphertext = bytes(text(row, "ciphertext"));
      expect(text(row, "nodeDecrypted")).toBe(text(row, "message"));
      expect(hexOf(pkcs1v15Decrypt(k, ciphertext))).toBe(text(row, "message"));
      expect(hexOf(pkcs1v15Decrypt(k, ciphertext, seeded(8)))).toBe(text(row, "message"));
      const block = rawPrivate(k, ciphertext);
      const padding = block.slice(2, block.length - bytes(text(row, "message")).length - 1);
      expect(hexOf(pkcs1v15Encrypt(k, bytes(text(row, "message")), scripted(padding)))).toBe(text(row, "ciphertext"));
    }
  });

  it("never pads with a zero byte and refuses a message that leaves fewer than eight padding bytes", () => {
    const k = key("1024");
    // An entropy source that hands out zeros half of the time.
    const stream = seeded(31);
    const zeroHeavy: Entropy = target => { stream(target); for (let index = 0; index < target.length; index += 1) if (((target[index] ?? 0) & 1) === 0) target[index] = 0; };
    const ciphertext = pkcs1v15Encrypt(k, message.subarray(0, 10), zeroHeavy);
    const block = rawPrivate(k, ciphertext);
    expect([block[0], block[1]]).toEqual([0, 2]);
    expect(block.subarray(2, 128 - 11).includes(0)).toBe(false);
    expect(hexOf(pkcs1v15Decrypt(k, ciphertext))).toBe(hexOf(message.subarray(0, 10)));
    expect(pkcs1v15Encrypt(key("2048"), new Uint8Array(245), seeded(1))).toHaveLength(256);
    const error = failure(() => pkcs1v15Encrypt(key("2048"), new Uint8Array(246), seeded(1)));
    expect([error.reason, error.detail]).toEqual(["data-too-large", nodeReason("pkcs1 encrypt too long")]);
  });

  it("returns the bytes Node returns for ciphertexts with bad padding (implicit rejection)", () => {
    const vectorsByKey = rows("implicitRejection");
    expect(vectorsByKey).toHaveLength(60);
    const lengths = new Set<number>();
    for (const row of vectorsByKey) {
      const k = key(text(row, "key"));
      const expected = text(record(row["node"], "node"), "returned");
      const label = `${text(row, "key")} ${text(row, "name")}`;
      expect(hexOf(pkcs1v15Decrypt(k, bytes(text(row, "ciphertext")))), label).toBe(expected);
      expect(hexOf(pkcs1v15Decrypt(k, bytes(text(row, "ciphertext")), seeded(6))), label).toBe(expected);
      if (!text(row, "name").startsWith("valid")) lengths.add(expected.length / 2);
    }
    // The synthetic messages have many different lengths, the empty one included in a large enough sample.
    expect(lengths.size).toBeGreaterThan(20);
  });

  it("refuses only ciphertexts that are not below the modulus", () => {
    const k = key("2048");
    expect(failure(() => pkcs1v15Decrypt(k, bytes((k.n + 1n).toString(16)))).detail).toBe(nodeReason("pkcs1 decrypt value >= n"));
    expect(failure(() => pkcs1v15Decrypt(k, new Uint8Array(257).fill(1))).detail).toBe(nodeReason("pkcs1 decrypt longer than modulus"));
  });
});

describe("RSA without padding", () => {
  it("matches Node in both directions", () => {
    const vectors = rows("raw");
    expect(vectors).toHaveLength(15);
    for (const row of vectors) {
      const k = key(text(row, "key"));
      const data = bytes(text(row, "data"));
      expect(hexOf(rawPublic(k, data))).toBe(text(row, "public"));
      expect(hexOf(rawPrivate(k, data))).toBe(text(row, "private"));
      expect(hexOf(rawPrivate(k, data, seeded(12)))).toBe(text(row, "private"));
      expect(text(record(row["privateDecryptOfPublic"], "privateDecryptOfPublic"), "returned")).toBe(text(row, "data"));
      expect(hexOf(rawPrivate(k, bytes(text(row, "public"))))).toBe(text(row, "data"));
      expect(hexOf(rawPublic(k, bytes(text(row, "private"))))).toBe(text(row, "data"));
    }
  });

  it("takes shorter input as left-padded, as Node's decrypt direction does, and refuses values not below the modulus", () => {
    const k = key("2048");
    const short = new Uint8Array(255).fill(1);
    expect(hexOf(rawPrivate(k, short))).toBe(nodeReturned("raw privateDecrypt short input"));
    expect(hexOf(rawPublic(k, short))).toBe(nodeReturned("raw publicDecrypt short input"));
    expect(failure(() => rawPublic(k, new Uint8Array(256).fill(0xff))).detail).toBe(nodeReason("raw publicEncrypt value >= n"));
    expect(failure(() => rawPrivate(k, new Uint8Array(256).fill(0xff))).detail).toBe(nodeReason("raw privateDecrypt value >= n"));
    expect(failure(() => rawPublic(k, new Uint8Array(257).fill(1))).reason).toBe("data-too-large");
    // The encrypt direction of Node also insists on exactly the modulus length; that check belongs to the API layer.
    expect([nodeReason("raw publicEncrypt short input"), nodeReason("raw publicEncrypt long input"), nodeReason("raw privateEncrypt short input")])
      .toEqual(["data too small for key size", "data too large for key size", "data too small for key size"]);
  });
});

describe("RSA key generation", () => {
  const survey = rows("keyGeneration");
  const surveyed = (bits: number, exponent: number): Record<string, unknown> => {
    const found = survey.find(row => row["bits"] === bits && row["publicExponent"] === exponent);
    if (found === undefined) throw new Error("no survey");
    return found;
  };
  const lcm = (k: RsaPrivateNumbers): bigint => ((k.p - 1n) * (k.q - 1n)) / gcd(k.p - 1n, k.q - 1n);
  const secondBit = (value: bigint): boolean => value.toString(2).charAt(1) === "1";
  const usable = (k: RsaPrivateNumbers): void => {
    expect(k.p * k.q).toBe(k.n);
    expect(k.p > k.q).toBe(true);
    expect((k.d * k.e) % lcm(k)).toBe(1n);
    expect([k.dp, k.dq, (k.qi * k.q) % k.p]).toEqual([k.d % (k.p - 1n), k.d % (k.q - 1n), 1n]);
    const digest = hashBytes("sha256", message);
    expect(pkcs1v15Verify(k, "sha256", digest, pkcs1v15Sign(k, "sha256", digest, seeded(1)))).toBe(true);
    expect(hexOf(oaepDecrypt(k, "sha1", "sha1", new Uint8Array(), oaepEncrypt(k, "sha1", "sha1", new Uint8Array(), message.subarray(0, 16), seeded(2))))).toBe(hexOf(message.subarray(0, 16)));
  };

  it("records what OpenSSL generates: two paths, told apart by size and exponent", () => {
    for (const [bits, exponent] of [[1024, 65537], [1025, 65537], [2048, 3]] as const) {
      const row = surveyed(bits, exponent);
      // Small keys and small exponents: both primes have their two top bits set and d is the inverse modulo (p-1)(q-1).
      expect([row["pGreaterThanQ"], row["dIsInverseModPhi"], row["pTopTwoBits"], row["qTopTwoBits"]]).toEqual([row["count"], row["count"], row["count"], row["count"]]);
      expect(row["dBelowLcm"]).not.toBe(row["count"]);
      expect(Object.keys(record(row["modulusBits"], "modulusBits"))).toEqual([String(bits)]);
    }
    for (const bits of [2048, 2049, 3072]) {
      const row = surveyed(bits, 65537);
      // From 2048 bits with a large exponent: d is below lcm(p-1, q-1), primes are above sqrt(2) * 2^(bits/2 - 1).
      expect([row["pGreaterThanQ"], row["dBelowLcm"], row["dTimesEIsOneModLcm"], row["pAboveSqrt2"], row["qAboveSqrt2"]]).toEqual([row["count"], row["count"], row["count"], row["count"], row["count"]]);
    }
    expect(surveyed(2048, 65537)["qTopTwoBits"]).not.toBe(surveyed(2048, 65537)["count"]);
    // An odd size on this path gives a modulus one bit shorter.
    expect(Object.keys(record(surveyed(2049, 65537)["modulusBits"], "modulusBits"))).toEqual(["2048"]);
    expect(Object.keys(record(surveyed(1025, 65537)["pBits"], "pBits"))).toEqual(["513"]);
  });

  it("generates small keys on the legacy path", () => {
    for (const [bits, exponent, seed] of [[1024, 65537n, 1], [1025, 65537n, 2], [512, 3n, 3], [1024, 17n, 4]] as const) {
      const k = generateRsaKey(bits, exponent, seeded(seed));
      usable(k);
      expect([bitLength(k.n), k.e]).toEqual([bits, exponent]);
      expect([bitLength(k.p), bitLength(k.q)]).toEqual([Math.ceil(bits / 2), Math.floor(bits / 2)]);
      expect([secondBit(k.p), secondBit(k.q)]).toEqual([true, true]);
      expect((k.d * k.e) % ((k.p - 1n) * (k.q - 1n))).toBe(1n);
    }
  });

  it("generates 2048-bit keys on the SP 800-56B path, and is repeatable for a given entropy stream", () => {
    const k = generateRsaKey(2048, 65537n, seeded(77));
    usable(k);
    expect([bitLength(k.n), bitLength(k.p), bitLength(k.q)]).toEqual([2048, 1024, 1024]);
    expect(k.d < lcm(k)).toBe(true);
    expect(k.d > 1n << 1024n).toBe(true);
    expect(k.p * k.p * 2n > 1n << 2048n && k.q * k.q * 2n > 1n << 2048n).toBe(true);
    expect(k.p - k.q > 1n << 924n).toBe(true);
    expect(generateRsaKey(2048, 65537n, seeded(77))).toEqual(k);
    expect(generateRsaKey(2048, 65537n, seeded(78)).n).not.toBe(k.n);
    const odd = generateRsaKey(2049, 0xffffffffn, seeded(5));
    usable(odd);
    expect([bitLength(odd.n), bitLength(odd.p), bitLength(odd.q)]).toEqual([2048, 1024, 1024]);
    // A small exponent keeps a 2048-bit key on the legacy path.
    const three = generateRsaKey(2048, 3n, seeded(9));
    usable(three);
    expect([bitLength(three.n), secondBit(three.p), secondBit(three.q)]).toEqual([2048, true, true]);
    expect((three.d * 3n) % ((three.p - 1n) * (three.q - 1n))).toBe(1n);
  });

  it("spreads the work over turns and gives the same key as the one-shot form", () => {
    const steps = generateRsaKeySteps(1024, 65537n, seeded(42), 0.01);
    let turns = 0;
    let step = steps.next();
    while (step.done !== true) { turns += 1; step = steps.next(); }
    expect(turns).toBeGreaterThan(10);
    expect(step.value).toEqual(generateRsaKey(1024, 65537n, seeded(42)));
  });

  it("refuses the sizes and exponents OpenSSL refuses", () => {
    const message511 = text(record(nodeBehaviour["generate 511 bits"], "generate 511 bits"), "message");
    const messageE2 = text(record(nodeBehaviour["generate e=2"], "generate e=2"), "message");
    for (const bits of [511, 256, 0, 1024.5]) {
      const error = failure(() => generateRsaKey(bits, 65537n, seeded(1)));
      expect(error.reason).toBe("key-too-small");
      expect(message511.endsWith(`::${error.detail}`)).toBe(true);
    }
    for (const [bits, exponent] of [[1024, 1n], [1024, 2n], [2048, 4n], [2048, 65538n], [1024, 0n], [1024, -3n]] as const) {
      const error = failure(() => generateRsaKey(bits, exponent, seeded(1)));
      expect(error.reason).toBe("public-exponent-out-of-range");
      expect(messageE2.endsWith(`::${error.detail}`)).toBe(true);
    }
    for (const name of ["generate e=1", "generate e=4 2048", "generate e=65538 2048"]) expect(text(record(nodeBehaviour[name], name), "message")).toBe(messageE2);
    expect([nodeReturned("generate e=3 1024"), nodeReturned("generate e=0x100000001 2048")]).toEqual(["object", "object"]);
  });
});
