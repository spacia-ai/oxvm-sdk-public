/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/diffiehellman.js (dhComputeSecret, dhGetPrivateKey,
 * setPublicKey, setPrivateKey, encode) and lib/buffer.js (the encoding names).
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
// What `DiffieHellman`, `DiffieHellmanGroup` and `ECDH` have in common. In Node the three classes share
// prototype functions (`ECDH.prototype.computeSecret === DiffieHellman.prototype.computeSecret`), so the
// functions live here, once, and each class registers what holds its keys.
import { Buffer } from "buffer/";
import type { Entropy } from "./node-crypto-bigint.ts";
import { bytesOf } from "./node-crypto-key-encoding.ts";
import { codedError } from "./node-crypto-key-errors.ts";
import { truthy } from "./node-crypto-misc.ts";
import { base64Encode } from "./node-crypto-pem.ts";
import { inspectValue, named } from "./node-util-validators.ts";

const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
/** Fills `bytes` from the browser's entropy, which hands out at most 65536 bytes a call. */
export const entropy: Entropy = bytes => {
  for (let start = 0; start < bytes.length; start += 65_536) bytes.set(getRandomValues(new Uint8Array(Math.min(65_536, bytes.length - start))), start);
};

/** The key holder behind an instance: Node's native handle. */
export interface SecretHandle {
  /** The shared secret; `undefined` where Node's binding answers that the peer's key is not valid for the curve. */
  computeSecret(key: Uint8Array): Uint8Array | undefined;
  setPublicKey(key: Uint8Array): void;
  setPrivateKey(key: Uint8Array): void;
  getPrivateKey(): Uint8Array;
}

const handles = new WeakMap<object, SecretHandle>();
export function adopt(instance: object, handle: SecretHandle): void { handles.set(instance, handle); }
/** Whether `value` is an instance of the constructor function: what `this instanceof DiffieHellman` asks. */
export function madeBy(value: unknown, constructor: (...args: never[]) => unknown): value is object {
  return typeof value === "object" && value !== null && value instanceof constructor;
}
/** A value that is not one of the instances has no handle; Node fails reading a member of `undefined`. */
export function missingHandle(member: string): TypeError { return new TypeError(`Cannot read properties of undefined (reading '${member}')`); }
function handleOf(value: unknown, member: string): SecretHandle {
  const handle = typeof value === "object" && value !== null ? handles.get(value) : undefined;
  if (handle === undefined) throw missingHandle(member);
  return handle;
}

/** `%s` of Node's error messages: a string as it is, a primitive as text, an object as `util.inspect` shows it. */
export function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "number" && Object.is(value, -0)) return "-0";
  if (typeof value === "symbol") return value.toString();
  return (typeof value === "object" && value !== null) || typeof value === "function" ? inspectValue(value) : String(value);
}

type Encoding = "utf8" | "utf16le" | "latin1" | "base64" | "base64url" | "hex" | "ascii";
function encodingOf(name: string): Encoding | undefined {
  switch (name.toLowerCase()) {
    case "utf8": case "utf-8": return "utf8";
    case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": return "utf16le";
    case "latin1": case "binary": return "latin1";
    case "base64": return "base64";
    case "base64url": return "base64url";
    case "hex": return "hex";
    case "ascii": return "ascii";
    default: return undefined;
  }
}
/** `Buffer.isEncoding`, with the encodings Node 24 knows (the `buffer` package predates base64url). */
export function isEncoding(value: unknown): value is string { return typeof value === "string" && encodingOf(value) !== undefined; }

/**
 * Node's `encode`: a Buffer, or its text when an encoding other than `'buffer'` is given. An encoding Node does
 * not know is ERR_UNKNOWN_ENCODING, as `buffer.toString` reports it.
 */
export function encode(bytes: Uint8Array, encoding: unknown): Buffer | string {
  const buffer = Buffer.from(bytes);
  if (!truthy(encoding) || encoding === "buffer") return buffer;
  const known = typeof encoding === "symbol" ? undefined : encodingOf(String(encoding));
  if (known === undefined) throw codedError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${messageText(encoding)}`);
  if (known === "base64url") return base64Encode(buffer, true);
  // The `buffer` package decodes malformed UTF-8 differently from Node; the platform's decoder agrees with Node.
  return known === "utf8" ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) : buffer.toString(known);
}

function invalidPublicKey(): Error { return codedError(Error, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve"); }

export const dhComputeSecret = named(function (this: unknown, key?: unknown, inEnc?: unknown, outEnc?: unknown): Buffer | string {
  const bytes = bytesOf(key, "key", inEnc);
  const secret = handleOf(this, "computeSecret").computeSecret(bytes);
  if (secret === undefined) throw invalidPublicKey();
  return encode(secret, outEnc);
}, "dhComputeSecret");
export const dhGetPrivateKey = named(function (this: unknown, encoding?: unknown): Buffer | string {
  return encode(handleOf(this, "getPrivateKey").getPrivateKey(), encoding);
}, "dhGetPrivateKey");
export const setPublicKey = named(function (this: unknown, key?: unknown, encoding?: unknown): unknown {
  handleOf(this, "setPublicKey").setPublicKey(bytesOf(key, "key", encoding));
  return this;
}, "setPublicKey");
export const setPrivateKey = named(function (this: unknown, key?: unknown, encoding?: unknown): unknown {
  handleOf(this, "setPrivateKey").setPrivateKey(bytesOf(key, "key", encoding));
  return this;
}, "setPrivateKey");

/** Node's own shape for a prototype method: assigned, so enumerable. */
export function expose(target: object, methods: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(methods)) Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
/** `new constructor(...args)` for a constructor that is a plain function, as Node's are. */
export function construct(constructor: (...args: never[]) => unknown, args: readonly unknown[]): object {
  const made: unknown = Reflect.construct(constructor, args);
  if (typeof made !== "object" || made === null) throw new TypeError("Illegal constructor");
  return made;
}
/** The prototype object of a constructor function. */
export function prototypeOf(constructor: (...args: never[]) => unknown): object {
  const prototype: unknown = Reflect.get(constructor, "prototype");
  if (typeof prototype !== "object" || prototype === null) throw new TypeError("Missing prototype");
  return prototype;
}
