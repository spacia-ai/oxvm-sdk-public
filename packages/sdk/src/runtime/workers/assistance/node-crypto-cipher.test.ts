import { Buffer } from "buffer/";
import * as native from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable, Stream, Transform, Writable } from "readable-stream";
import { describe, expect, it } from "vitest";
import { record, string } from "../../decode.ts";
import { createCryptoCiphers } from "./node-crypto-cipher.ts";

/** Recorded from Node 24.18.1 (OpenSSL 3.5.7) by the script under the file's `recorder` key. */
const controls = record(JSON.parse(readFileSync(new URL("./node-crypto-cipher.controls.json", import.meta.url), "utf8")), "cipher controls");
const crypto = createCryptoCiphers();

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const items: readonly unknown[] = value;
  return items;
}
function strings(value: unknown, label: string): string[] { return list(value, label).map(item => string(item, label)); }
function numbers(value: unknown, label: string): number[] {
  return list(value, label).map(item => { if (typeof item !== "number") throw new TypeError(`${label} must hold numbers`); return item; });
}
function pattern(length: number, salt = 0): Buffer { return Buffer.from(Array.from({ length }, (_, index) => (index * 7 + 3 + salt) & 255)); }
function hex(bytes: Uint8Array | string): string { if (typeof bytes === "string") throw new TypeError("Expected bytes"); return Buffer.from(bytes).toString("hex"); }
function property(value: unknown, key: string): unknown {
  return typeof value === "function" || (typeof value === "object" && value !== null) ? Reflect.get(value, key) : undefined;
}
/** Calls a method of a value whose static type does not declare it (the host's ciphers, by name). */
function call(target: unknown, method: string, ...args: unknown[]): unknown {
  const operation = property(target, method);
  if (typeof operation !== "function") throw new TypeError(`${method} is not a function`);
  return Reflect.apply(operation, target, args);
}
function bytesOf(value: unknown): Uint8Array { if (!(value instanceof Uint8Array)) throw new TypeError("Expected bytes"); return value; }
function whole(text: string): ArrayBuffer { const bytes = Buffer.from(text, "hex"); return Uint8Array.from(bytes).buffer; }

/** The recorder's argument notation. */
function argument(spec: unknown): unknown {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const fields = record(spec, "argument");
  if (typeof fields["hex"] === "string") return Buffer.from(fields["hex"], "hex");
  if (typeof fields["u8"] === "string") return new Uint8Array(whole(fields["u8"]));
  if (typeof fields["u16"] === "string") return new Uint16Array(whole(fields["u16"]));
  if (typeof fields["ab"] === "string") return whole(fields["ab"]);
  if (typeof fields["dv"] === "string") return new DataView(whole(fields["dv"]));
  if (typeof fields["pat"] === "number") return pattern(fields["pat"], typeof fields["salt"] === "number" ? fields["salt"] : 0);
  if ("undef" in fields) return undefined;
  if ("obj" in fields) return Object.fromEntries(Object.entries(record(fields["obj"], "object argument")).map(([key, value]) => [key, argument(value)]));
  throw new TypeError(`Unknown argument notation ${JSON.stringify(spec)}`);
}
function shown(value: unknown, self: unknown): unknown {
  if (value === undefined) return { undef: true };
  if (value === self) return { self: true };
  if (Buffer.isBuffer(value)) return { hex: value.toString("hex") };
  if (typeof value === "string") return { str: value };
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return { json: copy };
}
function failure(error: unknown): unknown {
  if (!(error instanceof Error)) throw new TypeError("A cipher threw a value that is not an Error");
  return { error: Object.fromEntries([["name", error.name], ["ctor", error.constructor.name], ["message", error.message], ...Object.entries(error)]) };
}
/** Runs recorded steps against this implementation, as the recorder ran them against Node. */
function run(steps: readonly unknown[]): unknown[] {
  let self: unknown;
  const results: unknown[] = [];
  for (const step of steps) {
    const [method, ...specs] = list(step, "step");
    try {
      const args = specs.map(argument);
      let value: unknown;
      if (method === "createCipheriv" || method === "createDecipheriv" || method === "getCipherInfo" || method === "getCiphers") {
        value = call(crypto, method, ...args);
        if (method.startsWith("create")) self = value;
      } else value = call(self, string(method, "method"), ...args);
      results.push(shown(value, self));
    } catch (error) { results.push(failure(error)); if (self === undefined) break; }
  }
  return results;
}

