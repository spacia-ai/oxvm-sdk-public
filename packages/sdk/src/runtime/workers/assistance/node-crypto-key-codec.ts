/**
 * Conversions between key material and the encodings `node:crypto` reads and writes: SubjectPublicKeyInfo,
 * PKCS#8, PKCS#1 and SEC1 in DER, and JWK. The DER written here is byte for byte what OpenSSL 3.5 writes for
 * the same key (recorded from Node.js v24.18.1 in `node-crypto-keys.controls.json`).
 */
import {
  DerReader, TAG, contextTag, derBitString, derExplicit, derInteger, derNull, derOctetString, derOid, derSequence, readDer,
} from "./node-crypto-asn1.ts";
import {
  CURVES, KeyCodecError, OKP, curveByOid, ecEncodedPoint, ecPoint, ecPublicPoint, ecScalar, modPow, okpByOid,
  type EcPrivate, type NamedCurve, type OkpKind, type PrivateMaterial, type PublicMaterial, type RsaPrivate, type RsaPssParameters, type RsaPublic,
} from "./node-crypto-key-model.ts";

export * from "./node-crypto-key-model.ts";
export { fromJwk, toJwk } from "./node-crypto-key-jwk.ts";

const OID = Object.freeze({
  rsa: "1.2.840.113549.1.1.1", rsaPss: "1.2.840.113549.1.1.10", mgf1: "1.2.840.113549.1.1.8",
  ec: "1.2.840.10045.2.1", dh: "1.2.840.113549.1.3.1", dsa: "1.2.840.10040.4.1",
});
/** Digest names as Node reports them in `asymmetricKeyDetails`, by object identifier. */
const DIGESTS: readonly (readonly [string, string])[] = Object.freeze([
  ["sha1", "1.3.14.3.2.26"], ["sha224", "2.16.840.1.101.3.4.2.4"], ["sha256", "2.16.840.1.101.3.4.2.1"],
  ["sha384", "2.16.840.1.101.3.4.2.2"], ["sha512", "2.16.840.1.101.3.4.2.3"], ["sha512-224", "2.16.840.1.101.3.4.2.5"],
  ["sha512-256", "2.16.840.1.101.3.4.2.6"], ["sha3-224", "2.16.840.1.101.3.4.2.7"], ["sha3-256", "2.16.840.1.101.3.4.2.8"],
  ["sha3-384", "2.16.840.1.101.3.4.2.9"], ["sha3-512", "2.16.840.1.101.3.4.2.10"],
] as const);
function digestOid(name: string): string {
  const found = DIGESTS.find(([digest]) => digest === name);
  if (found === undefined) throw new KeyCodecError("unsupported-algorithm", `Unsupported digest ${name}`);
  return found[1];
}
function digestName(oid: string): string {
  const found = DIGESTS.find(([, value]) => value === oid);
  if (found === undefined) throw new KeyCodecError("unsupported-algorithm", `Unsupported digest ${oid}`);
  return found[0];
}

/** AlgorithmIdentifier of a digest: OpenSSL writes the NULL parameters; both forms are read. */
function digestIdentifier(name: string): Uint8Array { return derSequence(derOid(digestOid(name)), derNull()); }
function readDigestIdentifier(reader: DerReader): string {
  const identifier = reader.sequence();
  const name = digestName(identifier.oid());
  if (!identifier.atEnd) identifier.null();
  identifier.end();
  return name;
}

/** RSASSA-PSS-params; fields at their DEFAULT (SHA-1, MGF1 with SHA-1, 20) are left out, as DER requires. */
function encodePssParameters(pss: RsaPssParameters): Uint8Array {
  const fields: Uint8Array[] = [];
  if (pss.hashAlgorithm !== "sha1") fields.push(derExplicit(0, digestIdentifier(pss.hashAlgorithm)));
  if (pss.mgf1HashAlgorithm !== "sha1") fields.push(derExplicit(1, derSequence(derOid(OID.mgf1), digestIdentifier(pss.mgf1HashAlgorithm))));
  if (pss.saltLength !== 20) fields.push(derExplicit(2, derInteger(BigInt(pss.saltLength))));
  return derSequence(...fields);
}
function readPssParameters(reader: DerReader): RsaPssParameters {
  let hashAlgorithm = "sha1", mgf1HashAlgorithm = "sha1", saltLength = 20;
  const hash = reader.optionalExplicit(0);
  if (hash !== undefined) { hashAlgorithm = readDigestIdentifier(hash); hash.end(); }
  const mask = reader.optionalExplicit(1);
  if (mask !== undefined) {
    const generator = mask.sequence();
    if (generator.oid() !== OID.mgf1) throw new KeyCodecError("unsupported-algorithm", "Unsupported mask generation function");
    mgf1HashAlgorithm = readDigestIdentifier(generator);
    generator.end(); mask.end();
  }
  const salt = reader.optionalExplicit(2);
  if (salt !== undefined) { saltLength = salt.smallInteger(); salt.end(); }
  const trailer = reader.optionalExplicit(3);
  if (trailer !== undefined) { if (trailer.smallInteger() !== 1) throw new KeyCodecError("unsupported-algorithm", "Unsupported PSS trailer field"); trailer.end(); }
  reader.end();
  return { hashAlgorithm, mgf1HashAlgorithm, saltLength };
}

