/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/diffiehellman.js (ECDH, getFormat) and
 * src/crypto/crypto_ec.cc (the order of the checks and the wording of the failures).
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
// `crypto.createECDH`, `crypto.ECDH` and `crypto.getCurves` of the fast path: the four curves the key objects
// know, computed with @noble/curves. Behaviour recorded from Node.js v24.18.1 (node-crypto-ecdh.controls.json).
import { equalBytes } from "@noble/curves/utils.js";
import type { Buffer } from "buffer/";
import { VMError } from "../../errors.ts";
import { bigIntToBytes, bytesToBigInt, randomBelow } from "./node-crypto-bigint.ts";
import { adopt, construct, dhComputeSecret, dhGetPrivateKey, encode, entropy, expose, madeBy, messageText, missingHandle, prototypeOf, setPrivateKey, setPublicKey, type SecretHandle } from "./node-crypto-dh-shared.ts";
import { bytesOf } from "./node-crypto-key-encoding.ts";
import { codedError, invalidCurve } from "./node-crypto-key-errors.ts";
import { CURVES, ecPoint, type NamedCurve } from "./node-crypto-key-model.ts";
import { truthy } from "./node-crypto-misc.ts";
import { named, validateString } from "./node-util-validators.ts";


/** The curves computed here, in the order of Node's `getCurves()`. */
const SUPPORTED: readonly NamedCurve[] = Object.freeze(["prime256v1", "secp256k1", "secp384r1", "secp521r1"] as const);
/** The other curves of Node 24's `getCurves()` (OpenSSL 3.5): real curves, refused here instead of misreported. */
const UNSUPPORTED = new Set((
  "Oakley-EC2N-3 Oakley-EC2N-4 SM2 brainpoolP160r1 brainpoolP160t1 brainpoolP192r1 brainpoolP192t1 brainpoolP224r1 brainpoolP224t1 brainpoolP256r1 "
  + "brainpoolP256t1 brainpoolP320r1 brainpoolP320t1 brainpoolP384r1 brainpoolP384t1 brainpoolP512r1 brainpoolP512t1 c2pnb163v1 c2pnb163v2 c2pnb163v3 "
  + "c2pnb176v1 c2pnb208w1 c2pnb272w1 c2pnb304w1 c2pnb368w1 c2tnb191v1 c2tnb191v2 c2tnb191v3 c2tnb239v1 c2tnb239v2 c2tnb239v3 c2tnb359v1 c2tnb431r1 "
  + "prime192v1 prime192v2 prime192v3 prime239v1 prime239v2 prime239v3 secp112r1 secp112r2 secp128r1 secp128r2 secp160k1 secp160r1 secp160r2 secp192k1 "
  + "secp224k1 secp224r1 sect113r1 sect113r2 sect131r1 sect131r2 sect163k1 sect163r1 sect163r2 sect193r1 sect193r2 sect233k1 sect233r1 sect239k1 "
  + "sect283k1 sect283r1 sect409k1 sect409r1 sect571k1 sect571r1 wap-wsg-idm-ecid-wtls1 wap-wsg-idm-ecid-wtls10 wap-wsg-idm-ecid-wtls11 "
  + "wap-wsg-idm-ecid-wtls12 wap-wsg-idm-ecid-wtls3 wap-wsg-idm-ecid-wtls4 wap-wsg-idm-ecid-wtls5 wap-wsg-idm-ecid-wtls6 wap-wsg-idm-ecid-wtls7 "
  + "wap-wsg-idm-ecid-wtls8 wap-wsg-idm-ecid-wtls9").split(" "));
/** Names OpenSSL knows that are not curves an EC key can have: Node finds the name and then fails to make the key. */
const NOT_EC = new Set(["X25519", "X448", "ED25519", "ED448"]);

