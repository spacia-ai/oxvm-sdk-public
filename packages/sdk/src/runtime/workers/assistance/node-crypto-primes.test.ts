import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { bitLength, type Entropy } from "./node-crypto-bigint.ts";
import { generatePrime, generatePrimeSteps, isProbablePrime, millerRabinRounds } from "./node-crypto-primes.ts";

// Recorded from real Node 24.18.1: what `generatePrimeSync` produces for each option (bit lengths, top bits,
// residues, sample primes), the errors it raises, and `checkPrimeSync` for known primes and pseudoprimes.
const control = record(JSON.parse(readFileSync(new URL("./node-crypto-primes.controls.json", import.meta.url), "utf8")), "primes controls");
const generated = ((): Record<string, unknown>[] => {
  const value = control["generated"];
  if (!Array.isArray(value)) throw new Error("generated is not a list");
  return value.map((row: unknown, index) => record(row, `generated[${String(index)}]`));
})();
const recordedFor = (label: string, bits: number): Record<string, unknown> => {
  const found = generated.find(row => row["label"] === label && row["bits"] === bits);
  if (found === undefined) throw new Error(`no record for ${label} ${String(bits)}`);
  return found;
};
const samples = (row: Record<string, unknown>): bigint[] => {
  const value = row["samples"];
  if (!Array.isArray(value)) throw new Error("samples");
  return value.map((sample: unknown) => BigInt(string(sample, "sample")));
};

function seeded(seed: number): Entropy {
  let state = seed >>> 0 || 1;
  return target => {
    for (let index = 0; index < target.length; index += 1) {
      state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      target[index] = state & 0xff;
    }
  };
}
const secondBit = (value: bigint): boolean => value.toString(2).charAt(1) === "1";

describe("primality testing", () => {
  it("agrees with Node's checkPrime on primes, Carmichael numbers and strong pseudoprimes", () => {
    expect(control["node"]).toEqual({ version: "v24.18.1", openssl: "3.5.7" });
    const checked = record(control["checkPrime"], "checkPrime");
    expect(Object.keys(checked).length).toBeGreaterThan(15);
    const entropy = seeded(1);
    for (const [value, answer] of Object.entries(checked)) {
      const expected = record(answer, value);
      expect(expected["oneCheck"]).toBe(expected["default"]);
      expect(isProbablePrime(BigInt(value), millerRabinRounds(bitLength(BigInt(value))), entropy), value).toBe(expected["default"]);
    }
  });

  it("settles small numbers exactly and finds no prime among products of two primes", () => {
    const entropy = seeded(2);
    const small: number[] = [];
    for (let value = -3; value < 200; value += 1) if (isProbablePrime(BigInt(value), 1, entropy)) small.push(value);
    expect(small).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199]);
    let count = 0;
    for (let value = 3_990_000; value < 4_010_000; value += 1) if (isProbablePrime(BigInt(value), 8, entropy)) count += 1;
    // pi(4010000) - pi(3990000), counted by a plain sieve below.
    const composite = new Uint8Array(4_010_000);
    let expected = 0;
    for (let value = 2; value < 4_010_000; value += 1) {
      if (composite[value] === 1) continue;
      if (value >= 3_990_000) expected += 1;
      for (let multiple = value * value; multiple < 4_010_000; multiple += value) composite[multiple] = 1;
    }
    expect(count).toBe(expected);
    const p = (1n << 89n) - 1n;
    const q = (1n << 107n) - 1n;
    expect([isProbablePrime(p, 16, entropy), isProbablePrime(q, 16, entropy), isProbablePrime(p * q, 16, entropy), isProbablePrime(p * p, 16, entropy)]).toEqual([true, true, false, false]);
    // Zero rounds still runs one: a composite with no small factor is not waved through.
    expect(isProbablePrime(p * q, 0, entropy)).toBe(false);
  });

  it("uses OpenSSL's default round counts", () => {
    expect([64, 512, 1024, 2048, 2049, 4096, 8192].map(millerRabinRounds)).toEqual([64, 64, 64, 64, 128, 128, 128]);
  });
});

