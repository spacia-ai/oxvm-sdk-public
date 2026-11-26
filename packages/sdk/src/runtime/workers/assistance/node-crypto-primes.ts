// Probable-prime testing and generation for the fast-path `node:crypto` (generatePrime, checkPrime, RSA and
// Diffie-Hellman key generation). Pure functions over BigInt; the caller supplies the entropy.
//
// The shape of what is generated follows OpenSSL's BN_generate_prime_ex2 as Node 24 (OpenSSL 3.5) shows it:
// without `add` a prime has its top two bits set, with `add` only the top bit; a safe prime is 3 modulo 4;
// `rem` defaults to 1, or to 3 for a safe prime. Candidates come from a sieve over a window that moves up
// from a random start, then pass Miller-Rabin with random bases.
import { bitLength, gcd, modPow, randomBelow, randomBigInt, type Entropy } from "./node-crypto-bigint.ts";

export interface PrimeOptions {
  readonly bits: number;
  readonly safe?: boolean;
  readonly add?: bigint;
  readonly rem?: bigint;
}

export interface PrimeSearchOptions extends PrimeOptions {
  /** Set the two top bits (so a product of two such primes has exactly twice the bits). Default: true unless `add` is given, as OpenSSL. */
  readonly topTwoBits?: boolean;
  /** Miller-Rabin rounds for the accepted prime. Default: `millerRabinRounds(bits)`. */
  readonly rounds?: number;
  /** Smallest acceptable start (RSA draws primes from [sqrt(2) * 2^(bits-1), 2^bits)). Not combined with `add`. */
  readonly minimum?: bigint;
  /** A cheap extra condition, checked before the primality test (RSA: p - 1 coprime to the public exponent). */
  readonly accept?: (candidate: bigint) => boolean;
}

function primesBelow(limit: number): number[] {
  const composite = new Uint8Array(limit);
  const primes: number[] = [];
  for (let value = 2; value < limit; value += 1) {
    if (composite[value] === 1) continue;
    primes.push(value);
    for (let multiple = value * value; multiple < limit; multiple += value) composite[multiple] = 1;
  }
  return primes;
}

// Trial division before Miller-Rabin: the 303 primes below 2000.
const TRIAL_LIMIT = 2000;
const TRIAL_PRIMES: readonly bigint[] = primesBelow(TRIAL_LIMIT).map(BigInt);
const TRIAL_PROVEN_BELOW = BigInt(TRIAL_LIMIT * TRIAL_LIMIT);

let sieveCache: readonly number[] = [];
let sieveCacheLimit = 0;
function sievePrimes(limit: number): readonly number[] {
  if (limit > sieveCacheLimit) { sieveCache = primesBelow(limit); sieveCacheLimit = limit; }
  if (limit === sieveCacheLimit) return sieveCache;
  let count = sieveCache.length;
  while (count > 0 && (sieveCache[count - 1] ?? 0) >= limit) count -= 1;
  return sieveCache.slice(0, count);
}

/**
 * Miller-Rabin rounds OpenSSL uses when the caller gives none (`bn_mr_min_checks`): 64 up to 2048 bits and
 * 128 above, an error probability of 2^-128 / 2^-256 for any input. Node's `checkPrime` with `checks: 0`
 * and `generatePrime` both use this.
 */
export function millerRabinRounds(bits: number): number {
  return bits > 2048 ? 128 : 64;
}

// Returns true when the small primes settle the question; `undefined` when Miller-Rabin has to decide.
function trialDivision(candidate: bigint): boolean | undefined {
  if (candidate < 2n) return false;
  for (const prime of TRIAL_PRIMES) {
    if (candidate === prime) return true;
    if (candidate % prime === 0n) return false;
  }
  return candidate < TRIAL_PROVEN_BELOW ? true : undefined;
}

interface Witness { readonly candidate: bigint; readonly minusOne: bigint; readonly odd: bigint; readonly twos: number }

function witnessFor(candidate: bigint): Witness {
  const minusOne = candidate - 1n;
  let odd = minusOne;
  let twos = 0;
  while ((odd & 1n) === 0n) { odd >>= 1n; twos += 1; }
  return { candidate, minusOne, odd, twos };
}

// One Miller-Rabin round with a random base in [2, candidate - 2]. False means composite for certain.
function passesRound(witness: Witness, entropy: Entropy): boolean {
  const base = 2n + randomBelow(witness.candidate - 3n, entropy);
  let power = modPow(base, witness.odd, witness.candidate);
  if (power === 1n || power === witness.minusOne) return true;
  for (let index = 1; index < witness.twos; index += 1) {
    power = (power * power) % witness.candidate;
    if (power === witness.minusOne) return true;
    if (power === 1n) return false;
  }
  return false;
}