type Algorithm =
  | { readonly kind: "rsa" } | { readonly kind: "rsa-pss"; readonly pss?: RsaPssParameters }
  | { readonly kind: "ec"; readonly namedCurve: NamedCurve } | { readonly kind: OkpKind }
  | { readonly kind: "dh"; readonly p: bigint; readonly g: bigint };

function readAlgorithm(reader: DerReader): Algorithm {
  const identifier = reader.sequence();
  const oid = identifier.oid();
  if (oid === OID.rsa) {
    if (!identifier.atEnd) identifier.null();
    identifier.end();
    return { kind: "rsa" };
  }
  if (oid === OID.rsaPss) {
    const parameters = identifier.optionalEnter(TAG.sequence);
    identifier.end();
    return parameters === undefined ? { kind: "rsa-pss" } : { kind: "rsa-pss", pss: readPssParameters(parameters) };
  }
  if (oid === OID.ec) {
    if (identifier.peekTag() !== TAG.oid) throw new KeyCodecError("unsupported-algorithm", "EC keys with explicit curve parameters are not supported");
    const curveOid = identifier.oid();
    identifier.end();
    const namedCurve = curveByOid(curveOid);
    if (namedCurve === undefined) throw new KeyCodecError("unsupported-algorithm", `Unsupported EC curve ${curveOid}`);
    return { kind: "ec", namedCurve };
  }
  if (oid === OID.dh) {
    const parameters = identifier.sequence();
    const p = parameters.integer(), g = parameters.integer();
    if (!parameters.atEnd) parameters.integer();
    parameters.end(); identifier.end();
    if (p <= 2n || g <= 1n) throw new KeyCodecError("invalid-structure", "Invalid DH parameters");
    return { kind: "dh", p, g };
  }
  const okp = okpByOid(oid);
  if (okp !== undefined) { identifier.end(); return { kind: okp }; }
  throw new KeyCodecError("unsupported-algorithm", oid === OID.dsa ? "DSA keys are not supported" : `Unsupported key algorithm ${oid}`);
}

function algorithmIdentifier(material: PublicMaterial): Uint8Array {
  switch (material.kind) {
    case "rsa": return derSequence(derOid(OID.rsa), derNull());
    case "rsa-pss": return derSequence(derOid(OID.rsaPss), ...(material.pss === undefined ? [] : [encodePssParameters(material.pss)]));
    case "ec": return derSequence(derOid(OID.ec), derOid(CURVES[material.namedCurve].oid));
    case "dh": return derSequence(derOid(OID.dh), derSequence(derInteger(material.p), derInteger(material.g)));
    case "ed25519": case "ed448": case "x25519": case "x448": return derSequence(derOid(OKP[material.kind].oid));
  }
}

function positive(value: bigint): bigint {
  if (value < 0n) throw new KeyCodecError("invalid-structure", "Negative key component");
  return value;
}
function readRsaPublicKey(bytes: Uint8Array): { readonly n: bigint; readonly e: bigint } {
  const key = readDer(bytes);
  const n = positive(key.integer()), e = positive(key.integer());
  key.end();
  return { n, e };
}
function readRsaPrivateKey(reader: DerReader, algorithm: { readonly kind: "rsa" } | { readonly kind: "rsa-pss"; readonly pss?: RsaPssParameters }): RsaPrivate {
  const version = reader.integer();
  if (version === 1n && reader.peekTag() === TAG.integer) throw new KeyCodecError("unsupported-algorithm", "Multi-prime RSA keys are not supported");
  if (version !== 0n) throw new KeyCodecError("invalid-structure", "Invalid RSA private key version");
  const [n, e, d, p, q, dp, dq, qi] = [reader.integer(), reader.integer(), reader.integer(), reader.integer(), reader.integer(), reader.integer(), reader.integer(), reader.integer()].map(positive);
  reader.end();
  if (n === undefined || e === undefined || d === undefined || p === undefined || q === undefined || dp === undefined || dq === undefined || qi === undefined) throw new KeyCodecError("invalid-structure", "Invalid RSA private key");
  return { kind: algorithm.kind, n, e, d, p, q, dp, dq, qi, ...(algorithm.kind === "rsa-pss" && algorithm.pss !== undefined ? { pss: algorithm.pss } : {}) };
}
function encodeRsaPrivateKey(key: RsaPrivate): Uint8Array {
  return derSequence(derInteger(0n), ...[key.n, key.e, key.d, key.p, key.q, key.dp, key.dq, key.qi].map(derInteger));
}

