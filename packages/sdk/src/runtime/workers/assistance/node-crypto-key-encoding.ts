/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/keys.js (parseKeyFormat, parseKeyType,
 * parseKeyFormatAndType, parseKeyEncoding) and lib/internal/crypto/util.js (getArrayBufferOrView).
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
import { Buffer } from "buffer/";
import { unavailableNodeApi } from "./node-capability.ts";
import { Asn1Error } from "./node-crypto-asn1.ts";
import {
  CURVES, KeyCodecError, OKP, OKP_KINDS, certificatePublicKeyInfo, curveByName, ecPoint, ecPublicPoint, encodePrivate, encodePublic, parsePrivate, parsePublic,
  type KeyMaterial, type PrivateMaterial, type PublicMaterial,
} from "./node-crypto-key-codec.ts";
import {
  KeyDecryptError, decryptPkcs8, encryptPkcs8, isEncryptedPkcs8, keyCipher, legacyDecrypt, legacyEncrypt, legacyEncryption, type KeyCipher,
} from "./node-crypto-key-encryption.ts";
import {
  OSSL, asn1Queue, codedError, failedToReadKey, incompatibleKeyOptions, incompatibleKeyType, invalidCurve, invalidKeyData, missingPassphrase, opensslError, unknownCipher, unknownEncoding, type OpensslEntry,
} from "./node-crypto-key-errors.ts";
import { base64Decode, pemBlocks, pemEncode, type PemBlock } from "./node-crypto-pem.ts";
import { invalidType, invalidValue, validateObject } from "./node-util-validators.ts";

// Preserve the browser entropy provider before application code can replace it.
const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
function randomBytes(length: number): Uint8Array { return entropy(new Uint8Array(length)); }

export type KeyFormat = "pem" | "der" | "jwk" | "raw-public" | "raw-private" | "raw-seed";
export type KeyEncodingType = "pkcs1" | "spki" | "pkcs8" | "sec1";
export interface KeyEncoding {
  readonly format: KeyFormat;
  readonly type?: KeyEncodingType | "compressed" | "uncompressed" | undefined;
  readonly cipher?: unknown;
  readonly passphrase?: Uint8Array | undefined;
}

