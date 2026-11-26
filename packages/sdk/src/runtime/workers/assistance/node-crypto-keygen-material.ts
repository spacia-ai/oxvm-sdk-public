/**
 * The keys `crypto.generateKeyPair` makes, as key material: RSA, EC, Edwards and Montgomery, Diffie-Hellman.
 * The slow ones are generators (see node-crypto-keygen-job.ts); what OpenSSL refuses while it generates is
 * thrown from the generator, with the message Node.js v24.18.1 (OpenSSL 3.5.7) reports. Those errors carry no `code`.
 * Shapes that a standard leaves open were measured on keys real Node generates
 * (node-crypto-keygen.controls.json, `observations`).
 */
import { bigIntToBytes, bitLength, bytesToBigInt, modPow, randomBelow, randomBigInt } from "./node-crypto-bigint.ts";
import { dhGroup, type DhGroup } from "./node-crypto-dh-groups.ts";
import { CURVES, OKP, curveByName, ecPublicPoint, type NamedCurve, type OkpKind, type PrivateMaterial, type RsaPssParameters } from "./node-crypto-key-codec.ts";
import { entropy, randomBytes, type Steps } from "./node-crypto-keygen-job.ts";
import { generatePrimeSteps } from "./node-crypto-primes.ts";
import { generateRsaKeySteps } from "./node-crypto-rsa.ts";

const KEY_SIZE_TOO_SMALL = "error:1C8000AB:Provider routines::key size too small";
const EXPONENT_OUT_OF_RANGE = "error:020000B2:rsa routines::pub exponent out of range";
const MODULUS_TOO_SMALL = "error:0280007E:Diffie-Hellman routines::modulus too small";
const MODULUS_TOO_LARGE = "error:02800067:Diffie-Hellman routines::modulus too large";
const BAD_GENERATOR = "error:02800065:Diffie-Hellman routines::bad generator";
const NO_INVERSE = "error:0180006C:bignum routines::no inverse";

/** RSA: OpenSSL checks the size, then the exponent (zero fails without an OpenSSL error). */
export function* rsaSteps(kind: "rsa" | "rsa-pss", bits: number, publicExponent: number, pss: RsaPssParameters | undefined, budgetMs: number): Steps<PrivateMaterial> {
  if (bits < 512) throw new Error(KEY_SIZE_TOO_SMALL);
  if (publicExponent === 0) throw new Error("Key generation job failed");
  if (publicExponent < 3 || publicExponent % 2 === 0) throw new Error(EXPONENT_OUT_OF_RANGE);
  const key = yield* generateRsaKeySteps(bits, BigInt(publicExponent), entropy, budgetMs);
  return { kind, n: key.n, e: key.e, d: key.d, p: key.p, q: key.q, dp: key.dp, dq: key.dq, qi: key.qi, ...(pss === undefined ? {} : { pss }) };
}

// The names `crypto.getCurves()` lists in Node.js v24.18.1 besides the four implemented here, and the NIST
// names OpenSSL maps to some of them: real Node generates keys on these.
const OTHER_CURVES = new Set([
  ...["Oakley-EC2N-3", "Oakley-EC2N-4", "SM2", "prime192v1", "prime192v2", "prime192v3", "prime239v1", "prime239v2", "prime239v3"],
  ...["160r1", "160t1", "192r1", "192t1", "224r1", "224t1", "256r1", "256t1", "320r1", "320t1", "384r1", "384t1", "512r1", "512t1"].map(name => `brainpoolP${name}`),
  ...["pnb163v1", "pnb163v2", "pnb163v3", "pnb176v1", "pnb208w1", "pnb272w1", "pnb304w1", "pnb368w1", "tnb191v1", "tnb191v2", "tnb191v3", "tnb239v1", "tnb239v2", "tnb239v3", "tnb359v1", "tnb431r1"].map(name => `c2${name}`),
  ...["112r1", "112r2", "128r1", "128r2", "160k1", "160r1", "160r2", "192k1", "224k1", "224r1"].map(name => `secp${name}`),
  ...["113r1", "113r2", "131r1", "131r2", "163k1", "163r1", "163r2", "193r1", "193r2", "233k1", "233r1", "239k1", "283k1", "283r1", "409k1", "409r1", "571k1", "571r1"].map(name => `sect${name}`),
  ...["1", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].map(name => `wap-wsg-idm-ecid-wtls${name}`),
  ...["B-163", "B-233", "B-283", "B-409", "B-571", "K-163", "K-233", "K-283", "K-409", "K-571", "P-192", "P-224"],
]);
const OKP_CURVE_NAMES = new Map<string, OkpKind>([["X25519", "x25519"], ["X448", "x448"], ["ED25519", "ed25519"], ["ED448", "ed448"]]);

