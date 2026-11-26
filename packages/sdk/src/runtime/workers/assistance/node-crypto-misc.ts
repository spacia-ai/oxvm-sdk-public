/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/hash.js, lib/internal/crypto/random.js,
 * lib/internal/crypto/util.js and lib/crypto.js (argument validation order and the Hash, Hmac, randomFill,
 * randomUUIDv7, setEngine and secureHeapUsed entry points).
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
import { blake2b, blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2.js";
import { type Keccak, sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from "@noble/hashes/sha3.js";
import type { CHash } from "@noble/hashes/utils.js";
import { Buffer } from "buffer/";
import { Transform } from "readable-stream";
import { VMError } from "../../errors.ts";
import { nodeConstantsModule } from "./node-constants.ts";
import { type CryptoPorts, later } from "./node-crypto-ports.ts";
import { invalidInstance, invalidType, invalidValue, named, outOfRange, templateText, validateBoolean, validateFunction, validateInteger, validateNumber, validateObject, validateString } from "./node-util-validators.ts";

// The browser's entropy source, taken before a program can decorate it.
const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const UINT32_MAX = 4_294_967_295, INT32_MAX = 2_147_483_647;

/** How a name known to pinned Node's OpenSSL is served here. */
export type Digest =
  | { readonly kind: "fixed"; readonly name: string; readonly hash: CHash }
  | { readonly kind: "xof"; readonly name: string; readonly create: () => Keccak; readonly size: number }
  /** OpenSSL knows the name, but pinned Node cannot run it: its legacy provider is not loaded. */
  | { readonly kind: "unavailable"; readonly name: string }
  /** Pinned Node runs it; the fast path has no implementation. */
  | { readonly kind: "unsupported"; readonly name: string };

const fixed = (name: string, hash: CHash, aliases: readonly string[]): readonly [Digest, readonly string[]] => [{ kind: "fixed", name, hash }, [name, ...aliases]];
const sha2 = (bits: string, hash: CHash): readonly [Digest, readonly string[]] => fixed(`sha${bits}`, hash, [`sha-${bits}`, `sha2-${bits}`, `rsa-sha${bits}`, `sha${bits}withrsaencryption`]);
const truncated = (bits: string, hash: CHash): readonly [Digest, readonly string[]] => fixed(`sha512-${bits}`, hash, [`sha-512/${bits}`, `sha2-512/${bits}`, `rsa-sha512/${bits}`, `sha512-${bits}withrsaencryption`]);
const sha3 = (bits: string, hash: CHash): readonly [Digest, readonly string[]] => fixed(`sha3-${bits}`, hash, [`rsa-sha3-${bits}`, `id-rsassa-pkcs1-v1_5-with-sha3-${bits}`]);
/** Every spelling pinned Node accepts (recorded in node-crypto-misc.controls.json), in lower case: OpenSSL compares names without case. */
const DIGESTS = new Map<string, Digest>([
  fixed("sha1", sha1, ["sha-1", "rsa-sha1", "rsa-sha1-2", "sha1withrsaencryption", "ssl3-sha1"]),
  sha2("224", sha224), sha2("256", sha256), sha2("384", sha384), sha2("512", sha512), truncated("224", sha512_224), truncated("256", sha512_256),
  sha3("224", sha3_224), sha3("256", sha3_256), sha3("384", sha3_384), sha3("512", sha3_512),
  fixed("md5", md5, ["rsa-md5", "md5withrsaencryption", "ssl3-md5"]),
  fixed("ripemd160", ripemd160, ["ripemd", "rmd160", "ripemd-160", "rsa-ripemd160", "ripemd160withrsa"]),
  fixed("blake2b512", blake2b, ["blake2b-512"]), fixed("blake2s256", blake2s, ["blake2s-256"]),
  [{ kind: "xof", name: "shake128", create: () => shake128.create({}), size: 16 }, ["shake128", "shake-128"]] as const,
  [{ kind: "xof", name: "shake256", create: () => shake256.create({}), size: 32 }, ["shake256", "shake-256"]] as const,
  [{ kind: "unsupported", name: "sm3" }, ["sm3", "rsa-sm3", "sm3withrsaencryption"]] as const,
  [{ kind: "unsupported", name: "md5-sha1" }, ["md5-sha1"]] as const,
  [{ kind: "unavailable", name: "md4" }, ["md4", "rsa-md4", "md4withrsaencryption"]] as const,
  [{ kind: "unavailable", name: "whirlpool" }, ["whirlpool"]] as const,
  [{ kind: "unavailable", name: "mdc2" }, ["mdc2", "rsa-mdc2", "mdc2withrsa"]] as const,
].flatMap(([digest, names]) => names.map((name): [string, Digest] => [name, digest])));

/** The digest a name selects, as pinned Node resolves it; `undefined` when OpenSSL does not know the name. */
export function digestFor(name: string): Digest | undefined { return DIGESTS.get(name.toLowerCase()); }
/** The fixed-length hash behind a name, for HMAC, the KDFs and signatures; `undefined` for anything else. */
export function hashFor(name: string): CHash | undefined {
  const digest = digestFor(name);
  return digest?.kind === "fixed" ? digest.hash : undefined;
}
/** `crypto.getHashes()` of pinned Node, in its order, without the four names of SM3 and MD5-SHA1 that nothing here computes. */
export const SUPPORTED_HASHES: readonly string[] = Object.freeze([
  "RSA-MD5", "RSA-RIPEMD160", "RSA-SHA1", "RSA-SHA1-2", "RSA-SHA224", "RSA-SHA256", "RSA-SHA3-224", "RSA-SHA3-256", "RSA-SHA3-384", "RSA-SHA3-512", "RSA-SHA384", "RSA-SHA512",
  "RSA-SHA512/224", "RSA-SHA512/256", "blake2b512", "blake2s256", "id-rsassa-pkcs1-v1_5-with-sha3-224", "id-rsassa-pkcs1-v1_5-with-sha3-256", "id-rsassa-pkcs1-v1_5-with-sha3-384",
  "id-rsassa-pkcs1-v1_5-with-sha3-512", "md5", "md5WithRSAEncryption", "ripemd", "ripemd160", "ripemd160WithRSA", "rmd160", "sha1", "sha1WithRSAEncryption", "sha224",
  "sha224WithRSAEncryption", "sha256", "sha256WithRSAEncryption", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "sha384", "sha384WithRSAEncryption", "sha512", "sha512-224",
  "sha512-224WithRSAEncryption", "sha512-256", "sha512-256WithRSAEncryption", "sha512WithRSAEncryption", "shake128", "shake256", "ssl3-md5", "ssl3-sha1",
]);

/** ERR_CRYPTO_INVALID_DIGEST, for a name OpenSSL does not know. */
export function invalidDigest(name: string): TypeError {
  return Object.assign(new TypeError(`Invalid digest: ${name}`), { code: "ERR_CRYPTO_INVALID_DIGEST" });
}
/** The refusal for a digest pinned Node computes and the fast path does not. */
export function unsupportedDigest(name: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", `crypto digest ${name} is not supported in the assisted process`, { builtin: "crypto", algorithm: name });
}
/** OpenSSL's report for a digest of the legacy provider; `stack` is what Node attaches as `opensslErrorStack`. */
function legacyDigest(stack: readonly string[]): Error {
  return Object.assign(new Error("error:0308010C:digital envelope routines::unsupported"), { opensslErrorStack: [...stack], library: "digital envelope routines", reason: "unsupported", code: "ERR_OSSL_EVP_UNSUPPORTED" });
}
const LEGACY_INIT = "error:03000086:digital envelope routines::initialization error";
function notExtendable(): Error {
  return Object.assign(new Error("error:030000B2:digital envelope routines::not XOF or invalid length"), { library: "digital envelope routines", reason: "not XOF or invalid length", code: "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH" });
}
function finalized(): Error { return Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" }); }

/** A secret key held by another owner (a KeyObject or CryptoKey): its bytes, or `undefined` when the value is not a key. */
export type KeyBytes = (value: unknown) => Uint8Array | undefined;

export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
  return value instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer);
}
/** The bytes of a buffer or view, in place. */
export function viewBytes(value: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
}
/** Node's `getArrayBufferOrView`: a string as UTF-8, a buffer or a view in place, anything else ERR_INVALID_ARG_TYPE. */
export function byteSource(value: unknown, name: string, expected = "string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView"): Uint8Array {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (isAnyArrayBuffer(value) || ArrayBuffer.isView(value)) return viewBytes(value);
  throw invalidType(name, expected, value);
}
/** A property of an options value, read the way a member access reads it; a primitive has none of ours. */
export function member(value: unknown, key: string): unknown {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}
/** JavaScript's own truthiness of a value of any type. */
export function truthy(value: unknown): boolean { return Boolean(value); }
const receivers = new Map<string, object>();
/** What an asynchronous form binds as `this` of its callback: Node passes its native job, which programs can only see by its class name. */
export function jobReceiver(name: string): object {
  let prototype = receivers.get(name);
  if (prototype === undefined) { prototype = { constructor: named(function () { return undefined; }, name) }; receivers.set(name, prototype); }
  const job = {};
  Object.setPrototypeOf(job, prototype);
  return job;
}

type Encoding = "utf8" | "utf16le" | "latin1" | "base64" | "base64url" | "hex" | "ascii";
/** Node's `normalizeEncoding`; `undefined` for a name it does not know. */
function normalizeEncoding(value: string | null | undefined): Encoding | undefined {
  if (value === null || value === undefined || value === "") return "utf8";
  switch (value.toLowerCase()) {
    case "utf8": case "utf-8": return "utf8";
    case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": return "utf16le";
    case "latin1": case "binary": return "latin1";
    case "base64": return "base64";
    case "base64url": return "base64url";
    case "hex": return "hex";
    case "ascii": return "ascii";
    default: return undefined;
  }
}
// The buffer polyfill reads both base64 alphabets but has no name for the second.
function decode(text: string, encoding: Encoding): Uint8Array { return Buffer.from(text, encoding === "base64url" ? "base64" : encoding); }
function encode(bytes: Uint8Array, encoding: Encoding): string {
  const buffer = Buffer.from(bytes);
  return encoding === "base64url" ? buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") : buffer.toString(encoding);
}
/** The data of `update`: OpenSSL takes an unknown encoding name as UTF-8, and an odd count of hex digits is refused. */
function updateBytes(data: unknown, encoding: unknown): Uint8Array {
  if (typeof data === "string") {
    const selected = typeof encoding === "string" ? normalizeEncoding(encoding) : undefined;
    if (selected === "hex" && data.length % 2 !== 0) throw invalidValue("encoding", encoding, `is invalid for data of length ${String(data.length)}`);
    return decode(data, selected ?? "utf8");
  }
  if (ArrayBuffer.isView(data)) return viewBytes(data);
  throw invalidType("data", "string or an instance of Buffer, TypedArray, or DataView", data);
}
/** The result of `digest`: any truthy encoding is made a string first, and an unknown one yields the Buffer. */
function digestOutput(bytes: Uint8Array, encoding: unknown): Buffer | string {
  const selected = truthy(encoding) ? normalizeEncoding(templateText(encoding)) : undefined;
  return selected === undefined ? Buffer.from(bytes) : encode(bytes, selected);
}

/** One running computation, whatever produces it. */
interface Running { update(bytes: Uint8Array): void; finish(): Uint8Array; fork(length: number | undefined): Running }
interface Block { update(bytes: Uint8Array): unknown; digest(): Uint8Array; clone(): Block }
function block(state: Block, size: number): Running {
  return {
    update: bytes => { state.update(bytes); }, finish: () => state.digest(),
    fork: length => { if (length !== undefined && length !== size) throw notExtendable(); return block(state.clone(), size); },
  };
}
function sponge(state: Keccak, length: number, size: number): Running {
  return { update: bytes => { state.update(bytes); }, finish: () => length === 0 ? new Uint8Array(0) : state.xof(length), fork: next => sponge(state.clone(), next ?? size, size) };
}
/** The digest a public hash entry point runs, or its refusal; `undefined` for an unknown name, which every entry point words differently. */
function runnable(name: string, stack: readonly string[]): Extract<Digest, { kind: "fixed" | "xof" }> | undefined {
  const digest = digestFor(name);
  if (digest?.kind === "unavailable") throw legacyDigest(stack);
  if (digest?.kind === "unsupported") throw unsupportedDigest(name);
  return digest;
}
function outputLength(options: unknown, name: string): number | undefined {
  const length: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "outputLength") : undefined;
  if (length === undefined) return undefined;
  validateInteger(length, name, 0, UINT32_MAX);
  return length;
}

