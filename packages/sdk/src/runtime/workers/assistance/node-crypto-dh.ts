/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/diffiehellman.js (DiffieHellman, DiffieHellmanGroup,
 * diffieHellman) and src/crypto/crypto_dh.cc (the order of the checks and the wording of the failures).
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
// `crypto.createDiffieHellman`, `DiffieHellman`, `getDiffieHellman` / `createDiffieHellmanGroup`,
// `DiffieHellmanGroup` and the stateless `crypto.diffieHellman` of the fast path. Behaviour recorded from
// Node.js v24.18.1 (node-crypto-dh.controls.json); the arithmetic is in node-crypto-dh-math.ts.
import type { Buffer } from "buffer/";
import { bigIntToBytes, bitLength, bytesToBigInt, modPow } from "./node-crypto-bigint.ts";
import { dhGroup } from "./node-crypto-dh-groups.ts";
import {
  MAX_MODULUS_BITS, MIN_MODULUS_BITS, checkDh, checkPeer, generatePrivate, generateSafePrime, isKnownSafePrime, primeLength, sharedSecret,
} from "./node-crypto-dh-math.ts";
import { adopt, construct, dhComputeSecret, dhGetPrivateKey, encode, entropy, expose, isEncoding, madeBy, missingHandle, prototypeOf, setPrivateKey, setPublicKey, type SecretHandle } from "./node-crypto-dh-shared.ts";
import { createStatelessDiffieHellman } from "./node-crypto-dh-stateless.ts";
import { stringBytes } from "./node-crypto-key-encoding.ts";
import { codedError, opensslError, type OpensslEntry } from "./node-crypto-key-errors.ts";
import type { createCryptoKeys } from "./node-crypto-keys.ts";
import { isAnyArrayBuffer, truthy, viewBytes } from "./node-crypto-misc.ts";
import type { CryptoPorts } from "./node-crypto-ports.ts";
import { invalidType, named, validateInteger } from "./node-util-validators.ts";

const INT32_MIN = -2147483648, INT32_MAX = 2147483647;
/** Above this size the primality tests behind `verifyError` take long enough to be put off until the flags are read. */
const EAGER_CHECK_BITS = 1024;

