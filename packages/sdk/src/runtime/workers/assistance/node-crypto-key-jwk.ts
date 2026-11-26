/**
 * JSON Web Keys as `node:crypto` imports and exports them (`format: 'jwk'`): RSA, EC and OKP keys. Member
 * order, messages and the order of checks were recorded from Node.js v24.18.1.
 */
import { unsignedFromBytes, unsignedToBytes } from "./node-crypto-asn1.ts";
import { invalidCurve, invalidJwk, unsupportedJwkKeyType } from "./node-crypto-key-errors.ts";
import {
  CURVES, KeyCodecError, OKP, OKP_KINDS, curveByName, ecPoint, ecScalar, isPrivateMaterial,
  type KeyMaterial, type OkpKind, type PrivateMaterial, type PublicMaterial,
} from "./node-crypto-key-model.ts";
import { base64Decode, base64Encode } from "./node-crypto-pem.ts";

const url = (bytes: Uint8Array): string => base64Encode(bytes, true);
const number = (value: bigint): string => url(unsignedToBytes(value));

/** The JWK of a key: its public members, and the private ones when `isPrivate` and the material has them. */
export function toJwk(material: KeyMaterial, isPrivate: boolean): Record<string, string> {
  const secret = isPrivate && isPrivateMaterial(material) ? material : undefined;
  switch (material.kind) {
    case "rsa": {
      const jwk: Record<string, string> = { kty: "RSA", n: number(material.n), e: number(material.e) };
      if (secret?.kind === "rsa") Object.assign(jwk, { d: number(secret.d), p: number(secret.p), q: number(secret.q), dp: number(secret.dp), dq: number(secret.dq), qi: number(secret.qi) });
      return jwk;
    }
    case "ec": {
      const { size, jwk: crv } = CURVES[material.namedCurve];
      const jwk: Record<string, string> = { kty: "EC", x: url(material.point.subarray(1, 1 + size)), y: url(material.point.subarray(1 + size)), crv };
      if (secret?.kind === "ec") jwk["d"] = url(secret.d);
      return jwk;
    }
    case "ed25519": case "ed448": case "x25519": case "x448": {
      const jwk: Record<string, string> = { crv: OKP[material.kind].jwk };
      if (secret !== undefined && "privateKey" in secret) jwk["d"] = url(secret.privateKey);
      jwk["x"] = url(material.publicKey);
      jwk["kty"] = "OKP";
      return jwk;
    }
    case "rsa-pss": case "dh": throw unsupportedJwkKeyType();
  }
}

function member(jwk: object, name: string): unknown { return Reflect.get(jwk, name); }
function decode(value: string): Uint8Array { return base64Decode(value) ?? new Uint8Array(); }

function rsaFromJwk(jwk: object): { readonly material: KeyMaterial; readonly isPrivate: boolean } {
  const invalid = (): Error => invalidJwk("Invalid JWK RSA key");
  const n = member(jwk, "n"), e = member(jwk, "e"), d = member(jwk, "d");
  if (typeof n !== "string" || typeof e !== "string" || (d !== undefined && typeof d !== "string")) throw invalid();
  const publicKey = { kind: "rsa" as const, n: unsignedFromBytes(decode(n)), e: unsignedFromBytes(decode(e)) };
  if (d === undefined) return { material: publicKey, isPrivate: false };
  const [p, q, dp, dq, qi] = ["p", "q", "dp", "dq", "qi"].map(name => {
    const value = member(jwk, name);
    if (typeof value !== "string") throw invalid();
    return unsignedFromBytes(decode(value));
  });
  if (p === undefined || q === undefined || dp === undefined || dq === undefined || qi === undefined) throw invalid();
  return { material: { ...publicKey, d: unsignedFromBytes(decode(d)), p, q, dp, dq, qi }, isPrivate: true };
}

function ecFromJwk(jwk: object): { readonly material: KeyMaterial; readonly isPrivate: boolean } {
  const invalid = (): Error => invalidJwk("Invalid JWK EC key");
  const crv = member(jwk, "crv"), x = member(jwk, "x"), y = member(jwk, "y"), d = member(jwk, "d");
  if (typeof crv !== "string" || typeof x !== "string" || typeof y !== "string" || (d !== undefined && typeof d !== "string")) throw invalid();
  const namedCurve = curveByName(crv);
  if (namedCurve === undefined) throw invalidCurve();
  const { size } = CURVES[namedCurve];
  try {
    const encoded = new Uint8Array(1 + 2 * size);
    encoded[0] = 4;
    encoded.set(unsignedToBytes(unsignedFromBytes(decode(x)), size), 1);
    encoded.set(unsignedToBytes(unsignedFromBytes(decode(y)), size), 1 + size);
    const publicKey = { kind: "ec" as const, namedCurve, point: ecPoint(namedCurve, encoded).point };
    if (d === undefined) return { material: publicKey, isPrivate: false };
    // Node keeps the point the JWK states; it does not check it against `d`.
    return { material: { ...publicKey, d: ecScalar(namedCurve, decode(d)) }, isPrivate: true };
  } catch (error) {
    if (error instanceof KeyCodecError || error instanceof RangeError) throw invalid();
    throw error;
  }
}

function okpFromJwk(jwk: object): { readonly material: KeyMaterial; readonly isPrivate: boolean } {
  const invalid = (): Error => invalidJwk("Invalid JWK OKP key");
  const crv = member(jwk, "crv"), x = member(jwk, "x"), d = member(jwk, "d");
  if (typeof crv !== "string" || typeof x !== "string" || (d !== undefined && typeof d !== "string")) throw invalid();
  const kind: OkpKind | undefined = OKP_KINDS.find(candidate => OKP[candidate].jwk === crv);
  if (kind === undefined) throw invalid();
  const { size, getPublicKey } = OKP[kind];
  if (d === undefined) {
    const publicKey = decode(x);
    if (publicKey.length !== size) throw invalid();
    return { material: { kind, publicKey }, isPrivate: false };
  }
  // A private OKP JWK is its `d`; Node derives the public key and ignores the `x` it states.
  const privateKey = decode(d);
  if (privateKey.length !== size) throw invalid();
  return { material: { kind, privateKey, publicKey: getPublicKey(privateKey) }, isPrivate: true };
}

/** Reads a JWK. It is private when it carries `d`; a caller that needs a private key checks `isPrivate`. */
export function fromJwk(jwk: unknown): { readonly material: PublicMaterial | PrivateMaterial; readonly isPrivate: boolean } {
  if (typeof jwk !== "object" || jwk === null) throw invalidJwk("Invalid JWK format");
  const kty = member(jwk, "kty");
  if (typeof kty !== "string") throw invalidJwk("Invalid JWK format");
  switch (kty) {
    case "RSA": return rsaFromJwk(jwk);
    case "EC": return ecFromJwk(jwk);
    case "OKP": return okpFromJwk(jwk);
    default: throw invalidJwk(`${kty} is not a supported JWK key type`);
  }
}
