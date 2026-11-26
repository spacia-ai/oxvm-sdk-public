/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/diffiehellman.js (diffieHellman).
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
// The stateless `crypto.diffieHellman({ privateKey, publicKey }[, callback])` for keys of type dh, ec, x25519 and
// x448. Behaviour recorded from Node.js v24.18.1 (node-crypto-dh.controls.json).
import { x25519 } from "@noble/curves/ed25519.js";
import { x448 } from "@noble/curves/ed448.js";
import { Buffer } from "buffer/";
import { bitLength } from "./node-crypto-bigint.ts";
import { MAX_MODULUS_BITS, MIN_MODULUS_BITS, namedExponentBits, sharedSecret } from "./node-crypto-dh-math.ts";
import { codedError, opensslError, type OpensslEntry } from "./node-crypto-key-errors.ts";
import { CURVES, isPrivateMaterial, type DhPrivate, type DhPublic, type EcPrivate, type EcPublic, type PrivateMaterial, type PublicMaterial } from "./node-crypto-key-model.ts";
import type { createCryptoKeys } from "./node-crypto-keys.ts";
import { jobReceiver, member } from "./node-crypto-misc.ts";
import { later, type CryptoPorts } from "./node-crypto-ports.ts";
import { invalidValue, named, validateFunction, validateObject } from "./node-util-validators.ts";

