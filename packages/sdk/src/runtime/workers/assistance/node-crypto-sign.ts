/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/sig.js (the Sign and Verify classes, signOneShot,
 * verifyOneShot and the order in which they read and validate their options).
 * Copyright Node.js contributors. All rights reserved.
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
import { Buffer } from "buffer/";
import { Writable } from "readable-stream";
import { bytesOf, stringBytes } from "./node-crypto-key-encoding.ts";
import { OSSL, opensslError } from "./node-crypto-key-errors.ts";
import type { KeyMaterial } from "./node-crypto-key-model.ts";
import type { createCryptoKeys, KeyInput } from "./node-crypto-keys.ts";
import { byteSource, type Digest, digestFor, invalidDigest, jobReceiver, member, truthy, unsupportedDigest, viewBytes } from "./node-crypto-misc.ts";
import { type CryptoPorts, later } from "./node-crypto-ports.ts";
import { type DsaEncoding, ecdsaSign, ecdsaSignatureLength, ecdsaVerify, eddsaSign, eddsaVerify } from "./node-crypto-sign-ec.ts";
import { SIGN_OSSL, contextTooLong, contextUnsupported, invalidDigestName, jobError, malformedSignature, notInitialised, signKeyRequired, unsupportedOperation } from "./node-crypto-sign-errors.ts";
import { RSA_PADDING, rsaDefaultDigest, rsaSign, rsaVerify, type SignMode } from "./node-crypto-sign-rsa.ts";
import { invalidInstance, invalidType, invalidValue, named, primitiveText, templateText, validateFunction, validateString } from "./node-util-validators.ts";

type Keys = ReturnType<typeof createCryptoKeys>;
interface Options { readonly padding: number | undefined; readonly saltLength: number | undefined; readonly dsaEncoding: DsaEncoding; readonly context: Uint8Array | undefined }
type Given = Pick<KeyInput, "material" | "isPrivate">;
/** What is signed: a message still to be hashed (the one-shot forms) or the digest a Sign or Verify object computed. */
type Subject = { readonly message: Uint8Array } | { readonly digest: Uint8Array };

/** Node's `getIntOption`: an int32 or nothing. */
function intOption(source: unknown, name: "padding" | "saltLength"): number | undefined {
  const value = member(source, name);
  if (value === undefined) return undefined;
  if (typeof value === "number" && value === value >> 0) return value;
  throw invalidValue(`options.${name}`, value);
}
/** The options of an RSA or (EC)DSA signature, read off the key argument in Node's order. */
function signatureOptions(source: unknown, withContext: boolean): Options {
  const padding = intOption(source, "padding");
  // With PSS padding and no salt length Node asks for the longest salt when signing, any salt when verifying.
  const saltLength = intOption(source, "saltLength") ?? (padding === RSA_PADDING.pss ? -2 : undefined);
  const given: unknown = typeof source === "object" ? member(source, "dsaEncoding") : undefined;
  const encoding: unknown = given === undefined ? "der" : given;
  if (encoding !== "der" && encoding !== "ieee-p1363") throw invalidValue("options.dsaEncoding", encoding);
  const context: unknown = withContext ? member(source, "context") : undefined;
  if (context !== undefined && !ArrayBuffer.isView(context)) throw invalidInstance("options.context", "Buffer, TypedArray, or DataView", context);
  return { padding, saltLength, dsaEncoding: encoding, context: context === undefined ? undefined : viewBytes(context) };
}

/** The hash of an ECDSA signature: any fixed-length digest OpenSSL has. */
function ecDigest(digest: Digest, subject: Subject): Uint8Array {
  if ("digest" in subject) return subject.digest;
  if (digest.kind === "unavailable") throw opensslError(SIGN_OSSL.evpUnsupported, [SIGN_OSSL.invalidDigest]);
  if (digest.kind === "unsupported") throw unsupportedDigest(digest.name);
  if (digest.kind === "xof") throw opensslError(SIGN_OSSL.invalidDigest);
  return digest.hash(subject.message);
}
function sha256(): Digest {
  const digest = digestFor("sha256");
  if (digest === undefined) throw new TypeError("Missing SHA-256");
  return digest;
}
function secretOf(material: KeyMaterial): Uint8Array | undefined { return "privateKey" in material ? material.privateKey : undefined; }

