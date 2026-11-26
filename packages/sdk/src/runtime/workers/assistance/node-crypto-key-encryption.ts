/**
 * Passphrase protection of private keys as OpenSSL does it: PKCS#8 EncryptedPrivateKeyInfo with PBES2
 * (PBKDF2 and AES-CBC), and the legacy PEM encryption of PKCS#1 and SEC1 keys (`Proc-Type: 4,ENCRYPTED`
 * with a `DEK-Info` header and the MD5-based EVP_BytesToKey derivation).
 */
import { cbc } from "@noble/ciphers/aes.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha224, sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { TAG, concatBytes, derInteger, derNull, derOctetString, derOid, derSequence, readDer } from "./node-crypto-asn1.ts";
import { KeyCodecError } from "./node-crypto-key-model.ts";
import type { PemBlock, PemHeader } from "./node-crypto-pem.ts";

export type KeyCipher = "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc";
const CIPHERS: Readonly<Record<KeyCipher, { readonly oid: string; readonly keyLength: number }>> = Object.freeze({
  "aes-128-cbc": { oid: "2.16.840.1.101.3.4.1.2", keyLength: 16 },
  "aes-192-cbc": { oid: "2.16.840.1.101.3.4.1.22", keyLength: 24 },
  "aes-256-cbc": { oid: "2.16.840.1.101.3.4.1.42", keyLength: 32 },
});
const CIPHER_NAMES: readonly KeyCipher[] = Object.freeze(["aes-128-cbc", "aes-192-cbc", "aes-256-cbc"] as const);
const PBES2 = "1.2.840.113549.1.5.13", PBKDF2 = "1.2.840.113549.1.5.12", HMAC_SHA256 = "1.2.840.113549.2.9";
const PRFS = Object.freeze([
  ["1.2.840.113549.2.7", sha1], ["1.2.840.113549.2.8", sha224], [HMAC_SHA256, sha256], ["1.2.840.113549.2.10", sha384], ["1.2.840.113549.2.11", sha512],
] as const);
/** OpenSSL's default PBKDF2 iteration count for key encryption (PKCS5_DEFAULT_ITER). */
const ITERATIONS = 2048;

/** The passphrase could not decrypt the key. */
export class KeyDecryptError extends Error {
  constructor() { super("bad decrypt"); this.name = "KeyDecryptError"; }
}

/**
 * The cipher a name selects, as OpenSSL resolves names: case-insensitive, with the `aes128`/`aes192`/`aes256`
 * aliases. `"unsupported"` is a cipher OpenSSL has and this implementation does not; `undefined` is no cipher.
 */
export function keyCipher(name: string): KeyCipher | "unsupported" | undefined {
  const lower = name.toLowerCase();
  const alias = /^aes(128|192|256)$/u.exec(lower);
  const resolved = alias === null ? lower : `aes-${alias[1] ?? ""}-cbc`;
  const found = CIPHER_NAMES.find(candidate => candidate === resolved);
  if (found !== undefined) return found;
  return /^(id-)?(aes|aria|camellia|sm4|des|desx|bf|cast5?|rc2|rc4|idea|seed|chacha20)([-\d]|$)/u.test(lower) ? "unsupported" : undefined;
}

function decrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 16 !== 0 || iv.length !== 16) throw new KeyDecryptError();
  try { return cbc(key, iv).decrypt(data); }
  catch { throw new KeyDecryptError(); }
}

/** Whether DER bytes are an EncryptedPrivateKeyInfo (an AlgorithmIdentifier where PrivateKeyInfo has its version). */
export function isEncryptedPkcs8(bytes: Uint8Array): boolean {
  try {
    const info = readDer(bytes);
    if (info.peekTag() !== TAG.sequence) return false;
    info.read(TAG.sequence);
    return info.peekTag() === TAG.octetString;
  } catch { return false; }
}