interface HashState { readonly running: Running; finalized: boolean }
/** A `crypto.Hash`: the stream Node documents, with `update`, `digest` and `copy`. */
export interface HashInstance extends Transform { update(data: unknown, encoding?: unknown): this; digest(encoding?: unknown): Buffer | string; copy(options?: unknown): HashInstance }
/** A `crypto.Hmac`. */
export interface HmacInstance extends Transform { update(data: unknown, encoding?: unknown): this; digest(encoding?: unknown): Buffer | string }
/** Node's own shape for a prototype method: assigned, so enumerable. */
function expose(prototype: object, methods: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(methods)) Object.defineProperty(prototype, key, { value, writable: true, enumerable: true, configurable: true });
}

/** `Hash`, `Hmac`, `createHash`, `createHmac` and `hash` of one process. */
function createHashes(keyBytes: KeyBytes | undefined) {
  const states = new WeakMap<object, HashState>();
  const stateOf = (value: unknown): HashState => {
    const state = typeof value === "object" && value !== null ? states.get(value) : undefined;
    if (state === undefined) throw new TypeError("Illegal invocation");
    return state;
  };
  /** What `copy` hands the constructor in place of an algorithm name: Node passes its native handle. */
  class Fork { readonly state: HashState; constructor(state: HashState) { this.state = state; } }
  const adopt = (instance: object, state: HashState, options: unknown): void => {
    states.set(instance, state);
    Object.defineProperty(instance, "_options", { value: options, writable: true, enumerable: true, configurable: true });
  };

  class HashObject extends Transform {
    declare update: (data: unknown, encoding?: unknown) => this;
    declare digest: (encoding?: unknown) => Buffer | string;
    declare copy: (options?: unknown) => HashInstance;
    constructor(algorithm?: unknown, options?: unknown) {
      if (!(algorithm instanceof Fork)) validateString(algorithm, "algorithm");
      const length = outputLength(options, "options.outputLength");
      let running: Running;
      if (algorithm instanceof Fork) running = algorithm.state.running.fork(length);
      else {
        const digest = runnable(algorithm, [LEGACY_INIT, "error:0308010C:digital envelope routines::unsupported"]);
        if (digest === undefined) throw new Error("Digest method not supported");
        if (digest.kind === "xof") running = sponge(digest.create(), length ?? digest.size, digest.size);
        else {
          if (length !== undefined && length !== digest.hash.outputLen) throw notExtendable();
          running = block(digest.hash.create(), digest.hash.outputLen);
        }
      }
      super();
      adopt(this, { running, finalized: false }, options);
    }
  }
  class HmacObject extends Transform {
    declare update: (data: unknown, encoding?: unknown) => this;
    declare digest: (encoding?: unknown) => Buffer | string;
    constructor(algorithm?: unknown, key?: unknown, options?: unknown) {
      validateString(algorithm, "hmac");
      const encoding: unknown = options === null || options === undefined ? undefined : member(options, "encoding");
      if (encoding !== undefined && encoding !== null) validateString(encoding, "options.encoding");
      const secret = secretKey(key, encoding ?? undefined);
      const digest = runnable(algorithm, [LEGACY_INIT]);
      if (digest === undefined) throw invalidDigest(algorithm);
      // HMAC needs a block hash; OpenSSL fails without a reason for an extendable one.
      if (digest.kind === "xof") throw new Error("error:00000000:lib(0)::reason(0)");
      super();
      adopt(this, { running: block(hmac.create(digest.hash, secret), digest.hash.outputLen), finalized: false }, options);
    }
  }
  /** Node's `prepareSecretKey`. */
  function secretKey(key: unknown, encoding: string | undefined): Uint8Array {
    const held = typeof key === "object" && key !== null && !ArrayBuffer.isView(key) && !isAnyArrayBuffer(key) ? keyBytes?.(key) : undefined;
    if (held !== undefined) return held;
    if (typeof key === "string") {
      const selected = encoding === "buffer" ? "utf8" : normalizeEncoding(encoding);
      if (selected === undefined) throw Object.assign(new TypeError(`Unknown encoding: ${String(encoding)}`), { code: "ERR_UNKNOWN_ENCODING" });
      return decode(key, selected);
    }
    return byteSource(key, "key", "string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey");
  }

  const update = named(function (this: unknown, data: unknown, encoding?: unknown): unknown {
    const state = stateOf(this);
    if (state.finalized) throw finalized();
    state.running.update(updateBytes(data, encoding));
    return this;
  }, "update");
  const hashDigest = named(function (this: unknown, outputEncoding?: unknown): Buffer | string {
    const state = stateOf(this);
    if (state.finalized) throw finalized();
    const bytes = state.running.finish();
    state.finalized = true;
    return digestOutput(bytes, outputEncoding);
  }, "digest");
  const hmacDigest = named(function (this: unknown, outputEncoding?: unknown): Buffer | string {
    const state = stateOf(this);
    // A second digest of an Hmac is empty, not an error.
    if (state.finalized) return truthy(outputEncoding) && outputEncoding !== "buffer" ? "" : Buffer.alloc(0);
    const bytes = state.running.finish();
    state.finalized = true;
    return digestOutput(bytes, outputEncoding);
  }, "digest");
  const copy = named(function (this: unknown, options?: unknown): HashInstance {
    const state = stateOf(this);
    if (state.finalized) throw finalized();
    return new HashObject(new Fork(state), options);
  }, "copy");
  const transform = named(function (this: unknown, chunk: unknown, encoding: unknown, callback: unknown): void {
    const state = stateOf(this);
    if (!state.finalized) state.running.update(updateBytes(chunk, encoding));
    if (typeof callback === "function") Reflect.apply(callback, undefined, []);
  }, "_transform");
  const flush = named(function (this: unknown, callback: unknown): void {
    const state = stateOf(this);
    const bytes = state.finalized ? new Uint8Array(0) : state.running.finish();
    state.finalized = true;
    if (this instanceof Transform) this.push(Buffer.from(bytes));
    if (typeof callback === "function") Reflect.apply(callback, undefined, []);
  }, "_flush");
  expose(HashObject.prototype, { copy, _transform: transform, _flush: flush, update, digest: hashDigest });
  expose(HmacObject.prototype, { update, digest: hmacDigest, _flush: flush, _transform: transform });

  // Node's constructors are functions: `Hash("sha256")` works without `new`, and a class may extend them.
  function Hash(this: unknown, algorithm?: unknown, options?: unknown): HashInstance {
    const target: unknown = new.target;
    const made: unknown = typeof target === "function" ? Reflect.construct(HashObject, [algorithm, options], target) : new HashObject(algorithm, options);
    if (!(made instanceof HashObject)) throw new TypeError("Illegal constructor");
    return made;
  }
  function Hmac(this: unknown, algorithm?: unknown, key?: unknown, options?: unknown): HmacInstance {
    const target: unknown = new.target;
    const made: unknown = typeof target === "function" ? Reflect.construct(HmacObject, [algorithm, key, options], target) : new HmacObject(algorithm, key, options);
    if (!(made instanceof HmacObject)) throw new TypeError("Illegal constructor");
    return made;
  }
  for (const [callable, implementation, name] of [[Hash, HashObject, "Hash"], [Hmac, HmacObject, "Hmac"]] as const) {
    named(callable, name);
    Object.defineProperty(callable, "prototype", { value: implementation.prototype, writable: false });
    Object.defineProperty(implementation.prototype, "constructor", { value: callable, writable: true, enumerable: false, configurable: true });
    Object.setPrototypeOf(callable, Transform);
  }

  const createHash = named((algorithm?: unknown, options?: unknown): HashInstance => new HashObject(algorithm, options), "createHash");
  const createHmac = named((algorithm?: unknown, key?: unknown, options?: unknown): HmacInstance => new HmacObject(algorithm, key, options), "createHmac");
  const hash = named((algorithm?: unknown, input?: unknown, options?: unknown): Buffer | string => {
    validateString(algorithm, "algorithm");
    if (typeof input !== "string" && !ArrayBuffer.isView(input)) throw invalidType("input", "string or an instance of Buffer, TypedArray, or DataView", input);
    let outputEncoding: unknown, length: unknown;
    if (typeof options === "string") outputEncoding = options;
    else if (options !== undefined) { validateObject(options, "options"); length = Reflect.get(options, "outputLength"); outputEncoding = Reflect.get(options, "outputEncoding"); }
    outputEncoding ??= "hex";
    validateString(outputEncoding, "outputEncoding");
    const selected = normalizeEncoding(outputEncoding) ?? (outputEncoding.toLowerCase() === "buffer" ? "buffer" : undefined);
    if (selected === undefined) throw invalidValue("outputEncoding", outputEncoding);
    if (length !== undefined) validateInteger(length, "outputLength", 0, UINT32_MAX);
    const digest = runnable(algorithm, [LEGACY_INIT, "error:0308010C:digital envelope routines::unsupported"]);
    if (digest === undefined) throw new Error(`Digest method ${algorithm} is not supported`);
    const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : viewBytes(input);
    let result: Uint8Array;
    if (digest.kind === "xof") { const size = length ?? digest.size; result = size === 0 ? new Uint8Array(0) : digest.create().update(bytes).xof(size); }
    else {
      if (length !== undefined && length !== digest.hash.outputLen) throw new Error(`Output length ${String(length)} is invalid for ${algorithm}, which does not support XOF`);
      result = digest.hash(bytes);
    }
    return selected === "buffer" ? Buffer.from(result) : encode(result, selected);
  }, "hash");
  return { Hash, Hmac, createHash, createHmac, hash };
}