function dhEntry(number: string, reason: string, code: string): OpensslEntry {
  return { text: `error:${number}:Diffie-Hellman routines::${reason}`, library: "Diffie-Hellman routines", reason, code };
}
const MODULUS_TOO_SMALL = dhEntry("0280007E", "modulus too small", "ERR_OSSL_DH_MODULUS_TOO_SMALL");
const BAD_GENERATOR = dhEntry("02800065", "bad generator", "ERR_OSSL_DH_BAD_GENERATOR");
function invalidState(message: string): Error { return codedError(Error, "ERR_CRYPTO_INVALID_STATE", message); }
function invalidParameters(): Error { return codedError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid DH parameters"); }
/** ERR_INVALID_ARG_TYPE for an argument with several accepted types, worded as Node words the list. */
function invalidOneOf(name: string, value: unknown): TypeError {
  const received = invalidType(name, "t", value).message.slice(`The "${name}" argument must be of type t. `.length);
  return codedError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be one of type number or string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. ${received}`);
}
/** A number's unsigned bytes without leading zeros, as OpenSSL's BN_bn2bin writes them; zero has none. */
function magnitude(value: bigint): Uint8Array { return value === 0n ? new Uint8Array() : bigIntToBytes(value); }

/** What Node's native DiffieHellman handle holds: the parameters and whichever keys have been generated or set. */
class DhHandle implements SecretHandle {
  readonly prime: bigint;
  readonly generator: bigint;
  #private: bigint | undefined;
  #public: bigint | undefined;
  constructor(prime: bigint, generator: bigint) { this.prime = prime; this.generator = generator; }
  #usable(): boolean {
    const bits = bitLength(this.prime);
    return bits >= MIN_MODULUS_BITS && bits <= MAX_MODULUS_BITS && (this.prime & 1n) === 1n;
  }
  /** DH_generate_key: keeps a private key that is there, draws one otherwise, and computes the public key. */
  generateKeys(): Uint8Array {
    if (!this.#usable()) throw codedError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Key generation failed");
    this.#private ??= generatePrivate(this.prime, this.generator, entropy);
    this.#public = modPow(this.generator, this.#private, this.prime);
    return magnitude(this.#public);
  }
  getPrime(): Uint8Array {
    if (this.prime === 0n) throw invalidState("p is null");
    return magnitude(this.prime);
  }
  getGenerator(): Uint8Array { return magnitude(this.generator); }
  getPublicKey(): Uint8Array {
    if (this.#public === undefined || this.#public === 0n) throw invalidState("No public key - did you forget to generate one?");
    return magnitude(this.#public);
  }
  getPrivateKey(): Uint8Array {
    if (this.#private === undefined || this.#private === 0n) throw invalidState("No private key - did you forget to generate one?");
    return magnitude(this.#private);
  }
  setPublicKey(key: Uint8Array): void { this.#public = bytesToBigInt(key); }
  setPrivateKey(key: Uint8Array): void { this.#private = bytesToBigInt(key); }
  computeSecret(key: Uint8Array): Uint8Array {
    const peer = bytesToBigInt(key);
    switch (checkPeer(this.prime, this.generator, peer)) {
      case "too-small": throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too small");
      case "too-large": throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too large");
      case "invalid": throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYTYPE", "Supplied key is invalid");
      case undefined: break;
    }
    const bits = bitLength(this.prime);
    // What Node hands back where OpenSSL's DH_compute_key fails: zeros as long as the prime for a modulus under
    // 512 bits (OpenSSL reports a length of zero, which Node pads), and nothing for a modulus too large or
    // without a private key (OpenSSL reports an error, which Node turns into an empty buffer).
    if (bits > MAX_MODULUS_BITS) return new Uint8Array();
    if (bits < MIN_MODULUS_BITS) return new Uint8Array(primeLength(this.prime));
    if (this.#private === undefined || (this.prime & 1n) === 0n) return new Uint8Array();
    return sharedSecret(this.prime, this.#private, peer);
  }
}

/** Node's native constructor for a prime of `bits` bits: the checks in its order, then the search for a safe prime. */
function generatedHandle(bits: number, generator: unknown): DhHandle {
  if (bits < 2) throw opensslError(MODULUS_TOO_SMALL);
  if (typeof generator !== "number") throw codedError(TypeError, "ERR_INVALID_ARG_TYPE", "Second argument must be an int32");
  if (generator < 2) throw opensslError(BAD_GENERATOR);
  // OpenSSL refuses these sizes; Node reports its refusal without OpenSSL's reason.
  if (bits < MIN_MODULUS_BITS || bits > MAX_MODULUS_BITS) throw invalidParameters();
  const base = BigInt(generator);
  return new DhHandle(generateSafePrime(bits, base, entropy), base);
}
function givenHandle(prime: Uint8Array, generator: number | Uint8Array): DhHandle {
  const base = typeof generator === "number" ? BigInt(generator) : bytesToBigInt(generator);
  if (base < 2n) throw opensslError(BAD_GENERATOR);
  return new DhHandle(bytesToBigInt(prime), base);
}

/**
 * Defines `verifyError` as Node does: an own, enumerable, read-only value. For a prime above 1024 bits that is not
 * one of the fixed groups', the two primality tests behind it take from a second (2048 bits) to most of a minute
 * (8192 bits) in JavaScript, so there the property starts as a getter that computes the flags when they are first
 * read and then becomes the value.
 */
function defineVerifyError(instance: object, compute: (() => number) | number): void {
  const settle = (value: number): void => { Object.defineProperty(instance, "verifyError", { value, writable: false, enumerable: true, configurable: false }); };
  if (typeof compute === "number") { settle(compute); return; }
  Object.defineProperty(instance, "verifyError", { get: (): number => { const value = compute(); settle(value); return value; }, enumerable: true, configurable: true });
}

/** The Diffie-Hellman half of `node:crypto` for one process. */
export function createCryptoDh(ports: CryptoPorts, keys: ReturnType<typeof createCryptoKeys>) {
  const handles = new WeakMap<object, DhHandle>();
  const handleOf = (value: unknown, member: string): DhHandle => {
    const handle = typeof value === "object" && value !== null ? handles.get(value) : undefined;
    if (handle === undefined) throw missingHandle(member);
    return handle;
  };
  const hold = (instance: object, handle: DhHandle): void => { handles.set(instance, handle); adopt(instance, handle); };

  // Node's constructors are functions: they work without `new`, and a class may extend them.
  function DiffieHellman(this: unknown, sizeOrKey?: unknown, keyEncoding?: unknown, generator?: unknown, genEncoding?: unknown): unknown {
    if (!madeBy(this, DiffieHellman)) return construct(DiffieHellman, [sizeOrKey, keyEncoding, generator, genEncoding]);
    if (typeof sizeOrKey !== "number" && typeof sizeOrKey !== "string" && !ArrayBuffer.isView(sizeOrKey) && !isAnyArrayBuffer(sizeOrKey)) throw invalidOneOf("sizeOrKey", sizeOrKey);
    if (typeof sizeOrKey === "number") validateInteger(sizeOrKey, "sizeOrKey", INT32_MIN, INT32_MAX);
    let base = generator, baseEncoding = genEncoding, primeEncoding = keyEncoding;
    // An encoding that is not one is the generator: createDiffieHellman(prime, generator[, generatorEncoding]).
    if (truthy(keyEncoding) && !isEncoding(keyEncoding) && keyEncoding !== "buffer") { baseEncoding = generator; base = keyEncoding; primeEncoding = undefined; }
    const prime = typeof sizeOrKey === "number" ? sizeOrKey : typeof sizeOrKey === "string" ? stringBytes(sizeOrKey, primeEncoding) : viewBytes(sizeOrKey);
    let given: number | Uint8Array;
    if (!truthy(base)) given = 2;
    else if (typeof base === "number") { validateInteger(base, "generator", INT32_MIN, INT32_MAX); given = base; }
    else if (typeof base === "string") given = stringBytes(base, baseEncoding);
    else if (ArrayBuffer.isView(base) || isAnyArrayBuffer(base)) given = viewBytes(base);
    else throw invalidOneOf("generator", base);
    if (typeof prime === "number") {
      // A generated prime is a safe prime with a suitable generator: nothing to verify.
      hold(this, generatedHandle(prime, given));
      defineVerifyError(this, 0);
      return undefined;
    }
    const handle = givenHandle(prime, given);
    hold(this, handle);
    const check = (): number => checkDh(handle.prime, handle.generator, entropy);
    defineVerifyError(this, isKnownSafePrime(handle.prime) || bitLength(handle.prime) <= EAGER_CHECK_BITS ? check() : check);
    return undefined;
  }
  function DiffieHellmanGroup(this: unknown, name?: unknown): unknown {
    if (!madeBy(this, DiffieHellmanGroup)) return construct(DiffieHellmanGroup, [name]);
    if (typeof name !== "string") throw codedError(TypeError, "ERR_INVALID_ARG_TYPE", "Group name must be a string");
    const group = dhGroup(name);
    if (group === undefined) throw codedError(Error, "ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group");
    hold(this, new DhHandle(group.prime, group.generator));
    defineVerifyError(this, 0);
    return undefined;
  }

  const dhGenerateKeys = named(function (this: unknown, encoding?: unknown): Buffer | string {
    return encode(handleOf(this, "generateKeys").generateKeys(), encoding);
  }, "dhGenerateKeys");
  const dhGetPrime = named(function (this: unknown, encoding?: unknown): Buffer | string {
    return encode(handleOf(this, "getPrime").getPrime(), encoding);
  }, "dhGetPrime");
  const dhGetGenerator = named(function (this: unknown, encoding?: unknown): Buffer | string {
    return encode(handleOf(this, "getGenerator").getGenerator(), encoding);
  }, "dhGetGenerator");
  const dhGetPublicKey = named(function (this: unknown, encoding?: unknown): Buffer | string {
    return encode(handleOf(this, "getPublicKey").getPublicKey(), encoding);
  }, "dhGetPublicKey");
  const common = { generateKeys: dhGenerateKeys, computeSecret: dhComputeSecret, getPrime: dhGetPrime, getGenerator: dhGetGenerator, getPublicKey: dhGetPublicKey, getPrivateKey: dhGetPrivateKey };
  expose(prototypeOf(DiffieHellman), { ...common, setPublicKey, setPrivateKey });
  expose(prototypeOf(DiffieHellmanGroup), common);

  const createDiffieHellman = named((sizeOrKey?: unknown, keyEncoding?: unknown, generator?: unknown, genEncoding?: unknown): object =>
    construct(DiffieHellman, [sizeOrKey, keyEncoding, generator, genEncoding]), "createDiffieHellman");
  // `getDiffieHellman` is the same function under a second name.
  const createDiffieHellmanGroup = named((name?: unknown): object => construct(DiffieHellmanGroup, [name]), "createDiffieHellmanGroup");
  const diffieHellman = createStatelessDiffieHellman(ports, keys);
  return { createDiffieHellman, DiffieHellman, createDiffieHellmanGroup, getDiffieHellman: createDiffieHellmanGroup, DiffieHellmanGroup, diffieHellman };
}
