// RSA over raw integers and bytes for the fast-path `node:crypto`: the primitives, the RFC 8017 paddings
// (PKCS#1 v1.5 signatures and encryption, PSS, OAEP) and key generation. No KeyObject, no Node API surface:
// the API layer parses keys into numbers, calls these functions and maps `RsaError` to OpenSSL-shaped errors.
// Behaviour that RFC 8017 leaves open follows OpenSSL 3.5 as Node 24 shows it (recorded in
// node-crypto-rsa.controls.json), including implicit rejection for PKCS#1 v1.5 decryption.
import { hmac } from "@noble/hashes/hmac.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2.js";
import { sha3_224, sha3_256, sha3_384, sha3_512 } from "@noble/hashes/sha3.js";
import { bigIntToBytes, bitLength, bytesToBigInt, gcd, modInverse, modPow, randomBelow, type Entropy } from "./node-crypto-bigint.ts";
import { generatePrimeSteps } from "./node-crypto-primes.ts";

export interface RsaPublicNumbers { readonly n: bigint; readonly e: bigint }
export interface RsaPrivateNumbers extends RsaPublicNumbers { readonly d: bigint; readonly p: bigint; readonly q: bigint; readonly dp: bigint; readonly dq: bigint; readonly qi: bigint }
export type HashName = "sha1" | "sha224" | "sha256" | "sha384" | "sha512" | "sha512-224" | "sha512-256" | "sha3-224" | "sha3-256" | "sha3-384" | "sha3-512" | "md5" | "ripemd160";

export type RsaErrorReason = "data-too-large" | "bad-padding" | "bad-signature" | "key-too-small" | "invalid-salt-length" | "oaep-decoding" | "data-too-large-for-modulus"
  | "data-too-small" | "invalid-digest-length" | "public-exponent-out-of-range";
/** The reason text OpenSSL gives for the same failure (`error.reason` in Node, the tail of its message). */
export type RsaErrorDetail = "data too large for key size" | "data greater than mod len" | "data too large for modulus" | "data too small for key size"
  | "digest too big for rsa key" | "key size too small" | "invalid digest length" | "invalid salt length" | "oaep decoding error" | "pub exponent out of range"
  | "invalid padding" | "block type is not 01" | "bad fixed header decrypt" | "null before block missing" | "bad pad byte count" | "bad signature";

export class RsaError extends Error {
  readonly reason: RsaErrorReason;
  readonly detail: RsaErrorDetail;
  constructor(reason: RsaErrorReason, detail: RsaErrorDetail) {
    super(`RSA: ${detail}`);
    this.name = "RsaError";
    this.reason = reason;
    this.detail = detail;
  }
}
Object.defineProperty(RsaError, "name", { value: "RsaError" });

// --- Hashes ---------------------------------------------------------------------------------------------

interface HashSpec { readonly digest: (data: Uint8Array) => Uint8Array; readonly length: number; readonly oid: readonly number[] }
const NIST = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02];
const HASHES: Readonly<Record<HashName, HashSpec>> = {
  "md5": { digest: data => md5(data), length: 16, oid: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05] },
  "ripemd160": { digest: data => ripemd160(data), length: 20, oid: [0x2b, 0x24, 0x03, 0x02, 0x01] },
  "sha1": { digest: data => sha1(data), length: 20, oid: [0x2b, 0x0e, 0x03, 0x02, 0x1a] },
  "sha224": { digest: data => sha224(data), length: 28, oid: [...NIST, 0x04] },
  "sha256": { digest: data => sha256(data), length: 32, oid: [...NIST, 0x01] },
  "sha384": { digest: data => sha384(data), length: 48, oid: [...NIST, 0x02] },
  "sha512": { digest: data => sha512(data), length: 64, oid: [...NIST, 0x03] },
  "sha512-224": { digest: data => sha512_224(data), length: 28, oid: [...NIST, 0x05] },
  "sha512-256": { digest: data => sha512_256(data), length: 32, oid: [...NIST, 0x06] },
  "sha3-224": { digest: data => sha3_224(data), length: 28, oid: [...NIST, 0x07] },
  "sha3-256": { digest: data => sha3_256(data), length: 32, oid: [...NIST, 0x08] },
  "sha3-384": { digest: data => sha3_384(data), length: 48, oid: [...NIST, 0x09] },
  "sha3-512": { digest: data => sha3_512(data), length: 64, oid: [...NIST, 0x0a] },
};