/** One signature, whatever the key: `digest` is undefined for a null algorithm. */
function makeSignature(keys: Keys, key: Given, digest: Digest | undefined, subject: Subject, options: Options, mode: SignMode): Uint8Array {
  const { material } = key;
  const context = options.context !== undefined && options.context.length > 0 ? options.context : undefined;
  switch (material.kind) {
    case "ed25519": case "ed448": {
      if (!("message" in subject)) throw unsupportedOperation();
      // With a context OpenSSL is set up through another call, which never looks at the digest.
      if (context === undefined && digest !== undefined) throw opensslError(SIGN_OSSL.invalidDigest);
      const secret = key.isPrivate ? secretOf(material) : undefined;
      if (secret === undefined) throw keys.missingPrivateKey(material);
      return eddsaSign(material.kind, secret, subject.message, context);
    }
    case "x25519": case "x448": case "dh":
      if (context !== undefined) throw contextUnsupported();
      throw opensslError(SIGN_OSSL.keytypeUnsupported);
    case "ec": {
      if (context !== undefined) throw contextUnsupported();
      const hashed = ecDigest(digest ?? sha256(), subject);
      if (!("d" in material)) throw mode === "one-shot" ? keys.missingPrivateKey(material) : opensslError(OSSL.ecMissingPrivateKey, [SIGN_OSSL.signatureFailure]);
      return ecdsaSign(material, hashed, options.dsaEncoding);
    }
    case "rsa": case "rsa-pss":
      if (context !== undefined) throw contextUnsupported();
      return rsaSign(material, digest ?? rsaDefaultDigest(material) ?? sha256(), subject, options, mode);
  }
}

function checkSignature(key: Given, digest: Digest | undefined, subject: Subject, signature: Uint8Array, options: Options, mode: SignMode): boolean {
  const { material } = key;
  const context = options.context !== undefined && options.context.length > 0 ? options.context : undefined;
  switch (material.kind) {
    case "ed25519": case "ed448":
      if (!("message" in subject)) throw unsupportedOperation();
      if (context === undefined && digest !== undefined) throw opensslError(SIGN_OSSL.invalidDigest);
      return eddsaVerify(material.kind, material.publicKey, subject.message, signature, context);
    case "x25519": case "x448": case "dh":
      if (context !== undefined) throw contextUnsupported();
      throw opensslError(SIGN_OSSL.keytypeUnsupported);
    case "ec":
      if (context !== undefined) throw contextUnsupported();
      return ecdsaVerify(material, ecDigest(digest ?? sha256(), subject), signature, options.dsaEncoding);
    case "rsa": case "rsa-pss":
      if (context !== undefined) throw contextUnsupported();
      return rsaVerify(material, digest ?? rsaDefaultDigest(material) ?? sha256(), subject, signature, options, mode);
  }
}

/** The digest of a one-shot call, refused as Node refuses it before the job starts. */
function oneShotDigest(algorithm: string | null | undefined, options: Options): Digest | undefined {
  let digest: Digest | undefined;
  if (algorithm !== null && algorithm !== undefined) {
    digest = digestFor(algorithm);
    if (digest === undefined) throw invalidDigest(algorithm);
  }
  if (options.context !== undefined && options.context.length > 255) throw contextTooLong();
  return digest;
}

/**
 * A key argument the way the classes take it: Node checks the argument's shape, then the options, and only then
 * has OpenSSL read the key, so a key that does not parse is reported after an invalid option.
 */