describe("node:crypto ciphers: shape", () => {
  const shape = record(controls["shape"], "shape");
  it("names its functions and classes as Node does", () => {
    const described = list(shape["functions"], "functions").map(item => record(item, "function"));
    for (const { key, name, length } of described) {
      const value: unknown = Reflect.get(crypto, string(key, "key"));
      expect(typeof value).toBe("function");
      expect({ name: property(value, "name"), length: property(value, "length") }).toEqual({ name, length });
    }
  });
  it.each(["Cipheriv", "Decipheriv"] as const)("gives %s Node's prototype", name => {
    const prototype: unknown = crypto[name].prototype;
    const actual = Object.fromEntries(Object.getOwnPropertyNames(prototype).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      const value: unknown = descriptor?.value;
      return [key, { name: property(value, "name"), length: property(value, "length"), enumerable: descriptor?.enumerable }];
    }));
    expect(actual).toEqual(shape[name]);
    expect(Object.keys(actual)).toEqual(Object.keys(record(shape[name], name)));
  });
  it("constructs with and without new, as a Transform", () => {
    expect(shape["callable"]).toBe(true);
    expect(shape["transform"]).toBe(true);
    const key = Buffer.alloc(16), iv = Buffer.alloc(16);
    expect(crypto.Cipheriv("aes-128-cbc", key, iv)).toBeInstanceOf(crypto.Cipheriv);
    expect(crypto.Decipheriv("aes-128-cbc", key, iv)).toBeInstanceOf(crypto.Decipheriv);
    expect(new crypto.Cipheriv("aes-128-cbc", key, iv)).toBeInstanceOf(Transform);
    expect(crypto.createCipheriv("aes-128-cbc", key, iv).constructor).toBe(crypto.Cipheriv);
    expect(crypto.createDecipheriv("aes-128-cbc", key, iv)).toBeInstanceOf(crypto.Decipheriv);
    expect(crypto.createDecipheriv("aes-128-cbc", key, iv)).not.toBeInstanceOf(crypto.Cipheriv);
    expect(crypto.createCipheriv("aes-128-cbc", key, iv)._decoder).toBeNull();
    class Derived extends crypto.Cipheriv {}
    expect(hex(new Derived("aes-128-ecb", key, null).final())).toBe("0143db63ee66b0cdff9f69917680151e");
  });
});

describe("node:crypto ciphers: names", () => {
  const supported = strings(controls["supported"], "supported");
  it("lists exactly the provided ciphers in Node's spelling and order", () => {
    expect(crypto.getCiphers()).toEqual(supported);
    const names = crypto.getCiphers();
    names.length = 0;
    expect(crypto.getCiphers()).toHaveLength(supported.length);
  });
  it("describes every provided cipher as Node does", () => {
    const info = record(controls["info"], "info");
    expect(Object.keys(info)).toEqual(supported);
    for (const name of supported) {
      const actual = crypto.getCipherInfo(name);
      expect(actual, name).toEqual(info[name]);
      expect(Object.keys(actual ?? {}), name).toEqual(Object.keys(record(info[name], name)));
      const nid = record(info[name], name)["nid"];
      expect(crypto.getCipherInfo(nid), name).toEqual(info[name]);
    }
  });
  it("refuses Node's other ciphers as unknown", () => {
    const others = strings(controls["ciphers"], "ciphers").filter(name => !supported.includes(name));
    expect(others).toContain("des-ede3-cbc");
    for (const name of others) {
      expect(() => crypto.createCipheriv(name, Buffer.alloc(32), Buffer.alloc(16)), name).toThrow(expect.objectContaining({ code: "ERR_CRYPTO_UNKNOWN_CIPHER", message: "Unknown cipher" }));
      expect(crypto.getCipherInfo(name), name).toBeUndefined();
    }
  });
});