export function hashBytes(name: HashName, data: Uint8Array): Uint8Array { return HASHES[name].digest(data); }
export function digestLength(name: HashName): number { return HASHES[name].length; }

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// Compares every byte whatever the content; unequal lengths differ.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function xorInto(target: Uint8Array, mask: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) target[index] = (target[index] ?? 0) ^ (mask[index] ?? 0);
}

/** MGF1 of RFC 8017 appendix B.2.1. */
export function mgf1(hash: HashName, seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const input = concat(seed, new Uint8Array(4));
  const view = new DataView(input.buffer);
  for (let counter = 0, offset = 0; offset < length; counter += 1) {
    view.setUint32(seed.length, counter);
    const block = hashBytes(hash, input);
    out.set(block.subarray(0, Math.min(block.length, length - offset)), offset);
    offset += block.length;
  }
  return out;
}

// --- Primitives -----------------------------------------------------------------------------------------

/** Bytes in the modulus: the length of every signature and ciphertext. */
export function modulusLength(key: RsaPublicNumbers): number { return Math.ceil(bitLength(key.n) / 8); }

export function rsaPublicOp(key: RsaPublicNumbers, message: bigint): bigint {
  if (message < 0n || message >= key.n) throw new RsaError("data-too-large-for-modulus", "data too large for modulus");
  return modPow(message, key.e, key.n);
}

/**
 * The private operation by the Chinese remainder theorem. With `entropy` the input is blinded with a random
 * factor first. The result is checked with the public operation; a mismatch (a wrong CRT parameter) falls
 * back to the plain exponentiation, as OpenSSL does.
 */
export function rsaPrivateOp(key: RsaPrivateNumbers, message: bigint, entropy?: Entropy): bigint {
  const { n, e, p, q } = key;
  if (message < 0n || message >= n) throw new RsaError("data-too-large-for-modulus", "data too large for modulus");
  let input = message;
  let unblind: bigint | undefined;
  if (entropy !== undefined) {
    let factor: bigint;
    do factor = randomBelow(n, entropy); while (factor < 2n || gcd(factor, n) !== 1n);
    input = (message * modPow(factor, e, n)) % n;
    unblind = modInverse(factor, n);
  }
  const fromP = modPow(input % p, key.dp, p);
  const fromQ = modPow(input % q, key.dq, q);
  let lift = (key.qi * (fromP - fromQ)) % p;
  if (lift < 0n) lift += p;
  let result = fromQ + lift * q;
  if (result >= n || modPow(result, e, n) !== input) result = modPow(input, key.d, n);
  return unblind === undefined ? result : (result * unblind) % n;
}

// An input no longer than the modulus, as the integer below the modulus that OpenSSL requires.
function integerFrom(key: RsaPublicNumbers, data: Uint8Array): bigint {
  if (data.length > modulusLength(key)) throw new RsaError("data-too-large", "data greater than mod len");
  const value = bytesToBigInt(data);
  if (value >= key.n) throw new RsaError("data-too-large-for-modulus", "data too large for modulus");
  return value;
}

/** RSA_NO_PADDING with the public key. Shorter input counts as left-padded with zeros; the output has the modulus length. */
export function rawPublic(key: RsaPublicNumbers, data: Uint8Array): Uint8Array {
  return bigIntToBytes(rsaPublicOp(key, integerFrom(key, data)), modulusLength(key));
}

/** RSA_NO_PADDING with the private key. */
export function rawPrivate(key: RsaPrivateNumbers, data: Uint8Array, entropy?: Entropy): Uint8Array {
  return bigIntToBytes(rsaPrivateOp(key, integerFrom(key, data), entropy), modulusLength(key));
}

// --- PKCS#1 v1.5 signatures (block type 1) --------------------------------------------------------------

function digestInfo(hash: HashName, digest: Uint8Array): Uint8Array {
  const { oid, length } = HASHES[hash];
  if (digest.length !== length) throw new RsaError("invalid-digest-length", "invalid digest length");
  const algorithm = [0x30, oid.length + 4, 0x06, oid.length, ...oid, 0x05, 0x00];
  return concat(Uint8Array.from([0x30, algorithm.length + 2 + length, ...algorithm, 0x04, length]), digest);
}