function keyThenOptions<Rest>(read: () => KeyInput, rest: () => Rest): { readonly key: KeyInput; readonly rest: Rest } {
  let key: KeyInput | undefined, failure: unknown;
  try { key = read(); }
  catch (error) { if (error instanceof TypeError) throw error; failure = error; }
  const others = rest();
  if (key === undefined) throw failure;
  return { key, rest: others };
}

type Running = ReturnType<Extract<Digest, { kind: "fixed" }>["hash"]["create"]>;
interface State { readonly role: "sign" | "verify"; readonly digest: Digest; readonly running: Running | undefined; done: boolean }
/** A `crypto.Sign`. */
export interface SignInstance extends Writable { update(data: unknown, encoding?: unknown): this; sign(privateKey: unknown, outputEncoding?: unknown): Buffer | string }
/** A `crypto.Verify`. */
export interface VerifyInstance extends Writable { update(data: unknown, encoding?: unknown): this; verify(key: unknown, signature: unknown, signatureEncoding?: unknown): boolean }

/** Node's own shape for a prototype method: assigned, so enumerable. */
function expose(prototype: object, methods: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(methods)) Object.defineProperty(prototype, key, { value, writable: true, enumerable: true, configurable: true });
}
/** The data of `update`: an odd count of hex digits is refused, and OpenSSL takes an unknown encoding name as UTF-8. */
function updateBytes(data: unknown, encoding: unknown): Uint8Array {
  if (typeof data === "string") {
    const name = typeof encoding === "string" ? encoding.toLowerCase() : "utf8";
    if (name === "hex" && data.length % 2 !== 0) throw invalidValue("encoding", encoding, `is invalid for data of length ${String(data.length)}`);
    return stringBytes(data, Buffer.isEncoding(name) || name === "base64url" ? name : "utf8");
  }
  if (ArrayBuffer.isView(data)) return viewBytes(data);
  throw invalidType("data", "string or an instance of Buffer, TypedArray, or DataView", data);
}
type WritableOptions = ConstructorParameters<typeof Writable>[0];
/** The stream takes any object as options, as Node's does; the declared type lists only what this repository passes elsewhere. */
function isWritableOptions(value: object): value is WritableOptions { return typeof value === "object"; }
/** Node's streams buffer 64 KiB by default; the stream implementation here would take 16. */
function streamOptions(options: unknown): WritableOptions {
  const given = typeof options === "object" && options !== null ? options : {};
  const custom = truthy(member(given, "objectMode")) || member(given, "highWaterMark") !== undefined || member(given, "writableHighWaterMark") !== undefined;
  const result: object = custom ? given : { ...given, highWaterMark: 65_536 };
  if (!isWritableOptions(result)) throw new TypeError("Invalid stream options");
  return result;
}

