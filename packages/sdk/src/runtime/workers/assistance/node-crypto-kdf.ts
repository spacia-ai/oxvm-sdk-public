/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/pbkdf2.js, lib/internal/crypto/scrypt.js,
 * lib/internal/crypto/hkdf.js and lib/internal/crypto/argon2.js (argument handling and validation order), and the
 * parameter checks of OpenSSL 3.5 providers/implementations/kdfs/scrypt.c (Apache-2.0) as Node reports them.
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";
import { hkdf as deriveHkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2 as derivePbkdf2 } from "@noble/hashes/pbkdf2.js";
import { scrypt as deriveScrypt } from "@noble/hashes/scrypt.js";
import type { CHash } from "@noble/hashes/utils.js";
import { Buffer } from "buffer/";
import { VMError } from "../../errors.ts";
import { byteSource, digestFor, invalidDigest, isAnyArrayBuffer, jobReceiver, type KeyBytes, member, truthy, unsupportedDigest } from "./node-crypto-misc.ts";
import { type CryptoPorts, later } from "./node-crypto-ports.ts";
import { invalidValue, named, outOfRange, validateFunction, validateInteger, validateObject, validateString } from "./node-util-validators.ts";

const UINT32_MAX = 4_294_967_295, INT32_MAX = 2_147_483_647;
/** What OpenSSL's derivation reports through Node when it fails without a reason of its own. */
function derivingFailed(): Error { return new Error("Deriving bits failed"); }
/** The hash a derivation runs on: an unknown name is refused at once, a known one that cannot be used fails the derivation. */
function derivationHash(name: string): CHash | undefined {
  const digest = digestFor(name);
  if (digest === undefined) throw invalidDigest(name);
  if (digest.kind === "unsupported") throw unsupportedDigest(name);
  return digest.kind === "fixed" ? digest.hash : undefined;
}
/** An asynchronous form: the work runs in a later turn, and the callback gets Node's job as its receiver and one argument on failure. */
function queue(ports: CryptoPorts, job: string, work: () => unknown, callback: (...args: unknown[]) => unknown): void {
  const receiver = jobReceiver(job);
  later(ports, work, (error, value) => { Reflect.apply(callback, receiver, error === null ? [null, value] : [error]); });
}

function pbkdf2Check(password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown) {
  validateString(digest, "digest");
  const secret = byteSource(password, "password"), seasoning = byteSource(salt, "salt");
  // OpenSSL counts both in a signed int.
  validateInteger(iterations, "iterations", 1, INT32_MAX);
  validateInteger(keylen, "keylen", 0, INT32_MAX);
  return { secret, seasoning, iterations, keylen, digest };
}
function pbkdf2Run(hash: CHash | undefined, secret: Uint8Array, seasoning: Uint8Array, iterations: number, keylen: number): Buffer {
  // OpenSSL refuses an empty key, and has no PBKDF2 over an extendable or a legacy digest.
  if (hash === undefined || keylen === 0) throw derivingFailed();
  return Buffer.from(derivePbkdf2(hash, secret, seasoning, { c: iterations, dkLen: keylen }));
}