export type ResolvedCurve = { readonly kind: "ec"; readonly curve: NamedCurve } | { readonly kind: "okp"; readonly type: OkpKind } | { readonly kind: "unsupported" };
/**
 * What `namedCurve` selects. Node looks the name up as a NIST name, then as the short name of any OpenSSL
 * object, exactly as written. `undefined`: not a curve ("Invalid EC curve name").
 */
export function resolveCurve(name: string): ResolvedCurve | undefined {
  const curve = curveByName(name);
  if (curve !== undefined) return { kind: "ec", curve };
  const okp = OKP_CURVE_NAMES.get(name);
  if (okp !== undefined) return { kind: "okp", type: okp };
  return OTHER_CURVES.has(name) ? { kind: "unsupported" } : undefined;
}

/** EC: a private scalar uniform in [1, n - 1]. */
export function ecKey(namedCurve: NamedCurve): PrivateMaterial {
  const { curve, size } = CURVES[namedCurve];
  const d = bigIntToBytes(1n + randomBelow(curve.Point.Fn.ORDER - 1n, entropy), size);
  return { kind: "ec", namedCurve, point: ecPublicPoint(namedCurve, d), d };
}

/** Ed25519 and Ed448 keep the random seed; OpenSSL stores an X25519 or X448 key already clamped. */
export function okpKey(kind: OkpKind): PrivateMaterial {
  const privateKey = randomBytes(OKP[kind].size);
  if (kind === "x25519") {
    privateKey[0] = (privateKey[0] ?? 0) & 248;
    privateKey[31] = ((privateKey[31] ?? 0) & 127) | 64;
  } else if (kind === "x448") {
    privateKey[0] = (privateKey[0] ?? 0) & 252;
    privateKey[55] = (privateKey[55] ?? 0) | 128;
  }
  return { kind, privateKey, publicKey: OKP[kind].getPublicKey(privateKey) };
}

/** The private key lengths OpenSSL uses for the groups it knows by name (RFC 7919 appendix A style). */
const GROUP_KEY_BITS: Readonly<Record<string, number>> = { modp5: 200, modp14: 225, modp15: 275, modp16: 325, modp17: 375, modp18: 400 };
export type DhSource =
  | { readonly from: "group"; readonly group: DhGroup; readonly keyBits: number | undefined }
  | { readonly from: "prime"; readonly prime: Uint8Array; readonly generator: number }
  | { readonly from: "length"; readonly bits: number; readonly generator: number };
/** The group of this name (any letter case), or undefined. */
export function resolveDhGroup(name: string): DhSource | undefined {
  const group = dhGroup(name);
  return group === undefined ? undefined : { from: "group", group, keyBits: GROUP_KEY_BITS[name.toLowerCase()] };
}

const DH_MIN_BITS = 512, DH_MAX_BITS = 10_000;
function dhModulusBits(bits: number): void {
  if (bits < DH_MIN_BITS) throw new Error(MODULUS_TOO_SMALL);
  if (bits > DH_MAX_BITS) throw new Error(MODULUS_TOO_LARGE);
}

/**
 * Diffie-Hellman. A named group OpenSSL knows gets a short private key in [1, 2^keyBits - 1]. Any other
 * modulus gets one two bits shorter than the modulus with its top bit set, and an even one when the
 * generator is 2 and bit 2 of the modulus is clear. `primeLength` makes a safe prime as OpenSSL's
 * DH_generate_parameters does: 23 modulo 24 for generator 2, 59 modulo 60 for 5, 11 modulo 12 otherwise.
 */
export function* dhSteps(source: DhSource, budgetMs: number): Steps<PrivateMaterial> {
  let p: bigint, g: bigint;
  if (source.from === "group") {
    ({ prime: p, generator: g } = source.group);
    if (source.keyBits !== undefined) {
      const x = 1n + randomBelow((1n << BigInt(source.keyBits)) - 1n, entropy);
      return { kind: "dh", p, g, x, y: modPow(g, x, p) };
    }
  } else if (source.from === "prime") {
    p = bytesToBigInt(source.prime); g = BigInt(source.generator);
    dhModulusBits(bitLength(p));
    if ((p & 1n) === 0n) throw new Error(NO_INVERSE);
  } else {
    dhModulusBits(source.bits);
    if (source.generator <= 1) throw new Error(BAD_GENERATOR);
    g = BigInt(source.generator);
    const [add, rem] = source.generator === 2 ? [24n, 23n] : source.generator === 5 ? [60n, 59n] : [12n, 11n];
    p = yield* generatePrimeSteps({ bits: source.bits, safe: true, add, rem }, entropy, budgetMs);
  }
  const length = bitLength(p) - 2;
  let x = randomBigInt(length, entropy) | (1n << BigInt(length - 1));
  if (g === 2n && (p & 4n) === 0n) x &= ~1n;
  return { kind: "dh", p, g, x, y: modPow(g, x, p) };
}