describe("node:crypto ciphers: recorded behaviour", () => {
  const cases = record(controls["cases"], "cases");
  // Node describes ciphers this runtime lacks; the last step of `info` is not one of them.
  it.each(Object.keys(cases))("%s", id => {
    const recorded = record(cases[id], id);
    expect(run(list(recorded["steps"], "steps"))).toEqual(recorded["results"]);
  });
});

interface Vector {
  readonly alg: string; readonly key: Buffer; readonly iv: Buffer | null; readonly aad: Buffer | undefined; readonly options: { authTagLength: number } | undefined;
  readonly size: number; readonly cuts: number[]; readonly ct: Buffer; readonly tag: Buffer | undefined;
  readonly encLengths: number[]; readonly decCuts: number[]; readonly decLengths: number[];
}
function vector(value: unknown): Vector {
  const fields = record(value, "vector");
  const bytes = (key: string): Buffer | undefined => (typeof fields[key] === "string" ? Buffer.from(fields[key], "hex") : undefined);
  const size = fields["size"], tagLength = fields["authTagLength"];
  if (typeof size !== "number") throw new TypeError("vector size");
  return {
    alg: string(fields["alg"], "alg"), key: bytes("key") ?? Buffer.alloc(0), iv: bytes("iv") ?? null, aad: bytes("aad"), tag: bytes("tag"), ct: bytes("ct") ?? Buffer.alloc(0),
    options: typeof tagLength === "number" ? { authTagLength: tagLength } : undefined, size,
    cuts: numbers(fields["cuts"], "cuts"), encLengths: numbers(fields["encLengths"], "encLengths"), decCuts: numbers(fields["decCuts"], "decCuts"), decLengths: numbers(fields["decLengths"], "decLengths"),
  };
}
function pieces(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const cut of [...cuts, bytes.length]) { out.push(bytes.subarray(at, cut)); at = cut; }
  return out;
}
function raw(value: Uint8Array | string): Uint8Array { if (typeof value === "string") throw new TypeError("Expected bytes"); return value; }
const aadOptions = (entry: Vector): { plaintextLength: number } | undefined => (entry.alg.includes("ccm") ? { plaintextLength: entry.size } : undefined);
function decrypt(entry: Vector, change: { ct?: Uint8Array; tag?: Uint8Array; aad?: Uint8Array } = {}): Uint8Array[] {
  const decipher = crypto.createDecipheriv(entry.alg, entry.key, entry.iv, entry.options);
  const tag = change.tag ?? entry.tag, aad = change.aad ?? entry.aad;
  if (tag !== undefined) decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(aad, aadOptions(entry));
  const out = pieces(change.ct ?? entry.ct, entry.decCuts).map(piece => raw(decipher.update(piece)));
  out.push(raw(decipher.final()));
  return out;
}
function flipped(bytes: Uint8Array, index: number): Uint8Array { const copy = Buffer.from(bytes); copy[index] = (copy[index] ?? 0) ^ 1; return copy; }