/** Decrypts an EncryptedPrivateKeyInfo to the PrivateKeyInfo it holds. */
export function decryptPkcs8(bytes: Uint8Array, passphrase: Uint8Array): Uint8Array {
  const info = readDer(bytes);
  const algorithm = info.sequence();
  const data = info.octetString();
  info.end();
  const scheme = algorithm.oid();
  if (scheme !== PBES2) throw new KeyCodecError("unsupported-algorithm", `Unsupported key encryption scheme ${scheme}`);
  const parameters = algorithm.sequence();
  algorithm.end();
  const derivation = parameters.sequence(), encryption = parameters.sequence();
  parameters.end();
  const function_ = derivation.oid();
  if (function_ !== PBKDF2) throw new KeyCodecError("unsupported-algorithm", `Unsupported key derivation function ${function_}`);
  const kdf = derivation.sequence();
  derivation.end();
  const salt = kdf.octetString(), iterations = kdf.smallInteger();
  const statedLength = kdf.peekTag() === TAG.integer ? kdf.smallInteger() : undefined;
  let prf: (typeof PRFS)[number][1] = sha1;
  const prfIdentifier = kdf.optionalEnter(TAG.sequence);
  kdf.end();
  if (prfIdentifier !== undefined) {
    const oid = prfIdentifier.oid();
    const found = PRFS.find(([candidate]) => candidate === oid);
    if (found === undefined) throw new KeyCodecError("unsupported-algorithm", `Unsupported PBKDF2 PRF ${oid}`);
    prf = found[1];
  }
  const cipherOid = encryption.oid();
  const cipher = CIPHER_NAMES.find(name => CIPHERS[name].oid === cipherOid);
  if (cipher === undefined) throw new KeyCodecError("unsupported-algorithm", `Unsupported key encryption cipher ${cipherOid}`);
  const iv = encryption.octetString();
  encryption.end();
  const { keyLength } = CIPHERS[cipher];
  if (statedLength !== undefined && statedLength !== keyLength) throw new KeyDecryptError();
  if (iterations < 1) throw new KeyDecryptError();
  return decrypt(pbkdf2(prf, passphrase, salt, { c: iterations, dkLen: keyLength }), iv, data);
}

/**
 * Encrypts a PrivateKeyInfo as OpenSSL does for `cipher` + `passphrase`: PBES2, PBKDF2 with HMAC-SHA-256,
 * 2048 iterations and a 16-byte salt. `salt` and `iv` are fresh random bytes.
 */
export function encryptPkcs8(bytes: Uint8Array, passphrase: Uint8Array, cipher: KeyCipher, salt: Uint8Array, iv: Uint8Array): Uint8Array {
  const { oid, keyLength } = CIPHERS[cipher];
  const key = pbkdf2(sha256, passphrase, salt, { c: ITERATIONS, dkLen: keyLength });
  return derSequence(
    derSequence(derOid(PBES2), derSequence(
      derSequence(derOid(PBKDF2), derSequence(derOctetString(salt), derInteger(BigInt(ITERATIONS)), derSequence(derOid(HMAC_SHA256), derNull()))),
      derSequence(derOid(oid), derOctetString(iv)))),
    derOctetString(cbc(key, iv).encrypt(bytes)));
}

/** EVP_BytesToKey with MD5 and one round, salted with the first eight bytes of the IV. */
function legacyKey(passphrase: Uint8Array, iv: Uint8Array, length: number): Uint8Array {
  const salt = iv.subarray(0, 8);
  let key: Uint8Array = new Uint8Array(), block: Uint8Array = new Uint8Array();
  while (key.length < length) {
    block = md5(concatBytes(block, passphrase, salt));
    key = concatBytes(key, block);
  }
  return key.subarray(0, length);
}

export type LegacyEncryption =
  | { readonly state: "plain" }
  | { readonly state: "encrypted"; readonly cipher: KeyCipher; readonly iv: Uint8Array }
  | { readonly state: "unsupported"; readonly cipher: string }
  | { readonly state: "not-proc-type" };

/** What a PEM block's headers say about its body. */
export function legacyEncryption(headers: readonly PemHeader[]): LegacyEncryption {
  const [first, second] = headers;
  if (first === undefined) return { state: "plain" };
  if (first.name !== "Proc-Type") return { state: "not-proc-type" };
  if (first.value.replace(/\s/gu, "") !== "4,ENCRYPTED") return { state: "plain" };
  const [name = "", hex = ""] = second?.name === "DEK-Info" ? second.value.split(",") : [];
  const cipher = keyCipher(name.trim());
  if (cipher === undefined || cipher === "unsupported" || !/^([0-9A-Fa-f]{2}){16}$/u.test(hex.trim())) return { state: "unsupported", cipher: name.trim() };
  const iv = Uint8Array.from(hex.trim().match(/../gu) ?? [], pair => Number.parseInt(pair, 16));
  return { state: "encrypted", cipher, iv };
}

export function legacyDecrypt(block: PemBlock, cipher: KeyCipher, iv: Uint8Array, passphrase: Uint8Array): Uint8Array {
  return decrypt(legacyKey(passphrase, iv, CIPHERS[cipher].keyLength), iv, block.body);
}

/** The headers and body of a legacy-encrypted PEM block. `iv` is 16 fresh random bytes. */
export function legacyEncrypt(bytes: Uint8Array, passphrase: Uint8Array, cipher: KeyCipher, iv: Uint8Array): { readonly headers: readonly PemHeader[]; readonly body: Uint8Array } {
  const hex = Array.from(iv, byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return {
    headers: [{ name: "Proc-Type", value: "4,ENCRYPTED" }, { name: "DEK-Info", value: `${cipher.toUpperCase()},${hex}` }],
    body: cbc(legacyKey(passphrase, iv, CIPHERS[cipher].keyLength), iv).encrypt(bytes),
  };
}

