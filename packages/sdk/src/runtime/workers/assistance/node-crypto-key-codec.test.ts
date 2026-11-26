import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { derBitString, derInteger, derNull, derOid, derSequence, readDer } from "./node-crypto-asn1.js";
import {
  encodePrivate, encodePublic, fromJwk, isPrivateMaterial, parsePrivate, parsePublic, publicOf, sameKey, toJwk,
  type KeyMaterial, type PrivateMaterial,
} from "./node-crypto-key-codec.js";
import { KeyDecryptError, decryptPkcs8, encryptPkcs8, isEncryptedPkcs8, keyCipher, legacyDecrypt, legacyEncrypt, legacyEncryption } from "./node-crypto-key-encryption.js";
import { pemBlocks, pemDecode, pemEncode } from "./node-crypto-pem.js";

/** Keys generated and exported by Node.js v24.18.1 (OpenSSL 3.5.7); see the file's `recorder`. */
const controls = record(JSON.parse(readFileSync(new URL("./node-crypto-keys.controls.json", import.meta.url), "utf8")), "key controls");
const keys = Object.entries(record(controls["keys"], "keys")).map(([name, value]) => [name, record(value, name)] as const);
const passphrase = new TextEncoder().encode("secret");

function text(value: unknown): string { if (typeof value !== "string") throw new TypeError("Expected a string"); return value; }
function bytes(hex: unknown): Uint8Array { return Uint8Array.from(text(hex).match(/../gu) ?? [], pair => Number.parseInt(pair, 16)); }
function hex(value: Uint8Array): string { return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join(""); }
function encodings(entry: Record<string, unknown>, half: "public" | "private" | "encrypted"): [string, Record<string, unknown>][] {
  return Object.entries(record(entry[half], half)).filter(([type]) => type !== "jwk").map(([type, value]) => [type, record(value, type)]);
}
function privateOf(entry: Record<string, unknown>): PrivateMaterial {
  return parsePrivate(bytes(record(record(entry["private"], "private")["pkcs8"], "pkcs8")["der"]), "pkcs8");
}
function publicType(type: string): "spki" | "pkcs1" { if (type !== "spki" && type !== "pkcs1") throw new TypeError(type); return type; }
function privateType(type: string): "pkcs8" | "pkcs1" | "sec1" { if (type !== "pkcs8" && type !== "pkcs1" && type !== "sec1") throw new TypeError(type); return type; }
const LABELS = { spki: "PUBLIC KEY", pkcs1: "RSA PUBLIC KEY", pkcs8: "PRIVATE KEY", sec1: "EC PRIVATE KEY" } as const;

