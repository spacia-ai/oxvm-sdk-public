/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/keys.js (the KeyObject classes,
 * prepareAsymmetricKey, prepareSecretKey, createSecretKey, createPublicKey, createPrivateKey).
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
import { equalBytes } from "@noble/curves/utils.js";
import { Buffer } from "buffer/";
import { unavailableNodeApi } from "./node-capability.ts";
import {
  ecEncodedPoint, fromJwk, isPrivateMaterial, publicOf, sameKey, toJwk,
  type AsymmetricKeyType, type KeyMaterial, type PrivateMaterial, type PublicMaterial,
} from "./node-crypto-key-codec.ts";
import {
  bytesOf, isAnyArrayBuffer, isStringOrBuffer, parseKeyEncoding, readPrivateKey, readPublicKey, readRawKey, writePrivateKey, writePublicKey, type KeyEncoding,
} from "./node-crypto-key-encoding.ts";
import { OSSL, incompatibleKeyOptions, incompatibleKeyType, invalidKeyObjectType, invalidThis, missingPrivateJwk, opensslError } from "./node-crypto-key-errors.ts";
import { base64Encode } from "./node-crypto-pem.ts";
import { markKeyObject } from "./node-key-object-brand.ts";
import { invalidInstance, invalidType, invalidValue, named, validateObject, validateString } from "./node-util-validators.ts";

type KeyType = "secret" | "public" | "private";
/** What a key object holds. Programs cannot make one: `new KeyObject(type, handle)` accepts nothing else. */
class KeyHandle {
  readonly type: KeyType;
  readonly secret: Uint8Array | undefined;
  readonly material: KeyMaterial | undefined;
  constructor(type: KeyType, secret: Uint8Array | undefined, material: KeyMaterial | undefined) { this.type = type; this.secret = secret; this.material = material; }
}