/** Fills `bytes` from the browser's entropy; shared memory is filled through a private copy, which `getRandomValues` requires. */
function fillRandom(bytes: Uint8Array): void {
  const backing = bytes.buffer, direct = backing instanceof ArrayBuffer ? new Uint8Array(backing, bytes.byteOffset, bytes.byteLength) : undefined;
  for (let start = 0; start < bytes.byteLength; start += 65_536) {
    const end = Math.min(start + 65_536, bytes.byteLength);
    if (direct === undefined) bytes.set(entropy(new Uint8Array(end - start)), start); else entropy(direct.subarray(start, end));
  }
}
function assertOffset(offset: unknown, elementSize: number, length: number): number {
  validateNumber(offset, "offset");
  const bytes = offset * elementSize, maximum = Math.min(length, INT32_MAX);
  if (Number.isNaN(bytes) || bytes > maximum || bytes < 0) throw outOfRange("offset", `>= 0 && <= ${String(maximum)}`, bytes);
  return bytes >>> 0;
}
function assertSize(size: unknown, elementSize: number, offset: number, length: number): number {
  validateNumber(size, "size");
  const bytes = size * elementSize;
  if (Number.isNaN(bytes) || bytes > INT32_MAX || bytes < 0) throw outOfRange("size", `>= 0 && <= ${String(INT32_MAX)}`, bytes);
  if (bytes + offset > length) throw outOfRange("size + offset", `<= ${String(length)}`, bytes + offset);
  return bytes >>> 0;
}
/** The byte range `randomFill` and `randomFillSync` agree on; `size` counts elements, as `offset` does. */
function fillRange(buffer: ArrayBuffer | SharedArrayBuffer | ArrayBufferView, offset: unknown, size: unknown): Uint8Array {
  const declared: unknown = Reflect.get(buffer, "BYTES_PER_ELEMENT");
  const elementSize = typeof declared === "number" && declared !== 0 ? declared : 1;
  const start = assertOffset(offset, elementSize, buffer.byteLength);
  const length = size === undefined ? buffer.byteLength - start : assertSize(size, elementSize, start, buffer.byteLength);
  return viewBytes(buffer).subarray(start, start + length);
}
function fillTarget(buffer: unknown): asserts buffer is ArrayBuffer | SharedArrayBuffer | ArrayBufferView {
  if (!isAnyArrayBuffer(buffer) && !ArrayBuffer.isView(buffer)) throw invalidInstance("buf", "ArrayBuffer or ArrayBufferView", buffer);
}
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * The members of `node:crypto` that are neither a cipher, a key nor a key derivation: the Hash and Hmac classes with
 * their factories, `randomFill`, `randomUUIDv7`, the FIPS, engine and secure-heap entry points, `getHashes` and
 * `constants`. `keyBytes` resolves a secret KeyObject or CryptoKey used as an HMAC key.
 */
