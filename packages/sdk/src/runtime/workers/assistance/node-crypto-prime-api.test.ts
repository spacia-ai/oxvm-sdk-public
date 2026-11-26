import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { decodeArgument, loadControls, replay, testPorts } from "./node-crypto-keygen.test-support.js";
import { createCryptoPrimes } from "./node-crypto-prime-api.js";
import { isProbablePrime } from "./node-crypto-primes.js";

/** Recorded from Node.js v24.18.1 by the script under the file's `recorder` key. */
const { document, cases } = loadControls("./node-crypto-prime-api.controls.json");
const ports = testPorts();
const crypto = createCryptoPrimes(ports);
const entropy = (bytes: Uint8Array): void => { bytes.set(globalThis.crypto.getRandomValues(new Uint8Array(bytes.length))); };
const prime = (value: bigint): boolean => isProbablePrime(value, 16, entropy);
const never = (): boolean => false;

interface PrimeOptions { readonly safe?: boolean; readonly add?: bigint; readonly rem?: bigint }
function integer(value: unknown): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value;
  if (value instanceof ArrayBuffer) return BigInt(`0x${Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("") || "0"}`);
  if (ArrayBuffer.isView(value)) return integer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return undefined;
}
/** The options of a generatePrime case, decoded. */
function optionsOf(args: readonly unknown[]): PrimeOptions {
  const options = decodeArgument(args[1], () => undefined);
  if (typeof options !== "object" || options === null) return {};
  const add = integer(Reflect.get(options, "add")), rem = integer(Reflect.get(options, "rem"));
  return { safe: Reflect.get(options, "safe") === true, ...(add === undefined ? {} : { add }), ...(rem === undefined ? {} : { rem }) };
}
function generated(size: number, options: PrimeOptions): bigint {
  const value = crypto.generatePrimeSync(size, { ...options, bigint: true });
  if (typeof value !== "bigint") throw new TypeError("Not a bigint");
  return value;
}
function expectResidue(value: bigint, options: PrimeOptions): void {
  expect(prime(value)).toBe(true);
  if (options.safe === true) expect(prime(value >> 1n)).toBe(true);
  if (options.add !== undefined) expect(value % options.add).toBe((options.rem ?? (options.safe === true ? 3n : 1n)) % options.add);
}

describe("generatePrime and checkPrime against recorded Node.js v24.18.1", () => {
  for (const item of cases) {
    it(`${item.fn} ${JSON.stringify(item.args).slice(0, 150)}`, async () => {
      const got = await replay(item, Reflect.get(crypto, item.fn), never);
      const options = optionsOf(item.args), size = item.args[0];
      if (item.result["hangs"] === true) {
        // Node never returns. A check for primality answers here; a search either finds the next prime of the
        // residue class or says that there is none.
        if (item.fn === "checkPrimeSync") { expect(got.returned).toEqual({ t: "boolean", v: true }); return; }
        if (got.threw !== undefined) { expect([got.threw["name"], String(got.threw["message"]).includes("Node.js would search without end")]).toEqual(["RangeError", true]); return; }
        if (typeof size !== "number") throw new TypeError("Missing size");
        expectResidue(generated(size, options), options);
        return;
      }
      if (options.add !== undefined && got.returned?.["t"] === "bigint") {
        // With `add` OpenSSL walks past the requested size when it has to; the length is not fixed.
        expect(record(item.result["returned"], "returned")["t"]).toBe("bigint");
        if (typeof size !== "number") throw new TypeError("Missing size");
        for (let index = 0; index < 5; index += 1) expectResidue(generated(size, options), options);
        return;
      }
      expect(got).toEqual(item.result);
      expect(ports.held()).toBe(0);
    }, 60_000);
  }

  it("has Node's function names and arities", () => {
    expect(Object.entries(crypto).map(([name, operation]) => [name, operation.name, operation.length, Object.getOwnPropertyNames(operation).sort()])).toEqual([
      ["generatePrime", "generatePrime", 3, ["length", "name", "prototype"]], ["generatePrimeSync", "generatePrimeSync", 1, ["length", "name", "prototype"]],
      ["checkPrime", "checkPrime", 1, ["length", "name", "prototype"]], ["checkPrimeSync", "checkPrimeSync", 1, ["length", "name", "prototype"]],
    ]);
  });
});