export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
  return value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer);
}
export function isStringOrBuffer(value: unknown): value is string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer {
  return typeof value === "string" || ArrayBuffer.isView(value) || isAnyArrayBuffer(value);
}
/** The bytes of a string in an encoding as `Buffer.from` reads it. */
export function stringBytes(text: string, encoding: unknown): Uint8Array {
  if (typeof encoding !== "string" || encoding === "buffer" || encoding === "") return Buffer.from(text, "utf8");
  if (encoding.toLowerCase() === "base64url") return base64Decode(text) ?? new Uint8Array();
  if (!Buffer.isEncoding(encoding)) throw unknownEncoding(encoding);
  return Buffer.from(text, encoding);
}
/** Node's `getArrayBufferOrView`, as bytes. */
export function bytesOf(value: unknown, name: string, encoding?: unknown): Uint8Array {
  if (isAnyArrayBuffer(value)) return new Uint8Array(value);
  if (typeof value === "string") return stringBytes(value, encoding);
  if (!ArrayBuffer.isView(value)) throw invalidType(name, "string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function parseKeyFormat(format: unknown, fallback: KeyFormat | undefined, optionName: string): KeyFormat {
  if (format === undefined && fallback !== undefined) return fallback;
  if (format === "pem" || format === "der" || format === "jwk" || format === "raw-public" || format === "raw-private" || format === "raw-seed") return format;
  throw invalidValue(optionName, format);
}
function parseKeyType(type: unknown, required: boolean, keyType: string | undefined, isPublic: boolean | undefined, optionName: string): KeyEncodingType | undefined {
  if (type === undefined && !required) return undefined;
  if (type === "pkcs1") {
    if (keyType !== undefined && keyType !== "rsa") throw incompatibleKeyOptions(type, "can only be used for RSA keys");
    return type;
  }
  if (type === "spki" && isPublic !== false) return type;
  if (type === "pkcs8" && isPublic !== true) return type;
  if (type === "sec1" && isPublic !== true) {
    if (keyType !== undefined && keyType !== "ec") throw incompatibleKeyOptions(type, "can only be used for EC keys");
    return type;
  }
  throw invalidValue(optionName, type);
}
const option = (name: string, prefix: string | undefined): string => prefix === undefined ? `options.${name}` : `${prefix}.${name}`;

function parseKeyFormatAndType(enc: object, keyType: string | undefined, isPublic: boolean | undefined, objName: string | undefined): KeyEncoding {
  const formatText: unknown = Reflect.get(enc, "format"), typeText: unknown = Reflect.get(enc, "type");
  const isInput = keyType === undefined;
  const format = parseKeyFormat(formatText, isInput ? "pem" : undefined, option("format", objName));
  if (format === "raw-public") {
    if (isPublic === false) throw invalidValue(option("format", objName), "raw-public");
    if (typeText === undefined || typeText === "uncompressed") return { format, type: "uncompressed" };
    if (typeText === "compressed") return { format, type: "compressed" };
    throw invalidValue(option("type", objName), typeText);
  }
  if (format === "raw-private" || format === "raw-seed") {
    if (isPublic === true) throw invalidValue(option("format", objName), format);
    if (typeText !== undefined) throw invalidValue(option("type", objName), typeText);
    return { format };
  }
  const isRequired = (!isInput || format === "der") && format !== "jwk";
  return { format, type: parseKeyType(typeText, isRequired, keyType, isPublic, option("type", objName)) };
}

/**
 * Node's `parseKeyEncoding`: the options of an input key (`keyType` undefined) or of an export. `isPublic` is
 * true for a public key export, false where only a private key is acceptable, undefined where either is.
 */
export function parseKeyEncoding(enc: unknown, keyType: string | undefined, isPublic: boolean | undefined, objName?: string): KeyEncoding {
  validateObject(enc, "options");
  const isInput = keyType === undefined;
  const { format, type } = parseKeyFormatAndType(enc, keyType, isPublic, objName);
  let cipher: unknown, passphrase: unknown, encoding: unknown;
  if (isPublic !== true) {
    cipher = Reflect.get(enc, "cipher"); passphrase = Reflect.get(enc, "passphrase"); encoding = Reflect.get(enc, "encoding");
    if (format === "raw-private" || format === "raw-seed") {
      if ((cipher !== undefined && cipher !== null) || passphrase !== undefined) throw incompatibleKeyOptions("raw format", "does not support encryption");
      return { format, type };
    }
    if (!isInput) {
      if (cipher !== undefined && cipher !== null) {
        if (typeof cipher !== "string") throw invalidValue(option("cipher", objName), cipher);
        if (format === "der" && (type === "pkcs1" || type === "sec1")) throw incompatibleKeyOptions(type, "does not support encryption");
      } else if (passphrase !== undefined) throw invalidValue(option("cipher", objName), cipher);
    }
    if ((isInput && passphrase !== undefined && !isStringOrBuffer(passphrase)) || (!isInput && cipher !== undefined && cipher !== null && !isStringOrBuffer(passphrase))) {
      throw invalidValue(option("passphrase", objName), passphrase);
    }
  }
  return { format, type, cipher, passphrase: passphrase === undefined ? undefined : bytesOf(passphrase, "key.passphrase", encoding) };
}

/** A key as read from an encoding: private when the encoding held a private key. */
export interface ReadKey { readonly material: KeyMaterial; readonly isPrivate: boolean }

/** Runs a decoder; an algorithm or curve this implementation lacks is refused as an unavailable API. */
function decoding<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof KeyCodecError && error.failure === "unsupported-algorithm") return unavailableNodeApi(`crypto key (${error.message})`);
    throw error;
  }
}
const latin1 = new TextDecoder("latin1");
/** OpenSSL refuses a passphrase longer than its 1024-byte buffer as if none had been given. */
const MAX_PASSPHRASE = 1024;
const PRIVATE_LABELS = ["PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY"];
const CERTIFICATE_LABELS = ["CERTIFICATE", "X509 CERTIFICATE", "TRUSTED CERTIFICATE"];
const UNSUPPORTED_PRIVATE: readonly OpensslEntry[] = [OSSL.nested, OSSL.nested, OSSL.wrongTag, OSSL.nested, OSSL.nested, OSSL.wrongTag, OSSL.unsupported];