/** ECPrivateKey (SEC1). The curve comes from the enclosing PKCS#8 structure or from the key's own parameters. */
function readEcPrivateKey(reader: DerReader, outer: NamedCurve | undefined): EcPrivate {
  if (reader.integer() !== 1n) throw new KeyCodecError("invalid-structure", "Invalid EC private key version");
  const scalar = reader.octetString();
  const parameters = reader.optionalExplicit(0);
  let namedCurve = outer;
  if (parameters !== undefined) {
    if (parameters.peekTag() !== TAG.oid) throw new KeyCodecError("unsupported-algorithm", "EC keys with explicit curve parameters are not supported");
    const oid = parameters.oid();
    parameters.end();
    const own = curveByOid(oid);
    if (own === undefined) throw new KeyCodecError("unsupported-algorithm", `Unsupported EC curve ${oid}`);
    namedCurve ??= own;
  }
  const embedded = reader.optionalExplicit(1);
  let encoded: Uint8Array | undefined;
  if (embedded !== undefined) { encoded = embedded.bitString(); embedded.end(); }
  reader.end();
  if (namedCurve === undefined) throw new KeyCodecError("invalid-structure", "EC private key without curve parameters");
  const d = ecScalar(namedCurve, scalar);
  if (encoded === undefined) return { kind: "ec", namedCurve, point: ecPublicPoint(namedCurve, d), d, omitPublic: true };
  const { point, compressed } = ecPoint(namedCurve, encoded);
  return { kind: "ec", namedCurve, point, d, ...(compressed ? { compressed } : {}) };
}
function encodeEcPrivateKey(key: EcPrivate, withParameters: boolean): Uint8Array {
  return derSequence(derInteger(1n), derOctetString(key.d),
    ...(withParameters ? [derExplicit(0, derOid(CURVES[key.namedCurve].oid))] : []),
    ...(key.omitPublic === true ? [] : [derExplicit(1, derBitString(ecEncodedPoint(key)))]));
}

function okpBytes(kind: OkpKind, bytes: Uint8Array): Uint8Array {
  if (bytes.length !== OKP[kind].size) throw new KeyCodecError("invalid-length", `Invalid ${kind} key length`);
  return bytes;
}

/** Reads a public key from DER: SubjectPublicKeyInfo, or PKCS#1 RSAPublicKey. */
export function parsePublic(bytes: Uint8Array, type: "spki" | "pkcs1"): PublicMaterial {
  if (type === "pkcs1") return { kind: "rsa", ...readRsaPublicKey(bytes) };
  const info = readDer(bytes);
  const algorithm = readAlgorithm(info);
  const key = info.bitString();
  info.end();
  switch (algorithm.kind) {
    case "rsa": return { kind: "rsa", ...readRsaPublicKey(key) };
    case "rsa-pss": return { kind: "rsa-pss", ...readRsaPublicKey(key), ...(algorithm.pss === undefined ? {} : { pss: algorithm.pss }) };
    case "ec": {
      const { point, compressed } = ecPoint(algorithm.namedCurve, key);
      return { kind: "ec", namedCurve: algorithm.namedCurve, point, ...(compressed ? { compressed } : {}) };
    }
    case "dh": {
      const reader = new DerReader(key);
      const y = positive(reader.integer());
      reader.end();
      return { kind: "dh", p: algorithm.p, g: algorithm.g, y };
    }
    case "ed25519": case "ed448": case "x25519": case "x448": return { kind: algorithm.kind, publicKey: okpBytes(algorithm.kind, key) };
  }
}

/** Which private key structure DER bytes hold, by the element after the leading version INTEGER. */
function privateStructure(bytes: Uint8Array): "pkcs8" | "pkcs1" | "sec1" | undefined {
  try {
    const reader = readDer(bytes);
    reader.integerBytes();
    const next = reader.peekTag();
    return next === TAG.sequence ? "pkcs8" : next === TAG.integer ? "pkcs1" : next === TAG.octetString ? "sec1" : undefined;
  } catch { return undefined; }
}

