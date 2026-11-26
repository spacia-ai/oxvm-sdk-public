/*!
 * The argument handling follows Node.js v24.18.1 lib/internal/crypto/cipher.js and src/crypto/crypto_cipher.cc.
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
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
import { Buffer } from "buffer/";
import { Transform } from "readable-stream";
import { createAeadEngine, validGcmTagLength } from "./node-crypto-cipher-aead.ts";
import { unsupportedState, createPlainEngine, type CipherEngine } from "./node-crypto-cipher-modes.ts";
import { cipherNames, findCipher, getCipherInfo, type CipherSpec } from "./node-crypto-cipher-table.ts";
import { StringDecoder } from "./node-string-decoder.ts";
import { invalidType, invalidValue, named, templateText, validateString } from "./node-util-validators.ts";

export interface CryptoCipherOptions {
  /** The bytes of a secret KeyObject or CryptoKey; undefined for any other value. */
  readonly keyBytes?: (value: unknown) => Uint8Array | undefined;
}

function coded<Failure extends Error>(error: Failure, code: string): Failure { return Object.assign(error, { code }); }
function invalidState(operation?: string): Error {
  return coded(new Error(operation === undefined ? "Invalid state" : `Invalid state for operation ${operation}`), "ERR_CRYPTO_INVALID_STATE");
}
function invalidTagLength(length: number): TypeError {
  return coded(new TypeError(`Invalid authentication tag length: ${String(length)}`), "ERR_CRYPTO_INVALID_AUTH_TAG");
}
function invalidIv(): TypeError { return coded(new TypeError("Invalid initialization vector"), "ERR_CRYPTO_INVALID_IV"); }

type Encoding = "utf8" | "utf16le" | "latin1" | "base64" | "base64url" | "hex" | "ascii";
/** Node's `normalizeEncoding`; undefined for a name Node does not know. */
function normalizeEncoding(encoding: unknown): Encoding | undefined {
  if (encoding === undefined || encoding === null || encoding === "") return "utf8";
  switch (templateText(encoding).toLowerCase()) {
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
function decodeString(text: string, encoding: unknown): Uint8Array {
  const selected = normalizeEncoding(encoding) ?? "utf8";
  // The `buffer` package predates base64url, which differs from base64 in two characters.
  return selected === "base64url" ? Buffer.from(text.replace(/-/gu, "+").replace(/_/gu, "/"), "base64") : Buffer.from(text, selected);
}
function viewBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) return new Uint8Array(value);
  return undefined;
}
const BYTE_SOURCES = "string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView";
/** Node's `getArrayBufferOrView`. */
function byteSource(value: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof value === "string") return decodeString(value, encoding === "buffer" ? "utf8" : encoding);
  const bytes = viewBytes(value);
  if (bytes === undefined) throw invalidType(name, BYTE_SOURCES, value);
  return bytes;
}
function option(options: unknown, key: string): unknown {
  if ((typeof options !== "object" && typeof options !== "function") || options === null) return undefined;
  const value: unknown = Reflect.get(options, key);
  return value ?? undefined;
}
function stringOption(options: unknown, key: string): string | undefined {
  const value = option(options, key);
  if (value === undefined) return undefined;
  validateString(value, `options.${key}`);
  return value;
}
/** Node's `getUIntOption`: -1 stands for an absent option. */
function uintOption(options: unknown, key: string): number {
  const value = option(options, key);
  if (value === undefined) return -1;
  if (typeof value !== "number" || value >>> 0 !== value) throw invalidValue(`options.${key}`, value);
  return value;
}