// 00 01 FF..FF 00 payload, with at least eight FF bytes.
function typeOneBlock(payload: Uint8Array, length: number, tooLong: RsaError): Uint8Array {
  if (payload.length + 11 > length) throw tooLong;
  const block = new Uint8Array(length).fill(0xff);
  block[0] = 0;
  block[1] = 1;
  block[length - payload.length - 1] = 0;
  block.set(payload, length - payload.length);
  return block;
}

function signatureBlock(key: RsaPublicNumbers, hash: HashName | null, digest: Uint8Array): Uint8Array {
  if (hash === null) return typeOneBlock(digest, modulusLength(key), new RsaError("data-too-large", "data too large for key size"));
  return typeOneBlock(digestInfo(hash, digest), modulusLength(key), new RsaError("key-too-small", "digest too big for rsa key"));
}

/** EMSA-PKCS1-v1_5. With `hash` null the bytes are padded as they are (`privateEncrypt` with RSA_PKCS1_PADDING). */
export function pkcs1v15Sign(key: RsaPrivateNumbers, hash: HashName | null, digest: Uint8Array, entropy?: Entropy): Uint8Array {
  const block = signatureBlock(key, hash, digest);
  return bigIntToBytes(rsaPrivateOp(key, bytesToBigInt(block), entropy), block.length);
}

/** Re-encodes the expected block and compares: no parsing of what the signature contains. */
export function pkcs1v15Verify(key: RsaPublicNumbers, hash: HashName | null, digest: Uint8Array, signature: Uint8Array): boolean {
  const length = modulusLength(key);
  if (signature.length !== length) return false;
  const value = bytesToBigInt(signature);
  if (value >= key.n) return false;
  let expected: Uint8Array;
  try { expected = signatureBlock(key, hash, digest); }
  catch (error) { if (error instanceof RsaError) return false; throw error; }
  return sameBytes(bigIntToBytes(modPow(value, key.e, key.n), length), expected);
}

/** `publicDecrypt` with RSA_PKCS1_PADDING: the payload of a type 1 block. The checks and their order are OpenSSL's. */
export function pkcs1v15Recover(key: RsaPublicNumbers, signature: Uint8Array): Uint8Array {
  const length = modulusLength(key);
  const block = bigIntToBytes(rsaPublicOp(key, integerFrom(key, signature)), length);
  if (length < 11 || block[0] !== 0) throw new RsaError("bad-padding", "invalid padding");
  if (block[1] !== 1) throw new RsaError("bad-padding", "block type is not 01");
  let separator = 2;
  while (separator < length && block[separator] === 0xff) separator += 1;
  if (separator === length) throw new RsaError("bad-padding", "null before block missing");
  if (block[separator] !== 0) throw new RsaError("bad-padding", "bad fixed header decrypt");
  if (separator - 2 < 8) throw new RsaError("bad-padding", "bad pad byte count");
  return block.slice(separator + 1);
}

// --- PSS ------------------------------------------------------------------------------------------------

function pssHash(hash: HashName, digest: Uint8Array, salt: Uint8Array): Uint8Array {
  return hashBytes(hash, concat(new Uint8Array(8), digest, salt));
}

/**
 * EMSA-PSS over an already computed digest. `saltLength` is a byte count (the API layer resolves Node's
 * RSA_PSS_SALTLEN_DIGEST and RSA_PSS_SALTLEN_MAX_SIGN; the longest is `pssMaxSaltLength`). The salt is the
 * first thing drawn from `entropy`; blinding draws follow.
 */
export function pssSign(key: RsaPrivateNumbers, hash: HashName, mgfHash: HashName, saltLength: number, digest: Uint8Array, entropy: Entropy): Uint8Array {
  const hashLength = digestLength(hash);
  if (digest.length !== hashLength) throw new RsaError("invalid-digest-length", "invalid digest length");
  if (!Number.isInteger(saltLength) || saltLength < 0) throw new RsaError("invalid-salt-length", "invalid salt length");
  const encodedBits = bitLength(key.n) - 1;
  const encodedLength = Math.ceil(encodedBits / 8);
  if (encodedLength < hashLength + saltLength + 2) throw new RsaError("data-too-large", "data too large for key size");
  const salt = new Uint8Array(saltLength);
  if (saltLength > 0) entropy(salt);
  const seed = pssHash(hash, digest, salt);
  const data = new Uint8Array(encodedLength - hashLength - 1);
  data[data.length - saltLength - 1] = 1;
  data.set(salt, data.length - saltLength);
  xorInto(data, mgf1(mgfHash, seed, data.length));
  data[0] = (data[0] ?? 0) & (0xff >> (8 * encodedLength - encodedBits));
  const encoded = concat(data, seed, Uint8Array.of(0xbc));
  return bigIntToBytes(rsaPrivateOp(key, bytesToBigInt(encoded), entropy), modulusLength(key));
}