describe.each(keys)("%s", (_name, entry) => {
  it("re-encodes every public encoding Node wrote, byte for byte, in DER and PEM", () => {
    for (const [type, encoded] of encodings(entry, "public")) {
      const material = parsePublic(bytes(encoded["der"]), publicType(type));
      expect(hex(encodePublic(material, publicType(type)))).toBe(encoded["der"]);
      expect(pemEncode(LABELS[publicType(type)], encodePublic(material, publicType(type)))).toBe(encoded["pem"]);
      expect(hex(pemDecode(text(encoded["pem"]))?.body ?? new Uint8Array())).toBe(encoded["der"]);
    }
  });
  it("re-encodes every private encoding Node wrote, byte for byte, in DER and PEM", () => {
    for (const [type, encoded] of encodings(entry, "private")) {
      const material = parsePrivate(bytes(encoded["der"]), privateType(type));
      expect(hex(encodePrivate(material, privateType(type)))).toBe(encoded["der"]);
      const label = type === "pkcs1" ? "RSA PRIVATE KEY" : LABELS[privateType(type)];
      expect(pemEncode(label, encodePrivate(material, privateType(type)))).toBe(encoded["pem"]);
    }
  });
  it("reads the same key from every encoding and writes each of them from any other", () => {
    const privateKey = privateOf(entry);
    const publicEncodings = record(entry["public"], "public"), privateEncodings = record(entry["private"], "private");
    const spki = record(publicEncodings["spki"], "spki");
    // The public half derived from the private key is the public key Node exported.
    expect(hex(encodePublic(publicOf(privateKey), "spki"))).toBe(spki["der"]);
    expect(sameKey(privateKey, parsePublic(bytes(spki["der"]), "spki"))).toBe(true);
    for (const [type, encoded] of encodings(entry, "public")) expect(hex(encodePublic(publicOf(privateKey), publicType(type)))).toBe(encoded["der"]);
    for (const [type, encoded] of encodings(entry, "private")) {
      expect(hex(encodePrivate(privateKey, privateType(type)))).toBe(encoded["der"]);
      // PKCS#1 holds no RSA-PSS parameters, so only the other encodings carry the whole key.
      expect(hex(encodePrivate(parsePrivate(bytes(encoded["der"]), privateType(type)), "pkcs8"))).toBe(record(privateEncodings["pkcs8"], "pkcs8")["der"]);
    }
  });
  it("converts to and from JWK as Node does, or refuses the key types Node refuses", () => {
    const privateKey = privateOf(entry);
    const publicJwk = record(entry["public"], "public")["jwk"], privateJwk = record(entry["private"], "private")["jwk"];
    if (publicJwk === undefined || privateJwk === undefined) {
      expect(() => toJwk(privateKey, true)).toThrow(expect.objectContaining({ code: "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", message: "Unsupported JWK Key Type." }));
      return;
    }
    expect(toJwk(privateKey, true)).toEqual(privateJwk);
    expect(Object.keys(toJwk(privateKey, true))).toEqual(Object.keys(record(privateJwk, "jwk")));
    expect(toJwk(privateKey, false)).toEqual(publicJwk);
    expect(Object.keys(toJwk(publicOf(privateKey), false))).toEqual(Object.keys(record(publicJwk, "jwk")));
    const fromPrivate = fromJwk(privateJwk), fromPublic = fromJwk(publicJwk);
    expect(fromPrivate.isPrivate).toBe(true);
    expect(fromPublic.isPrivate).toBe(false);
    if (!isPrivateMaterial(fromPrivate.material) || isPrivateMaterial(fromPublic.material)) throw new TypeError("Wrong JWK material");
    expect(hex(encodePrivate(fromPrivate.material, "pkcs8"))).toBe(record(record(entry["private"], "private")["pkcs8"], "pkcs8")["der"]);
    expect(hex(encodePublic(fromPublic.material, "spki"))).toBe(record(record(entry["public"], "public")["spki"], "spki")["der"]);
  });
  it("decrypts the encrypted keys Node wrote, and encrypts to the same bytes with the same salt and IV", () => {
    const privateKey = privateOf(entry);
    for (const [type, encoded] of encodings(entry, "encrypted")) {
      const pem = typeof encoded["pem"] === "string" ? pemDecode(encoded["pem"]) : undefined;
      if (type.startsWith("pkcs8")) {
        const encrypted = pem?.body ?? bytes(encoded["der"]);
        expect(isEncryptedPkcs8(encrypted)).toBe(true);
        const plain = decryptPkcs8(encrypted, passphrase);
        expect(hex(plain)).toBe(hex(encodePrivate(privateKey, "pkcs8")));
        expect(() => decryptPkcs8(encrypted, new TextEncoder().encode("nope"))).toThrow(KeyDecryptError);
        // EncryptedPrivateKeyInfo { { PBES2, { { PBKDF2, { salt, ... } }, { cipher, iv } } }, data }
        const parameters = readDer(encrypted).sequence();
        parameters.oid();
        const scheme = parameters.sequence(), derivation = scheme.sequence(), encryption = scheme.sequence();
        derivation.oid(); encryption.oid();
        const salt = derivation.sequence().octetString(), iv = encryption.octetString();
        const cipher = keyCipher(type === "pkcs8" ? "aes-256-cbc" : type.slice("pkcs8-".length));
        if (cipher === undefined || cipher === "unsupported") throw new TypeError("Unexpected cipher");
        expect(hex(encryptPkcs8(plain, passphrase, cipher, salt, iv))).toBe(hex(encrypted));
        if (typeof encoded["der"] === "string") expect(hex(decryptPkcs8(bytes(encoded["der"]), passphrase))).toBe(hex(plain));
        continue;
      }
      // Legacy PEM encryption of PKCS#1 and SEC1.
      if (pem === undefined) throw new TypeError("Missing PEM");
      const state = legacyEncryption(pem.headers);
      if (state.state !== "encrypted") throw new TypeError("Expected an encrypted block");
      const inner = privateType(type.slice(0, type.indexOf("-")));
      const plain = legacyDecrypt(pem, state.cipher, state.iv, passphrase);
      expect(hex(plain)).toBe(hex(encodePrivate(privateKey, inner)));
      expect(() => legacyDecrypt(pem, state.cipher, state.iv, new TextEncoder().encode("nope"))).toThrow(KeyDecryptError);
      const again = legacyEncrypt(plain, passphrase, state.cipher, state.iv);
      expect(pemEncode(pem.label, again.body, again.headers)).toBe(encoded["pem"]);
    }
  });
});