describe("node:crypto ciphers: vectors recorded from Node", () => {
  const vectors = list(controls["vectors"], "vectors").map(vector);
  const algorithms = [...new Set(vectors.map(entry => entry.alg))];
  it("covers every cipher family with at least eight cases", () => {
    for (const alg of algorithms) expect(vectors.filter(entry => entry.alg === alg).length, alg).toBeGreaterThanOrEqual(8);
    const families = new Set(crypto.getCiphers().map(name => crypto.getCipherInfo(name)?.nid));
    expect(new Set(algorithms.map(alg => crypto.getCipherInfo(alg)?.nid))).toEqual(families);
  });
  it.each(algorithms)("%s encrypts to Node's bytes, chunk by chunk", alg => {
    for (const entry of vectors.filter(candidate => candidate.alg === alg)) {
      const cipher = crypto.createCipheriv(entry.alg, entry.key, entry.iv, entry.options);
      if (entry.aad !== undefined) cipher.setAAD(entry.aad, aadOptions(entry));
      const out = pieces(pattern(entry.size), entry.cuts).map(piece => raw(cipher.update(piece)));
      out.push(raw(cipher.final()));
      const label = `${alg} ${String(entry.size)} bytes`;
      expect(hex(Buffer.concat(out)), label).toBe(hex(entry.ct));
      expect(out.map(piece => piece.length), label).toEqual(entry.encLengths);
      if (entry.tag !== undefined) expect(hex(cipher.getAuthTag()), label).toBe(hex(entry.tag));
    }
  });
  it.each(algorithms)("%s decrypts Node's bytes, chunk by chunk", alg => {
    for (const entry of vectors.filter(candidate => candidate.alg === alg)) {
      const out = decrypt(entry);
      const label = `${alg} ${String(entry.size)} bytes`;
      expect(hex(Buffer.concat(out)), label).toBe(hex(pattern(entry.size)));
      expect(out.map(piece => piece.length), label).toEqual(entry.decLengths);
    }
  });
  it.each(algorithms.filter(alg => /gcm|ccm|ocb|poly1305/u.test(alg)))("%s refuses a changed ciphertext, tag or additional data", alg => {
    const unauthentic = "Unsupported state or unable to authenticate data";
    for (const entry of vectors.filter(candidate => candidate.alg === alg)) {
      const tag = entry.tag ?? Buffer.alloc(0);
      expect(() => decrypt(entry, { tag: flipped(tag, tag.length - 1) }), "tag").toThrow(unauthentic);
      if (entry.ct.length > 0) expect(() => decrypt(entry, { ct: flipped(entry.ct, entry.ct.length >> 1) }), "ciphertext").toThrow(unauthentic);
      const aad = entry.aad;
      if (aad !== undefined) expect(() => decrypt(entry, { aad: flipped(aad, 0) }), "aad").toThrow(unauthentic);
    }
  });
  it("fails to unwrap a changed wrapped key", () => {
    for (const entry of vectors.filter(candidate => candidate.alg.endsWith("-wrap"))) {
      expect(() => decrypt(entry, { ct: flipped(entry.ct, 9) })).toThrow("Trying to add data in unsupported state");
    }
  });
});

/** A small deterministic generator for chunk sizes. */
function sizes(seed: number, total: number): number[] {
  const out: number[] = [];
  let state = seed, left = total;
  while (left > 0) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const size = Math.min(left, (state >>> 16) % 97);
    out.push(size); left -= size;
  }
  return out;
}
describe("node:crypto ciphers: against the host's OpenSSL", () => {
  const streaming = crypto.getCiphers().filter(name => !/ccm|wrap/iu.test(name));
  it.each(streaming)("%s agrees over irregular chunks in both directions", name => {
    const info = crypto.getCipherInfo(name);
    if (info === undefined) throw new Error(`No info for ${name}`);
    const key = pattern(info.keyLength, 31), iv = info.ivLength === undefined ? null : pattern(info.ivLength, 77), plain = pattern(5000, 5);
    const options = info.mode === "ocb" ? { authTagLength: 16 } : undefined;
    const aead = /gcm|ocb|poly1305/iu.test(name);
    const reference = call(native, "createCipheriv", name, key, iv, options);
    if (aead) call(reference, "setAAD", pattern(21, 1));
    const expected = Buffer.concat([bytesOf(call(reference, "update", plain)), bytesOf(call(reference, "final"))]);
    const cipher = crypto.createCipheriv(name, key, iv, options);
    if (aead) cipher.setAAD(pattern(21, 1));
    const out: Uint8Array[] = [];
    let at = 0;
    for (const size of sizes(7, plain.length)) { out.push(raw(cipher.update(plain.subarray(at, at + size)))); at += size; }
    out.push(raw(cipher.final()));
    expect(hex(Buffer.concat(out))).toBe(hex(expected));
    const decipher = crypto.createDecipheriv(name, key, iv, options);
    if (aead) {
      const tag = bytesOf(call(reference, "getAuthTag"));
      expect(hex(cipher.getAuthTag())).toBe(hex(tag));
      decipher.setAuthTag(tag); decipher.setAAD(pattern(21, 1));
    }
    const back: Uint8Array[] = [];
    at = 0;
    for (const size of sizes(11, expected.length)) { back.push(raw(decipher.update(expected.subarray(at, at + size)))); at += size; }
    back.push(raw(decipher.final()));
    expect(hex(Buffer.concat(back))).toBe(hex(plain));
  });
  it("matches a megabyte of AES-256-GCM, AES-256-CBC and ChaCha20-Poly1305", () => {
    const plain = pattern(1 << 20, 2);
    for (const [name, ivLength] of [["aes-256-gcm", 12], ["aes-256-cbc", 16], ["chacha20-poly1305", 12], ["aes-256-ctr", 16]] as const) {
      const key = pattern(32, 3), iv = pattern(ivLength, 4);
      const reference = native.createCipheriv(name, key, iv);
      const cipher = crypto.createCipheriv(name, key, iv);
      const actual = Buffer.concat([raw(cipher.update(plain.subarray(0, 300_001))), raw(cipher.update(plain.subarray(300_001))), raw(cipher.final())]);
      expect(native.createHash("sha256").update(actual).digest("hex"), name).toBe(native.createHash("sha256").update(reference.update(plain)).update(reference.final()).digest("hex"));
    }
  });
});