function parsePkcs8(bytes: Uint8Array): PrivateMaterial {
  const info = readDer(bytes);
  const version = info.integer();
  const algorithm = readAlgorithm(info);
  const key = info.octetString();
  if (version !== 0n && version !== 1n) throw new KeyCodecError("invalid-structure", "Unsupported PKCS#8 version");
  info.optional(contextTag(0));
  info.optional(contextTag(1, false));
  info.end();
  switch (algorithm.kind) {
    case "rsa": case "rsa-pss": return readRsaPrivateKey(readDer(key), algorithm);
    case "ec": return readEcPrivateKey(readDer(key), algorithm.namedCurve);
    case "dh": {
      const reader = new DerReader(key);
      const x = positive(reader.integer());
      reader.end();
      return { kind: "dh", p: algorithm.p, g: algorithm.g, x, y: modPow(algorithm.g, x, algorithm.p) };
    }
    case "ed25519": case "ed448": case "x25519": case "x448": {
      const reader = new DerReader(key);
      const privateKey = Uint8Array.from(okpBytes(algorithm.kind, reader.octetString()));
      reader.end();
      return { kind: algorithm.kind, privateKey, publicKey: OKP[algorithm.kind].getPublicKey(privateKey) };
    }
  }
}

/**
 * Reads a private key from DER. `pkcs8` is read strictly as PrivateKeyInfo; for `pkcs1` and `sec1` OpenSSL's
 * decoder accepts any of the three structures, so the structure found decides.
 */
export function parsePrivate(bytes: Uint8Array, type: "pkcs8" | "pkcs1" | "sec1"): PrivateMaterial {
  const structure = type === "pkcs8" ? "pkcs8" : privateStructure(bytes) ?? type;
  switch (structure) {
    case "pkcs8": return parsePkcs8(bytes);
    case "pkcs1": return readRsaPrivateKey(readDer(bytes), { kind: "rsa" });
    case "sec1": return readEcPrivateKey(readDer(bytes), undefined);
  }
}

function rsaPublicKey(key: RsaPublic): Uint8Array { return derSequence(derInteger(key.n), derInteger(key.e)); }

/** Writes a public key as SubjectPublicKeyInfo, or (RSA only) PKCS#1 RSAPublicKey. */
export function encodePublic(material: PublicMaterial, type: "spki" | "pkcs1"): Uint8Array {
  if (type === "pkcs1") {
    if (material.kind !== "rsa") throw new KeyCodecError("unsupported-type", "PKCS#1 holds RSA keys only");
    return rsaPublicKey(material);
  }
  return derSequence(algorithmIdentifier(material), derBitString(publicKeyBytes(material)));
}
function publicKeyBytes(material: PublicMaterial): Uint8Array {
  switch (material.kind) {
    case "rsa": case "rsa-pss": return rsaPublicKey(material);
    case "ec": return ecEncodedPoint(material);
    case "dh": return derInteger(material.y);
    case "ed25519": case "ed448": case "x25519": case "x448": return material.publicKey;
  }
}

/** Writes a private key as PKCS#8 PrivateKeyInfo, PKCS#1 RSAPrivateKey (RSA only) or SEC1 ECPrivateKey (EC only). */
export function encodePrivate(material: PrivateMaterial, type: "pkcs8" | "pkcs1" | "sec1"): Uint8Array {
  if (type === "pkcs1") {
    if (material.kind !== "rsa") throw new KeyCodecError("unsupported-type", "PKCS#1 holds RSA keys only");
    return encodeRsaPrivateKey(material);
  }
  if (type === "sec1") {
    if (material.kind !== "ec") throw new KeyCodecError("unsupported-type", "SEC1 holds EC keys only");
    return encodeEcPrivateKey(material, true);
  }
  return derSequence(derInteger(0n), algorithmIdentifier(material), derOctetString(privateKeyBytes(material)));
}
function privateKeyBytes(material: PrivateMaterial): Uint8Array {
  switch (material.kind) {
    case "rsa": case "rsa-pss": return encodeRsaPrivateKey(material);
    case "ec": return encodeEcPrivateKey(material, false);
    case "dh": return derInteger(material.x);
    case "ed25519": case "ed448": case "x25519": case "x448": return derOctetString(material.privateKey);
  }
}

/** The SubjectPublicKeyInfo of an X.509 certificate (DER), as its own DER value. */
export function certificatePublicKeyInfo(certificate: Uint8Array): Uint8Array {
  const body = readDer(certificate).sequence();
  body.optional(contextTag(0));
  body.integerBytes();
  for (let skipped = 0; skipped < 4; skipped += 1) body.read(TAG.sequence);
  return body.read(TAG.sequence).raw;
}
