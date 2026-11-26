import { describe, expect, it } from "vitest";
import { bigIntToBytes, bitLength, bytesToBigInt, gcd, modInverse, modPow, randomBelow, randomBigInt, type Entropy } from "./node-crypto-bigint.ts";

function seeded(seed: number): Entropy {
  let state = seed >>> 0 || 1;
  return target => {
    for (let index = 0; index < target.length; index += 1) {
      state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      target[index] = state & 0xff;
    }
  };
}
// Square-and-multiply, one bit at a time: the reference the windowed and Montgomery paths must agree with.
function slowPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n % modulus;
  let power = ((base % modulus) + modulus) % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) result = (result * power) % modulus;
    power = (power * power) % modulus;
  }
  return result;
}

describe("big-integer helpers", () => {
  it("converts between big-endian bytes and integers", () => {
    expect(bytesToBigInt(new Uint8Array())).toBe(0n);
    expect(bytesToBigInt(Uint8Array.of(0, 0, 1, 2))).toBe(258n);
    expect(bytesToBigInt(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe((1n << 72n) - 1n);
    expect([...bigIntToBytes(0n)]).toEqual([0]);
    expect([...bigIntToBytes(0n, 0)]).toEqual([]);
    expect([...bigIntToBytes(0n, 3)]).toEqual([0, 0, 0]);
    expect([...bigIntToBytes(255n)]).toEqual([255]);
    expect([...bigIntToBytes(256n)]).toEqual([1, 0]);
    expect([...bigIntToBytes(0x0abcn)]).toEqual([0x0a, 0xbc]);
    expect([...bigIntToBytes(258n, 4)]).toEqual([0, 0, 1, 2]);
    expect([...bigIntToBytes(0xffffn, 2)]).toEqual([255, 255]);
    expect(() => bigIntToBytes(0x10000n, 2)).toThrow(RangeError);
    expect(() => bigIntToBytes(1n, 0)).toThrow(RangeError);
    expect(() => bigIntToBytes(-1n)).toThrow(RangeError);
    expect(() => bigIntToBytes(1n, -1)).toThrow(RangeError);
    expect(() => bigIntToBytes(1n, 1.5)).toThrow(RangeError);
    const stream = seeded(1);
    for (const size of [1, 2, 31, 32, 33, 256, 513]) {
      const sample = new Uint8Array(size);
      stream(sample);
      expect([...bigIntToBytes(bytesToBigInt(sample), size)]).toEqual([...sample]);
    }
  });

  it("measures bit lengths", () => {
    expect([0n, 1n, 2n, 3n, 4n, 255n, 256n, -256n, (1n << 64n) - 1n, 1n << 64n, 1n << 4095n].map(bitLength)).toEqual([0, 1, 2, 2, 3, 8, 9, 9, 64, 65, 4096]);
  });

  it("computes greatest common divisors and modular inverses", () => {
    expect([gcd(0n, 0n), gcd(0n, 7n), gcd(12n, 18n), gcd(-12n, 18n), gcd(17n, 5n), gcd(1n << 200n, 1n << 100n)]).toEqual([0n, 7n, 6n, 6n, 1n, 1n << 100n]);
    expect(modInverse(3n, 7n)).toBe(5n);
    expect(modInverse(-3n, 7n)).toBe(2n);
    expect(modInverse(10n, 7n)).toBe(5n);
    expect(modInverse(0n, 1n)).toBe(0n);
    expect(modInverse(65537n, (1n << 127n) - 1n) * 65537n % ((1n << 127n) - 1n)).toBe(1n);
    expect(() => modInverse(6n, 9n)).toThrow(RangeError);
    expect(() => modInverse(0n, 7n)).toThrow(RangeError);
    expect(() => modInverse(3n, 0n)).toThrow(RangeError);
    const entropy = seeded(5);
    const modulus = randomBigInt(1024, entropy) | 1n | (1n << 1023n);
    for (let round = 0; round < 20; round += 1) {
      const value = randomBelow(modulus, entropy);
      if (gcd(value, modulus) !== 1n) continue;
      expect((modInverse(value, modulus) * value) % modulus).toBe(1n);
    }
  });

  it("raises to powers modulo odd and even moduli of every size, on both reduction paths", () => {
    expect(modPow(4n, 13n, 497n)).toBe(445n);
    expect(modPow(2n, 0n, 7n)).toBe(1n);
    expect(modPow(0n, 0n, 7n)).toBe(1n);
    expect(modPow(5n, 3n, 1n)).toBe(0n);
    expect(modPow(-2n, 3n, 7n)).toBe(6n);
    expect(modPow(10n, 1n, 7n)).toBe(3n);
    expect(() => modPow(2n, -1n, 7n)).toThrow(RangeError);
    expect(() => modPow(2n, 3n, 0n)).toThrow(RangeError);
    const entropy = seeded(99);
    for (const bits of [8, 24, 64, 80, 240, 521, 672, 1024, 2048, 3000, 3072, 4096]) {
      for (const even of [false, true]) {
        let modulus = randomBigInt(bits, entropy) | (1n << BigInt(bits - 1));
        modulus = even ? modulus & ~1n : modulus | 1n;
        const base = randomBigInt(bits + 7, entropy);
        for (const exponentBits of [1, 17, 25, bits]) {
          const exponent = randomBigInt(exponentBits, entropy) | (1n << BigInt(exponentBits - 1));
          expect(modPow(base, exponent, modulus), `${String(bits)} ${String(exponentBits)} ${String(even)}`).toBe(slowPow(base, exponent, modulus));
        }
      }
    }
    // Fermat: a^(p-1) = 1 for the Mersenne prime 2^4423 - 1, a modulus on the Montgomery path.
    const mersenne = (1n << 4423n) - 1n;
    expect(modPow(3n, mersenne - 1n, mersenne)).toBe(1n);
    // Exponents with long runs of zeros and ones.
    const modulus = (1n << 521n) - 1n;
    for (const exponent of [1n << 300n, (1n << 300n) - 1n, (1n << 300n) + 1n, 0x8000000000000001n]) expect(modPow(7n, exponent, modulus)).toBe(slowPow(7n, exponent, modulus));
  });

  it("draws exactly the requested bits and stays below a limit", () => {
    const entropy = seeded(3);
    expect(randomBigInt(0, entropy)).toBe(0n);
    expect(() => randomBigInt(-1, entropy)).toThrow(RangeError);
    expect(() => randomBigInt(1.5, entropy)).toThrow(RangeError);
    const ones: Entropy = target => { target.fill(0xff); };
    expect([1, 7, 8, 9, 63, 64, 65].map(bits => randomBigInt(bits, ones))).toEqual([1, 7, 8, 9, 63, 64, 65].map(bits => (1n << BigInt(bits)) - 1n));
    let widest = 0;
    let topClear = 0;
    for (let round = 0; round < 200; round += 1) {
      const value = randomBigInt(13, entropy);
      expect(value >= 0n && value < 1n << 13n).toBe(true);
      widest = Math.max(widest, bitLength(value));
      if (bitLength(value) < 13) topClear += 1;
    }
    expect(widest).toBe(13);
    expect(topClear).toBeGreaterThan(50);
    expect(() => randomBelow(0n, entropy)).toThrow(RangeError);
    expect(randomBelow(1n, entropy)).toBe(0n);
    const seen = new Set<bigint>();
    for (let round = 0; round < 400; round += 1) {
      const value = randomBelow(5n, entropy);
      expect(value >= 0n && value < 5n).toBe(true);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
    const limit = (1n << 200n) + 12345n;
    for (let round = 0; round < 50; round += 1) expect(randomBelow(limit, entropy) < limit).toBe(true);
    // A power of two as the limit takes every draw: one byte of entropy for 256 values.
    let draws = 0;
    const counting: Entropy = target => { draws += 1; target.fill(0xab); };
    expect(randomBelow(256n, counting)).toBe(0xabn);
    expect(draws).toBe(1);
  });
});
