/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/random.js (generatePrime, generatePrimeSync,
 * checkPrime, checkPrimeSync: the order of argument validation).
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
import { bigIntToBytes, bitLength, bytesToBigInt, gcd } from "./node-crypto-bigint.ts";
import { NO_BUDGET, TURN_BUDGET_MS, driveSteps, entropy, pacer, runSteps, validateInt32, type Steps } from "./node-crypto-keygen-job.ts";
import { isAnyArrayBuffer, jobReceiver, member, viewBytes } from "./node-crypto-misc.ts";
import type { CryptoPorts } from "./node-crypto-ports.ts";
import { generatePrimeSteps, isProbablePrime, millerRabinRounds } from "./node-crypto-primes.ts";
import { invalidType, named, outOfRange, validateBoolean, validateFunction, validateObject } from "./node-util-validators.ts";

const BITS_TOO_SMALL = "error:01800076:bignum routines::bits too small";
const DIV_BY_ZERO = "error:01800067:bignum routines::div by zero";
const NUMBER_TYPES = "bigint or an instance of ArrayBuffer, TypedArray, Buffer, or DataView";

/** A non-negative integer given as a bigint or as big-endian bytes. */
function unsigned(value: unknown, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw outOfRange(name, ">= 0", value);
    return value;
  }
  if (isAnyArrayBuffer(value) || ArrayBuffer.isView(value)) return bytesToBigInt(viewBytes(value));
  throw invalidType(name, NUMBER_TYPES, value);
}
const rangeError = (message: string): RangeError => Object.assign(new RangeError(message), { code: "ERR_OUT_OF_RANGE" });

interface PrimeJob { readonly create: (budgetMs: number) => Steps<bigint>; readonly result: (prime: bigint) => bigint | ArrayBuffer }

function arrayBuffer(value: bigint): ArrayBuffer {
  const bytes = bigIntToBytes(value);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * The search. OpenSSL's limits come first, with its messages. Where no prime has the requested residue,
 * OpenSSL (and so Node) searches without end; this refuses instead. Where OpenSSL keeps drawing the same
 * composite (an even residue class, for one), the search here goes on to the next prime of the class.
 */
function* primeSteps(bits: number, safe: boolean, add: bigint | undefined, rem: bigint | undefined, budgetMs: number): Steps<bigint> {
  if (bits < 2 || (add === undefined && safe && bits < 6 && bits !== 3)) throw new Error(BITS_TOO_SMALL);
  if (add === 0n) throw new Error(DIV_BY_ZERO);
  // Every integer is a multiple of one: OpenSSL then returns an ordinary prime of the size.
  const free = add === undefined || (add === 1n && (rem === undefined || rem === 0n));
  if (!free) {
    // A residue class that shares a factor with its modulus holds one prime at most: that factor. OpenSSL
    // reaches it only when it has the requested size (`generatePrimeSync(2, { add: 3n, rem: 0n })` is 3).
    const residue = rem ?? (safe ? 3n : 1n), lone = residue === 0n ? add : residue;
    if (lone > 1n && gcd(add, residue) === lone && bitLength(lone) === bits && isProbablePrime(lone, 64, entropy) && (!safe || isProbablePrime(lone >> 1n, 64, entropy))) return lone;
  }
  try {
    return yield* generatePrimeSteps(free ? { bits, safe } : { bits, safe, add, ...(rem === undefined ? {} : { rem }) }, entropy, budgetMs);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new RangeError(`crypto.generatePrime: no prime satisfies options.add and options.rem; Node.js would search without end (${error.message})`, { cause: error });
  }
}

/** Node's `createRandomPrimeJob`, and what its native job refuses when it is constructed. */
function primeJob(size: number, options: unknown): PrimeJob {
  validateObject(options, "options");
  const safeOption = member(options, "safe"), bigintOption = member(options, "bigint");
  const safe = safeOption === undefined ? false : safeOption, bigint = bigintOption === undefined ? false : bigintOption;
  const addOption = member(options, "add"), remOption = member(options, "rem");
  validateBoolean(safe, "options.safe");
  validateBoolean(bigint, "options.bigint");
  const add = addOption === undefined ? undefined : unsigned(addOption, "options.add");
  const rem = remOption === undefined ? undefined : unsigned(remOption, "options.rem");
  if (add !== undefined) {
    if (bitLength(add) > size) throw rangeError("invalid options.add");
    if (rem !== undefined && add <= rem) throw rangeError("invalid options.rem");
  }
  // Without `add`, OpenSSL does not read `rem`.
  return { create: budgetMs => primeSteps(size, safe, add, add === undefined ? undefined : rem, budgetMs), result: bigint ? prime => prime : arrayBuffer };
}

/** Trial division settles everything below this (the square of the first prime it does not try). */
const SETTLED_BELOW = 4_000_000n;
/** Miller-Rabin with random bases, one round at a time so that a callback form can yield between rounds. */
function* checkSteps(candidate: bigint, checks: number, budgetMs: number): Steps<boolean> {
  if (candidate < SETTLED_BELOW) return isProbablePrime(candidate, 1, entropy);
  const due = pacer(budgetMs);
  const rounds = checks === 0 ? millerRabinRounds(bitLength(candidate)) : checks;
  for (let round = 0; round < rounds; round += 1) {
    if (!isProbablePrime(candidate, 1, entropy)) return false;
    if (due()) yield undefined;
  }
  return true;
}
function checkCount(options: unknown): number {
  validateObject(options, "options");
  const option = member(options, "checks"), checks = option === undefined ? 0 : option;
  validateInt32(checks, "options.checks", 0);
  return checks;
}

/** `generatePrime`, `generatePrimeSync`, `checkPrime` and `checkPrimeSync` of `node:crypto`. */
export function createCryptoPrimes(ports: CryptoPorts) {
  function generatePrimeSync(size: unknown, options: unknown = {}): bigint | ArrayBuffer {
    validateInt32(size, "size", 1);
    const job = primeJob(size, options);
    return job.result(runSteps(job.create(NO_BUDGET)));
  }
  function generatePrime(size: unknown, options: unknown, callback: unknown): void {
    validateInt32(size, "size", 1);
    let chosen = options, done = callback;
    if (typeof chosen === "function") { done = chosen; chosen = {}; }
    validateFunction(done, "callback");
    const job = primeJob(size, chosen), finish = done;
    driveSteps(ports, job.create(TURN_BUDGET_MS), outcome => {
      if (outcome.ok) finish(undefined, job.result(outcome.value));
      else finish(outcome.error);
    });
  }
  function checkPrimeSync(candidate: unknown, options: unknown = {}): boolean {
    const value = unsigned(candidate, "candidate");
    return runSteps(checkSteps(value, checkCount(options), NO_BUDGET));
  }
  function checkPrime(candidate: unknown, options: unknown = {}, callback?: unknown): void {
    const value = unsigned(candidate, "candidate");
    let chosen = options, done = callback;
    if (typeof chosen === "function") { done = chosen; chosen = {}; }
    validateFunction(done, "callback");
    const checks = checkCount(chosen), receiver = jobReceiver("CheckPrimeJob"), finish = done;
    driveSteps(ports, checkSteps(value, checks, TURN_BUDGET_MS), outcome => {
      Reflect.apply(finish, receiver, outcome.ok ? [undefined, outcome.value] : [outcome.error]);
    });
  }
  named(generatePrime, "generatePrime"); named(generatePrimeSync, "generatePrimeSync");
  named(checkPrime, "checkPrime"); named(checkPrimeSync, "checkPrimeSync");
  return { generatePrime, generatePrimeSync, checkPrime, checkPrimeSync };
}
