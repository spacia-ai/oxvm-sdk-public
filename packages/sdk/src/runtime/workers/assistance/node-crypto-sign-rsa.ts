// RSA signatures as `node:crypto` makes and checks them: which scheme a key, a digest and the `padding` and
// `saltLength` options select, with OpenSSL's refusals in OpenSSL's order (recorded in
// node-crypto-sign.controls.json). The arithmetic is node-crypto-rsa.ts.
import { unavailableNodeApi } from "./node-capability.ts";
import { bitLength, type Entropy } from "./node-crypto-bigint.ts";
import { OSSL, opensslError, type OpensslEntry } from "./node-crypto-key-errors.ts";
import type { RsaPrivate, RsaPublic } from "./node-crypto-key-model.ts";
import { type Digest, digestFor, unsupportedDigest } from "./node-crypto-misc.ts";
import { digestLength, hashBytes, type HashName, modulusLength, pkcs1v15Sign, pkcs1v15Verify, pssMaxSaltLength, pssSign, pssVerify } from "./node-crypto-rsa.ts";
import { SIGN_OSSL, withRsaErrors } from "./node-crypto-sign-errors.ts";

// The browser's entropy source, taken before a program can decorate it.
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
/** Fills `bytes` from the browser's entropy. */
export const entropy: Entropy = bytes => {
  for (let start = 0; start < bytes.length; start += 65_536) bytes.set(getRandomValues(new Uint8Array(Math.min(65_536, bytes.length - start))), start);
};

export const RSA_PADDING = Object.freeze({ pkcs1: 1, none: 3, oaep: 4, x931: 5, pss: 6 });
const SALT_DIGEST = -1, SALT_AUTO = -2, SALT_MAX = -3, SALT_AUTO_DIGEST_MAX = -4;

/** `one-shot` is `crypto.sign` / `crypto.verify`; `stream` is the Sign and Verify classes, which configure OpenSSL in another order. */
export type SignMode = "one-shot" | "stream";
export interface RsaSignOptions { readonly padding: number | undefined; readonly saltLength: number | undefined }
type Scheme =
  | { readonly kind: "pkcs1"; readonly hash: HashName }
  | { readonly kind: "pss"; readonly hash: HashName; readonly mgf: HashName; readonly salt: number | "auto" };

/** The digest of the RSA primitives behind a digest name; `undefined` for a digest RSA signatures do not take. */
export function rsaHash(name: string): HashName | undefined {
  const digest = digestFor(name);
  if (digest?.kind !== "fixed") return undefined;
  switch (digest.name) {
    case "sha1": case "sha224": case "sha256": case "sha384": case "sha512": case "sha512-224": case "sha512-256":
    case "sha3-224": case "sha3-256": case "sha3-384": case "sha3-512": case "md5": case "ripemd160": return digest.name;
    default: return undefined;
  }
}

/** The digest a signature uses when `algorithm` is null: the one an RSA-PSS key is restricted to, else SHA-256. */
export function rsaDefaultDigest(key: RsaPublic): Digest | undefined {
  return digestFor(key.kind === "rsa-pss" && key.pss !== undefined ? key.pss.hashAlgorithm : "sha256");
}