describe("encodings OpenSSL accepts beyond the ones it writes", () => {
  const extras = record(controls["extras"], "extras");
  const curves = [["p256", "prime256v1"], ["p384", "secp384r1"], ["p521", "secp521r1"], ["k256", "secp256k1"]] as const;
  it.each(curves)("%s: compressed points are decompressed and kept compressed when written again", (name, namedCurve) => {
    const entry = record(record(controls["keys"], "keys")[name], name);
    const compressed = parsePublic(bytes(extras[`${name}.spki.compressed`]), "spki");
    const plain = parsePublic(bytes(record(record(entry["public"], "public")["spki"], "spki")["der"]), "spki");
    if (compressed.kind !== "ec" || plain.kind !== "ec") throw new TypeError("Expected EC keys");
    expect(compressed.namedCurve).toBe(namedCurve);
    expect(hex(compressed.point)).toBe(hex(plain.point));
    expect(sameKey(compressed, plain)).toBe(true);
    expect(hex(encodePublic(compressed, "spki"))).toBe(extras[`${name}.spki.compressed`]);
  });
  it.each(curves)("%s: a PKCS#8 key without its public key gets the derived point and is written without one", name => {
    const entry = record(record(controls["keys"], "keys")[name], name);
    const bare = parsePrivate(bytes(extras[`${name}.pkcs8.nopublic`]), "pkcs8");
    const full = privateOf(entry);
    if (bare.kind !== "ec" || full.kind !== "ec") throw new TypeError("Expected EC keys");
    expect(hex(bare.point)).toBe(hex(full.point));
    expect(hex(bare.d)).toBe(hex(full.d));
    expect(hex(encodePrivate(bare, "pkcs8"))).toBe(extras[`${name}.pkcs8.nopublic`]);
    // A bare ECPrivateKey has no curve; outside PKCS#8 it cannot be read.
    expect(() => parsePrivate(bytes(extras[`${name}.sec1.bare`]), "sec1")).toThrow(/without curve parameters/u);
  });
  it("reads a private key from any structure when asked for PKCS#1 or SEC1, and PKCS#8 only as PKCS#8", () => {
    const rsa = record(record(record(controls["keys"], "keys")["rsa1024"], "rsa1024")["private"], "private");
    const ec = record(record(record(controls["keys"], "keys")["p256"], "p256")["private"], "private");
    const der = (encodings_: Record<string, unknown>, type: string): Uint8Array => bytes(record(encodings_[type], type)["der"]);
    expect(parsePrivate(der(rsa, "pkcs8"), "pkcs1").kind).toBe("rsa");
    expect(parsePrivate(der(rsa, "pkcs1"), "sec1").kind).toBe("rsa");
    expect(parsePrivate(der(ec, "sec1"), "pkcs1").kind).toBe("ec");
    expect(parsePrivate(der(ec, "pkcs8"), "sec1").kind).toBe("ec");
    expect(() => parsePrivate(der(ec, "sec1"), "pkcs8")).toThrow(expect.objectContaining({ name: "Asn1Error", reason: "wrong-tag", depth: 1 }));
    expect(() => parsePrivate(der(rsa, "pkcs8").subarray(0, 40), "pkcs8")).toThrow(expect.objectContaining({ name: "Asn1Error", reason: "too-long", depth: 0 }));
    expect(() => parsePrivate(Uint8Array.of(...der(rsa, "pkcs8"), 0), "pkcs8")).toThrow(/trailing bytes/u);
  });
  it("refuses encodings that do not hold the key type", () => {
    const ec = privateOf(record(record(controls["keys"], "keys")["p256"], "p256"));
    const rsa = privateOf(record(record(controls["keys"], "keys")["rsa1024"], "rsa1024"));
    expect(() => encodePrivate(ec, "pkcs1")).toThrow(/RSA keys only/u);
    expect(() => encodePublic(publicOf(ec), "pkcs1")).toThrow(/RSA keys only/u);
    expect(() => encodePrivate(rsa, "sec1")).toThrow(/EC keys only/u);
  });
  it("refuses key algorithms it does not implement by name", () => {
    // The outline of a DSA SubjectPublicKeyInfo: { { id-dsa, parameters }, BIT STRING { INTEGER } }.
    const dsa = derSequence(derSequence(derOid("1.2.840.10040.4.1"), derNull()), derBitString(derInteger(1n)));
    expect(() => parsePublic(dsa, "spki")).toThrow(expect.objectContaining({ name: "KeyCodecError", failure: "unsupported-algorithm" }));
    const material: KeyMaterial = parsePublic(bytes(record(record(record(record(controls["keys"], "keys")["ed25519"], "ed25519")["public"], "public")["spki"], "spki")["der"]), "spki");
    expect(material.kind).toBe("ed25519");
  });
  it("tells OpenSSL's cipher names apart", () => {
    expect([keyCipher("AES-256-CBC"), keyCipher("aes128"), keyCipher("aes-192-cbc")]).toEqual(["aes-256-cbc", "aes-128-cbc", "aes-192-cbc"]);
    expect([keyCipher("des3"), keyCipher("aes-256-gcm"), keyCipher("des-ede3-cbc")]).toEqual(["unsupported", "unsupported", "unsupported"]);
    expect(keyCipher("bogus")).toBeUndefined();
    expect(legacyEncryption([{ name: "Proc-Type", value: "4,ENCRYPTED" }, { name: "DEK-Info", value: "DES-EDE3-CBC,0011223344556677" }])).toEqual({ state: "unsupported", cipher: "DES-EDE3-CBC" });
    expect(legacyEncryption([{ name: "Comment", value: "x" }])).toEqual({ state: "not-proc-type" });
    expect(pemBlocks("no pem here")).toEqual([]);
  });
});