function operationFailed(message: string): Error { return codedError(Error, "ERR_CRYPTO_OPERATION_FAILED", message); }
/** The curve of a name as OpenSSL's `OBJ_sn2nid` reads it (exact case, no aliases); `notEc` words the non-curve failure. */
function curveOf(name: string, notEc: string): NamedCurve {
  const curve = SUPPORTED.find(candidate => candidate === name);
  if (curve !== undefined) return curve;
  if (UNSUPPORTED.has(name)) throw new VMError("FEATURE_NOT_AVAILABLE", `crypto curve ${name} is not supported in the assisted process`, { builtin: "crypto", algorithm: name });
  if (NOT_EC.has(name)) throw operationFailed(notEc);
  throw invalidCurve();
}

type Format = "uncompressed" | "compressed" | "hybrid";
function getFormat(format: unknown): Format {
  if (!truthy(format) || format === "uncompressed") return "uncompressed";
  if (format === "compressed" || format === "hybrid") return format;
  throw codedError(TypeError, "ERR_CRYPTO_ECDH_INVALID_FORMAT", `Invalid ECDH format: ${messageText(format)}`);
}

/** A point as the handle keeps it: uncompressed bytes, or the point at infinity (which OpenSSL reads from a single zero byte). */
type Point = Uint8Array | "infinity";
function readPoint(curve: NamedCurve, bytes: Uint8Array): Point | undefined {
  if (bytes.length === 1 && bytes[0] === 0) return "infinity";
  try { return ecPoint(curve, bytes).point; }
  catch { return undefined; }
}
function writePoint(curve: NamedCurve, point: Point, format: Format): Uint8Array {
  if (point === "infinity") return new Uint8Array(1);
  if (format === "uncompressed") return point;
  const parity = (point[point.length - 1] ?? 0) & 1;
  if (format === "hybrid") { const hybrid = Uint8Array.from(point); hybrid[0] = 6 + parity; return hybrid; }
  const compressed = point.slice(0, 1 + CURVES[curve].size);
  compressed[0] = 2 + parity;
  return compressed;
}