describe("prime generation", () => {
  it("accepts every sample prime Node generated", () => {
    const entropy = seeded(4);
    for (const row of generated) for (const sample of samples(row)) expect(isProbablePrime(sample, 16, entropy), sample.toString()).toBe(true);
    for (const sample of samples(recordedFor("safe", 64))) expect(isProbablePrime(sample >> 1n, 16, entropy)).toBe(true);
  });

  it("sets the two top bits unless add is given, as Node does", () => {
    const plain = recordedFor("plain", 64);
    expect(plain["topTwoBits"]).toBe(plain["count"]);
    const withAdd = recordedFor("add 12 (rem default 1)", 64);
    expect(withAdd["topTwoBits"]).not.toBe(withAdd["count"]);
    const entropy = seeded(5);
    let addWithoutSecondBit = 0;
    for (let round = 0; round < 40; round += 1) {
      const prime = generatePrime({ bits: 64 }, entropy);
      expect([bitLength(prime), secondBit(prime), isProbablePrime(prime, 16, entropy)]).toEqual([64, true, true]);
      const residue = generatePrime({ bits: 64, add: 12n }, entropy);
      expect([bitLength(residue), residue % 12n, isProbablePrime(residue, 16, entropy)]).toEqual([64, 1n, true]);
      if (!secondBit(residue)) addWithoutSecondBit += 1;
    }
    expect(addWithoutSecondBit).toBeGreaterThan(5);
    let topOnly = 0;
    for (let round = 0; round < 40; round += 1) if (!secondBit(generatePrime({ bits: 48, topTwoBits: false }, entropy))) topOnly += 1;
    expect(topOnly).toBeGreaterThan(5);
  });

  it("gives the only possible answers for tiny sizes", () => {
    const entropy = seeded(6);
    for (const [bits, label] of [[2, "plain"], [3, "plain"], [4, "plain"], [3, "safe"], [6, "safe"]] as const) {
      const expected = new Set(samples(recordedFor(label, bits)));
      expect(expected.size).toBe(1);
      for (let round = 0; round < 10; round += 1) expect(expected.has(generatePrime({ bits, safe: label === "safe" }, entropy))).toBe(true);
    }
    const eight = new Set<bigint>();
    for (let round = 0; round < 200; round += 1) eight.add(generatePrime({ bits: 8 }, entropy));
    expect([...eight].sort((a, b) => Number(a - b))).toEqual([193n, 197n, 199n, 211n, 223n, 227n, 229n, 233n, 239n, 241n, 251n]);
  });

  it("generates safe primes and honours add and rem", () => {
    const entropy = seeded(7);
    for (const bits of [16, 39, 40, 64, 128, 256]) {
      const prime = generatePrime({ bits, safe: true }, entropy);
      expect([bitLength(prime), prime % 4n, secondBit(prime)]).toEqual([bits, 3n, true]);
      expect([isProbablePrime(prime, 16, entropy), isProbablePrime(prime >> 1n, 16, entropy)]).toEqual([true, true]);
    }
    const cases: readonly (readonly [number, boolean, bigint, bigint | undefined, bigint])[] = [
      [64, false, 12n, 5n, 5n], [16, false, 7n, 3n, 3n], [64, true, 8n, undefined, 3n], [64, true, 24n, 23n, 23n], [32, true, 12n, 11n, 11n],
      [128, false, 1000003n, 17n, 17n], [96, true, 7n, 3n, 3n], [256, false, 1n << 64n, 12345n, 12345n],
    ];
    for (const [bits, safe, add, rem, residue] of cases) {
      for (let round = 0; round < 4; round += 1) {
        const prime = generatePrime(rem === undefined ? { bits, safe, add } : { bits, safe, add, rem }, entropy);
        expect([bitLength(prime) >= bits, prime % add, isProbablePrime(prime, 16, entropy)], `${String(bits)} ${String(add)}`).toEqual([true, residue, true]);
        if (safe) expect(isProbablePrime(prime >> 1n, 16, entropy)).toBe(true);
      }
    }
    // Node's recorded runs hold the same residues.
    for (const label of ["add 12 rem 5", "safe add 8 (rem default 3)", "safe add 24 rem 23", "add 7 rem 3"]) {
      const row = generated.find(candidate => candidate["label"] === label);
      expect(row?.["conditionHeld"]).toBe(row?.["count"]);
    }
    // Like OpenSSL, the search with add may step past the requested size when no prime of that size fits.
    expect(samples(recordedFor("add 2^15+1", 16))).toEqual([65539n, 65539n, 65539n]);
    expect(generatePrime({ bits: 16, add: 32769n }, entropy)).toBe(65539n);
  });

  it("refuses sizes Node refuses, and residues that no prime has", () => {
    const entropy = seeded(8);
    const errors = record(control["errors"], "errors");
    for (const name of ["bits1", "safe5", "safe4"]) expect(string(record(errors[name], name)["message"], "message")).toContain("bits too small");
    expect(() => generatePrime({ bits: 1 }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 0 }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 12.5 }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 5, safe: true }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 4, safe: true }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 8, add: 257n }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 8, add: 7n, rem: 7n }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 8, add: 0n }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 8, rem: 1n }, entropy)).toThrow(RangeError);
    // Real Node never returns for these (OpenSSL keeps searching); refusing is a deliberate difference.
    expect(() => generatePrime({ bits: 16, add: 6n, rem: 2n }, entropy)).toThrow("No prime satisfies");
    expect(() => generatePrime({ bits: 16, add: 6n, rem: 3n }, entropy)).toThrow("No prime satisfies");
    expect(() => generatePrime({ bits: 64, safe: true, add: 12n }, entropy)).toThrow("No prime satisfies");
    expect(() => generatePrime({ bits: 64, safe: true, add: 7n, rem: 1n }, entropy)).toThrow("No prime satisfies");
    expect(() => generatePrime({ bits: 64, safe: true, add: 8n, rem: 5n }, entropy)).toThrow("No prime satisfies");
  });

  it("generates large primes, the same ones for the same entropy stream", () => {
    const prime = generatePrime({ bits: 512 }, seeded(11));
    expect([bitLength(prime), secondBit(prime), isProbablePrime(prime, 8, seeded(1))]).toEqual([512, true, true]);
    expect(generatePrime({ bits: 512 }, seeded(11))).toBe(prime);
    expect(generatePrime({ bits: 512 }, seeded(12))).not.toBe(prime);
    const large = generatePrime({ bits: 1024, rounds: 4 }, seeded(13));
    expect([bitLength(large), isProbablePrime(large, 8, seeded(1))]).toEqual([1024, true]);
  });

  it("honours a minimum, an acceptance test and a round count", () => {
    const minimum = (1n << 127n) + (1n << 126n) + (1n << 125n);
    const entropy = seeded(14);
    for (let round = 0; round < 10; round += 1) {
      const prime = generatePrime({ bits: 128, minimum, rounds: 5, accept: candidate => candidate % 5n === 2n }, entropy);
      expect([bitLength(prime), prime >= minimum, prime % 5n]).toEqual([128, true, 2n]);
    }
    expect(() => generatePrime({ bits: 128, minimum: 1n << 128n }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 128, minimum: 5n }, entropy)).toThrow(RangeError);
    expect(() => generatePrime({ bits: 128, minimum, add: 3n }, entropy)).toThrow(RangeError);
  });

  it("yields while it works when given a time budget, and returns the same prime", () => {
    const steps = generatePrimeSteps({ bits: 768 }, seeded(21), 0.01);
    let turns = 0;
    let step = steps.next();
    while (step.done !== true) { expect(step.value).toBeUndefined(); turns += 1; step = steps.next(); }
    expect(turns).toBeGreaterThan(5);
    expect(step.value).toBe(generatePrime({ bits: 768 }, seeded(21)));
    const unpaced = generatePrimeSteps({ bits: 256 }, seeded(22), Number.POSITIVE_INFINITY).next();
    expect(unpaced.done).toBe(true);
    // Invalid options surface on the first step, not at creation.
    const invalid = generatePrimeSteps({ bits: 1 }, seeded(1), 1);
    expect(() => invalid.next()).toThrow(RangeError);
  });
});