const SCRYPT_DEFAULTS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
function scryptParameters(): RangeError { return Object.assign(new RangeError("Invalid scrypt params"), { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" }); }
function scryptMemory(): RangeError {
  return Object.assign(new RangeError("Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded"), { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" });
}
function incompatible(first: string, second: string): TypeError {
  return Object.assign(new TypeError(`Option "${first}" cannot be used in combination with option "${second}"`), { code: "ERR_INCOMPATIBLE_OPTION_PAIR" });
}
/** One cost parameter under its short or its long name; naming both is an error, and zero means the default. */
function scryptOption(options: unknown, short: "N" | "r" | "p", long: string): number {
  let value: number = SCRYPT_DEFAULTS[short];
  const brief: unknown = member(options, short), full: unknown = member(options, long);
  if (brief !== undefined) { validateInteger(brief, short, 0, UINT32_MAX); value = brief; }
  if (full !== undefined) {
    if (brief !== undefined) throw incompatible(short, long);
    validateInteger(full, long, 0, UINT32_MAX); value = full;
  }
  return value === 0 ? SCRYPT_DEFAULTS[short] : value;
}
function scryptCheck(password: unknown, salt: unknown, keylen: unknown, options: unknown) {
  const secret = byteSource(password, "password"), seasoning = byteSource(salt, "salt");
  validateInteger(keylen, "keylen", 0, INT32_MAX);
  let { N, r, p, maxmem }: { N: number; r: number; p: number; maxmem: number } = SCRYPT_DEFAULTS;
  if (truthy(options) && options !== SCRYPT_DEFAULTS) {
    N = scryptOption(options, "N", "cost"); r = scryptOption(options, "r", "blockSize"); p = scryptOption(options, "p", "parallelization");
    const limit: unknown = member(options, "maxmem");
    if (limit !== undefined) { validateInteger(limit, "maxmem", 0); maxmem = limit === 0 ? SCRYPT_DEFAULTS.maxmem : limit; }
  }
  return { secret, seasoning, keylen, N, r, p, maxmem };
}
/** OpenSSL's own acceptance of scrypt parameters, which Node asks for before it derives anything. */
function scryptAccept(N: number, r: number, p: number, maxmem: number): void {
  if (N < 2 || !Number.isInteger(Math.log2(N))) throw scryptParameters();
  // p * r below 2^30; N below 2^(128 * r / 8); B of 128 * r * p bytes in a signed int; B and V of 128 * r * (N + 2) bytes within maxmem.
  if (p > Math.floor((2 ** 30 - 1) / r) || (16 * r <= 63 && N >= 2 ** (16 * r))) throw scryptMemory();
  const block = 128 * r * p, table = 128 * r * (N + 2);
  if (block > INT32_MAX || block + table > maxmem) throw scryptMemory();
}
function scryptRun(secret: Uint8Array, seasoning: Uint8Array, keylen: number, N: number, r: number, p: number): Buffer {
  if (keylen === 0) return Buffer.alloc(0);
  // The limit was checked above with OpenSSL's formula, which is the larger of the two.
  return Buffer.from(deriveScrypt(secret, seasoning, { N, r, p, dkLen: keylen, maxmem: 128 * r * (N + p + 2) }));
}

const HKDF_SOURCE = "string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer";
function hkdfCheck(keyBytes: KeyBytes | undefined, digest: unknown, ikm: unknown, salt: unknown, info: unknown, length: unknown) {
  validateString(digest, "digest");
  const held = typeof ikm === "object" && ikm !== null && !ArrayBuffer.isView(ikm) && !isAnyArrayBuffer(ikm) ? keyBytes?.(ikm) : undefined;
  const key = held ?? byteSource(ikm, "ikm", "string or an instance of SecretKeyObject, ArrayBuffer, TypedArray, DataView, or Buffer");
  const seasoning = byteSource(salt, "salt", HKDF_SOURCE), context = byteSource(info, "info", HKDF_SOURCE);
  validateInteger(length, "length", 0, Number.MAX_SAFE_INTEGER);
  if (context.byteLength > 1024) throw outOfRange("info", "must not contain more than 1024 bytes", context.byteLength);
  return { digest, key, seasoning, context, length };
}
/** The checks Node's native side makes when the job is created: they throw even from the asynchronous form. */
function hkdfHash(digest: string, length: number): CHash | undefined {
  const hash = derivationHash(digest);
  // RFC 5869: at most 255 blocks of output. Pinned Node aborts the process for a length above 2^32; that is refused here too.
  if (hash !== undefined && length > 255 * hash.outputLen) throw Object.assign(new RangeError("Invalid key length"), { code: "ERR_CRYPTO_INVALID_KEYLEN" });
  return hash;
}
function hkdfRun(hash: CHash | undefined, key: Uint8Array, seasoning: Uint8Array, context: Uint8Array, length: number): ArrayBuffer {
  if (hash === undefined || length === 0) throw derivingFailed();
  const bytes = deriveHkdf(hash, key, seasoning, context, length), result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

const ARGON2 = { argon2d, argon2i, argon2id };
/** Node validates the optional inputs without naming them, so a wrong type surfaces as its internal assertion. */
function argon2Optional(value: unknown): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  try { return byteSource(value, "parameters"); }
  catch {
    throw Object.assign(new Error("'name' must be a string\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n"), { code: "ERR_INTERNAL_ASSERTION" });
  }
}
function argon2Check(algorithm: unknown, parameters: unknown) {
  validateString(algorithm, "algorithm");
  if (algorithm !== "argon2d" && algorithm !== "argon2i" && algorithm !== "argon2id") throw invalidValue("algorithm", algorithm, "must be one of: 'argon2d', 'argon2i', 'argon2id'");
  validateObject(parameters, "parameters");
  const parallelism: unknown = member(parameters, "parallelism"), tagLength: unknown = member(parameters, "tagLength"), memory: unknown = member(parameters, "memory"), passes: unknown = member(parameters, "passes");
  const message = byteSource(member(parameters, "message"), "parameters.message");
  const nonce = byteSource(member(parameters, "nonce"), "parameters.nonce");
  validateInteger(nonce.byteLength, "parameters.nonce.byteLength", 8, UINT32_MAX);
  validateInteger(parallelism, "parameters.parallelism", 1, 2 ** 24 - 1);
  validateInteger(tagLength, "parameters.tagLength", 4, UINT32_MAX);
  validateInteger(memory, "parameters.memory", 8 * parallelism, UINT32_MAX);
  validateInteger(passes, "parameters.passes", 1, UINT32_MAX);
  const secret = argon2Optional(member(parameters, "secret")), associatedData = argon2Optional(member(parameters, "associatedData"));
  return { derive: ARGON2[algorithm], message, nonce, parallelism, tagLength, memory, passes, secret, associatedData };
}
function argon2Run(checked: ReturnType<typeof argon2Check>): Buffer {
  const { derive, message, nonce, parallelism, tagLength, memory, passes, secret, associatedData } = checked;
  // The working memory is one typed array of 256 words per KiB, which cannot hold 16 GiB or more.
  if (4 * parallelism * Math.floor(memory / (4 * parallelism)) * 256 > UINT32_MAX - 1) throw new VMError("FEATURE_NOT_AVAILABLE", "crypto.argon2 memory above 16 GiB is not supported in the assisted process", { builtin: "crypto", export: "argon2", memory });
  // @noble/hashes 2.0.1 builds a tag above 64 bytes in whole 32-bit words and would silently drop the remainder.
  if (tagLength > 64 && tagLength % 4 !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "crypto.argon2 tagLength above 64 must be a multiple of 4 in the assisted process", { builtin: "crypto", export: "argon2", tagLength });
  return Buffer.from(derive(message, nonce, { t: passes, m: memory, p: parallelism, dkLen: tagLength, key: secret, personalization: associatedData }));
}

/**
 * The key derivations of `node:crypto` (PBKDF2, scrypt, HKDF, Argon2), computed in JavaScript. The synchronous forms
 * return at once; the callback forms validate at once and derive in one later turn. `keyBytes` resolves a secret
 * KeyObject given as HKDF input keying material.
 */
export function createCryptoKdf(ports: CryptoPorts, options: { readonly keyBytes?: KeyBytes } = {}) {
  const pbkdf2Sync = named((password?: unknown, salt?: unknown, iterations?: unknown, keylen?: unknown, digest?: unknown): Buffer => {
    const checked = pbkdf2Check(password, salt, iterations, keylen, digest);
    return pbkdf2Run(derivationHash(checked.digest), checked.secret, checked.seasoning, checked.iterations, checked.keylen);
  }, "pbkdf2Sync");
  const pbkdf2 = named((password?: unknown, salt?: unknown, iterations?: unknown, keylen?: unknown, digest?: unknown, callback?: unknown): void => {
    if (typeof digest === "function") { callback = digest; digest = undefined; }
    const checked = pbkdf2Check(password, salt, iterations, keylen, digest);
    validateFunction(callback, "callback");
    // Node copies its inputs when the job is created: later writes to the caller's buffers do not reach the derivation.
    const hash = derivationHash(checked.digest), secret = checked.secret.slice(), seasoning = checked.seasoning.slice();
    queue(ports, "PBKDF2Job", () => pbkdf2Run(hash, secret, seasoning, checked.iterations, checked.keylen), callback);
  }, "pbkdf2");

  const scryptSync = named((password: unknown, salt: unknown, keylen: unknown, settings: unknown = SCRYPT_DEFAULTS): Buffer => {
    const { secret, seasoning, keylen: length, N, r, p, maxmem } = scryptCheck(password, salt, keylen, settings);
    scryptAccept(N, r, p, maxmem);
    return scryptRun(secret, seasoning, length, N, r, p);
  }, "scryptSync");
  const scrypt = named((password: unknown, salt: unknown, keylen: unknown, settings: unknown, callback: unknown = SCRYPT_DEFAULTS): void => {
    if (callback === SCRYPT_DEFAULTS) { callback = settings; settings = SCRYPT_DEFAULTS; }
    const { secret, seasoning, keylen: length, N, r, p, maxmem } = scryptCheck(password, salt, keylen, settings);
    validateFunction(callback, "callback");
    scryptAccept(N, r, p, maxmem);
    const key = secret.slice(), seasoned = seasoning.slice();
    queue(ports, "ScryptJob", () => scryptRun(key, seasoned, length, N, r, p), callback);
  }, "scrypt");

  const hkdfSync = named((digest?: unknown, ikm?: unknown, salt?: unknown, info?: unknown, keylen?: unknown): ArrayBuffer => {
    const checked = hkdfCheck(options.keyBytes, digest, ikm, salt, info, keylen);
    return hkdfRun(hkdfHash(checked.digest, checked.length), checked.key, checked.seasoning, checked.context, checked.length);
  }, "hkdfSync");
  const hkdf = named((digest?: unknown, ikm?: unknown, salt?: unknown, info?: unknown, keylen?: unknown, callback?: unknown): void => {
    const checked = hkdfCheck(options.keyBytes, digest, ikm, salt, info, keylen);
    validateFunction(callback, "callback");
    const hash = hkdfHash(checked.digest, checked.length), key = checked.key.slice(), seasoning = checked.seasoning.slice(), context = checked.context.slice();
    queue(ports, "HKDFJob", () => hkdfRun(hash, key, seasoning, context, checked.length), callback);
  }, "hkdf");

  const argon2Sync = named((algorithm?: unknown, parameters?: unknown): Buffer => argon2Run(argon2Check(algorithm, parameters)), "argon2Sync");
  const argon2 = named((algorithm?: unknown, parameters?: unknown, callback?: unknown): void => {
    const checked = argon2Check(algorithm, parameters);
    validateFunction(callback, "callback");
    const copied = { ...checked, message: checked.message.slice(), nonce: checked.nonce.slice(), secret: checked.secret.slice(), associatedData: checked.associatedData.slice() };
    queue(ports, "Argon2Job", () => argon2Run(copied), callback);
  }, "argon2");

  return { pbkdf2, pbkdf2Sync, scrypt, scryptSync, hkdf, hkdfSync, argon2, argon2Sync };
}