/** The longest salt a key takes with this hash (RSA_PSS_SALTLEN_MAX_SIGN); negative when the key is too small for the hash. */
export function pssMaxSaltLength(key: RsaPublicNumbers, hash: HashName): number {
  return Math.ceil((bitLength(key.n) - 1) / 8) - digestLength(hash) - 2;
}

/** EMSA-PSS-VERIFY. `"auto"` accepts whatever salt length the signature carries (RSA_PSS_SALTLEN_AUTO). */
export function pssVerify(key: RsaPublicNumbers, hash: HashName, mgfHash: HashName, saltLength: number | "auto", digest: Uint8Array, signature: Uint8Array): boolean {
  const hashLength = digestLength(hash);
  if (digest.length !== hashLength || signature.length !== modulusLength(key)) return false;
  const value = bytesToBigInt(signature);
  if (value >= key.n) return false;
  const encodedBits = bitLength(key.n) - 1;
  const encodedLength = Math.ceil(encodedBits / 8);
  const opened = modPow(value, key.e, key.n);
  if (bitLength(opened) > encodedBits || encodedLength < hashLength + 2) return false;
  const encoded = bigIntToBytes(opened, encodedLength);
  if (encoded[encodedLength - 1] !== 0xbc) return false;
  const data = encoded.slice(0, encodedLength - hashLength - 1);
  const seed = encoded.subarray(data.length, encodedLength - 1);
  xorInto(data, mgf1(mgfHash, seed, data.length));
  data[0] = (data[0] ?? 0) & (0xff >> (8 * encodedLength - encodedBits));
  let separator = 0;
  while (separator < data.length && data[separator] === 0) separator += 1;
  if (separator === data.length || data[separator] !== 1) return false;
  const salt = data.subarray(separator + 1);
  if (saltLength !== "auto" && salt.length !== saltLength) return false;
  return sameBytes(pssHash(hash, digest, salt), seed);
}

// --- OAEP -----------------------------------------------------------------------------------------------

export function oaepEncrypt(key: RsaPublicNumbers, hash: HashName, mgfHash: HashName, label: Uint8Array, message: Uint8Array, entropy: Entropy): Uint8Array {
  const length = modulusLength(key);
  const hashLength = digestLength(hash);
  if (message.length > length - 2 * hashLength - 2) throw new RsaError("data-too-large", "data too large for key size");
  const data = new Uint8Array(length - hashLength - 1);
  data.set(hashBytes(hash, label));
  data[data.length - message.length - 1] = 1;
  data.set(message, data.length - message.length);
  const seed = new Uint8Array(hashLength);
  entropy(seed);
  xorInto(data, mgf1(mgfHash, seed, data.length));
  xorInto(seed, mgf1(mgfHash, data, hashLength));
  return bigIntToBytes(rsaPublicOp(key, bytesToBigInt(concat(Uint8Array.of(0), seed, data))), length);
}

