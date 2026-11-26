/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/keygen.js (generateKeyPair, generateKeyPairSync,
 * generateKey, generateKeySync: the order of argument validation and the option handling of each key type).
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
import { unavailableNodeApi } from "./node-capability.ts";
import { KeyCodecError, publicOf, toJwk, type PrivateMaterial } from "./node-crypto-key-codec.ts";
import { parseKeyEncoding, writePrivateKey, writePublicKey, type KeyEncoding } from "./node-crypto-key-encoding.ts";
import { keyCipher } from "./node-crypto-key-encryption.ts";
import { codedError, unknownCipher } from "./node-crypto-key-errors.ts";
import { NO_BUDGET, TURN_BUDGET_MS, driveSteps, randomBytes, runSteps, validateInt32, validateUint32, type Steps } from "./node-crypto-keygen-job.ts";
import { dhSteps, ecKey, okpKey, resolveCurve, resolveDhGroup, rsaSteps, type DhSource } from "./node-crypto-keygen-material.ts";
import type { createCryptoKeys } from "./node-crypto-keys.ts";
import { digestFor, jobReceiver, member } from "./node-crypto-misc.ts";
import { later, type CryptoPorts } from "./node-crypto-ports.ts";
import { invalidInstance, invalidValue, named, validateFunction, validateInteger, validateObject, validateString } from "./node-util-validators.ts";

type Keys = ReturnType<typeof createCryptoKeys>;
/** What the process gives key generation besides its ports: `process.emitWarning`, for the deprecated options. */
export interface KeygenEnvironment { readonly emitWarning?: (message: string, type: string, code: string) => void }

interface PairEncoding { readonly publicKey: KeyEncoding | undefined; readonly privateKey: KeyEncoding | undefined }
/** A validated request: `create` is the work, and everything that Node refuses before the work starts has been refused. */
interface PairJob { readonly receiver: string; readonly encoding: PairEncoding; readonly work: Work }
/** The work of a job: done at once, or a generator that yields within the budget. */
type Work = { readonly kind: "immediate"; readonly make: () => PrivateMaterial } | { readonly kind: "steps"; readonly create: (budgetMs: number) => Steps<PrivateMaterial> };
const steps = (create: (budgetMs: number) => Steps<PrivateMaterial>): Work => ({ kind: "steps", create });
const immediate = (make: () => PrivateMaterial): Work => ({ kind: "immediate", make });

function halfEncoding(value: unknown, type: string, isPublic: boolean, name: string): KeyEncoding | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw invalidValue(name, value);
  return parseKeyEncoding(value, type, isPublic ? (type === "" ? undefined : true) : false, name);
}
function pairEncoding(type: string, options: unknown): PairEncoding {
  if (options === null) throw new TypeError("Cannot destructure property 'publicKeyEncoding' of 'options' as it is null.");
  const publicKeyEncoding = member(options, "publicKeyEncoding"), privateKeyEncoding = member(options, "privateKeyEncoding");
  const publicKey = halfEncoding(publicKeyEncoding, type, true, "options.publicKeyEncoding");
  return { publicKey, privateKey: halfEncoding(privateKeyEncoding, type, false, "options.privateKeyEncoding") };
}