/** What Node's native ECDH handle holds: an EC key that may have a private scalar, a public point, both or neither. */
class EcdhHandle implements SecretHandle {
  readonly #curve: NamedCurve;
  #scalar: bigint | undefined;
  /** The point the scalar gives, kept to tell whether a public key set afterwards still belongs to it. */
  #derived: Uint8Array | undefined;
  #point: Point | undefined;
  constructor(curve: NamedCurve) { this.#curve = curve; }
  #order(): bigint { return CURVES[this.#curve].curve.Point.Fn.ORDER; }
  #publicOf(scalar: bigint): Uint8Array {
    const { curve, size } = CURVES[this.#curve];
    return curve.getPublicKey(bigIntToBytes(scalar, size), false);
  }
  #adopt(scalar: bigint): void {
    const point = this.#publicOf(scalar);
    this.#scalar = scalar; this.#derived = point; this.#point = point;
  }
  generateKeys(): void { this.#adopt(1n + randomBelow(this.#order() - 1n, entropy)); }
  getPublicKey(format: Format): Uint8Array {
    if (this.#point === undefined) throw operationFailed("Failed to get ECDH public key");
    return writePoint(this.#curve, this.#point, format);
  }
  getPrivateKey(): Uint8Array {
    if (this.#scalar === undefined) throw operationFailed("Failed to get ECDH private key");
    return bigIntToBytes(this.#scalar);
  }
  setPrivateKey(key: Uint8Array): void {
    const scalar = bytesToBigInt(key);
    if (scalar < 1n || scalar >= this.#order()) throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.");
    this.#adopt(scalar);
  }
  setPublicKey(key: Uint8Array): void {
    const point = readPoint(this.#curve, key);
    if (point === undefined) throw operationFailed("Failed to convert Buffer to EC_POINT");
    this.#point = point;
  }
  /** OpenSSL's EC_KEY_check_key: a public point that is not infinity and, with a private scalar, is the scalar's point. */
  #pairIsValid(): boolean {
    if (this.#point === undefined || this.#point === "infinity") return false;
    return this.#derived === undefined || equalBytes(this.#derived, this.#point);
  }
  computeSecret(key: Uint8Array): Uint8Array | undefined {
    if (!this.#pairIsValid()) throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYPAIR", "Invalid key pair");
    const peer = readPoint(this.#curve, key);
    if (peer === undefined) return undefined;
    if (peer === "infinity" || this.#scalar === undefined) throw operationFailed("Failed to compute ECDH key");
    const { curve, size } = CURVES[this.#curve];
    // The secret is the X coordinate of scalar * peer, as long as the field.
    return curve.getSharedSecret(bigIntToBytes(this.#scalar, size), peer, true).slice(1);
  }
}

/** Reports a deprecation as `process.emitWarning(message, type, code)` does. */
export type EcdhWarn = (message: string, type: string, code: string) => void;

/** `createECDH`, `ECDH` and `getCurves` of one process. `warn` receives DEP0031 the first time `ecdh.setPublicKey` runs. */
export function createCryptoEcdh(warn?: EcdhWarn) {
  const handles = new WeakMap<object, EcdhHandle>();
  const handleOf = (value: unknown, member: string): EcdhHandle => {
    const handle = typeof value === "object" && value !== null ? handles.get(value) : undefined;
    if (handle === undefined) throw missingHandle(member);
    return handle;
  };

  // Node's constructor is a function: `ECDH(curve)` works without `new`, and a class may extend it.
  function ECDH(this: unknown, curve?: unknown): unknown {
    if (!madeBy(this, ECDH)) return construct(ECDH, [curve]);
    validateString(curve, "curve");
    const handle = new EcdhHandle(curveOf(curve, "Failed to create key using named curve"));
    handles.set(this, handle);
    adopt(this, handle);
    return undefined;
  }

  const generateKeys = named(function (this: unknown, encoding?: unknown, format?: unknown): unknown {
    handleOf(this, "generateKeys").generateKeys();
    const read: unknown = typeof this === "object" && this !== null ? Reflect.get(this, "getPublicKey") : undefined;
    if (typeof read !== "function") throw new TypeError("this.getPublicKey is not a function");
    const key: unknown = Reflect.apply(read, this, [encoding, format]);
    return key;
  }, "generateKeys");
  const getPublicKey = named(function (this: unknown, encoding?: unknown, format?: unknown): Buffer | string {
    const selected = getFormat(format);
    return encode(handleOf(this, "getPublicKey").getPublicKey(selected), encoding);
  }, "getPublicKey");
  let warned = false;
  // Node wraps the method with `util.deprecate`, whose wrapper is called `deprecated` and warns once per process.
  const deprecated = named(function (this: unknown, key?: unknown, encoding?: unknown): unknown {
    if (!warned) { warned = true; warn?.("ecdh.setPublicKey() is deprecated.", "DeprecationWarning", "DEP0031"); }
    const result: unknown = Reflect.apply(setPublicKey, this, [key, encoding]);
    return result;
  }, "deprecated");
  expose(prototypeOf(ECDH), { computeSecret: dhComputeSecret, setPrivateKey, setPublicKey: deprecated, getPrivateKey: dhGetPrivateKey, generateKeys, getPublicKey });

  const convertKey = named((key?: unknown, curve?: unknown, inEnc?: unknown, outEnc?: unknown, format?: unknown): Buffer | string => {
    validateString(curve, "curve");
    const bytes = bytesOf(key, "key", inEnc);
    const selected = getFormat(format);
    // Node's binding answers an empty key with an empty string, before it looks at the curve.
    if (bytes.length === 0) return "";
    const named = curveOf(curve, "Failed to get EC_GROUP");
    const point = readPoint(named, bytes);
    if (point === undefined) throw operationFailed("Failed to convert Buffer to EC_POINT");
    return encode(writePoint(named, point, selected), outEnc);
  }, "convertKey");
  // Assigned as Node assigns it: writable, enumerable and configurable.
  const constructor = Object.assign(ECDH, { convertKey });

  const createECDH = named((curve?: unknown): object => construct(ECDH, [curve]), "createECDH");
  // Node's getCurves is an anonymous cached function that hands out a fresh array.
  const getCurves = named((): string[] => [...SUPPORTED], "");
  return { createECDH, ECDH: constructor, getCurves };
}