/** `sign`, `verify`, `createSign`, `createVerify` and the `Sign` and `Verify` classes of one process. */
export function createCryptoSign(ports: CryptoPorts, keys: Keys) {
  const states = new WeakMap<object, State>();
  /** The state behind `this`, failing as Node's member access on its missing native handle fails. */
  const stateOf = (value: unknown, role: "sign" | "verify" | undefined, method: string): State => {
    const state = typeof value === "object" && value !== null ? states.get(value) : undefined;
    if (state === undefined) throw new TypeError(`Cannot read properties of undefined (reading '${method}')`);
    if (role !== undefined && state.role !== role) throw new TypeError(`this[kHandle].${method} is not a function`);
    return state;
  };
  const start = (role: "sign" | "verify", algorithm: unknown): State => {
    validateString(algorithm, "algorithm");
    const digest = digestFor(algorithm);
    if (digest === undefined) throw invalidDigestName();
    if (digest.kind === "unavailable") throw opensslError(SIGN_OSSL.evpUnsupported, [SIGN_OSSL.initializationError]);
    if (digest.kind === "unsupported") throw unsupportedDigest(algorithm);
    return { role, digest, running: digest.kind === "fixed" ? digest.hash.create() : undefined, done: false };
  };
  /** Uses the object up and gives the digest; an extendable digest fails here as it does in OpenSSL. */
  const finish = (state: State): Uint8Array => {
    if (state.done) throw notInitialised();
    state.done = true;
    if (state.running === undefined) throw opensslError(SIGN_OSSL.mallocFailure);
    return state.running.digest();
  };

  class SignObject extends Writable {
    declare update: (data: unknown, encoding?: unknown) => this;
    declare sign: (privateKey: unknown, outputEncoding?: unknown) => Buffer | string;
    constructor(algorithm?: unknown, options?: unknown) {
      const state = start("sign", algorithm);
      super(streamOptions(options));
      states.set(this, state);
    }
  }
  class VerifyObject extends Writable {
    declare update: (data: unknown, encoding?: unknown) => this;
    declare verify: (key: unknown, signature: unknown, signatureEncoding?: unknown) => boolean;
    constructor(algorithm?: unknown, options?: unknown) {
      const state = start("verify", algorithm);
      super(streamOptions(options));
      states.set(this, state);
    }
  }

  const write = named(function (this: unknown, chunk: unknown, encoding: unknown, callback: unknown): void {
    const update: unknown = member(this, "update");
    if (typeof update === "function") Reflect.apply(update, this, [chunk, encoding]);
    if (typeof callback === "function") Reflect.apply(callback, undefined, []);
  }, "_write");
  const update = named(function (this: unknown, data: unknown, encoding?: unknown): unknown {
    const bytes = updateBytes(data, encoding);
    const state = stateOf(this, undefined, "update");
    if (state.done) throw notInitialised();
    state.running?.update(bytes);
    return this;
  }, "update");
  const signMethod = named(function (this: unknown, privateKey: unknown, encoding?: unknown): Buffer | string {
    if (!truthy(privateKey)) throw signKeyRequired();
    const { key, rest: options } = keyThenOptions(() => keys.keyFromInput(privateKey, "private", "privateKey"), () => signatureOptions(privateKey, false));
    const state = stateOf(this, "sign", "sign");
    // Edwards keys sign whole messages only; Node says so before it touches the object.
    if (key.material.kind === "ed25519" || key.material.kind === "ed448") throw unsupportedOperation();
    const signature = Buffer.from(makeSignature(keys, key, state.digest, { digest: finish(state) }, options, "stream"));
    return truthy(encoding) && encoding !== "buffer" ? encoded(signature, encoding) : signature;
  }, "sign");
  const verifyMethod = named(function (this: unknown, key: unknown, signature: unknown, signatureEncoding?: unknown): boolean {
    const { key: given, rest } = keyThenOptions(() => keys.keyFromInput(key, "public", "key"), () => ({ options: signatureOptions(key, false), bytes: bytesOf(signature, "signature", signatureEncoding) }));
    const state = stateOf(this, "verify", "verify");
    const { material } = given;
    if (material.kind === "ed25519" || material.kind === "ed448") throw unsupportedOperation();
    if (material.kind === "ec" && rest.options.dsaEncoding === "ieee-p1363" && rest.bytes.length !== ecdsaSignatureLength(material)) throw malformedSignature();
    const subject = { digest: finish(state) };
    if (material.kind !== "rsa" && material.kind !== "rsa-pss") return checkSignature(given, state.digest, subject, rest.bytes, rest.options, "stream");
    // What OpenSSL refuses while it is being set up (a padding, a salt length, a digest) is a failed verification here.
    try { return checkSignature(given, state.digest, subject, rest.bytes, rest.options, "stream"); }
    catch { return false; }
  }, "verify");
  expose(SignObject.prototype, { _write: write, update, sign: signMethod });
  expose(VerifyObject.prototype, { _write: write, update, verify: verifyMethod });

  // Node's constructors are functions: `Sign("sha256")` works without `new`, and a class may extend them.
  function Sign(this: unknown, algorithm?: unknown, options?: unknown): SignInstance {
    const target: unknown = new.target;
    const made: unknown = typeof target === "function" ? Reflect.construct(SignObject, [algorithm, options], target) : new SignObject(algorithm, options);
    if (!(made instanceof SignObject)) throw new TypeError("Illegal constructor");
    return made;
  }
  function Verify(this: unknown, algorithm?: unknown, options?: unknown): VerifyInstance {
    const target: unknown = new.target;
    const made: unknown = typeof target === "function" ? Reflect.construct(VerifyObject, [algorithm, options], target) : new VerifyObject(algorithm, options);
    if (!(made instanceof VerifyObject)) throw new TypeError("Illegal constructor");
    return made;
  }
  for (const [callable, implementation, name] of [[Sign, SignObject, "Sign"], [Verify, VerifyObject, "Verify"]] as const) {
    named(callable, name);
    Object.defineProperty(callable, "prototype", { value: implementation.prototype, writable: true });
    Object.defineProperty(implementation.prototype, "constructor", { value: callable, writable: true, enumerable: false, configurable: true });
    Object.setPrototypeOf(callable, Writable);
  }
  const createSign = named((algorithm?: unknown, options?: unknown): SignInstance => new SignObject(algorithm, options), "createSign");
  const createVerify = named((algorithm?: unknown, options?: unknown): VerifyInstance => new VerifyObject(algorithm, options), "createVerify");

  /** Runs a one-shot job now, or later with its result handed to the callback as Node's SignJob hands it. */
  const run = <Result>(work: () => Result, callback: unknown): Result | undefined => {
    if (typeof callback !== "function") return work();
    const job = jobReceiver("SignJob");
    later(ports, work, (error, value) => { Reflect.apply(callback, job, error === null ? [null, value] : [jobError(error)]); });
    return undefined;
  };
  const sign = named((algorithm?: unknown, data?: unknown, key?: unknown, callback?: unknown): Buffer | undefined => {
    if (algorithm !== null && algorithm !== undefined) validateString(algorithm, "algorithm");
    if (callback !== undefined) validateFunction(callback, "callback");
    const message = byteSource(data, "data");
    if (!truthy(key)) throw signKeyRequired();
    const options = signatureOptions(key, true);
    const given = keys.keyFromInput(key, "private");
    const digest = oneShotDigest(algorithm, options);
    return run(() => Buffer.from(makeSignature(keys, given, digest, { message }, options, "one-shot")), callback);
  }, "signOneShot");
  const verify = named((algorithm?: unknown, data?: unknown, key?: unknown, signature?: unknown, callback?: unknown): boolean | undefined => {
    if (algorithm !== null && algorithm !== undefined) validateString(algorithm, "algorithm");
    if (callback !== undefined) validateFunction(callback, "callback");
    const message = byteSource(data, "data");
    if (key === null || key === undefined) throw new TypeError(`Cannot read properties of ${primitiveText(key)} (reading 'padding')`);
    const options = signatureOptions(key, true);
    const bytes = byteSource(signature, "signature");
    const given = keys.keyFromInput(key, "public");
    const digest = oneShotDigest(algorithm, options);
    return run(() => checkSignature(given, digest, { message }, bytes, options, "one-shot"), callback);
  }, "verifyOneShot");
  return { sign, verify, createSign, createVerify, Sign, Verify };
}

/** `Buffer.prototype.toString` with Node's refusal of an encoding it does not know. */
function encoded(bytes: Buffer, encoding: unknown): string {
  const name = templateText(encoding);
  // The buffer polyfill has no name for the URL-safe base64 alphabet.
  if (name.toLowerCase() === "base64url") return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (!Buffer.isEncoding(name)) throw Object.assign(new TypeError(`Unknown encoding: ${name}`), { code: "ERR_UNKNOWN_ENCODING" });
  return bytes.toString(name);
}