/** Trial division by the primes below 2000, then `rounds` Miller-Rabin rounds with random bases. */
export function isProbablePrime(candidate: bigint, rounds: number, entropy: Entropy): boolean {
  const settled = trialDivision(candidate);
  if (settled !== undefined) return settled;
  const witness = witnessFor(candidate);
  for (let round = 0; round < Math.max(1, rounds); round += 1) if (!passesRound(witness, entropy)) return false;
  return true;
}

function clock(): number {
  return globalThis.performance.now();
}

// True once per `budgetMs` of work: the generator yields at that point.
function pacer(budgetMs: number): () => boolean {
  if (!(budgetMs > 0) || budgetMs === Number.POSITIVE_INFINITY) return () => false;
  let deadline = clock() + budgetMs;
  return () => {
    const now = clock();
    if (now < deadline) return false;
    deadline = now + budgetMs;
    return true;
  };
}

interface Plan {
  readonly bits: number;
  readonly safe: boolean;
  readonly add: bigint | undefined;
  readonly rem: bigint;
  readonly step: bigint;
  readonly topTwoBits: boolean;
  readonly rounds: number;
  readonly minimum: bigint | undefined;
  readonly accept: ((candidate: bigint) => boolean) | undefined;
}

function plan(options: PrimeSearchOptions): Plan {
  const { bits, add } = options;
  const safe = options.safe === true;
  if (!Number.isInteger(bits) || bits < 2) throw new RangeError("A prime needs at least 2 bits");
  if (add === undefined && safe && bits < 6 && bits !== 3) throw new RangeError("A safe prime needs 3 bits, or 6 and more");
  const rounds = options.rounds ?? millerRabinRounds(bits);
  if (add === undefined) {
    if (options.rem !== undefined) throw new RangeError("A remainder needs a modulus (add)");
    const minimum = options.minimum;
    if (minimum !== undefined && (minimum < 1n << BigInt(bits - 1) || minimum >= 1n << BigInt(bits))) throw new RangeError("The minimum must have exactly the requested bits");
    return { bits, safe, add, rem: 0n, step: safe ? 4n : 2n, topTwoBits: options.topTwoBits ?? true, rounds, minimum, accept: options.accept };
  }
  if (options.minimum !== undefined) throw new RangeError("A minimum cannot be combined with add");
  if (add <= 0n || bitLength(add) > bits) throw new RangeError("add must be positive and no longer than the prime");
  const rem = options.rem ?? (safe ? 3n : 1n);
  if (rem < 0n || rem >= add) throw new RangeError("rem must be in [0, add)");
  // OpenSSL searches forever when no prime has the requested residue; this refuses instead.
  let possible = gcd(add, rem) === 1n;
  if (possible && safe) {
    let oddPart = add;
    while ((oddPart & 1n) === 0n) oddPart >>= 1n;
    possible = gcd(oddPart, rem - 1n) === 1n && ((add & 3n) !== 0n || (rem & 3n) === 3n);
  }
  if (!possible) throw new RangeError("No prime satisfies the requested add and rem");
  return { bits, safe, add, rem, step: add, topTwoBits: options.topTwoBits ?? false, rounds, minimum: undefined, accept: options.accept };
}

function startingPoint(search: Plan, entropy: Entropy): bigint {
  const top = 1n << BigInt(search.bits - 1);
  if (search.add !== undefined) {
    let start = randomBigInt(search.bits, entropy) | top | 1n;
    if (search.topTwoBits) start |= top >> 1n;
    start = start - (start % search.add) + search.rem;
    if (bitLength(start) < search.bits || start < (search.safe ? 5n : 3n)) start += search.add;
    return start;
  }
  let start: bigint;
  if (search.minimum === undefined) {
    start = randomBigInt(search.bits, entropy) | top;
    if (search.topTwoBits) start |= top >> 1n;
  } else {
    start = search.minimum + randomBelow((top << 1n) - search.minimum, entropy);
  }
  return start | (search.safe ? 3n : 1n);
}

// Miller-Rabin on a sieve survivor: one round on each number first (most composites stop there), then the rest.
function* survivorIsPrime(candidate: bigint, search: Plan, entropy: Entropy, due: () => boolean): Generator<undefined, boolean, undefined> {
  const numbers = search.safe ? [witnessFor(candidate), witnessFor(candidate >> 1n)] : [witnessFor(candidate)];
  for (let round = 0; round < Math.max(1, search.rounds); round += 1) {
    for (const witness of numbers) {
      if (!passesRound(witness, entropy)) return false;
      if (due()) yield undefined;
    }
  }
  return true;
}

// Small primes: no sieve, every candidate of the right form is tested directly.
const DIRECT_BELOW_BITS = 40;
const DIRECT_STEPS = 4096;