export function createCryptoMisc(ports: CryptoPorts, options: { readonly keyBytes?: KeyBytes } = {}) {
  const randomFillSync = named(<Target>(buf: Target, offset: unknown = 0, size?: unknown): Target => {
    fillTarget(buf);
    fillRandom(fillRange(buf, offset, size));
    return buf;
  }, "randomFillSync");
  const randomFill = named((buf?: unknown, offset?: unknown, size?: unknown, callback?: unknown): void => {
    fillTarget(buf);
    const length: unknown = Reflect.get(buf, "length");
    if (typeof offset === "function") { callback = offset; offset = 0; size = length; }
    // A buffer without `length` (an ArrayBuffer, a DataView) leaves Node with NaN here, which it then refuses.
    else if (typeof size === "function") { callback = size; size = typeof length === "number" && typeof offset === "number" ? length - offset : Number.NaN; }
    else validateFunction(callback, "callback");
    const done = callback, range = fillRange(buf, offset, size);
    if (typeof done !== "function") return;
    if (range.byteLength === 0) { Reflect.apply(done, undefined, [null, buf]); return; }
    const job = jobReceiver("RandomBytesJob");
    later(ports, () => { fillRandom(range); }, error => { Reflect.apply(done, job, [error, buf]); });
  }, "randomFill");

  const scratch = new Uint8Array(16);
  /** RFC 9562 version 7: 48 bits of Unix milliseconds, then random bits. Pinned Node keeps no counter within a millisecond. */
  const randomUUIDv7 = named((settings?: unknown): string => {
    if (settings !== undefined) validateObject(settings, "options");
    const requested: unknown = member(settings, "disableEntropyCache"), disableEntropyCache: unknown = requested === undefined ? false : requested;
    validateBoolean(disableEntropyCache, "options.disableEntropyCache");
    entropy(scratch.subarray(6));
    const now = Date.now(), high = now / 2 ** 32;
    scratch[0] = high >>> 8; scratch[1] = high; scratch[2] = now >>> 24; scratch[3] = now >>> 16; scratch[4] = now >>> 8; scratch[5] = now;
    scratch[6] = ((scratch[6] ?? 0) & 0x0f) | 0x70; scratch[8] = ((scratch[8] ?? 0) & 0x3f) | 0x80;
    const text = Array.from(scratch, byte => HEX[byte] ?? "").join("");
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  }, "randomUUIDv7");

  const getFips = named((): number => 0, "getFips");
  /** There is no FIPS provider to switch to: turning it on fails as in a Node built without one, turning it off is already true. */
  const setFips = named((value?: unknown): void => {
    if (truthy(value)) throw Object.assign(new Error("Cannot set FIPS mode in a non-FIPS build."), { code: "ERR_CRYPTO_FIPS_UNAVAILABLE" });
  }, "setFips");
  /** Pinned Node's answer when no secure heap was asked for. */
  const secureHeapUsed = named((): { total: number; used: number; utilization: number; min: number } => ({ total: 0, used: 0, utilization: Number.NaN, min: 2 }), "secureHeapUsed");
  /** OpenSSL's built-in loader engine is the only one there is; it has nothing to load here. */
  const setEngine = named((id?: unknown, flags?: unknown): void => {
    validateString(id, "id");
    if (truthy(flags)) validateNumber(flags, "flags");
    if (id !== "dynamic") throw Object.assign(new Error(`Engine "${id}" was not found`), { code: "ERR_CRYPTO_ENGINE_UNKNOWN" });
  }, "setEngine");
  const getHashes = named((): string[] => [...SUPPORTED_HASHES], "");

  // `crypto.constants`: the OpenSSL part of the constants module, without a prototype, plus the default cipher list, which
  // Node resolves on first read and lets a program replace.
  const constants: Record<string, unknown> = {};
  Object.setPrototypeOf(constants, null);
  const keys = Object.keys(nodeConstantsModule);
  for (const [key, value] of Object.entries(nodeConstantsModule).slice(keys.indexOf("OPENSSL_VERSION_NUMBER"))) Object.defineProperty(constants, key, { value, writable: false, enumerable: true, configurable: false });
  const settle = (value: unknown): void => { Object.defineProperty(constants, "defaultCipherList", { value, writable: true, enumerable: true, configurable: true }); };
  Object.defineProperty(constants, "defaultCipherList", {
    get: () => { settle(nodeConstantsModule.defaultCoreCipherList); return nodeConstantsModule.defaultCoreCipherList; },
    set: (value: unknown) => { settle(value); }, enumerable: true, configurable: true,
  });

  return { ...createHashes(options.keyBytes), randomFill, randomFillSync, randomUUIDv7, getFips, setFips, secureHeapUsed, setEngine, getHashes, constants };
}