/** Throws `RsaError` "oaep-decoding" for every decoding failure alike; all checks run before the decision. */
export function oaepDecrypt(key: RsaPrivateNumbers, hash: HashName, mgfHash: HashName, label: Uint8Array, ciphertext: Uint8Array, entropy?: Entropy): Uint8Array {
  const length = modulusLength(key);
  const hashLength = digestLength(hash);
  const input = integerFrom(key, ciphertext);
  if (length < 2 * hashLength + 2) throw new RsaError("oaep-decoding", "oaep decoding error");
  const block = bigIntToBytes(rsaPrivateOp(key, input, entropy), length);
  const seed = block.slice(1, 1 + hashLength);
  const data = block.slice(1 + hashLength);
  xorInto(seed, mgf1(mgfHash, data, hashLength));
  xorInto(data, mgf1(mgfHash, seed, data.length));
  let bad = block[0] ?? 0;
  const labelHash = hashBytes(hash, label);
  for (let index = 0; index < hashLength; index += 1) bad |= (data[index] ?? 0) ^ (labelHash[index] ?? 0);
  // The first non-zero byte after the label hash must be the 01 separator.
  let separator = 0;
  let found = 0;
  for (let index = hashLength; index < data.length; index += 1) {
    const byte = data[index] ?? 0;
    const first = found === 0 && byte !== 0 ? 1 : 0;
    separator = first === 1 ? index : separator;
    bad |= first === 1 ? byte ^ 1 : 0;
    found |= first;
  }
  if (bad !== 0 || found === 0) throw new RsaError("oaep-decoding", "oaep decoding error");
  return data.slice(separator + 1);
}

// --- PKCS#1 v1.5 encryption (block type 2) --------------------------------------------------------------

export function pkcs1v15Encrypt(key: RsaPublicNumbers, message: Uint8Array, entropy: Entropy): Uint8Array {
  const length = modulusLength(key);
  if (message.length > length - 11) throw new RsaError("data-too-large", "data too large for key size");
  const padding = new Uint8Array(length - message.length - 3);
  entropy(padding);
  const single = new Uint8Array(1);
  for (let index = 0; index < padding.length; index += 1) {
    while (padding[index] === 0) { entropy(single); padding[index] = single[0] ?? 0; }
  }
  return bigIntToBytes(rsaPublicOp(key, bytesToBigInt(concat(Uint8Array.of(0, 2), padding, Uint8Array.of(0), message))), length);
}

// The pseudo-random function of OpenSSL's implicit rejection (`ossl_rsa_prf`): HMAC-SHA256 blocks over a
// 16-bit counter, a label and the 16-bit output length in bits.
function rejectionStream(key: Uint8Array, label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const labelBytes = Uint8Array.from(label, character => character.charCodeAt(0));
  const bits = (length * 8) & 0xffff;
  for (let counter = 0, offset = 0; offset < length; counter += 1, offset += 32) {
    const block = hmac(sha256, key, concat(Uint8Array.of((counter >> 8) & 0xff, counter & 0xff), labelBytes, Uint8Array.of(bits >> 8, bits & 0xff)));
    out.set(block.subarray(0, Math.min(32, length - offset)), offset);
  }
  return out;
}

const REJECTION_LENGTH_CANDIDATES = 128;

/**
 * RSAES-PKCS1-v1_5 decryption with implicit rejection, as OpenSSL 3.2 and later (`rsa_ossl_private_decrypt`,
 * `ossl_rsa_padding_check_PKCS1_type_2`): a block with bad padding does not fail; it gives a message of
 * pseudo-random length and content derived from the private exponent and the ciphertext, so the same bad
 * ciphertext always decrypts to the same bytes and the caller cannot tell it from a valid one.
 */
export function pkcs1v15Decrypt(key: RsaPrivateNumbers, ciphertext: Uint8Array, entropy?: Entropy): Uint8Array {
  const length = modulusLength(key);
  const input = integerFrom(key, ciphertext);
  if (length < 11) throw new RsaError("data-too-small", "data too small for key size");
  // Key derivation key: HMAC-SHA256 keyed with SHA-256 of the private exponent, over the ciphertext, both padded to the modulus length.
  const derivationKey = hmac(sha256, sha256(bigIntToBytes(key.d, length)), bigIntToBytes(input, length));
  const block = bigIntToBytes(rsaPrivateOp(key, input, entropy), length);
  const synthetic = rejectionStream(derivationKey, "message", length);
  const lengths = rejectionStream(derivationKey, "length", REJECTION_LENGTH_CANDIDATES * 2);
  const longest = length - 2 - 8;
  let mask = longest;
  mask |= mask >> 1; mask |= mask >> 2; mask |= mask >> 4; mask |= mask >> 8;
  let syntheticLength = 0;
  for (let index = 0; index < lengths.length; index += 2) {
    const candidate = (((lengths[index] ?? 0) << 8) | (lengths[index + 1] ?? 0)) & mask;
    syntheticLength = candidate < longest ? candidate : syntheticLength;
  }
  let good = block[0] === 0 ? 1 : 0;
  good &= block[1] === 2 ? 1 : 0;
  let zeroIndex = 0;
  let foundZero = 0;
  for (let index = 2; index < length; index += 1) {
    const isZero = block[index] === 0 ? 1 : 0;
    zeroIndex = foundZero === 0 && isZero === 1 ? index : zeroIndex;
    foundZero |= isZero;
  }
  good &= zeroIndex >= 2 + 8 ? 1 : 0;
  const source = good === 1 ? block : synthetic;
  return source.slice(good === 1 ? zeroIndex + 1 : length - syntheticLength);
}

