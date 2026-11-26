// The arithmetic of finite-field Diffie-Hellman as OpenSSL 3.5 does it for Node 24: the parameter check behind
// `verifyError`, the size of the private exponent, the check of a peer's public value and the secret. Pure
// functions over BigInt; recorded behaviour is in node-crypto-dh.controls.json.
import { bigIntToBytes, bitLength, modPow, randomBigInt, type Entropy } from "./node-crypto-bigint.ts";
import { DH_GROUPS, FFDHE_GROUPS } from "./node-crypto-dh-groups.ts";
import { generatePrime, isProbablePrime, millerRabinRounds } from "./node-crypto-primes.ts";

/** OpenSSL refuses to generate keys or derive secrets outside these modulus sizes (DH_MIN_MODULUS_BITS, OPENSSL_DH_MAX_MODULUS_BITS). */
export const MIN_MODULUS_BITS = 512;
export const MAX_MODULUS_BITS = 10000;

// DH_check's flags. The first four are in `crypto.constants`; the two modulus flags are not, but Node reports them.
export const DH_CHECK_P_NOT_PRIME = 1;
export const DH_CHECK_P_NOT_SAFE_PRIME = 2;
export const DH_NOT_SUITABLE_GENERATOR = 8;
export const DH_MODULUS_TOO_SMALL = 0x80;
export const DH_MODULUS_TOO_LARGE = 0x100;

/**
 * The safe-prime groups OpenSSL knows by their numbers (RFC 3526 from 1536 bits, RFC 7919), with the longest
 * private exponent it uses for each. Parameters equal to one of them, with generator 2, are a "named group"
 * wherever they come from: OpenSSL then knows q = (p - 1) / 2, shortens the exponent and checks peers against q.
 * The 768-bit and 1024-bit groups of RFC 2409 (modp1, modp2) are not among them.
 */
const NAMED_EXPONENT_BITS: ReadonlyMap<bigint, number> = new Map<bigint, number>(([
  [DH_GROUPS["modp5"], 200], [DH_GROUPS["modp14"], 225], [DH_GROUPS["modp15"], 275], [DH_GROUPS["modp16"], 325], [DH_GROUPS["modp17"], 375], [DH_GROUPS["modp18"], 400],
  [FFDHE_GROUPS["ffdhe2048"], 225], [FFDHE_GROUPS["ffdhe3072"], 275], [FFDHE_GROUPS["ffdhe4096"], 325], [FFDHE_GROUPS["ffdhe6144"], 375], [FFDHE_GROUPS["ffdhe8192"], 400],
] as const).flatMap(([group, bits]) => group === undefined ? [] : [[group.prime, bits] as const]));
const KNOWN_SAFE_PRIMES: ReadonlySet<bigint> = new Set([...Object.values(DH_GROUPS), ...Object.values(FFDHE_GROUPS)].map(group => group.prime));

/** The longest private exponent of a named group; `undefined` for any other parameters. */
export function namedExponentBits(prime: bigint, generator: bigint): number | undefined {
  return generator === 2n ? NAMED_EXPONENT_BITS.get(prime) : undefined;
}
/** Whether the prime is one of the fixed groups' (a safe prime by construction, so nothing has to be tested). */
export function isKnownSafePrime(prime: bigint): boolean { return KNOWN_SAFE_PRIMES.has(prime); }