function selectScheme(key: RsaPublic, digest: Digest, options: RsaSignOptions, mode: SignMode, signing: boolean, failure: (main: OpensslEntry) => Error): Scheme {
  const restricted = key.kind === "rsa-pss" ? key.pss : undefined;
  const restrictedHash = restricted === undefined ? undefined : rsaHash(restricted.hashAlgorithm);
  if (restricted !== undefined && restrictedHash !== undefined) {
    // A key whose own minimum salt cannot fit is refused before anything else is looked at.
    const longest = modulusLength(key) - digestLength(restrictedHash) - ((bitLength(key.n) & 7) === 1 ? 1 : 0);
    if (restricted.saltLength > longest) throw opensslError(SIGN_OSSL.invalidSaltLength);
  }
  const allowed = (): HashName => {
    if (digest.kind === "unavailable") throw opensslError(SIGN_OSSL.evpUnsupported, [SIGN_OSSL.invalidDigest]);
    if (digest.kind === "unsupported") throw unsupportedDigest(digest.name);
    const hash = rsaHash(digest.name);
    if (hash === undefined || (restrictedHash !== undefined && restrictedHash !== hash)) throw opensslError(SIGN_OSSL.digestNotAllowed);
    return hash;
  };
  // EVP_DigestSign takes the digest first; the classes hash on their own and name the digest last.
  let hash = mode === "one-shot" ? allowed() : undefined;
  const padding = mode === "one-shot" && options.padding === -1 ? undefined : options.padding;
  let pss = key.kind === "rsa-pss";
  if (pss) {
    if (padding !== undefined && padding !== RSA_PADDING.pss) throw opensslError(SIGN_OSSL.illegalPaddingMode);
  } else if (padding === RSA_PADDING.pss) pss = true;
  else if (padding === RSA_PADDING.none) throw opensslError(SIGN_OSSL.invalidPaddingMode);
  else if (padding === RSA_PADDING.x931) {
    if (mode === "stream") throw opensslError(SIGN_OSSL.invalidX931Digest);
    return unavailableNodeApi("crypto RSA_X931_PADDING signatures");
  } else if (padding !== undefined && padding !== RSA_PADDING.pkcs1) throw opensslError(SIGN_OSSL.illegalPaddingMode);
  if (!pss) return { kind: "pkcs1", hash: hash ?? allowed() };

  const requested = options.saltLength;
  if (requested !== undefined) {
    if (requested < SALT_AUTO_DIGEST_MAX) throw opensslError(SIGN_OSSL.invalidSaltLength);
    if (restricted !== undefined) {
      if (signing && (requested === SALT_AUTO || requested === SALT_AUTO_DIGEST_MAX)) throw opensslError(SIGN_OSSL.invalidSaltLength);
      if (requested >= 0 && requested < restricted.saltLength) throw opensslError(SIGN_OSSL.saltLengthTooSmall);
    }
  }
  hash ??= allowed();
  const size = digestLength(hash), longest = pssMaxSaltLength(key, hash);
  if (requested === SALT_DIGEST && restricted !== undefined && restricted.saltLength > size) throw opensslError(SIGN_OSSL.saltLengthTooSmall);
  let salt: number | "auto";
  if (requested === undefined) salt = restricted === undefined ? (signing ? Math.min(size, longest) : "auto") : restricted.saltLength;
  else if (requested === SALT_DIGEST) salt = size;
  else if (requested === SALT_MAX) salt = longest;
  else if (requested === SALT_AUTO) salt = signing ? longest : "auto";
  else if (requested === SALT_AUTO_DIGEST_MAX) salt = signing ? Math.min(size, longest) : "auto";
  else salt = requested;
  if (signing && salt !== "auto" && salt < 0) throw failure(SIGN_OSSL.dataTooLargeForKeySize);
  const mgf = restricted === undefined ? hash : rsaHash(restricted.mgf1HashAlgorithm) ?? hash;
  return { kind: "pss", hash, mgf, salt };
}

function privateOf(key: RsaPublic | RsaPrivate): RsaPrivate | undefined { return "d" in key ? key : undefined; }

/**
 * Signs `message` (the one-shot form hashes it here) or the digest a Sign object computed. Every refusal is
 * OpenSSL's; the queue Node attaches differs between the two forms.
 */
export function rsaSign(key: RsaPublic | RsaPrivate, digest: Digest, input: { readonly message: Uint8Array } | { readonly digest: Uint8Array }, options: RsaSignOptions, mode: SignMode): Uint8Array {
  const queue = mode === "one-shot" ? [SIGN_OSSL.rsaLib] : [SIGN_OSSL.signatureFailure, SIGN_OSSL.rsaLib];
  const failure = (main: OpensslEntry): Error => opensslError(main, queue);
  const scheme = selectScheme(key, digest, options, mode, true, failure);
  const secret = privateOf(key);
  if (secret === undefined) throw opensslError(OSSL.rsaMissingPrivateKey, queue);
  const hashed = "digest" in input ? input.digest : hashBytes(scheme.hash, input.message);
  return withRsaErrors(() => {
    if (scheme.kind === "pkcs1") return pkcs1v15Sign(secret, scheme.hash, hashed, entropy);
    return pssSign(secret, scheme.hash, scheme.mgf, scheme.salt === "auto" ? 0 : scheme.salt, hashed, entropy);
  }, () => queue);
}

/** Whether `signature` is this key's over the message or digest. Refusals throw; the Verify class turns them into `false`. */
export function rsaVerify(key: RsaPublic, digest: Digest, input: { readonly message: Uint8Array } | { readonly digest: Uint8Array }, signature: Uint8Array, options: RsaSignOptions, mode: SignMode): boolean {
  const scheme = selectScheme(key, digest, options, mode, false, main => opensslError(main));
  const hashed = "digest" in input ? input.digest : hashBytes(scheme.hash, input.message);
  if (scheme.kind === "pkcs1") return pkcs1v15Verify(key, scheme.hash, hashed, signature);
  return pssVerify(key, scheme.hash, scheme.mgf, scheme.salt, hashed, signature);
}