// --- Key generation -------------------------------------------------------------------------------------

function integerSquareRoot(value: bigint): bigint {
  if (value < 2n) return value;
  let estimate = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function privateNumbers(first: bigint, second: bigint, e: bigint, d: bigint): RsaPrivateNumbers {
  const [p, q] = first > second ? [first, second] : [second, first];
  return { n: p * q, e, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qi: modInverse(q, p) };
}

/**
 * Cooperative RSA key generation, yielding about every `budgetMs` milliseconds. It follows the two paths of
 * OpenSSL 3.5 as measured on keys Node 24 generates:
 *  - at least 2048 bits with an exponent above 65536 (SP 800-56B): both primes have `bits / 2` bits (rounded
 *    down, so an odd size gives a modulus one bit shorter) and lie above sqrt(2) * 2^(bits/2 - 1), differ in
 *    their top 100 bits, and d = e^-1 mod lcm(p - 1, q - 1) with d > 2^(bits/2);
 *  - otherwise (small keys, small exponents): primes with their two top bits set, the first one bit longer
 *    for an odd size, and d = e^-1 mod (p - 1)(q - 1).
 * Either way p > q. OpenSSL derives each SP 800-56B prime from two auxiliary primes; this draws them directly.
 */
export function* generateRsaKeySteps(bits: number, publicExponent: bigint, entropy: Entropy, budgetMs: number): Generator<undefined, RsaPrivateNumbers, undefined> {
  if (!Number.isInteger(bits) || bits < 512) throw new RsaError("key-too-small", "key size too small");
  const e = publicExponent;
  if (e < 3n || (e & 1n) === 0n) throw new RsaError("public-exponent-out-of-range", "pub exponent out of range");
  const accept = (candidate: bigint): boolean => gcd(candidate - 1n, e) === 1n;
  if (bits < 2048 || bitLength(e) <= 16) {
    const firstBits = Math.ceil(bits / 2);
    const first = yield* generatePrimeSteps({ bits: firstBits, topTwoBits: true, accept }, entropy, budgetMs);
    let second: bigint;
    do second = yield* generatePrimeSteps({ bits: bits - firstBits, topTwoBits: true, accept }, entropy, budgetMs); while (second === first);
    return privateNumbers(first, second, e, modInverse(e, (first - 1n) * (second - 1n)));
  }
  const primeBits = bits >> 1;
  const minimum = integerSquareRoot(1n << BigInt(2 * primeBits - 1)) + 1n;
  // Miller-Rabin rounds for randomly drawn candidates, FIPS 186-5 table B.1 as OpenSSL applies it.
  const rounds = bits >= 3072 ? 4 : 5;
  const closest = 1n << BigInt(primeBits - 100);
  for (;;) {
    const first = yield* generatePrimeSteps({ bits: primeBits, minimum, rounds, accept }, entropy, budgetMs);
    let second: bigint;
    let distance: bigint;
    do {
      second = yield* generatePrimeSteps({ bits: primeBits, minimum, rounds, accept }, entropy, budgetMs);
      distance = first > second ? first - second : second - first;
    } while (distance <= closest);
    const totient = (first - 1n) * (second - 1n);
    const d = modInverse(e, totient / gcd(first - 1n, second - 1n));
    if (d > 1n << BigInt(bits >> 1)) return privateNumbers(first, second, e, d);
  }
}

/** Runs key generation to completion on the calling turn. */
export function generateRsaKey(bits: number, publicExponent: bigint, entropy: Entropy): RsaPrivateNumbers {
  const steps = generateRsaKeySteps(bits, publicExponent, entropy, Number.POSITIVE_INFINITY);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}