/** A StringDecoder per cipher: output text keeps incomplete characters and base64 groups between calls. */
class OutputDecoder {
  readonly encoding: Encoding;
  readonly #stateful: StringDecoder | undefined;
  constructor(encoding: Encoding) {
    this.encoding = encoding;
    this.#stateful = encoding === "utf8" || encoding === "utf16le" ? new StringDecoder(encoding)
      : encoding === "base64" || encoding === "base64url" ? new StringDecoder("base64") : undefined;
  }
  #text(bytes: Uint8Array, end: boolean): string {
    if (this.#stateful === undefined) return Buffer.from(bytes).toString(this.encoding === "base64url" ? "base64" : this.encoding);
    const text = end ? this.#stateful.end(bytes) : this.#stateful.write(bytes);
    return this.encoding === "base64url" ? text.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "") : text;
  }
  write(bytes: Uint8Array): string { return this.#text(bytes, false); }
  end(bytes: Uint8Array): string { return this.#text(bytes, true); }
}
/** Node's `outputEncoding && outputEncoding !== 'buffer'`. */
function wantsText(encoding: unknown): boolean { return Boolean(encoding) && encoding !== "buffer"; }
function decoderFor(current: OutputDecoder | null, encoding: unknown): OutputDecoder {
  const normalized = normalizeEncoding(encoding);
  if (normalized === undefined) throw coded(new TypeError(`Unknown encoding: ${templateText(encoding)}`), "ERR_UNKNOWN_ENCODING");
  if (current === null) return new OutputDecoder(normalized);
  if (current.encoding !== normalized) {
    throw coded(new Error("Cannot change encoding\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n"
      + "Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n"), "ERR_INTERNAL_ASSERTION");
  }
  return current;
}

/** The checks of `CipherBase::InitIv` and `InitAuthenticated`, in their order. */
function createEngine(name: string, spec: CipherSpec, key: Uint8Array, iv: Uint8Array | null, encrypting: boolean, requestedTag: number): CipherEngine {
  if (iv === null ? spec.ivLength !== 0 : !spec.aead && iv.length !== spec.ivLength) throw invalidIv();
  const nonce = iv ?? new Uint8Array(0);
  let tagLength: number | undefined;
  if (spec.mode === "gcm") {
    if (nonce.length < 1 || nonce.length > 128) throw invalidIv();
    if (requestedTag !== -1) { if (!validGcmTagLength(requestedTag)) throw invalidTagLength(requestedTag); tagLength = requestedTag; }
  } else if (spec.mode === "chacha20-poly1305") {
    if (nonce.length !== 12) throw invalidIv();
    tagLength = requestedTag === -1 ? 16 : requestedTag;
    if (tagLength < 1 || tagLength > 16) throw invalidTagLength(tagLength);
  } else if (spec.mode === "ccm" || spec.mode === "ocb") {
    const ccm = spec.mode === "ccm";
    if (ccm ? nonce.length < 7 || nonce.length > 13 : nonce.length < 1 || nonce.length > 15) throw invalidIv();
    if (requestedTag === -1) throw coded(new TypeError(`authTagLength required for ${name}`), "ERR_CRYPTO_INVALID_AUTH_TAG");
    if (requestedTag > 16 || (ccm && (requestedTag < 4 || requestedTag % 2 !== 0))) throw invalidTagLength(requestedTag);
    tagLength = requestedTag;
  }
  if (key.length !== spec.keyLength) throw coded(new RangeError("Invalid key length"), "ERR_CRYPTO_INVALID_KEYLEN");
  if (spec.mode === "gcm" || spec.mode === "ccm" || spec.mode === "ocb" || spec.mode === "chacha20-poly1305") return createAeadEngine(spec.mode, key, nonce, encrypting, tagLength);
  return createPlainEngine(spec.mode, key, nonce, encrypting);
}

/** One cipher context (Node's `CipherBase`): the engine lives until `final`. */
class CipherHandle {
  #engine: CipherEngine | undefined;
  readonly #encrypting: boolean;
  #tag: Uint8Array | undefined;
  #tagGiven = false;
  constructor(engine: CipherEngine, encrypting: boolean) { this.#engine = engine; this.#encrypting = encrypting; }
  update(data: Uint8Array): Buffer {
    if (this.#engine === undefined) throw unsupportedState();
    return toBuffer(this.#engine.update(data));
  }
  final(): Buffer {
    const engine = this.#engine;
    if (engine === undefined) throw invalidState();
    this.#engine = undefined;
    const out = engine.final();
    if (this.#encrypting) this.#tag = engine.aead?.tag();
    return toBuffer(out);
  }
  setAutoPadding(enabled: boolean): boolean {
    if (this.#engine === undefined) return false;
    this.#engine.setPadding?.(enabled);
    return true;
  }
  setAAD(aad: Uint8Array, plaintextLength: number): boolean {
    return this.#engine?.aead?.setAAD(aad, plaintextLength) ?? false;
  }
  getAuthTag(): Buffer | undefined { return this.#tag === undefined ? undefined : toBuffer(Uint8Array.from(this.#tag)); }
  setAuthTag(tag: Uint8Array): boolean {
    const aead = this.#engine?.aead;
    if (aead === undefined || this.#encrypting || this.#tagGiven) return false;
    if (!aead.acceptsTag(tag.length)) throw invalidTagLength(tag.length);
    aead.setTag(Uint8Array.from(tag));
    this.#tagGiven = true;
    return true;
  }
}
function toBuffer(bytes: Uint8Array): Buffer {
  return bytes.buffer instanceof ArrayBuffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes);
}

const handles = new WeakMap<object, CipherHandle>();
function handleOf(cipher: object): CipherHandle {
  const handle = handles.get(cipher);
  if (handle === undefined) throw new TypeError("Illegal invocation");
  return handle;
}

/** What `Cipheriv` and `Decipheriv` share: the stream and the methods Node assigns to both prototypes. */
export interface CipherStream extends Transform {
  _decoder: OutputDecoder | null;
  update(data: unknown, inputEncoding?: unknown, outputEncoding?: unknown): Buffer | string;
  final(outputEncoding?: unknown): Buffer | string;
  setAutoPadding(autoPadding?: unknown): this;
  setAAD(buffer: unknown, options?: unknown): this;
}
export interface Cipheriv extends CipherStream { getAuthTag(): Buffer }
export interface Decipheriv extends CipherStream { setAuthTag(buffer: unknown, encoding?: unknown): this }
/** A constructor that, like Node's, also works without `new`. */
export interface CipherConstructor<Instance> {
  new (cipher: unknown, key: unknown, iv: unknown, options?: unknown): Instance;
  (cipher: unknown, key: unknown, iv: unknown, options?: unknown): Instance;
  readonly prototype: Instance;
}
export interface CryptoCiphers {
  createCipheriv(cipher: unknown, key: unknown, iv: unknown, options?: unknown): Cipheriv;
  createDecipheriv(cipher: unknown, key: unknown, iv: unknown, options?: unknown): Decipheriv;
  readonly Cipheriv: CipherConstructor<Cipheriv>;
  readonly Decipheriv: CipherConstructor<Decipheriv>;
  getCiphers(): string[];
  getCipherInfo(nameOrNid: unknown, options?: unknown): ReturnType<typeof getCipherInfo>;
}

function _transform(this: CipherStream, chunk: unknown, encoding: unknown, callback: (error?: Error | null) => void): void {
  this.push(handleOf(this).update(typeof chunk === "string" ? decodeString(chunk, encoding) : byteSource(chunk, "data")));
  callback();
}
function _flush(this: CipherStream, callback: (error?: Error | null) => void): void {
  try { this.push(handleOf(this).final()); }
  catch (error) { callback(error instanceof Error ? error : new Error(String(error))); return; }
  callback();
}
function update(this: CipherStream, data: unknown, inputEncoding?: unknown, outputEncoding?: unknown): Buffer | string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    if (normalizeEncoding(inputEncoding) === "hex" && data.length % 2 !== 0) throw invalidValue("encoding", inputEncoding, `is invalid for data of length ${String(data.length)}`);
    bytes = decodeString(data, inputEncoding);
  } else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw invalidType("data", "string or an instance of Buffer, TypedArray, or DataView", data);
  const out = handleOf(this).update(bytes);
  if (wantsText(outputEncoding)) {
    this._decoder = decoderFor(this._decoder, outputEncoding);
    return this._decoder.write(out);
  }
  return out;
}
function final(this: CipherStream, outputEncoding?: unknown): Buffer | string {
  const out = handleOf(this).final();
  if (wantsText(outputEncoding)) {
    this._decoder = decoderFor(this._decoder, outputEncoding);
    return this._decoder.end(out);
  }
  return out;
}
function setAutoPadding<Self extends CipherStream>(this: Self, autoPadding?: unknown): Self {
  if (!handleOf(this).setAutoPadding(Boolean(autoPadding))) throw invalidState("setAutoPadding");
  return this;
}
function getAuthTag(this: CipherStream): Buffer {
  const tag = handleOf(this).getAuthTag();
  if (tag === undefined) throw invalidState("getAuthTag");
  return tag;
}
function setAuthTag<Self extends CipherStream>(this: Self, buffer: unknown, encoding?: unknown): Self {
  if (!handleOf(this).setAuthTag(byteSource(buffer, "buffer", encoding))) throw invalidState("setAuthTag");
  return this;
}
function setAAD<Self extends CipherStream>(this: Self, buffer: unknown, options?: unknown): Self {
  const encoding = stringOption(options, "encoding");
  const plaintextLength = uintOption(options, "plaintextLength");
  if (!handleOf(this).setAAD(byteSource(buffer, "aadbuf", encoding), plaintextLength)) throw invalidState("setAAD");
  return this;
}
const shared = { _transform, _flush, update, final, setAutoPadding };

function isCipherConstructor<Instance>(value: unknown, sample: abstract new (cipher: unknown, key: unknown, iv: unknown, options?: unknown) => Instance): value is CipherConstructor<Instance> {
  return typeof value === "function" && typeof sample === "function";
}
/** Installs Node's prototype methods (enumerable, as assignment leaves them) and makes the class callable. */
function publish<Instance extends object>(constructor: new (cipher: unknown, key: unknown, iv: unknown, options?: unknown) => Instance, name: string, methods: Record<string, unknown>): CipherConstructor<Instance> {
  named(constructor, name);
  const callable: unknown = new Proxy(constructor, {
    apply: (target, _self: unknown, args: unknown[]): Instance => new target(args[0], args[1], args[2], args[3]),
  });
  for (const [key, value] of Object.entries(methods)) Object.defineProperty(constructor.prototype, key, { value, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(constructor.prototype, "constructor", { value: callable, writable: true, enumerable: false, configurable: true });
  if (!isCipherConstructor(callable, constructor)) throw new TypeError("Invalid cipher constructor");
  return callable;
}

/** `node:crypto`'s symmetric ciphers on @noble/ciphers. */
export function createCryptoCiphers(options: CryptoCipherOptions = {}): CryptoCiphers {
  const keyBytes = options.keyBytes;
  /** `createCipherWithIV`: argument types first, then the native checks; all of it before the stream exists. */
  let opened: CipherHandle | undefined;
  const open = (encrypting: boolean, cipher: unknown, key: unknown, iv: unknown, settings: unknown): object => {
    validateString(cipher, "cipher");
    const encoding = stringOption(settings, "encoding");
    let secret = keyBytes?.(key);
    if (secret === undefined) {
      if (typeof key !== "string" && viewBytes(key) === undefined) throw invalidType("key", "string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey", key);
      secret = byteSource(key, "key", encoding);
    }
    const vector = iv === null ? null : byteSource(iv, "iv");
    const tagLength = uintOption(settings, "authTagLength");
    const spec = findCipher(cipher);
    if (spec === undefined) throw coded(new Error("Unknown cipher"), "ERR_CRYPTO_UNKNOWN_CIPHER");
    opened = new CipherHandle(createEngine(cipher, spec, secret, vector, encrypting, tagLength), encrypting);
    return typeof settings === "object" && settings !== null ? settings : {};
  };
  const adopt = (stream: object): void => {
    if (opened === undefined) throw new TypeError("Cipher was not initialised");
    handles.set(stream, opened);
    opened = undefined;
  };
  class CipherivStream extends Transform {
    _decoder: OutputDecoder | null = null;
    declare update: typeof update;
    declare final: typeof final;
    declare setAutoPadding: typeof setAutoPadding;
    declare getAuthTag: typeof getAuthTag;
    declare setAAD: typeof setAAD;
    constructor(cipher: unknown, key: unknown, iv: unknown, settings?: unknown) {
      super(open(true, cipher, key, iv, settings));
      adopt(this);
    }
  }
  class DecipherivStream extends Transform {
    _decoder: OutputDecoder | null = null;
    declare update: typeof update;
    declare final: typeof final;
    declare setAutoPadding: typeof setAutoPadding;
    declare setAuthTag: typeof setAuthTag;
    declare setAAD: typeof setAAD;
    constructor(cipher: unknown, key: unknown, iv: unknown, settings?: unknown) {
      super(open(false, cipher, key, iv, settings));
      adopt(this);
    }
  }
  const Cipheriv = publish<Cipheriv>(CipherivStream, "Cipheriv", { ...shared, getAuthTag, setAAD });
  const Decipheriv = publish<Decipheriv>(DecipherivStream, "Decipheriv", { ...shared, setAuthTag, setAAD });
  return {
    createCipheriv: named((cipher: unknown, key: unknown, iv: unknown, settings?: unknown): Cipheriv => new Cipheriv(cipher, key, iv, settings), "createCipheriv"),
    createDecipheriv: named((cipher: unknown, key: unknown, iv: unknown, settings?: unknown): Decipheriv => new Decipheriv(cipher, key, iv, settings), "createDecipheriv"),
    Cipheriv, Decipheriv,
    // Node's is an anonymous cached function.
    getCiphers: named((): string[] => cipherNames(), ""),
    getCipherInfo: named((nameOrNid: unknown, settings?: unknown) => getCipherInfo(nameOrNid, settings), "getCipherInfo"),
  };
}
