// Big-integer arithmetic for the fast-path `node:crypto`: byte conversion, modular exponentiation and
// inversion, and uniform random integers. Pure functions over native BigInt; nothing here knows about keys.
//
// BigInt arithmetic is not constant-time. The RSA layer blinds private operations so that the values these
// functions see do not depend on attacker-chosen input alone.

/** Fills the given bytes with entropy (`crypto.getRandomValues` in production, a fixed stream in tests). */
export type Entropy = (bytes: Uint8Array) => void;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/** Big-endian unsigned bytes to an integer. Empty input is zero. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let hex = "";
  for (const byte of bytes) hex += HEX[byte] ?? "";
  return BigInt(`0x${hex}`);
}

/** Big-endian unsigned bytes of a non-negative integer: minimal (zero is one byte) or left-padded to `length`. */
export function bigIntToBytes(value: bigint, length?: number): Uint8Array {
  if (value < 0n) throw new RangeError("A negative integer has no unsigned byte encoding");
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const size = hex.length / 2;
  const total = length ?? size;
  if (!Number.isInteger(total) || total < 0) throw new RangeError("The byte length must be a non-negative integer");
  const significant = value === 0n ? 0 : size;
  if (significant > total) throw new RangeError(`The integer needs ${String(significant)} bytes and does not fit in ${String(total)}`);
  const bytes = new Uint8Array(total);
  const offset = total - size;
  for (let index = Math.max(0, -offset); index < size; index += 1) bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** Number of bits in the magnitude of the integer; zero has none. */
export function bitLength(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  if (magnitude === 0n) return 0;
  const hex = magnitude.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(Number.parseInt(hex.charAt(0), 16)));
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The inverse of `value` modulo `modulus`, in [0, modulus). Throws RangeError when there is none. */
export function modInverse(value: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) throw new RangeError("The modulus must be positive");
  let r0 = modulus;
  let r1 = ((value % modulus) + modulus) % modulus;
  let s0 = 0n;
  let s1 = 1n;
  while (r1 !== 0n) {
    const quotient = r0 / r1;
    [r0, r1] = [r1, r0 - quotient * r1];
    [s0, s1] = [s1, s0 - quotient * s1];
  }
  if (r0 !== 1n) throw new RangeError("The value has no inverse for this modulus");
  return s0 < 0n ? s0 + modulus : s0 % modulus;
}

// Window width by exponent size, the thresholds OpenSSL's BN_window_bits_for_exponent_size uses.
function windowBits(exponentBits: number): number {
  if (exponentBits > 671) return 6;
  if (exponentBits > 239) return 5;
  if (exponentBits > 79) return 4;
  if (exponentBits > 23) return 3;
  return 1;
}

// Left-to-right sliding-window exponentiation over any ring given as `multiply` (which also reduces).
function slidingWindow(base: bigint, exponent: bigint, one: bigint, multiply: (a: bigint, b: bigint) => bigint): bigint {
  const bits = exponent.toString(2);
  const width = windowBits(bits.length);
  // Odd powers base^1, base^3, ..., base^(2^width - 1).
  const odd: bigint[] = [base];
  if (width > 1) {
    const square = multiply(base, base);
    let power = base;
    for (let index = 1; index < 1 << (width - 1); index += 1) { power = multiply(power, square); odd.push(power); }
  }
  let result = one;
  let position = 0;
  while (position < bits.length) {
    if (bits.charCodeAt(position) === 48) { result = multiply(result, result); position += 1; continue; }
    let end = Math.min(position + width, bits.length) - 1;
    while (bits.charCodeAt(end) === 48) end -= 1;
    for (let index = position; index <= end; index += 1) result = multiply(result, result);
    const power = odd[Number.parseInt(bits.slice(position, end + 1), 2) >> 1];
    if (power === undefined) throw new RangeError("The exponent window is out of range");
    result = multiply(result, power);
    position = end + 1;
  }
  return result;
}

// Measured in Node 24 and 26: `%` after each product wins up to about 2048-bit moduli, Montgomery
// reduction (two masked products and a shift instead of a division) wins by about a tenth from 3072 bits.
const MONTGOMERY_FROM_BITS = 3000;

function montgomeryPow(base: bigint, exponent: bigint, modulus: bigint, modulusBits: number): bigint {
  const width = Math.ceil(modulusBits / 64) * 64;
  const shift = BigInt(width);
  const radix = 1n << shift;
  const negatedInverse = radix - modInverse(modulus, radix);
  const reduce = (value: bigint): bigint => {
    const factor = BigInt.asUintN(width, BigInt.asUintN(width, value) * negatedInverse);
    const reduced = (value + factor * modulus) >> shift;
    return reduced >= modulus ? reduced - modulus : reduced;
  };
  const multiply = (a: bigint, b: bigint): bigint => reduce(a * b);
  return reduce(slidingWindow((base << shift) % modulus, exponent, radix % modulus, multiply));
}

/** `base ** exponent mod modulus` for a non-negative exponent and a positive modulus. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) throw new RangeError("The modulus must be positive");
  if (exponent < 0n) throw new RangeError("The exponent must not be negative");
  if (modulus === 1n) return 0n;
  const reduced = ((base % modulus) + modulus) % modulus;
  if (exponent === 0n) return 1n;
  if (exponent === 1n) return reduced;
  const modulusBits = bitLength(modulus);
  if (modulusBits >= MONTGOMERY_FROM_BITS && (modulus & 1n) === 1n) return montgomeryPow(reduced, exponent, modulus, modulusBits);
  return slidingWindow(reduced, exponent, 1n, (a, b) => (a * b) % modulus);
}

/** An integer of exactly `bits` random bits: uniform in [0, 2^bits). The top bit is not forced. */
export function randomBigInt(bits: number, entropy: Entropy): bigint {
  if (!Number.isInteger(bits) || bits < 0) throw new RangeError("The bit count must be a non-negative integer");
  if (bits === 0) return 0n;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  entropy(bytes);
  const spare = bytes.length * 8 - bits;
  const first = bytes[0] ?? 0;
  bytes[0] = first & (0xff >> spare);
  return bytesToBigInt(bytes);
}

/** Uniform in [0, limit): draws as many bits as the limit has and rejects values that are too large. */
export function randomBelow(limit: bigint, entropy: Entropy): bigint {
  if (limit <= 0n) throw new RangeError("The limit must be positive");
  const bits = bitLength(limit - 1n);
  for (;;) {
    const candidate = randomBigInt(bits, entropy);
    if (candidate < limit) return candidate;
  }
}
