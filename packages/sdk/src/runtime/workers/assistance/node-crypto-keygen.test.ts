import { p256, p384, p521 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Buffer } from "buffer/";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { bitLength, gcd, modPow } from "./node-crypto-bigint.js";
import { isPrivateMaterial, type PrivateMaterial } from "./node-crypto-key-codec.js";
import { loadControls, replay, testPorts } from "./node-crypto-keygen.test-support.js";
import { createCryptoKeygen } from "./node-crypto-keygen.js";
import { createCryptoKeys } from "./node-crypto-keys.js";
import { isProbablePrime } from "./node-crypto-primes.js";
import { nodeUtil } from "./node-util.js";

/** Recorded from Node.js v24.18.1 by the scripts under the file's `recorder` and `observer` keys. */
const { document, cases } = loadControls("./node-crypto-keygen.controls.json");
const refusedHere = new Set(Array.isArray(document["refusedHere"]) ? document["refusedHere"].map(String) : []);
const keys = createCryptoKeys();
const ports = testPorts();
const warnings: unknown[][] = [];
const crypto = createCryptoKeygen(ports, keys, { emitWarning: (...args) => { warnings.push(args); } });
const isKeyObject = (value: unknown): boolean => value instanceof keys.KeyObject;
const entropy = (bytes: Uint8Array): void => { bytes.set(globalThis.crypto.getRandomValues(new Uint8Array(bytes.length))); };

function privateMaterial(key: unknown): PrivateMaterial {
  const held = keys.materialOf(key);
  if (held === undefined || !isPrivateMaterial(held.material)) throw new TypeError("Not a private key object");
  return held.material;
}
function pairOf(type: string, options?: object): { publicKey: unknown; privateKey: unknown } {
  return crypto.generateKeyPairSync(type, options);
}
function exportKey(key: unknown, options: object): unknown {
  if (typeof key !== "object" || key === null) throw new TypeError("Not a key object");
  const method: unknown = Reflect.get(key, "export");
  if (typeof method !== "function") throw new TypeError("No export");
  return Reflect.apply(method, key, [options]);
}

describe("generateKeyPair and generateKey against recorded Node.js v24.18.1", () => {
  it("has Node's function names and arities", () => {
    const functions = record(record(document["observations"], "observations")["functions"], "functions");
    for (const [name, operation] of Object.entries(crypto)) {
      const recorded = record(functions[name], name);
      expect([operation.name, operation.length], name).toEqual([recorded["name"], recorded["length"]]);
      expect(Object.getOwnPropertyNames(operation).sort(), name).toEqual(recorded["keys"]);
    }
  });

  for (const item of cases) {
    it(`${item.fn} ${JSON.stringify(item.args).slice(0, 150)}`, async () => {
      const got = await replay(item, Reflect.get(crypto, item.fn), isKeyObject, warnings);
      if (refusedHere.has(item.id)) {
        // Real Node does this; the fast path says that it cannot rather than approximate it.
        expect(got.threw).toEqual({ t: "refused", code: "FEATURE_NOT_AVAILABLE" });
        expect(item.result["returned"]).toBeDefined();
        return;
      }
      expect(got).toEqual(item.result);
      expect(ports.held()).toBe(0);
    }, 60_000);
  }

  it("refuses exactly the listed cases", () => {
    expect([...refusedHere].filter(id => !cases.some(item => item.id === id))).toEqual([]);
  });
});

