// ECDSA and EdDSA for the fast-path `node:crypto`, on @noble/curves. OpenSSL draws a random nonce for every
// ECDSA signature; these are RFC 6979 deterministic, which every verifier accepts alike. As in OpenSSL the
// digest is cut to the bit length of the curve order and a signature with a high `s` is made and accepted.
import { ed25519, ed25519ctx } from "@noble/curves/ed25519.js";
import { ed448 } from "@noble/curves/ed448.js";
import { CURVES, type EcPrivate, type EcPublic } from "./node-crypto-key-model.ts";

export type DsaEncoding = "der" | "ieee-p1363";

/** The length of an `ieee-p1363` signature: `r` and `s`, each as long as the curve order. */
export function ecdsaSignatureLength(key: EcPublic): number { return 2 * CURVES[key.namedCurve].size; }

export function ecdsaSign(key: EcPrivate, digest: Uint8Array, encoding: DsaEncoding): Uint8Array {
  return CURVES[key.namedCurve].curve.sign(digest, key.d, { prehash: false, lowS: false, format: encoding === "der" ? "der" : "compact" });
}

/** A signature that is not strict DER, has a wrong length or carries a value out of range verifies as false. */
export function ecdsaVerify(key: EcPublic, digest: Uint8Array, signature: Uint8Array, encoding: DsaEncoding): boolean {
  try { return CURVES[key.namedCurve].curve.verify(signature, digest, key.point, { prehash: false, lowS: false, format: encoding === "der" ? "der" : "compact" }); }
  catch { return false; }
}

export type EdKind = "ed25519" | "ed448";
/** Ed25519 with a context is Ed25519ctx; an empty context is plain Ed25519. Ed448 always has one, empty by default. */
export function eddsaSign(kind: EdKind, secret: Uint8Array, message: Uint8Array, context: Uint8Array | undefined): Uint8Array {
  if (kind === "ed448") return ed448.sign(message, secret, context === undefined ? {} : { context });
  return context === undefined || context.length === 0 ? ed25519.sign(message, secret) : ed25519ctx.sign(message, secret, { context });
}

/** As OpenSSL verifies: RFC 8032's strict rules, not ZIP 215. A signature of the wrong length is false. */
export function eddsaVerify(kind: EdKind, publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array, context: Uint8Array | undefined): boolean {
  try {
    if (kind === "ed448") return ed448.verify(signature, message, publicKey, { zip215: false, ...(context === undefined ? {} : { context }) });
    if (context === undefined || context.length === 0) return ed25519.verify(signature, message, publicKey, { zip215: false });
    return ed25519ctx.verify(signature, message, publicKey, { zip215: false, context });
  } catch { return false; }
}