describe("node:crypto ciphers: keys and streams", () => {
  const key = pattern(32, 8), iv = pattern(12, 9);
  it("takes a KeyObject's bytes from the key port before reading the key itself", () => {
    const keyObject = { type: "secret" };
    const withKeys = createCryptoCiphers({ keyBytes: value => (value === keyObject ? key : undefined) });
    const viaObject = withKeys.createCipheriv("aes-256-gcm", keyObject, iv), direct = withKeys.createCipheriv("aes-256-gcm", key, iv);
    expect(hex(raw(viaObject.update("text")))).toBe(hex(raw(direct.update("text"))));
    expect(() => crypto.createCipheriv("aes-256-gcm", keyObject, iv)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => withKeys.createCipheriv("aes-256-gcm", { type: "secret" }, iv)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  });
  it("round-trips through stream.pipeline", async () => {
    const plain = pattern(100_000, 6);
    const run = (source: Uint8Array[], through: Transform): Promise<Buffer> => new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(bytesOf(chunk)); done(); } });
      Stream.pipeline(Readable.from(source), through, sink, error => { if (error instanceof Error) reject(error); else resolve(Buffer.concat(chunks)); });
    });
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const sealed = await run([plain.subarray(0, 7), plain.subarray(7, 65_000), plain.subarray(65_000)], cipher);
    const reference = native.createCipheriv("aes-256-gcm", key, iv);
    expect(hex(sealed)).toBe(Buffer.concat([reference.update(plain), reference.final()]).toString("hex"));
    expect(hex(cipher.getAuthTag())).toBe(reference.getAuthTag().toString("hex"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv).setAuthTag(cipher.getAuthTag());
    expect(hex(await run([sealed.subarray(0, 33), sealed.subarray(33)], decipher))).toBe(hex(plain));
    const forged = crypto.createDecipheriv("aes-256-gcm", key, iv).setAuthTag(Buffer.alloc(16));
    await expect(run([sealed], forged)).rejects.toThrow("Unsupported state or unable to authenticate data");
  });
  it("encrypts written chunks and flushes the padding on end", async () => {
    const cipher = crypto.createCipheriv("aes-256-cbc", key, pattern(16, 9));
    const chunks: Uint8Array[] = [];
    cipher.on("data", chunk => { chunks.push(bytesOf(chunk)); });
    const ended = new Promise<void>((resolve, reject) => { cipher.on("end", () => { resolve(); }); cipher.on("error", error => { reject(error instanceof Error ? error : new Error("stream failed")); }); });
    cipher.write("hello ");
    cipher.write("776f726c64", "hex");
    cipher.write(Buffer.from("!"));
    cipher.end();
    await ended;
    const reference = native.createCipheriv("aes-256-cbc", key, pattern(16, 9));
    expect(hex(Buffer.concat(chunks))).toBe(Buffer.concat([reference.update("hello world!"), reference.final()]).toString("hex"));
    expect(() => cipher.final()).toThrow(expect.objectContaining({ code: "ERR_CRYPTO_INVALID_STATE" }));
  });
  it("hands a bad final block to the stream's error event", async () => {
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, pattern(16, 9));
    const failed = new Promise<unknown>(resolve => { decipher.on("error", resolve); });
    decipher.resume();
    decipher.end(Buffer.alloc(15));
    expect(await failed).toMatchObject({ code: "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH", reason: "wrong final block length", library: "Provider routines" });
  });
});