/** The digests Node's RSA-PSS key parameters carry faithfully, with their lengths (the default salt length). */
const PSS_DIGESTS = new Map<string, number>([["sha1", 20], ["sha224", 28], ["sha256", 32], ["sha384", 48], ["sha512", 64], ["sha512-224", 28], ["sha512-256", 32]]);
function pssDigest(name: unknown, mgf1: boolean): string | undefined {
  if (typeof name !== "string" || name === "") return undefined;
  const digest = digestFor(name);
  if (digest === undefined) throw codedError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid ${mgf1 ? "MGF1 " : ""}digest: ${name}`);
  // Node accepts any digest here and then reports parameters that do not match the key it made.
  if (!PSS_DIGESTS.has(digest.name)) return unavailableNodeApi(`crypto.generateKeyPair rsa-pss with digest ${name}`);
  return digest.name;
}

function rsaJob(type: "rsa" | "rsa-pss", options: unknown, environment: KeygenEnvironment): Work {
  validateObject(options, "options");
  const modulusLength: unknown = Reflect.get(options, "modulusLength");
  validateUint32(modulusLength, "options.modulusLength");
  const publicExponent: unknown = Reflect.get(options, "publicExponent");
  let exponent = 0x10001;
  if (publicExponent !== undefined && publicExponent !== null) { validateUint32(publicExponent, "options.publicExponent"); exponent = publicExponent; }
  if (type === "rsa") return steps(budgetMs => rsaSteps("rsa", modulusLength, exponent, undefined, budgetMs));
  const read = (name: string): unknown => Reflect.get(options, name);
  const hash = read("hash"), mgf1Hash = read("mgf1Hash"), hashAlgorithm = read("hashAlgorithm"), mgf1HashAlgorithm = read("mgf1HashAlgorithm"), saltLength = read("saltLength");
  if (saltLength !== undefined) validateInt32(saltLength, "options.saltLength", 0);
  if (hashAlgorithm !== undefined) validateString(hashAlgorithm, "options.hashAlgorithm");
  if (mgf1HashAlgorithm !== undefined) validateString(mgf1HashAlgorithm, "options.mgf1HashAlgorithm");
  const deprecated = (name: string, value: unknown, replacement: string, current: unknown): void => {
    if (value === undefined) return;
    environment.emitWarning?.(`"options.${name}" is deprecated, use "options.${replacement}" instead.`, "DeprecationWarning", "DEP0154");
    validateString(value, `options.${name}`);
    if (typeof current === "string" && current !== "" && value !== current) throw invalidValue(`options.${name}`, value);
  };
  deprecated("hash", hash, "hashAlgorithm", hashAlgorithm);
  deprecated("mgf1Hash", mgf1Hash, "mgf1HashAlgorithm", mgf1HashAlgorithm);
  const digest = pssDigest(hashAlgorithm === "" || hashAlgorithm === undefined ? hash : hashAlgorithm, false);
  const mgf1 = pssDigest(mgf1HashAlgorithm === "" || mgf1HashAlgorithm === undefined ? mgf1Hash : mgf1HashAlgorithm, true);
  const hashName = digest ?? "sha1";
  const pss = digest === undefined && mgf1 === undefined && saltLength === undefined ? undefined
    : { hashAlgorithm: hashName, mgf1HashAlgorithm: mgf1 ?? hashName, saltLength: saltLength ?? PSS_DIGESTS.get(hashName) ?? 20 };
  return steps(budgetMs => rsaSteps("rsa-pss", modulusLength, exponent, pss, budgetMs));
}

function dsaJob(options: unknown): never {
  validateObject(options, "options");
  validateUint32(Reflect.get(options, "modulusLength"), "options.modulusLength");
  const divisorLength: unknown = Reflect.get(options, "divisorLength");
  if (divisorLength !== undefined && divisorLength !== null) validateInt32(divisorLength, "options.divisorLength", 0);
  return unavailableNodeApi("crypto.generateKeyPair dsa");
}

function ecJob(options: unknown): Work {
  validateObject(options, "options");
  const namedCurve: unknown = Reflect.get(options, "namedCurve"), paramEncoding: unknown = Reflect.get(options, "paramEncoding");
  validateString(namedCurve, "options.namedCurve");
  if (paramEncoding !== undefined && paramEncoding !== null && paramEncoding !== "named" && paramEncoding !== "explicit") throw invalidValue("options.paramEncoding", paramEncoding);
  const curve = resolveCurve(namedCurve);
  if (curve === undefined) throw codedError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
  if (curve.kind === "unsupported") return unavailableNodeApi(`crypto.generateKeyPair ec curve ${namedCurve}`);
  // OpenSSL makes an X25519, X448, Ed25519 or Ed448 key when the "curve" is one of those names.
  if (curve.kind === "okp") return immediate(() => okpKey(curve.type));
  if (paramEncoding === "explicit") return unavailableNodeApi("crypto.generateKeyPair ec with paramEncoding 'explicit'");
  return immediate(() => ecKey(curve.curve));
}

const incompatible = (first: string, second: string): Error =>
  codedError(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", `Option "${first}" cannot be used in combination with option "${second}"`);
const given = (value: unknown): boolean => value !== undefined && value !== null;

function dhJob(options: unknown): Work {
  validateObject(options, "options");
  const group: unknown = Reflect.get(options, "group"), primeLength: unknown = Reflect.get(options, "primeLength");
  const prime: unknown = Reflect.get(options, "prime"), generator: unknown = Reflect.get(options, "generator");
  let source: DhSource;
  if (given(group)) {
    if (given(prime)) throw incompatible("group", "prime");
    if (given(primeLength)) throw incompatible("group", "primeLength");
    if (given(generator)) throw incompatible("group", "generator");
    validateString(group, "options.group");
    const known = resolveDhGroup(group);
    if (known === undefined) throw codedError(Error, "ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group");
    source = known;
  } else {
    if (given(prime)) {
      if (given(primeLength)) throw incompatible("prime", "primeLength");
      if (!ArrayBuffer.isView(prime)) throw invalidInstance("options.prime", "Buffer, TypedArray, or DataView", prime);
    } else if (given(primeLength)) validateInt32(primeLength, "options.primeLength", 0);
    else throw codedError(TypeError, "ERR_MISSING_OPTION", "At least one of the group, prime, or primeLength options is required");
    if (given(generator)) validateInt32(generator, "options.generator", 0);
    const g = typeof generator === "number" ? generator : 2;
    source = ArrayBuffer.isView(prime) ? { from: "prime", prime: Uint8Array.from(new Uint8Array(prime.buffer, prime.byteOffset, prime.byteLength)), generator: g }
      : { from: "length", bits: typeof primeLength === "number" ? primeLength : 0, generator: g };
  }
  return steps(budgetMs => dhSteps(source, budgetMs));
}

const POST_QUANTUM = /^(?:ml-dsa-(?:44|65|87)|ml-kem-(?:512|768|1024)|slh-dsa-(?:sha2|shake)-(?:128|192|256)[fs])$/u;

/** Node's `createJob`: everything it validates, and everything its native job refuses when it is constructed. */
function pairJob(type: unknown, options: unknown, environment: KeygenEnvironment): PairJob {
  validateString(type, "type");
  const encoding = pairEncoding(type, options);
  if (options !== undefined) validateObject(options, "options");
  let receiver: string, work: Work;
  switch (type) {
    case "rsa": case "rsa-pss": receiver = "RsaKeyPairGenJob"; work = rsaJob(type, options, environment); break;
    case "dsa": return dsaJob(options);
    case "ec": receiver = "EcKeyPairGenJob"; work = ecJob(options); break;
    case "dh": receiver = "DhKeyPairGenJob"; work = dhJob(options); break;
    case "ed25519": case "ed448": case "x25519": case "x448": receiver = "NidKeyPairGenJob"; work = immediate(() => okpKey(type)); break;
    default:
      if (POST_QUANTUM.test(type)) return unavailableNodeApi(`crypto.generateKeyPair ${type}`);
      throw invalidValue("type", type, "must be a supported key type");
  }
  const cipher = encoding.privateKey?.cipher;
  if (typeof cipher === "string" && keyCipher(cipher) === undefined) throw unknownCipher();
  return { receiver, encoding, work };
}

/** A method of a key object, called the way a program calls it. */
function exported(key: object, options: object): unknown {
  const method: unknown = Reflect.get(key, "export");
  if (typeof method !== "function") throw new TypeError("The key object has no export method");
  return Reflect.apply(method, key, [options]);
}
function failedToEncode(half: string, work: () => unknown): unknown {
  try { return work(); }
  catch (error) {
    if (error instanceof KeyCodecError) throw new Error(`Failed to encode ${half} key`, { cause: error });
    throw error;
  }
}

/** One half of the result: a key object, or the key in the encoding the caller chose. */
function publicHalf(keys: Keys, material: PrivateMaterial, encoding: KeyEncoding | undefined): unknown {
  if (encoding === undefined) return keys.wrapMaterial(material, false);
  return failedToEncode("public", () => {
    if (encoding.format === "pem" || encoding.format === "der") return writePublicKey(publicOf(material), encoding);
    if (encoding.format === "jwk") return toJwk(publicOf(material), false);
    return exported(keys.wrapMaterial(material, false), { format: encoding.format, type: encoding.type });
  });
}
function privateHalf(keys: Keys, material: PrivateMaterial, encoding: KeyEncoding | undefined): unknown {
  if (encoding === undefined) return keys.wrapMaterial(material, true);
  return failedToEncode("private", () => {
    if (encoding.format === "pem" || encoding.format === "der") return writePrivateKey(material, encoding);
    if (encoding.format === "jwk") return toJwk(material, true);
    return exported(keys.wrapMaterial(material, true), { format: encoding.format });
  });
}
interface Pair { readonly publicKey: unknown; readonly privateKey: unknown }
function* pairSteps(keys: Keys, job: PairJob, budgetMs: number): Steps<Pair> {
  const material = job.work.kind === "immediate" ? job.work.make() : yield* job.work.create(budgetMs);
  return { publicKey: publicHalf(keys, material, job.encoding.publicKey), privateKey: privateHalf(keys, material, job.encoding.privateKey) };
}

/** Node's `generateKeyJob`: the length of the secret key in bytes (a bit length is rounded down). */
function secretKeyLength(type: unknown, options: unknown): number {
  validateString(type, "type");
  validateObject(options, "options");
  const length: unknown = Reflect.get(options, "length");
  switch (type) {
    case "hmac": validateInteger(length, "options.length", 8, 2 ** 31 - 1); return Math.floor(length / 8);
    case "aes":
      if (length !== 128 && length !== 192 && length !== 256) throw invalidValue("options.length", length, "must be one of: 128, 192, 256");
      return length / 8;
    default: throw invalidValue("type", type, "must be a supported key type");
  }
}

const customPromisify = Symbol.for("nodejs.util.promisify.custom");

/**
 * `generateKeyPair`, `generateKeyPairSync`, `generateKey` and `generateKeySync` of `node:crypto`. The callback
 * forms spread RSA and Diffie-Hellman parameter generation over turns of the process.
 */
export function createCryptoKeygen(ports: CryptoPorts, keys: Keys, environment: KeygenEnvironment = {}) {
  function generateKeyPairSync(type: unknown, options: unknown): Pair {
    return runSteps(pairSteps(keys, pairJob(type, options, environment), NO_BUDGET));
  }
  function generateKeyPair(type: unknown, options: unknown, callback: unknown): void {
    let chosen = options, done = callback;
    if (typeof chosen === "function") { done = chosen; chosen = undefined; }
    validateFunction(done, "callback");
    const job = pairJob(type, chosen, environment), receiver = jobReceiver(job.receiver), finish = done;
    driveSteps(ports, pairSteps(keys, job, TURN_BUDGET_MS), outcome => {
      Reflect.apply(finish, receiver, outcome.ok ? [null, outcome.value.publicKey, outcome.value.privateKey] : [outcome.error]);
    });
  }
  // Node names the two results with a private symbol that only its own `util.promisify` reads; this
  // `util.promisify` reads the public one, so `promisify(generateKeyPair)` resolves to the same object.
  Object.defineProperty(generateKeyPair, customPromisify, {
    configurable: true, enumerable: false,
    value: named(function (type: unknown, options: unknown): Promise<Pair> {
      return new Promise<Pair>((resolve, reject) => {
        const settle = (error: unknown, publicKey: unknown, privateKey: unknown): void => {
          if (error === null || error === undefined) resolve({ publicKey, privateKey });
          else reject(error instanceof Error ? error : new Error("Key generation failed", { cause: error }));
        };
        if (options === undefined) generateKeyPair(type, settle, undefined);
        else generateKeyPair(type, options, settle);
      });
    }, "generateKeyPair"),
  });

  function generateKeySync(type: unknown, options: unknown): ReturnType<Keys["createSecretKey"]> {
    return keys.createSecretKey(randomBytes(secretKeyLength(type, options)));
  }
  function generateKey(type: unknown, options: unknown, callback: unknown): void {
    let chosen = options, done = callback;
    if (typeof chosen === "function") { done = chosen; chosen = undefined; }
    validateFunction(done, "callback");
    const length = secretKeyLength(type, chosen), receiver = jobReceiver("SecretKeyGenJob"), finish = done;
    later(ports, () => keys.createSecretKey(randomBytes(length)), (error, key) => { Reflect.apply(finish, receiver, error === null ? [null, key] : [error]); });
  }
  named(generateKeyPair, "generateKeyPair"); named(generateKeyPairSync, "generateKeyPairSync");
  named(generateKey, "generateKey"); named(generateKeySync, "generateKeySync");
  return { generateKeyPair, generateKeyPairSync, generateKey, generateKeySync };
}
