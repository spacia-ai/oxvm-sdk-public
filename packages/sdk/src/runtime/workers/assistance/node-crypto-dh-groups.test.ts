import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { bitLength } from "./node-crypto-bigint.ts";
import { DH_GROUPS, FFDHE_GROUPS, dhGroup } from "./node-crypto-dh-groups.ts";
import { isProbablePrime } from "./node-crypto-primes.ts";

// Recorded from real Node 24.18.1: `getDiffieHellman(name).getPrime('hex')` for every MODP group, and Node's
// refusal of the RFC 7919 names. The RFC 7919 primes come from OpenSSL's command line (same file).
const control = record(JSON.parse(readFileSync(new URL("./node-crypto-dh-groups.controls.json", import.meta.url), "utf8")), "dh controls");
const modp = record(control["modp"], "modp");
const cli = record(record(control["opensslCli"], "opensslCli")["groups"], "groups");
const fixed = (seed: number) => (target: Uint8Array): void => { for (let index = 0; index < target.length; index += 1) target[index] = (seed * (index + 1) * 2654435761) >>> 24; };

// floor(constant * 2^bits) for pi and e, by exact integer series with guard bits.
function piTimes(bits: number): bigint {
  const guard = 64n;
  const one = 1n << (BigInt(bits) + guard);
  // Machin: pi = 16 atan(1/5) - 4 atan(1/239).
  const arctanInverse = (x: bigint): bigint => {
    let sum = 0n;
    let power = one / x;
    for (let k = 0n; power !== 0n; k += 1n) { sum += (k % 2n === 0n ? power : -power) / (2n * k + 1n); power /= x * x; }
    return sum;
  };
  return (16n * arctanInverse(5n) - 4n * arctanInverse(239n)) >> guard;
}
function eTimes(bits: number): bigint {
  const guard = 64n;
  let term = 1n << (BigInt(bits) + guard);
  let sum = 0n;
  for (let k = 1n; term !== 0n; k += 1n) { sum += term; term /= k; }
  return sum >> guard;
}

describe("fixed Diffie-Hellman groups", () => {
  it("holds exactly Node's MODP groups with Node's primes", () => {
    expect(control["node"]).toEqual({ version: "v24.18.1", openssl: "3.5.7" });
    expect(Object.keys(DH_GROUPS)).toEqual(["modp1", "modp2", "modp5", "modp14", "modp15", "modp16", "modp17", "modp18"]);
    expect(Object.keys(modp)).toEqual(Object.keys(DH_GROUPS));
    for (const [name, group] of Object.entries(DH_GROUPS)) {
      const recorded = record(modp[name], name);
      expect(group.prime.toString(16), name).toBe(string(recorded["prime"], "prime"));
      expect(group.generator.toString(16).padStart(2, "0")).toBe(recorded["generator"]);
      expect([recorded["verifyError"], recorded["sameFromCreate"]]).toEqual([0, true]);
    }
    expect(Object.entries(DH_GROUPS).map(([, group]) => bitLength(group.prime))).toEqual([768, 1024, 1536, 2048, 3072, 4096, 6144, 8192]);
    expect(Object.isFrozen(DH_GROUPS) && Object.isFrozen(DH_GROUPS["modp14"])).toBe(true);
  });

  it("rebuilds every MODP prime from the formula of RFC 2409 and RFC 3526", () => {
    // p = 2^n - 2^(n-64) - 1 + 2^64 * (floor(2^(n-130) * pi) + offset)
    const offsets: Readonly<Record<string, bigint>> = { modp1: 149686n, modp2: 129093n, modp5: 741804n, modp14: 124476n, modp15: 1690314n, modp16: 240904n, modp17: 929484n, modp18: 4743158n };
    for (const [name, group] of Object.entries(DH_GROUPS)) {
      const bits = bitLength(group.prime);
      const size = BigInt(bits);
      const offset = offsets[name];
      if (offset === undefined) throw new Error(name);
      expect((1n << size) - (1n << (size - 64n)) - 1n + ((piTimes(bits - 130) + offset) << 64n), name).toBe(group.prime);
    }
  });

  it("holds safe primes (checked for the two smallest groups)", () => {
    for (const name of ["modp1", "modp2"]) {
      const prime = DH_GROUPS[name]?.prime ?? 0n;
      expect([isProbablePrime(prime, 4, fixed(3)), isProbablePrime(prime >> 1n, 4, fixed(5))], name).toEqual([true, true]);
    }
  });

  it("looks a group up as Node does: any letter case, nothing else", () => {
    const unknown = record(control["unknown"], "unknown");
    expect(record(unknown["getDiffieHellman"], "unknown")["code"]).toBe("ERR_CRYPTO_UNKNOWN_DH_GROUP");
    expect(unknown["upperCase"]).toBe(512);
    expect(dhGroup("MODP14")).toBe(DH_GROUPS["modp14"]);
    expect(dhGroup("modp18")?.generator).toBe(2n);
    for (const name of ["modp3", "", "ffdhe2048", "constructor", "__proto__", "toString"]) expect(dhGroup(name), name).toBeUndefined();
  });

  it("keeps the RFC 7919 groups apart, because Node 24 refuses their names", () => {
    const refused = record(control["ffdhe"], "ffdhe");
    expect(Object.keys(FFDHE_GROUPS)).toEqual(["ffdhe2048", "ffdhe3072", "ffdhe4096", "ffdhe6144", "ffdhe8192"]);
    for (const name of Object.keys(FFDHE_GROUPS)) {
      const row = record(refused[name], name);
      expect([record(row["getDiffieHellman"], name)["code"], record(row["keyPair"], name)["code"]]).toEqual(["ERR_CRYPTO_UNKNOWN_DH_GROUP", "ERR_CRYPTO_UNKNOWN_DH_GROUP"]);
      expect(Object.hasOwn(DH_GROUPS, name)).toBe(false);
    }
  });

  it("holds OpenSSL's RFC 7919 primes, which are the RFC's formula", () => {
    // The same extraction gives Node's primes for the two MODP groups OpenSSL names, so the method is sound.
    expect(string(record(cli["modp_1536"], "modp_1536")["prime"], "prime")).toBe(DH_GROUPS["modp5"]?.prime.toString(16));
    expect(string(record(cli["modp_2048"], "modp_2048")["prime"], "prime")).toBe(DH_GROUPS["modp14"]?.prime.toString(16));
    // p = 2^n - 2^(n-64) + (floor(2^(n-130) * e) + offset) * 2^64 - 1
    const offsets: Readonly<Record<string, bigint>> = { ffdhe2048: 560316n, ffdhe3072: 2625351n, ffdhe4096: 5736041n, ffdhe6144: 15705020n, ffdhe8192: 10965728n };
    for (const [name, group] of Object.entries(FFDHE_GROUPS)) {
      const bits = Number(name.slice(5));
      const size = BigInt(bits);
      const offset = offsets[name];
      if (offset === undefined) throw new Error(name);
      expect(group.prime.toString(16), name).toBe(string(record(cli[name], name)["prime"], "prime"));
      expect([bitLength(group.prime), group.generator]).toEqual([bits, 2n]);
      expect((1n << size) - (1n << (size - 64n)) + ((eTimes(bits - 130) + offset) << 64n) - 1n, name).toBe(group.prime);
    }
    const smallest = FFDHE_GROUPS["ffdhe2048"]?.prime ?? 0n;
    expect([isProbablePrime(smallest, 2, fixed(7)), isProbablePrime(smallest >> 1n, 2, fixed(9))]).toEqual([true, true]);
  });
});