describe("generated key pairs", () => {
  it.each([[512, 65537], [513, 3], [1023, 65537], [1024, 17], [2048, 65537], [2048, 3]])("RSA %i bits, e = %i: the numbers of a valid key", (bits, exponent) => {
    const { publicKey, privateKey } = pairOf("rsa", { modulusLength: bits, publicExponent: exponent });
    const key = privateMaterial(privateKey);
    if (key.kind !== "rsa") throw new TypeError("Not RSA");
    expect(bitLength(key.n)).toBe(bits);
    expect(key.e).toBe(BigInt(exponent));
    expect(key.n).toBe(key.p * key.q);
    expect(key.p > key.q).toBe(true);
    expect(isProbablePrime(key.p, 8, entropy) && isProbablePrime(key.q, 8, entropy)).toBe(true);
    const lambda = (key.p - 1n) * (key.q - 1n) / gcd(key.p - 1n, key.q - 1n);
    expect((key.d * key.e) % lambda).toBe(1n);
    expect(key.dp).toBe(key.d % (key.p - 1n));
    expect(key.dq).toBe(key.d % (key.q - 1n));
    expect((key.qi * key.q) % key.p).toBe(1n);
    expect(modPow(modPow(42n, key.e, key.n), key.d, key.n)).toBe(42n);
    expect(Reflect.get(Object(publicKey), "asymmetricKeyDetails")).toEqual({ modulusLength: bits, publicExponent: BigInt(exponent) });
    expect(keys.createPublicKey(exportKey(privateKey, { type: "pkcs1", format: "pem" })).equals(publicKey)).toBe(true);
  }, 120_000);

  it("RSA-PSS carries its parameters through an export and back", () => {
    const { publicKey, privateKey } = pairOf("rsa-pss", { modulusLength: 1024, hashAlgorithm: "sha256", mgf1HashAlgorithm: "sha1", saltLength: 17 });
    const expected = { modulusLength: 1024, publicExponent: 65537n, hashAlgorithm: "sha256", mgf1HashAlgorithm: "sha1", saltLength: 17 };
    expect(Reflect.get(Object(publicKey), "asymmetricKeyDetails")).toEqual(expected);
    const again = keys.createPrivateKey(exportKey(privateKey, { type: "pkcs8", format: "pem" }));
    expect([again.type, Reflect.get(again, "asymmetricKeyType"), Reflect.get(again, "asymmetricKeyDetails")]).toEqual(["private", "rsa-pss", expected]);
  });

  it.each([["prime256v1", p256, 32], ["P-384", p384, 48], ["secp521r1", p521, 66], ["secp256k1", secp256k1, 32]] as const)("EC %s: a point on the curve that the private scalar derives", (namedCurve, curve, size) => {
    const { publicKey, privateKey } = pairOf("ec", { namedCurve });
    const key = privateMaterial(privateKey);
    if (key.kind !== "ec") throw new TypeError("Not EC");
    expect(key.d.length).toBe(size);
    const point = curve.Point.fromBytes(key.point);
    point.assertValidity();
    expect(Buffer.from(curve.getPublicKey(key.d, false)).equals(Buffer.from(key.point))).toBe(true);
    const scalar = BigInt(`0x${Buffer.from(key.d).toString("hex")}`);
    expect(scalar > 0n && scalar < curve.Point.Fn.ORDER).toBe(true);
    const pem = exportKey(privateKey, { type: "sec1", format: "pem" });
    expect(keys.createPublicKey(pem).equals(publicKey)).toBe(true);
    expect(keys.createPrivateKey({ key: exportKey(privateKey, { format: "jwk" }), format: "jwk" }).equals(privateKey)).toBe(true);
  });

  it.each(["ed25519", "ed448", "x25519", "x448"])("%s: the public key derives from the private key, in every encoding", type => {
    const { publicKey, privateKey } = pairOf(type);
    for (const encoding of [{ type: "pkcs8", format: "pem" }, { type: "pkcs8", format: "der" }]) {
      const again = keys.createPrivateKey({ key: exportKey(privateKey, encoding), ...encoding });
      expect(again.equals(privateKey)).toBe(true);
      expect(keys.createPublicKey(again).equals(publicKey)).toBe(true);
    }
    const encoded = crypto.generateKeyPairSync(type, { publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } });
    const { d, ...rest } = record(encoded.privateKey, "jwk");
    expect(typeof d).toBe("string");
    expect(encoded.publicKey).toEqual(rest);
    expect(keys.createPublicKey({ key: encoded.privateKey, format: "jwk" }).equals(keys.createPublicKey({ key: encoded.publicKey, format: "jwk" }))).toBe(true);
  });

  it("X25519 and X448 private keys are stored clamped, as OpenSSL stores them", () => {
    const okp = record(record(document["observations"], "observations")["okp"], "okp");
    for (const type of ["x25519", "x448", "ed25519", "ed448"]) {
      let and0 = 255, or0 = 0, andL = 255, orL = 0, len = 0;
      for (let index = 0; index < 64; index += 1) {
        const key = privateMaterial(pairOf(type).privateKey);
        if (!("privateKey" in key)) throw new TypeError("Not an OKP key");
        const bytes = key.privateKey;
        len = bytes.length;
        and0 &= bytes[0] ?? 0; or0 |= bytes[0] ?? 0; andL &= bytes[len - 1] ?? 0; orL |= bytes[len - 1] ?? 0;
      }
      const seen = { len, and0, or0, andL, orL }, recorded = record(okp[type], type);
      // The forced bits are exact; the free ones were all seen both ways over 64 keys.
      expect(seen.len, type).toBe(recorded["len"]);
      if (type.startsWith("x")) expect(seen, type).toEqual(recorded);
    }
  });

  it("Diffie-Hellman: group keys have OpenSSL's private key lengths", () => {
    const groups = record(record(document["observations"], "observations")["dhGroups"], "dhGroups");
    for (const [name, value] of Object.entries(groups)) {
      const recorded = record(value, name);
      let longest = 0;
      for (let index = 0; index < (name === "modp17" || name === "modp18" ? 2 : 6); index += 1) {
        const key = privateMaterial(pairOf("dh", { group: name }).privateKey);
        if (key.kind !== "dh") throw new TypeError("Not DH");
        expect([bitLength(key.p), key.g], name).toEqual([recorded["pBits"], 2n]);
        expect(key.y, name).toBe(modPow(key.g, key.x, key.p));
        expect(key.x > 0n && bitLength(key.x) <= Number(recorded["xBitsMax"]), name).toBe(true);
        if (recorded["xBitsMin"] === recorded["xBitsMax"]) expect(bitLength(key.x), name).toBe(recorded["xBitsMax"]);
        longest = Math.max(longest, bitLength(key.x));
      }
      expect(longest, name).toBeGreaterThan(Number(recorded["xBitsMax"]) - 12);
    }
  }, 120_000);

  it("Diffie-Hellman: a given prime is used as given, and an even private key where OpenSSL makes one", () => {
    const modp1 = keys.materialOf(pairOf("dh", { group: "modp1" }).publicKey)?.material;
    if (modp1?.kind !== "dh") throw new TypeError("Not DH");
    const bytes = Buffer.from(modp1.p.toString(16), "hex");
    const same = privateMaterial(pairOf("dh", { prime: bytes, generator: 5 }).privateKey);
    if (same.kind !== "dh") throw new TypeError("Not DH");
    expect([same.p, same.g, bitLength(same.x)]).toEqual([modp1.p, 5n, 766]);
    bytes[bytes.length - 1] = 0xfb;
    for (let index = 0; index < 8; index += 1) {
      const key = privateMaterial(pairOf("dh", { prime: bytes }).privateKey);
      if (key.kind !== "dh") throw new TypeError("Not DH");
      expect([key.x & 1n, bitLength(key.x)]).toEqual([0n, 766]);
    }
    bytes[bytes.length - 1] = 0xf0;
    expect(() => pairOf("dh", { prime: bytes })).toThrow("error:0180006C:bignum routines::no inverse");
    expect(() => pairOf("dh", { prime: Buffer.concat([Buffer.from([1]), Buffer.alloc(1250, 255)]) })).toThrow("error:02800067:Diffie-Hellman routines::modulus too large");
    expect(() => pairOf("dh", { primeLength: 10_001 })).toThrow("error:02800067:Diffie-Hellman routines::modulus too large");
    expect(() => pairOf("dh", { primeLength: 512, generator: 1 })).toThrow("error:02800065:Diffie-Hellman routines::bad generator");
  });

  it.each([[2, 24n, 23n], [5, 60n, 59n], [3, 12n, 11n]])("Diffie-Hellman primeLength 512, generator %i: a safe prime of OpenSSL's residue", (generator, add, rem) => {
    const { publicKey, privateKey } = pairOf("dh", { primeLength: 512, generator });
    const key = privateMaterial(privateKey);
    if (key.kind !== "dh") throw new TypeError("Not DH");
    expect([bitLength(key.p), key.g, key.p % add, bitLength(key.x)]).toEqual([512, BigInt(generator), rem, 510]);
    expect(isProbablePrime(key.p, 16, entropy) && isProbablePrime(key.p >> 1n, 16, entropy)).toBe(true);
    expect(keys.createPublicKey(exportKey(privateKey, { type: "pkcs8", format: "pem" })).equals(publicKey)).toBe(true);
  }, 120_000);

  it("an encrypted private key opens with its passphrase only", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" } });
    expect(keys.createPublicKey({ key: privateKey, passphrase: "secret" }).equals(publicKey)).toBe(true);
    expect(() => keys.createPrivateKey({ key: privateKey, passphrase: "wrong" })).toThrow();
  });
});