describe("the primes generatePrime makes", () => {
  const shapes = record(document["primeShapes"], "primeShapes");
  const shapeCases: [string, number, PrimeOptions][] = [["b2", 2, {}], ["b3", 3, {}], ["b4", 4, {}], ["b5", 5, {}], ["b8", 8, {}], ["safe3", 3, { safe: true }], ["safe6", 6, { safe: true }],
    ["safe7", 7, { safe: true }], ["safe8", 8, { safe: true }], ["b8add128", 8, { add: 128n, rem: 1n }], ["b3add5rem2", 3, { add: 5n, rem: 2n }], ["b2add3rem2", 2, { add: 3n, rem: 2n }],
    ["b2add3rem0", 2, { add: 3n, rem: 0n }], ["b8add250rem7", 8, { add: 250n, rem: 7n }], ["b4add1", 4, { add: 1n }]];
  it.each(shapeCases)("small sizes give the primes Node gives: %s", (name, size, options) => {
    const recorded = record(shapes[name], name)["distinct"];
    if (!Array.isArray(recorded)) throw new TypeError("No recorded primes");
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) seen.add(String(generated(size, options)));
    expect([...seen].filter(value => !recorded.includes(value))).toEqual([]);
    if (recorded.length <= 2) expect(seen.size).toBe(recorded.length);
  });

  it.each([[64, {}], [256, {}], [1024, {}], [128, { safe: true }], [64, { add: 7n }], [64, { add: 12n, rem: 5n }], [96, { safe: true, add: 12n, rem: 11n }]] as const)("%i bits %o", (size, options) => {
    const value = generated(size, options);
    expectResidue(value, options);
    expect(value.toString(2).length).toBe(size);
    // Without `add` the two top bits are set; with it only the top one is forced.
    if (!("add" in options)) expect(value >> BigInt(size - 2)).toBe(3n);
    const buffer = crypto.generatePrimeSync(size, options);
    expect(buffer instanceof ArrayBuffer && buffer.byteLength).toBe(Math.ceil(size / 8));
  });

  it("an ArrayBuffer result is the big-endian prime", () => {
    const buffer = crypto.generatePrimeSync(40);
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError("Not an ArrayBuffer");
    expect(crypto.checkPrimeSync(buffer)).toBe(true);
    expect(crypto.checkPrimeSync(new Uint8Array(buffer))).toBe(true);
    expect(new Uint8Array(buffer)[0]).toBeGreaterThanOrEqual(0xc0);
  });

  it("says so when no prime can satisfy add and rem, in both forms", async () => {
    expect(() => crypto.generatePrimeSync(32, { add: 12n, rem: 4n })).toThrow(/no prime satisfies options\.add and options\.rem; Node\.js would search without end/u);
    const args = await new Promise<unknown[]>(resolve => { crypto.generatePrime(32, { add: 7n, rem: 0n }, (...given: unknown[]) => { resolve(given); }); });
    expect(args).toHaveLength(1);
    expect(args[0]).toBeInstanceOf(RangeError);
    expect(ports.held()).toBe(0);
  });
});

describe("checkPrime", () => {
  it("answers for large primes and composites, with any number of checks", () => {
    const mersenne = 2n ** 2203n - 1n;
    expect(crypto.checkPrimeSync(mersenne)).toBe(true);
    expect(crypto.checkPrimeSync(mersenne, { checks: 3 })).toBe(true);
    expect(crypto.checkPrimeSync(mersenne * (2n ** 127n - 1n))).toBe(false);
    expect(crypto.checkPrimeSync(mersenne + 2n, { checks: 1 })).toBe(false);
    // A strong pseudoprime to the bases 2, 3, 5 and 7: random bases find it out.
    expect(crypto.checkPrimeSync(3_215_031_751n, { checks: 2_147_483_647 })).toBe(false);
  });

  it("the callback form yields between rounds and holds the process until it answers", async () => {
    ports.turns.length = 0;
    const pending = new Promise<unknown[]>(resolve => { crypto.checkPrime(2n ** 4423n - 1n, { checks: 24 }, (...args: unknown[]) => { resolve(args); }); });
    expect(ports.held()).toBe(1);
    expect(await pending).toEqual([undefined, true]);
    expect(ports.held()).toBe(0);
    expect(ports.turns.length).toBeGreaterThan(1);
  }, 60_000);
});