/** The flags of DH_check_params: what OpenSSL can say without testing primality. */
export function checkParameters(prime: bigint, generator: bigint): number {
  let flags = 0;
  if ((prime & 1n) === 0n) flags |= DH_CHECK_P_NOT_PRIME;
  if (generator <= 1n || generator >= prime - 1n) flags |= DH_NOT_SUITABLE_GENERATOR;
  const bits = bitLength(prime);
  if (bits < MIN_MODULUS_BITS) flags |= DH_MODULUS_TOO_SMALL;
  if (bits > MAX_MODULUS_BITS) flags |= DH_MODULUS_TOO_LARGE;
  return flags;
}
/** The flags of DH_check for parameters without q: DH_check_params, then whether p and (p - 1) / 2 are prime. */
export function checkDh(prime: bigint, generator: bigint, entropy: Entropy, knownSafe = isKnownSafePrime(prime)): number {
  // OpenSSL does not check a named group at all.
  if (namedExponentBits(prime, generator) !== undefined) return 0;
  const flags = checkParameters(prime, generator);
  if (knownSafe) return flags;
  const rounds = millerRabinRounds(bitLength(prime));
  if (prime < 2n || !isProbablePrime(prime, rounds, entropy)) return flags | DH_CHECK_P_NOT_PRIME;
  return isProbablePrime(prime >> 1n, rounds, entropy) ? flags : flags | DH_CHECK_P_NOT_SAFE_PRIME;
}

/**
 * A safe prime as DH_generate_parameters_ex chooses it: 23 modulo 24 for generator 2, 59 modulo 60 for generator
 * 5 and 11 modulo 12 for any other, so that the generator has a large order.
 */
export function generateSafePrime(bits: number, generator: bigint, entropy: Entropy): bigint {
  const [add, rem] = generator === 2n ? [24n, 23n] : generator === 5n ? [60n, 59n] : [12n, 11n];
  return generatePrime({ bits, safe: true, add, rem }, entropy);
}

/**
 * A private exponent as OpenSSL's generate_key draws it. Named group: 1 + a uniform number below 2^N, drawn again
 * when that is 2^N. Otherwise: two bits shorter than the prime with the top bit set, and even when the generator
 * is 2 and bit 2 of the prime is clear (the lowest bit would not be secret).
 */
export function generatePrivate(prime: bigint, generator: bigint, entropy: Entropy): bigint {
  const named = namedExponentBits(prime, generator);
  if (named !== undefined) {
    for (;;) { const candidate = randomBigInt(named, entropy) + 1n; if (candidate < 1n << BigInt(named)) return candidate; }
  }
  const length = bitLength(prime) - 2;
  let exponent = randomBigInt(length, entropy) | (1n << BigInt(length - 1));
  if (generator === 2n && (prime & 4n) === 0n) exponent &= ~1n;
  return exponent;
}

/** The Jacobi symbol (a / n) for odd positive n: for a prime n, 1 exactly when a is a non-zero square. */
export function jacobi(value: bigint, modulus: bigint): -1 | 0 | 1 {
  if (modulus <= 0n || (modulus & 1n) === 0n) throw new RangeError("The Jacobi symbol needs an odd positive modulus");
  let a = ((value % modulus) + modulus) % modulus, n = modulus, sign = 1;
  while (a !== 0n) {
    while ((a & 1n) === 0n) {
      a >>= 1n;
      const residue = n & 7n;
      if (residue === 3n || residue === 5n) sign = -sign;
    }
    [a, n] = [n, a];
    if ((a & 3n) === 3n && (n & 3n) === 3n) sign = -sign;
    a %= n;
  }
  if (n !== 1n) return 0;
  return sign === 1 ? 1 : -1;
}

export type PeerFault = "too-small" | "too-large" | "invalid";
/**
 * DH_check_pub_key: the peer's value must lie in [2, p - 2] and, for a named group (whose q OpenSSL knows), in
 * the subgroup of order q, which for a safe prime means being a square.
 */
export function checkPeer(prime: bigint, generator: bigint, peer: bigint): PeerFault | undefined {
  if (peer <= 1n) return "too-small";
  if (peer >= prime - 1n) return "too-large";
  if (namedExponentBits(prime, generator) !== undefined && jacobi(peer, prime) !== 1) return "invalid";
  return undefined;
}

/** The number of bytes of the prime: the length Node pads a shared secret to. */
export function primeLength(prime: bigint): number { return Math.ceil(bitLength(prime) / 8); }
/** peer ^ exponent mod prime, left-padded with zeros to the prime's length. */
export function sharedSecret(prime: bigint, exponent: bigint, peer: bigint): Uint8Array {
  return bigIntToBytes(modPow(peer, exponent, prime), primeLength(prime));
}