function entry(number: string, library: string, reason: string, code: string): OpensslEntry {
  return { text: `error:${number}:${library}::${reason}`, library, reason, code };
}
const DH = "Diffie-Hellman routines";
const NOT_SUPPORTED = entry("03000096", "digital envelope routines", "operation not supported for this keytype", "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
const MISMATCH = entry("1C8000CB", "Provider routines", "mismatching domain parameters", "ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS");
const DERIVATION = entry("1C8000A4", "Provider routines", "failed during derivation", "ERR_OSSL_FAILED_DURING_DERIVATION");
const PUBKEY_TOO_SMALL = entry("0280007C", DH, "check pubkey too small", "ERR_OSSL_DH_CHECK_PUBKEY_TOO_SMALL");
const PUBKEY_TOO_LARGE = entry("0280007B", DH, "check pubkey too large", "ERR_OSSL_DH_CHECK_PUBKEY_TOO_LARGE");
const MODULUS_TOO_SMALL = entry("0280007E", DH, "modulus too small", "ERR_OSSL_DH_MODULUS_TOO_SMALL");
const MODULUS_TOO_LARGE = entry("02800067", DH, "modulus too large", "ERR_OSSL_DH_MODULUS_TOO_LARGE");

/** Why the derivation failed: an entry of OpenSSL's error queue, or nothing where OpenSSL left none. */
class DeriveFailure extends Error {
  readonly entry: OpensslEntry | undefined;
  constructor(cause?: OpensslEntry) { super(cause?.text ?? "Deriving bits failed"); this.name = "DeriveFailure"; this.entry = cause; }
}
/** The failure as the synchronous form throws it; the callback form receives only the message. */
function thrown(failure: DeriveFailure, plain: boolean): Error {
  return failure.entry === undefined || plain ? new Error(failure.message) : opensslError(failure.entry);
}

function deriveEc(privateKey: EcPrivate, publicKey: EcPublic): Uint8Array {
  if (privateKey.namedCurve !== publicKey.namedCurve) throw new DeriveFailure(MISMATCH);
  // The X coordinate of d * Q, as long as the field.
  return CURVES[privateKey.namedCurve].curve.getSharedSecret(privateKey.d, publicKey.point, true).slice(1);
}
function deriveDh(privateKey: DhPrivate, publicKey: DhPublic): Uint8Array {
  const { p, g, x } = privateKey;
  if (p !== publicKey.p || g !== publicKey.g) throw new DeriveFailure(MISMATCH);
  const bits = bitLength(p);
  if (bits < MIN_MODULUS_BITS) throw new DeriveFailure(MODULUS_TOO_SMALL);
  if (bits > MAX_MODULUS_BITS) throw new DeriveFailure(MODULUS_TOO_LARGE);
  const inRange = publicKey.y > 1n && publicKey.y < p - 1n;
  // For a group OpenSSL knows by name the range check fails without an entry in its error queue.
  if (!inRange && namedExponentBits(p, g) !== undefined) throw new DeriveFailure();
  if (publicKey.y <= 1n) throw new DeriveFailure(PUBKEY_TOO_SMALL);
  if (!inRange) throw new DeriveFailure(PUBKEY_TOO_LARGE);
  return sharedSecret(p, x, publicKey.y);
}
function deriveMontgomery(curve: typeof x25519, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let secret: Uint8Array;
  // A peer of low order gives an all-zero secret, which OpenSSL refuses (noble throws for it).
  try { secret = curve.getSharedSecret(privateKey, publicKey); }
  catch { throw new DeriveFailure(DERIVATION); }
  if (secret.every(byte => byte === 0)) throw new DeriveFailure(DERIVATION);
  return secret;
}
/** OpenSSL's EVP_PKEY_derive for two keys, with Node's padding of a finite-field secret to the prime's length. */
function derive(privateKey: PrivateMaterial, publicKey: PublicMaterial): Uint8Array {
  switch (privateKey.kind) {
    case "ec": if (publicKey.kind === "ec") return deriveEc(privateKey, publicKey); break;
    case "dh": if (publicKey.kind === "dh") return deriveDh(privateKey, publicKey); break;
    case "x25519": if (publicKey.kind === "x25519") return deriveMontgomery(x25519, privateKey.privateKey, publicKey.publicKey); break;
    case "x448": if (publicKey.kind === "x448") return deriveMontgomery(x448, privateKey.privateKey, publicKey.publicKey); break;
    case "rsa": case "rsa-pss": case "ed25519": case "ed448": break;
  }
  throw new DeriveFailure(NOT_SUPPORTED);
}

const ENABLED: ReadonlySet<string> = new Set(["dh", "ec", "x448", "x25519"]);

/** `crypto.diffieHellman` of one process. */
export function createStatelessDiffieHellman(ports: CryptoPorts, keys: ReturnType<typeof createCryptoKeys>) {
  return named((options?: unknown, callback?: unknown): Buffer | undefined => {
    validateObject(options, "options");
    if (callback !== undefined) validateFunction(callback, "callback");
    const privateKey = member(options, "privateKey"), publicKey = member(options, "publicKey");
    if (privateKey === undefined) throw invalidValue("options.privateKey", privateKey);
    if (publicKey === undefined) throw invalidValue("options.publicKey", publicKey);
    // Two key objects of different or unsuitable types are refused by name before anything is read.
    const direct = keys.materialOf(privateKey), peer = keys.materialOf(publicKey);
    if (direct?.type === "private" && peer !== undefined) {
      const privateType = direct.material.kind, publicType = peer.material.kind;
      if (privateType !== publicType || !ENABLED.has(privateType)) throw codedError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY", `Incompatible key types for Diffie-Hellman: ${privateType} and ${publicType}`);
    }
    const theirs = keys.keyFromInput(publicKey, "public", "options.publicKey").material;
    const ours = keys.keyFromInput(privateKey, "private", "options.privateKey").material;
    const work = (plain: boolean): Buffer => {
      if (!isPrivateMaterial(ours)) throw keys.missingPrivateKey(ours);
      try { return Buffer.from(derive(ours, theirs)); }
      catch (error) { throw error instanceof DeriveFailure ? thrown(error, plain) : error; }
    };
    if (callback === undefined) return work(false);
    const job = jobReceiver("DHBitsJob");
    later(ports, () => work(true), (error, secret) => {
      // Node passes a failure alone and a result after null.
      if (secret === undefined) Reflect.apply(callback, job, [error]);
      else Reflect.apply(callback, job, [null, secret]);
    });
    return undefined;
  }, "diffieHellman");
}