function truncated(error: unknown): boolean {
  return error instanceof Asn1Error && error.depth === 0 && (error.reason === "too-long" || error.reason === "not-enough-data");
}

function readPrivatePem(block: PemBlock | undefined, passphrase: Uint8Array | undefined): PrivateMaterial {
  if (block === undefined) throw opensslError(OSSL.unsupported, [OSSL.unsupported]);
  if (block.label === "DSA PRIVATE KEY") return unavailableNodeApi("crypto key (DSA keys are not supported)");
  const usable = passphrase !== undefined && passphrase.length <= MAX_PASSPHRASE ? passphrase : undefined;
  if (block.label === "ENCRYPTED PRIVATE KEY") {
    if (usable === undefined) throw opensslError(OSSL.interrupted, [OSSL.badPasswordRead, OSSL.interrupted, OSSL.unableToGetPassphrase, OSSL.interrupted, OSSL.interrupted]);
    let plain: Uint8Array;
    try { plain = decoding(() => decryptPkcs8(block.body, usable)); }
    catch (error) {
      if (error instanceof KeyDecryptError) throw opensslError(OSSL.badDecrypt, [OSSL.cipherFinal, OSSL.badDecrypt, OSSL.cipherFinal, OSSL.badDecrypt]);
      if (error instanceof Asn1Error || error instanceof KeyCodecError) throw opensslError(OSSL.unsupported, [...asn1Queue(error), OSSL.unsupported]);
      throw error;
    }
    return readPrivateDer(plain, "pkcs8", undefined, true);
  }
  if (block.label === "PRIVATE KEY") return readPrivateDer(block.body, "pkcs8", undefined, true);
  let body = block.body;
  const encryption = legacyEncryption(block.headers);
  if (encryption.state === "not-proc-type") throw opensslError(OSSL.notProcType, [OSSL.notProcType]);
  if (encryption.state === "unsupported") return unavailableNodeApi(`crypto key (PEM encryption ${encryption.cipher} is not supported)`);
  if (encryption.state === "encrypted") {
    if (usable === undefined) throw opensslError(OSSL.interrupted, [OSSL.badPasswordRead, OSSL.interrupted, OSSL.interrupted]);
    try { body = legacyDecrypt(block, encryption.cipher, encryption.iv, usable); }
    catch (error) {
      if (error instanceof KeyDecryptError) throw opensslError(OSSL.badDecrypt, [OSSL.pemBadDecrypt, OSSL.badDecrypt]);
      throw error;
    }
  }
  return readPrivateDer(body, block.label === "RSA PRIVATE KEY" ? "pkcs1" : "sec1", undefined, true);
}

function readPrivateDer(data: Uint8Array, type: KeyEncodingType | undefined, passphrase: Uint8Array | undefined, fromPem = false): PrivateMaterial {
  let bytes = data;
  const kind = type === "pkcs1" || type === "sec1" ? type : "pkcs8";
  if (!fromPem && kind === "pkcs8" && isEncryptedPkcs8(bytes)) {
    if (passphrase === undefined) throw missingPassphrase();
    if (passphrase.length > MAX_PASSPHRASE) throw opensslError(OSSL.badPasswordRead, [OSSL.badPasswordRead]);
    try { bytes = decoding(() => decryptPkcs8(bytes, passphrase)); }
    catch (error) {
      if (error instanceof KeyDecryptError) throw opensslError(OSSL.badDecrypt, [OSSL.cipherFinal, OSSL.badDecrypt]);
      throw error;
    }
  }
  try { return decoding(() => parsePrivate(bytes, kind)); }
  catch (error) {
    if (!(error instanceof Asn1Error) && !(error instanceof KeyCodecError)) throw error;
    if (fromPem) throw opensslError(OSSL.unsupported, [...asn1Queue(error), OSSL.unsupported]);
    if (truncated(error)) throw opensslError(OSSL.notEnoughData, [OSSL.notEnoughData]);
    if (kind === "pkcs8") throw opensslError(OSSL.wrongTag, asn1Queue(error));
    throw opensslError(OSSL.unsupported, UNSUPPORTED_PRIVATE);
  }
}