describe("generateKey", () => {
  it("makes fresh keys of the requested size", () => {
    const first = crypto.generateKeySync("hmac", { length: 256 }), second = crypto.generateKeySync("hmac", { length: 256 });
    expect([first.symmetricKeySize, first.equals(second)]).toEqual([32, false]);
    expect(Buffer.isBuffer(first.export())).toBe(true);
    // More than one getRandomValues call can fill.
    const large = crypto.generateKeySync("hmac", { length: 8 * 200_000 }).export();
    expect(Buffer.isBuffer(large) && large.length === 200_000 && large.subarray(190_000).some(byte => byte !== 0)).toBe(true);
  });
});

describe("the callback forms", () => {
  const generate = (type: string, options: object): Promise<unknown[]> => new Promise(resolve => { crypto.generateKeyPair(type, options, (...args: unknown[]) => { resolve(args); }); });

  it("util.promisify(generateKeyPair) resolves to { publicKey, privateKey }", async () => {
    const promisified: unknown = nodeUtil.promisify(crypto.generateKeyPair);
    if (typeof promisified !== "function") throw new TypeError("Not promisified");
    const pair: unknown = await Reflect.apply(promisified, undefined, ["ed25519"]);
    expect(Object.keys(record(pair, "pair"))).toEqual(["publicKey", "privateKey"]);
    const encoded: unknown = await Reflect.apply(promisified, undefined, ["x25519", { publicKeyEncoding: { type: "spki", format: "pem" } }]);
    expect(String(record(encoded, "pair")["publicKey"])).toMatch(/^-----BEGIN PUBLIC KEY-----/u);
    await expect(Reflect.apply(promisified, undefined, ["rsa", { modulusLength: 100 }])).rejects.toThrow("key size too small");
    await expect(Reflect.apply(promisified, undefined, ["foo"])).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
    expect(Object.keys(crypto.generateKeyPair)).toEqual([]);
  });

  it("spreads RSA generation over turns and holds the process until the callback", async () => {
    ports.turns.length = 0;
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 1);
    const pending = generate("rsa", { modulusLength: 3072 });
    expect(ports.held()).toBe(1);
    const [error, publicKey] = await pending;
    clearInterval(ticker);
    expect(error).toBeNull();
    expect(Reflect.get(Object(publicKey), "asymmetricKeyDetails")).toEqual({ modulusLength: 3072, publicExponent: 65537n });
    expect(ports.held()).toBe(0);
    // Other timers ran between the slices.
    expect(ports.turns.length).toBeGreaterThan(1);
    expect(ticks).toBeGreaterThan(0);
  }, 120_000);

  it("spreads safe-prime generation over turns", async () => {
    ports.turns.length = 0;
    const [error, , privateKey] = await generate("dh", { primeLength: 512 });
    expect(error).toBeNull();
    const key = privateMaterial(privateKey);
    expect(key.kind === "dh" && bitLength(key.p)).toBe(512);
    expect(ports.turns.length).toBeGreaterThan(1);
    expect(ports.held()).toBe(0);
  }, 120_000);
});