let handleOf: (key: unknown) => KeyHandle;
/** Node's KeyObject extends a native class without a name, which holds the key. */
class NativeKeyObject {
  readonly #handle: KeyHandle;
  constructor(...[handle]: [KeyHandle]) { this.#handle = handle; markKeyObject(this); }
  static {
    handleOf = (key: unknown): KeyHandle => {
      if (key === null || typeof key !== "object" || !(#handle in key)) throw invalidThis("KeyObject");
      return key.#handle;
    };
  }
}
named(NativeKeyObject, "");

export class KeyObject extends NativeKeyObject {
  constructor(type: unknown, handle: unknown) {
    if (type !== "secret" && type !== "public" && type !== "private") throw invalidValue("type", type);
    if (typeof handle !== "object" || !(handle instanceof KeyHandle)) throw invalidType("handle", "object", handle);
    super(handle);
  }
  get type(): KeyType { return handleOf(this).type; }
  static from(key: unknown): KeyObject {
    if (typeof CryptoKey === "undefined" || !(key instanceof CryptoKey)) throw invalidInstance("key", "CryptoKey", key);
    // A browser CryptoKey gives up its material only asynchronously (`subtle.exportKey`).
    return unavailableNodeApi("crypto.KeyObject.from");
  }
  equals(otherKeyObject: unknown): boolean {
    if (!isKeyObject(otherKeyObject)) throw invalidInstance("otherKeyObject", "KeyObject", otherKeyObject);
    const mine = handleOf(this), other = handleOf(otherKeyObject);
    if (mine.type !== other.type) return false;
    if (mine.secret !== undefined && other.secret !== undefined) return mine.secret.length === other.secret.length && equalBytes(mine.secret, other.secret);
    return mine.material !== undefined && other.material !== undefined && sameKey(mine.material, other.material);
  }
}
Object.defineProperty(KeyObject.prototype, Symbol.toStringTag, { configurable: true, value: "KeyObject" });

function isKeyObject(value: unknown): value is KeyObject {
  try { handleOf(value); return true; }
  catch { return false; }
}
function secretOf(key: unknown): Uint8Array {
  const { secret } = handleOf(key);
  if (secret === undefined) throw invalidThis("SecretKeyObject");
  return secret;
}
function materialIn(key: unknown): KeyMaterial {
  const { material } = handleOf(key);
  if (material === undefined) throw invalidThis("AsymmetricKeyObject");
  return material;
}

export class SecretKeyObject extends KeyObject {
  constructor(handle: unknown) { super("secret", handle); }
  get symmetricKeySize(): number { return secretOf(this).length; }
  export(options?: unknown): Buffer | { kty: string; k: string } {
    const secret = secretOf(this);
    if (options !== undefined) {
      validateObject(options, "options");
      const format: unknown = Reflect.get(options, "format");
      if (format !== undefined && format !== "buffer" && format !== "jwk") throw invalidValue("options.format", format, "must be one of: undefined, 'buffer', 'jwk'");
      if (format === "jwk") return { kty: "oct", k: base64Encode(secret, true) };
    }
    return Buffer.from(secret);
  }
  toCryptoKey(): never {
    secretOf(this);
    // Node returns a CryptoKey synchronously; a browser makes one only asynchronously (`subtle.importKey`).
    return unavailableNodeApi("crypto.KeyObject.toCryptoKey");
  }
}

function bitLength(value: bigint): number { return value === 0n ? 0 : value.toString(2).length; }
function keyDetails(material: KeyMaterial): Record<string, unknown> {
  switch (material.kind) {
    case "rsa": return { modulusLength: bitLength(material.n), publicExponent: material.e };
    case "rsa-pss": return { modulusLength: bitLength(material.n), publicExponent: material.e,
      ...(material.pss === undefined ? {} : { hashAlgorithm: material.pss.hashAlgorithm, mgf1HashAlgorithm: material.pss.mgf1HashAlgorithm, saltLength: material.pss.saltLength }) };
    case "ec": return { namedCurve: material.namedCurve };
    case "dh": case "ed25519": case "ed448": case "x25519": case "x448": return {};
  }
}

export class AsymmetricKeyObject extends KeyObject {
  get asymmetricKeyType(): AsymmetricKeyType { return materialIn(this).kind; }
  get asymmetricKeyDetails(): Record<string, unknown> { return keyDetails(materialIn(this)); }
  toCryptoKey(): never {
    materialIn(this);
    return unavailableNodeApi("crypto.KeyObject.toCryptoKey");
  }
}

/** `format: 'raw-public'`: an EC point (in the form `type` asks for) or the bytes of an Edwards or Montgomery key. */
function rawPublic(material: KeyMaterial, options: object): Buffer {
  switch (material.kind) {
    case "ec": {
      const type: unknown = Reflect.get(options, "type") ?? "uncompressed";
      if (type !== "compressed" && type !== "uncompressed") throw invalidValue("options.type", type, "must be one of: 'compressed', 'uncompressed'");
      return Buffer.from(ecEncodedPoint({ kind: "ec", namedCurve: material.namedCurve, point: material.point, compressed: type === "compressed" }));
    }
    case "ed25519": case "ed448": case "x25519": case "x448": return Buffer.from(material.publicKey);
    case "rsa": case "rsa-pss": case "dh": throw incompatibleKeyType();
  }
}
function rawPrivate(material: KeyMaterial): Buffer {
  if (isPrivateMaterial(material)) {
    if (material.kind === "ec") return Buffer.from(material.d);
    if ("privateKey" in material) return Buffer.from(material.privateKey);
  }
  throw incompatibleKeyType();
}

export class PublicKeyObject extends AsymmetricKeyObject {
  constructor(handle: unknown) { super("public", handle); }
  export(options?: unknown): string | Buffer | Record<string, string> {
    const material = materialIn(this);
    const given = typeof options === "object" && options !== null ? options : undefined;
    const format: unknown = given === undefined ? undefined : Reflect.get(given, "format");
    if (format === "jwk") return toJwk(material, false);
    if (given !== undefined && format === "raw-public") return rawPublic(material, given);
    const encoding = parseKeyEncoding(options, material.kind, true);
    if (encoding.format === "pem" || encoding.format === "der") return writePublicKey(isPrivateMaterial(material) ? publicOf(material) : material, encoding);
    throw incompatibleKeyType();
  }
}

export class PrivateKeyObject extends AsymmetricKeyObject {
  constructor(handle: unknown) { super("private", handle); }
  export(options?: unknown): string | Buffer | Record<string, string> {
    const material = materialIn(this);
    const given = typeof options === "object" && options !== null ? options : undefined;
    const format: unknown = given === undefined ? undefined : Reflect.get(given, "format");
    if (given !== undefined && Reflect.get(given, "passphrase") !== undefined && format !== "pem" && format !== "der") throw incompatibleKeyOptions(format, "does not support encryption");
    if (format === "jwk") return toJwk(material, true);
    if (format === "raw-private") return rawPrivate(material);
    if (format === "raw-seed") throw incompatibleKeyType();
    const encoding = parseKeyEncoding(options, material.kind, false);
    if (!isPrivateMaterial(material)) throw invalidThis("PrivateKeyObject");
    if (encoding.format === "pem" || encoding.format === "der") return writePrivateKey(material, encoding);
    throw incompatibleKeyType();
  }
}

// `toCryptoKey(algorithm, extractable, keyUsages)`: the arguments are never read, the arity is Node's.
for (const prototype of [SecretKeyObject.prototype, AsymmetricKeyObject.prototype]) {
  const method: unknown = Reflect.get(prototype, "toCryptoKey");
  if (typeof method === "function") Object.defineProperty(method, "length", { value: 3 });
}
for (const [constructor, name] of [[KeyObject, "KeyObject"], [SecretKeyObject, "SecretKeyObject"], [AsymmetricKeyObject, "AsymmetricKeyObject"], [PublicKeyObject, "PublicKeyObject"], [PrivateKeyObject, "PrivateKeyObject"]] as const) named(constructor, name);

const KEY_TYPES = "ArrayBuffer, Buffer, TypedArray, or DataView";
const INPUT_TYPES = `string or an instance of ${KEY_TYPES}`;
const INPUT_OR_KEY_TYPES = "string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";
type Context = "consume-public" | "consume-private" | "create-public" | "create-private";

function validateAsymmetricKeyType(type: KeyType, context: Context, key: unknown): void {
  if (context === "create-private") throw invalidType("key", INPUT_TYPES, key);
  if (type !== "private") {
    if (context === "consume-private" || context === "create-public") throw invalidKeyObjectType(type, "private");
    if (type !== "public") throw invalidKeyObjectType(type, "private or public");
  }
}

type Prepared =
  | { readonly from: "key-object"; readonly material: KeyMaterial }
  | { readonly from: "jwk"; readonly data: object }
  | { readonly from: "raw"; readonly data: Uint8Array; readonly isPublic: boolean; readonly keyType: string; readonly namedCurve: unknown }
  | { readonly from: "encoded"; readonly data: Uint8Array; readonly encoding: KeyEncoding };

function keyObjectMaterial(key: KeyObject, context: Context): Prepared {
  const handle = handleOf(key);
  validateAsymmetricKeyType(handle.type, context, key);
  if (handle.material === undefined) throw invalidKeyObjectType(handle.type, "private");
  return { from: "key-object", material: handle.material };
}
function isCryptoKey(value: unknown): boolean { return typeof CryptoKey !== "undefined" && value instanceof CryptoKey; }

/** Node's `prepareAsymmetricKey`: what a key argument is, before any decoding. */
function prepareAsymmetricKey(key: unknown, context: Context, name: string): Prepared {
  if (isKeyObject(key)) return keyObjectMaterial(key, context);
  if (isCryptoKey(key)) return unavailableNodeApi("crypto CryptoKey as a key argument");
  if (isStringOrBuffer(key)) return { from: "encoded", data: bytesOf(key, name), encoding: { format: "pem" } };
  if (typeof key === "object") {
    if (key === null) throw new TypeError(`Cannot destructure property 'key' of 'key' as it is null.`);
    const data: unknown = Reflect.get(key, "key"), encoding: unknown = Reflect.get(key, "encoding"), format: unknown = Reflect.get(key, "format");
    if (isKeyObject(data)) return keyObjectMaterial(data, context);
    if (isCryptoKey(data)) return unavailableNodeApi("crypto CryptoKey as a key argument");
    if (format === "jwk") {
      validateObject(data, `${name}.key`);
      return { from: "jwk", data };
    }
    if (format === "raw-public" || format === "raw-private" || format === "raw-seed") {
      if ((context === "consume-private" || context === "create-private") && format === "raw-public") throw invalidValue(`${name}.format`, format);
      if (!ArrayBuffer.isView(data) && !isAnyArrayBuffer(data)) throw invalidInstance(`${name}.key`, KEY_TYPES, data);
      const keyType: unknown = Reflect.get(key, "asymmetricKeyType"), namedCurve: unknown = Reflect.get(key, "namedCurve");
      validateString(keyType, `${name}.asymmetricKeyType`);
      if (keyType === "ec") validateString(namedCurve, `${name}.namedCurve`);
      return { from: "raw", data: bytesOf(data, `${name}.key`), isPublic: format === "raw-public", keyType, namedCurve };
    }
    if (!isStringOrBuffer(data)) throw invalidType(`${name}.key`, context === "create-private" ? INPUT_TYPES : INPUT_OR_KEY_TYPES, data);
    const isPublic = context === "consume-private" || context === "create-private" ? false : undefined;
    return { from: "encoded", data: bytesOf(data, `${name}.key`, encoding), encoding: parseKeyEncoding(key, undefined, isPublic, name) };
  }
  throw invalidType(name, context === "create-private" ? INPUT_TYPES : INPUT_OR_KEY_TYPES, key);
}

/** The key a prepared argument holds; `privateOnly` where the encoding must be a private key's. */
function keyFrom(prepared: Prepared, privateOnly: boolean): { readonly material: KeyMaterial; readonly isPrivate: boolean } {
  if (prepared.from === "encoded") return privateOnly ? { material: readPrivateKey(prepared.data, prepared.encoding), isPrivate: true } : readPublicKey(prepared.data, prepared.encoding);
  if (prepared.from === "jwk") return fromJwk(prepared.data);
  if (prepared.from === "raw") return readRawKey(prepared.data, prepared.isPublic, prepared.keyType, prepared.namedCurve);
  return { material: prepared.material, isPrivate: isPrivateMaterial(prepared.material) };
}

function wrapSecret(bytes: Uint8Array): SecretKeyObject { return new SecretKeyObject(new KeyHandle("secret", Uint8Array.from(bytes), undefined)); }
/** A key object for key material: a private key, or the public key (derived from private material when needed). */
export function wrapMaterial(material: PublicMaterial | PrivateMaterial, isPrivate: boolean): KeyObject {
  if (isPrivate) {
    if (!isPrivateMaterial(material)) throw new TypeError("Private key material is required");
    return new PrivateKeyObject(new KeyHandle("private", undefined, material));
  }
  return new PublicKeyObject(new KeyHandle("public", undefined, isPrivateMaterial(material) ? publicOf(material) : material));
}

export function createSecretKey(key: unknown, encoding?: unknown): SecretKeyObject {
  if (typeof key !== "string" && !ArrayBuffer.isView(key) && !isAnyArrayBuffer(key)) throw invalidInstance("key", KEY_TYPES, key);
  return wrapSecret(bytesOf(key, "key", encoding));
}
export function createPublicKey(key: unknown): KeyObject {
  return wrapMaterial(keyFrom(prepareAsymmetricKey(key, "create-public", "key"), false).material, false);
}
export function createPrivateKey(key: unknown): KeyObject {
  const { material } = keyFrom(prepareAsymmetricKey(key, "create-private", "key"), true);
  if (!isPrivateMaterial(material)) throw missingPrivateJwk();
  return wrapMaterial(material, true);
}

/** The bytes of a secret key object; `undefined` for anything else. */
export function keyBytes(value: unknown): Uint8Array | undefined {
  if (!isKeyObject(value)) return undefined;
  const { secret } = handleOf(value);
  return secret === undefined ? undefined : Uint8Array.from(secret);
}
/** The material of an asymmetric key object; `undefined` for anything else. */
export function materialOf(value: unknown): { readonly type: "public" | "private"; readonly material: PublicMaterial | PrivateMaterial } | undefined {
  if (!isKeyObject(value)) return undefined;
  const { type, material } = handleOf(value);
  return type === "secret" || material === undefined ? undefined : { type, material };
}

const KEY_OPTIONS = ["padding", "saltLength", "dsaEncoding", "oaepHash", "oaepLabel", "encoding", "context"] as const;
export type KeyInputOptions = Readonly<Partial<Record<(typeof KEY_OPTIONS)[number], unknown>>>;
export interface KeyInput { readonly material: PublicMaterial | PrivateMaterial; readonly isPrivate: boolean; readonly options: KeyInputOptions }

/**
 * A key argument as `sign`, `verify`, `publicEncrypt`, `privateDecrypt` and the like accept it: a KeyObject, PEM
 * text or bytes, `{ key, format, type, passphrase, encoding, ... }`, or a JWK in that form. `want: "public"`
 * accepts a private key too and returns its public half. `want: "private"` returns a private key with one
 * exception Node has too: a public JWK (`{ key: jwk, format: 'jwk' }` without `d`) is passed on as the public key
 * it is, with `isPrivate: false`, and the operation fails on it (`missingPrivateKey` is what signing reports). `options` are the operation's own members of an
 * options object (`padding`, `saltLength`, `dsaEncoding`, `oaepHash`, `oaepLabel`, `encoding`, `context`).
 */
export function keyFromInput(input: unknown, want: "public" | "private", argName = "key"): KeyInput {
  const options: Partial<Record<(typeof KEY_OPTIONS)[number], unknown>> = {};
  if (typeof input === "object" && input !== null && !isKeyObject(input) && !isStringOrBuffer(input)) {
    for (const name of KEY_OPTIONS) { const value: unknown = Reflect.get(input, name); if (value !== undefined) options[name] = value; }
  }
  if (want === "private") {
    const { material } = keyFrom(prepareAsymmetricKey(input, "consume-private", argName), true);
    return { material, isPrivate: isPrivateMaterial(material), options };
  }
  const { material } = keyFrom(prepareAsymmetricKey(input, "consume-public", argName), false);
  return { material: isPrivateMaterial(material) ? publicOf(material) : material, isPrivate: false, options };
}

/** What Node's signing reports for a public key given where a private key is needed (a public JWK). */
export function missingPrivateKey(material: KeyMaterial): Error {
  switch (material.kind) {
    case "ec": return opensslError(OSSL.ecMissingPrivateKey);
    case "rsa": case "rsa-pss": return opensslError(OSSL.rsaMissingPrivateKey, [OSSL.rsaLib]);
    case "ed25519": case "ed448": case "x25519": case "x448": case "dh": return opensslError(OSSL.notAPrivateKey);
  }
}

for (const [operation, name] of [[createSecretKey, "createSecretKey"], [createPublicKey, "createPublicKey"], [createPrivateKey, "createPrivateKey"]] as const) named(operation, name);

/** The key half of `node:crypto`, and what the other halves use to take keys apart and build them. */
export function createCryptoKeys(): {
  readonly KeyObject: typeof KeyObject; readonly createSecretKey: typeof createSecretKey; readonly createPublicKey: typeof createPublicKey;
  readonly createPrivateKey: typeof createPrivateKey; readonly keyBytes: typeof keyBytes; readonly materialOf: typeof materialOf;
  readonly wrapMaterial: typeof wrapMaterial; readonly keyFromInput: typeof keyFromInput; readonly missingPrivateKey: typeof missingPrivateKey;
} {
  return { KeyObject, createSecretKey, createPublicKey, createPrivateKey, keyBytes, materialOf, wrapMaterial, keyFromInput, missingPrivateKey };
}