/** Reads a private key from PEM or DER bytes, with the errors Node reports. */
export function readPrivateKey(data: Uint8Array, encoding: KeyEncoding): PrivateMaterial {
  if (encoding.format === "pem") return readPrivatePem(pemBlocks(latin1.decode(data)).find(block => PRIVATE_LABELS.includes(block.label)), encoding.passphrase);
  return readPrivateDer(data, encoding.type === "pkcs1" || encoding.type === "sec1" || encoding.type === "pkcs8" ? encoding.type : undefined, encoding.passphrase);
}

/** Node's test for PKCS#1 DER holding a private key: a SEQUENCE that starts with a one-byte INTEGER 0 or 1. */
function isRsaPrivateKey(data: Uint8Array): boolean {
  if (data[0] !== 0x30) return false;
  const first = data[1];
  if (first === undefined) return false;
  const offset = first < 0x80 ? 2 : 2 + (first & 0x7f);
  return data[offset] === 2 && data[offset + 1] === 1 && ((data[offset + 2] ?? 0xff) & 0xfe) === 0;
}
function publicFailure(error: unknown, lead: readonly OpensslEntry[]): OpensslEntry[] {
  if (!(error instanceof Asn1Error) && !(error instanceof KeyCodecError)) throw error;
  return [...lead, ...asn1Queue(error)];
}

/**
 * Reads the key of a public key input: a public key (SPKI, PKCS#1, the key of an X.509 certificate) or, as
 * Node accepts wherever a public key is expected, a private key.
 */
export function readPublicKey(data: Uint8Array, encoding: KeyEncoding): ReadKey {
  if (encoding.format === "pem") {
    const blocks = pemBlocks(latin1.decode(data));
    const find = (labels: readonly string[]): PemBlock | undefined => blocks.find(block => labels.includes(block.label));
    const spki = find(["PUBLIC KEY"]), pkcs1 = spki === undefined ? find(["RSA PUBLIC KEY"]) : undefined;
    const certificate = spki === undefined && pkcs1 === undefined ? find(CERTIFICATE_LABELS) : undefined;
    const block = spki ?? pkcs1 ?? certificate;
    if (block === undefined) return { material: readPrivatePem(find(PRIVATE_LABELS), encoding.passphrase), isPrivate: true };
    if (block.headers.length > 0 && legacyEncryption(block.headers).state !== "plain") throw opensslError(OSSL.notProcType, [OSSL.notProcType]);
    try {
      if (pkcs1 !== undefined) return { material: decoding(() => parsePublic(pkcs1.body, "pkcs1")), isPrivate: false };
      const info = certificate === undefined ? block.body : certificatePublicKeyInfo(certificate.body);
      return { material: decoding(() => parsePublic(info, "spki")), isPrivate: false };
    } catch (error) {
      throw opensslError(OSSL.wrongTag, publicFailure(error, pkcs1 === undefined ? [OSSL.unsupported] : [OSSL.unsupported, OSSL.asn1Lib]));
    }
  }
  const type = encoding.type;
  if (type === "pkcs8" || type === "sec1" || (type === "pkcs1" && isRsaPrivateKey(data))) return { material: readPrivateDer(data, type, encoding.passphrase), isPrivate: true };
  const pkcs1 = type === "pkcs1";
  try { return { material: decoding(() => parsePublic(data, pkcs1 ? "pkcs1" : "spki")), isPrivate: false }; }
  catch (error) { throw failedToReadKey(publicFailure(error, pkcs1 ? [OSSL.asn1Lib] : [])); }
}