function* directSearch(search: Plan, entropy: Entropy, due: () => boolean): Generator<undefined, bigint, undefined> {
  for (;;) {
    let candidate = startingPoint(search, entropy);
    for (let steps = 0; steps < DIRECT_STEPS; steps += 1, candidate += search.step) {
      if (search.add === undefined && bitLength(candidate) !== search.bits) break;
      if (due()) yield undefined;
      if (search.accept !== undefined && !search.accept(candidate)) continue;
      if (!isProbablePrime(candidate, search.rounds, entropy)) continue;
      if (search.safe && ((candidate & 1n) === 0n || !isProbablePrime(candidate >> 1n, search.rounds, entropy))) continue;
      return candidate;
    }
  }
}

function inverseModPrime(value: number, prime: number): number {
  let r0 = prime; let r1 = value % prime; let s0 = 0; let s1 = 1;
  while (r1 !== 0) {
    const quotient = Math.floor(r0 / r1);
    [r0, r1] = [r1, r0 - quotient * r1];
    [s0, s1] = [s1, s0 - quotient * s1];
  }
  return ((s0 % prime) + prime) % prime;
}

// How far the sieve goes. A longer table removes more candidates before the costly exponentiation but costs
// one big-integer remainder per prime at each start; a safe prime needs two numbers prime at once and many
// more candidates, so it gets the longest table. Values chosen by measurement.
function sieveLimit(search: Plan): number {
  if (search.safe) return search.bits >= 1024 ? 1 << 20 : 1 << 17;
  if (search.bits >= 1536) return 1 << 17;
  return search.bits >= 512 ? 1 << 15 : 1 << 12;
}

function* sievedSearch(search: Plan, entropy: Entropy, due: () => boolean): Generator<undefined, bigint, undefined> {
  const primes = sievePrimes(sieveLimit(search));
  const count = primes.length;
  const windowSize = search.safe ? 1 << 16 : 1 << 12;
  const flags = new Uint8Array(windowSize);
  const residues = new Int32Array(count);
  const inverses = new Int32Array(count);
  const advances = new Int32Array(count);
  const stepResidues = primes.map(prime => Number(search.step % BigInt(prime)));
  for (let index = 0; index < count; index += 1) {
    const prime = primes[index] ?? 2;
    const stepResidue = stepResidues[index] ?? 0;
    inverses[index] = stepResidue === 0 ? 0 : inverseModPrime(stepResidue, prime);
    advances[index] = (windowSize % prime) * stepResidue % prime;
  }
  const mark = (first: number, prime: number): void => { for (let slot = first; slot < windowSize; slot += prime) flags[slot] = 1; };
  for (;;) {
    let base = startingPoint(search, entropy);
    for (let index = 0; index < count; index += 1) residues[index] = Number(base % BigInt(primes[index] ?? 2));
    if (due()) yield undefined;
    let inRange = true;
    while (inRange) {
      flags.fill(0);
      for (let index = 0; index < count; index += 1) {
        const prime = primes[index] ?? 2;
        const residue = residues[index] ?? 0;
        const inverse = inverses[index] ?? 0;
        if (inverse === 0) {
          // The step is a multiple of this prime, so the residue never changes.
          if (residue === 0 || (search.safe && prime !== 2 && residue === 1)) flags.fill(1);
        } else {
          // candidate = base + slot * step is divisible by the prime at slot = -residue / step.
          mark((prime - residue) * inverse % prime, prime);
          // (candidate - 1) / 2 is divisible by an odd prime when candidate is 1 modulo it.
          if (search.safe && prime !== 2) mark((prime + 1 - residue) * inverse % prime, prime);
        }
        residues[index] = (residue + (advances[index] ?? 0)) % prime;
      }
      for (let slot = 0; slot < windowSize; slot += 1) {
        if (flags[slot] === 1) continue;
        const candidate = base + BigInt(slot) * search.step;
        if (search.add === undefined && bitLength(candidate) !== search.bits) { inRange = false; break; }
        if (search.safe && (candidate & 3n) !== 3n) continue;
        if (search.accept !== undefined && !search.accept(candidate)) continue;
        if (yield* survivorIsPrime(candidate, search, entropy, due)) return candidate;
        // A run of failing candidates must not hold the turn: the asynchronous forms spread the search over turns.
        if (due()) yield undefined;
      }
      base += BigInt(windowSize) * search.step;
      if (due()) yield undefined;
    }
  }
}

/**
 * Cooperative prime generation: yields about every `budgetMs` milliseconds of work so the caller can spread
 * the search over several turns, and returns the prime. A budget of Infinity (or 0) never yields.
 */
export function* generatePrimeSteps(options: PrimeSearchOptions, entropy: Entropy, budgetMs: number): Generator<undefined, bigint, undefined> {
  const search = plan(options);
  const due = pacer(budgetMs);
  return yield* (search.bits < DIRECT_BELOW_BITS ? directSearch(search, entropy, due) : sievedSearch(search, entropy, due));
}

/** Runs the search to completion on the calling turn. */
export function generatePrime(options: PrimeSearchOptions, entropy: Entropy): bigint {
  const steps = generatePrimeSteps(options, entropy, Number.POSITIVE_INFINITY);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}
