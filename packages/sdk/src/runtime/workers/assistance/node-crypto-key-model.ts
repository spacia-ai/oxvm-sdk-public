/**
 * The key material `node:crypto`'s key objects hold, as plain values: what the ciphers, signatures, RSA and
 * Diffie-Hellman modules compute with. Encodings live in `node-crypto-key-codec.ts`.
 */
import { p256, p384, p521 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { ed448, x448 } from "@noble/curves/ed448.js";
import { equalBytes } from "@noble/curves/utils.js";
import { unsignedFromBytes, unsignedToBytes } from "./node-crypto-asn1.ts";

export type AsymmetricKeyType = "rsa" | "rsa-pss" | "ec" | "ed25519" | "ed448" | "x25519" | "x448" | "dh" | "dsa";
export type NamedCurve = "prime256v1" | "secp384r1" | "secp521r1" | "secp256k1";
export type OkpKind = "ed25519" | "ed448" | "x25519" | "x448";

export interface RsaPssParameters { readonly hashAlgorithm: string; readonly mgf1HashAlgorithm: string; readonly saltLength: number }
export interface RsaPublic { readonly kind: "rsa" | "rsa-pss"; readonly n: bigint; readonly e: bigint; readonly pss?: RsaPssParameters }
export interface RsaPrivate extends RsaPublic { readonly d: bigint; readonly p: bigint; readonly q: bigint; readonly dp: bigint; readonly dq: bigint; readonly qi: bigint }
export interface EcPublic {
  readonly kind: "ec"; readonly namedCurve: NamedCurve;
  /** Uncompressed: 04 || X || Y. */
  readonly point: Uint8Array;
  /** The key was read with a compressed point; OpenSSL keeps that form when it writes the key again. */
  readonly compressed?: boolean;
}
export interface EcPrivate extends EcPublic {
  /** Big-endian, as long as the curve's field. */
  readonly d: Uint8Array;
  /** The key was read from an ECPrivateKey without its public key; OpenSSL then writes it without one. */
  readonly omitPublic?: boolean;
}
export interface OkpPublic { readonly kind: OkpKind; readonly publicKey: Uint8Array }
/** `privateKey` is the seed or scalar bytes as PKCS#8 holds them. */
export interface OkpPrivate extends OkpPublic { readonly privateKey: Uint8Array }
export interface DhPublic { readonly kind: "dh"; readonly p: bigint; readonly g: bigint; readonly y: bigint }
export interface DhPrivate extends DhPublic { readonly x: bigint }
export type PublicMaterial = RsaPublic | EcPublic | OkpPublic | DhPublic;
export type PrivateMaterial = RsaPrivate | EcPrivate | OkpPrivate | DhPrivate;
export type KeyMaterial = PublicMaterial | PrivateMaterial;

/** Why material could not be built or encoded; the caller words the failure as Node does. */
export type KeyFailure = "invalid-point" | "invalid-private-key" | "invalid-length" | "unsupported-type" | "unsupported-algorithm" | "invalid-structure";
export class KeyCodecError extends Error {
  readonly failure: KeyFailure;
  constructor(failure: KeyFailure, detail: string) { super(detail); this.name = "KeyCodecError"; this.failure = failure; }
}

interface CurveInfo { readonly oid: string; readonly size: number; readonly jwk: string; readonly curve: typeof p256 }
export const CURVES: Readonly<Record<NamedCurve, CurveInfo>> = Object.freeze({
  prime256v1: { oid: "1.2.840.10045.3.1.7", size: 32, jwk: "P-256", curve: p256 },
  secp384r1: { oid: "1.3.132.0.34", size: 48, jwk: "P-384", curve: p384 },
  secp521r1: { oid: "1.3.132.0.35", size: 66, jwk: "P-521", curve: p521 },
  secp256k1: { oid: "1.3.132.0.10", size: 32, jwk: "secp256k1", curve: secp256k1 },
});
/** A curve by its OpenSSL name or its JWK / NIST name (`P-256`). */
export function curveByName(name: string): NamedCurve | undefined {
  for (const curve of ["prime256v1", "secp384r1", "secp521r1", "secp256k1"] as const) if (curve === name || CURVES[curve].jwk === name) return curve;
  return undefined;
}
export function curveByOid(oid: string): NamedCurve | undefined {
  for (const name of ["prime256v1", "secp384r1", "secp521r1", "secp256k1"] as const) if (CURVES[name].oid === oid) return name;
  return undefined;
}

interface OkpInfo { readonly oid: string; readonly size: number; readonly jwk: string; readonly getPublicKey: (secret: Uint8Array) => Uint8Array }
export const OKP: Readonly<Record<OkpKind, OkpInfo>> = Object.freeze({
  ed25519: { oid: "1.3.101.112", size: 32, jwk: "Ed25519", getPublicKey: (secret: Uint8Array) => ed25519.getPublicKey(secret) },
  ed448: { oid: "1.3.101.113", size: 57, jwk: "Ed448", getPublicKey: (secret: Uint8Array) => ed448.getPublicKey(secret) },
  x25519: { oid: "1.3.101.110", size: 32, jwk: "X25519", getPublicKey: (secret: Uint8Array) => x25519.getPublicKey(secret) },
  x448: { oid: "1.3.101.111", size: 56, jwk: "X448", getPublicKey: (secret: Uint8Array) => x448.getPublicKey(secret) },
});
export const OKP_KINDS: readonly OkpKind[] = Object.freeze(["ed25519", "ed448", "x25519", "x448"] as const);
export function okpByOid(oid: string): OkpKind | undefined { return OKP_KINDS.find(kind => OKP[kind].oid === oid); }

/** A point as OpenSSL reads it (compressed, uncompressed or hybrid), checked to be on the curve. */
export function ecPoint(namedCurve: NamedCurve, encoded: Uint8Array): { readonly point: Uint8Array; readonly compressed: boolean } {
  const { size, curve } = CURVES[namedCurve];
  const form = encoded[0];
  let bytes = encoded;
  if ((form === 6 || form === 7) && encoded.length === 1 + 2 * size) {
    // Hybrid: uncompressed with the parity of Y in the first byte.
    if (((encoded[encoded.length - 1] ?? 0) & 1) !== (form & 1)) throw new KeyCodecError("invalid-point", "Invalid EC point");
    bytes = Uint8Array.from(encoded);
    bytes[0] = 4;
  }
  try { return { point: curve.Point.fromBytes(bytes).toBytes(false), compressed: form === 2 || form === 3 }; }
  catch { throw new KeyCodecError("invalid-point", "Invalid EC point"); }
}
/** A point in the form the key was read in. */
export function ecEncodedPoint(key: EcPublic): Uint8Array {
  if (key.compressed !== true) return key.point;
  const { size } = CURVES[key.namedCurve];
  const compressed = new Uint8Array(1 + size);
  compressed[0] = 2 + ((key.point[key.point.length - 1] ?? 0) & 1);
  compressed.set(key.point.subarray(1, 1 + size), 1);
  return compressed;
}
/** A private scalar as long as the curve's field, from an encoding that may carry or lack leading zeros. */
export function ecScalar(namedCurve: NamedCurve, bytes: Uint8Array): Uint8Array {
  const { size } = CURVES[namedCurve];
  try { return unsignedToBytes(unsignedFromBytes(bytes), size); }
  catch { throw new KeyCodecError("invalid-private-key", "Invalid EC private key"); }
}
/** The public point of a private scalar. */
export function ecPublicPoint(namedCurve: NamedCurve, d: Uint8Array): Uint8Array {
  try { return CURVES[namedCurve].curve.getPublicKey(d, false); }
  catch { throw new KeyCodecError("invalid-private-key", "Invalid EC private key"); }
}

/** `base ** exponent mod modulus`. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n || exponent < 0n) throw new RangeError("Invalid modular exponentiation");
  if (modulus === 1n) return 0n;
  let result = 1n, square = ((base % modulus) + modulus) % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
  }
  return result;
}

export function isPrivateMaterial(material: KeyMaterial): material is PrivateMaterial {
  switch (material.kind) {
    case "rsa": case "rsa-pss": return "d" in material;
    case "ec": return "d" in material;
    case "dh": return "x" in material;
    case "ed25519": case "ed448": case "x25519": case "x448": return "privateKey" in material;
  }
}

/** The public half of a private key. */
export function publicOf(material: PrivateMaterial): PublicMaterial {
  switch (material.kind) {
    case "rsa": case "rsa-pss":
      return { kind: material.kind, n: material.n, e: material.e, ...(material.pss === undefined ? {} : { pss: material.pss }) };
    case "ec":
      return { kind: "ec", namedCurve: material.namedCurve, point: material.point, ...(material.compressed === true ? { compressed: true } : {}) };
    case "dh":
      return { kind: "dh", p: material.p, g: material.g, y: modPow(material.g, material.x, material.p) };
    case "ed25519": case "ed448": case "x25519": case "x448":
      return { kind: material.kind, publicKey: OKP[material.kind].getPublicKey(material.privateKey) };
  }
}

/** Whether two keys are the same key, as OpenSSL compares them: by type and public components. */
export function sameKey(left: KeyMaterial, right: KeyMaterial): boolean {
  switch (left.kind) {
    case "rsa": case "rsa-pss": return right.kind === left.kind && left.n === right.n && left.e === right.e;
    case "ec": return right.kind === "ec" && left.namedCurve === right.namedCurve && equalBytes(left.point, right.point);
    case "dh": return right.kind === "dh" && left.p === right.p && left.g === right.g && left.y === right.y;
    case "ed25519": case "ed448": case "x25519": case "x448": return right.kind === left.kind && equalBytes(left.publicKey, right.publicKey);
  }
}