/** A key from its raw bytes (`format: 'raw-public' | 'raw-private' | 'raw-seed'` with `asymmetricKeyType`). */
export function readRawKey(data: Uint8Array, isPublic: boolean, keyType: string, namedCurve: unknown): ReadKey {
  if (keyType === "ec") {
    const curve = typeof namedCurve === "string" ? curveByName(namedCurve) : undefined;
    if (curve === undefined) throw invalidCurve();
    try {
      if (isPublic) return { material: { kind: "ec", namedCurve: curve, point: ecPoint(curve, data).point }, isPrivate: false };
      if (data.length !== CURVES[curve].size) throw invalidKeyData();
      return { material: { kind: "ec", namedCurve: curve, point: ecPublicPoint(curve, data), d: Uint8Array.from(data) }, isPrivate: true };
    } catch (error) {
      if (error instanceof KeyCodecError) throw invalidKeyData();
      throw error;
    }
  }
  const okp = OKP_KINDS.find(kind => kind === keyType);
  if (okp !== undefined) {
    if (data.length !== OKP[okp].size) throw invalidKeyData();
    if (isPublic) return { material: { kind: okp, publicKey: Uint8Array.from(data) }, isPrivate: false };
    return { material: { kind: okp, privateKey: Uint8Array.from(data), publicKey: OKP[okp].getPublicKey(data) }, isPrivate: true };
  }
  if (keyType === "rsa" || keyType === "rsa-pss" || keyType === "dh" || keyType === "dsa") throw incompatibleKeyType();
  if (/^(ml-dsa|ml-kem|slh-dsa)-/u.test(keyType)) return unavailableNodeApi(`crypto key type ${keyType}`);
  throw codedError(TypeError, "ERR_INVALID_ARG_VALUE", `Invalid asymmetricKeyType: ${keyType}`);
}

/** A public key in PEM (a string) or DER (a Buffer), as `KeyObject.prototype.export` returns it. */
export function writePublicKey(material: PublicMaterial, encoding: KeyEncoding): string | Buffer {
  const type = encoding.type === "pkcs1" ? "pkcs1" : "spki";
  const bytes = encodePublic(material, type);
  return encoding.format === "pem" ? pemEncode(type === "pkcs1" ? "RSA PUBLIC KEY" : "PUBLIC KEY", bytes) : Buffer.from(bytes);
}

function resolveCipher(cipher: string): KeyCipher {
  const resolved = keyCipher(cipher);
  if (resolved === undefined) throw unknownCipher();
  if (resolved === "unsupported") return unavailableNodeApi(`crypto key encryption with ${cipher}`);
  return resolved;
}

/** A private key in PEM or DER, encrypted when the encoding names a cipher. */
export function writePrivateKey(material: PrivateMaterial, encoding: KeyEncoding): string | Buffer {
  const type = encoding.type === "pkcs1" || encoding.type === "sec1" ? encoding.type : "pkcs8";
  const cipher = typeof encoding.cipher === "string" ? resolveCipher(encoding.cipher) : undefined;
  const passphrase = encoding.passphrase ?? new Uint8Array();
  const bytes = encodePrivate(material, type);
  if (type === "pkcs8") {
    const body = cipher === undefined ? bytes : encryptPkcs8(bytes, passphrase, cipher, randomBytes(16), randomBytes(16));
    return encoding.format === "pem" ? pemEncode(cipher === undefined ? "PRIVATE KEY" : "ENCRYPTED PRIVATE KEY", body) : Buffer.from(body);
  }
  const label = type === "pkcs1" ? "RSA PRIVATE KEY" : "EC PRIVATE KEY";
  if (encoding.format !== "pem") return Buffer.from(bytes);
  if (cipher === undefined) return pemEncode(label, bytes);
  const encrypted = legacyEncrypt(bytes, passphrase, cipher, randomBytes(16));
  return pemEncode(label, encrypted.body, encrypted.headers);
}
