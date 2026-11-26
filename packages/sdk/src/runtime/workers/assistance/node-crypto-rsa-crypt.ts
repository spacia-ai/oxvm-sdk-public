/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/crypto/cipher.js (rsaFunctionFor: the order in which
 * publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt read and validate their arguments).
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
import { bytesOf } from "./node-crypto-key-encoding.ts";
import { OSSL, opensslError, type OpensslEntry } from "./node-crypto-key-errors.ts";
import type { KeyMaterial, RsaPrivate, RsaPublic } from "./node-crypto-key-model.ts";
import type { createCryptoKeys, KeyInput } from "./node-crypto-keys.ts";
import { type Digest, digestFor, member, truthy, unsupportedDigest } from "./node-crypto-misc.ts";
import { modulusLength, oaepDecrypt, oaepEncrypt, pkcs1v15Decrypt, pkcs1v15Encrypt, pkcs1v15Recover, pkcs1v15Sign, rawPrivate, rawPublic } from "./node-crypto-rsa.ts";
import { SIGN_OSSL, emptyOpensslError, invalidDigestUsed, withRsaErrors } from "./node-crypto-sign-errors.ts";
import { RSA_PADDING, entropy, rsaHash } from "./node-crypto-sign-rsa.ts";
import { named, validateString } from "./node-util-validators.ts";

type Keys = ReturnType<typeof createCryptoKeys>;
type Operation = "publicEncrypt" | "privateDecrypt" | "privateEncrypt" | "publicDecrypt";
interface Request { readonly padding: number; readonly digest: Digest | undefined; readonly label: Uint8Array | undefined; readonly data: Uint8Array }

function privateOf(key: RsaPublic | RsaPrivate): RsaPrivate | undefined { return "d" in key ? key : undefined; }
/** The padding as OpenSSL receives it: Node converts whatever the option holds to an unsigned 32-bit integer. */
function paddingOf(value: unknown, fallback: number): number { return truthy(value) ? Number(value) >>> 0 : fallback; }

/** `publicEncrypt` and `privateDecrypt`: OpenSSL's asymmetric cipher. */
function cipher(operation: "publicEncrypt" | "privateDecrypt", material: KeyMaterial, request: Request): Uint8Array {
  if (material.kind === "rsa-pss") throw opensslError(SIGN_OSSL.providerKeytypeUnsupported);
  if (material.kind !== "rsa") throw opensslError(SIGN_OSSL.keytypeUnsupported);
  const { padding, digest, data } = request;
  if (padding === RSA_PADDING.pss) throw emptyOpensslError();
  if (padding !== RSA_PADDING.pkcs1 && padding !== RSA_PADDING.none && padding !== RSA_PADDING.oaep) throw opensslError(SIGN_OSSL.unknownPaddingType);
  // The digest is set whatever the padding; only OAEP then uses it.
  if (digest?.kind === "unavailable") throw opensslError(SIGN_OSSL.evpUnsupported);
  const encrypting = operation === "publicEncrypt";
  const size = modulusLength(material);
  const secret = privateOf(material);
  const queue = (main: OpensslEntry): readonly OpensslEntry[] | undefined =>
    !encrypting && padding === RSA_PADDING.oaep && main !== SIGN_OSSL.oaepDecoding ? [SIGN_OSSL.failedToDecrypt] : undefined;
  if (!encrypting) {
    if (secret === undefined) throw opensslError(OSSL.rsaMissingPrivateKey, [SIGN_OSSL.failedToDecrypt]);
    if (data.length === 0) throw opensslError(SIGN_OSSL.dataTooSmall, queue(SIGN_OSSL.dataTooSmall));
  }
  if (padding === RSA_PADDING.oaep) {
    if (digest?.kind === "xof") throw encrypting ? opensslError(SIGN_OSSL.invalidLength) : emptyOpensslError();
    const hash = rsaHash(digest?.name ?? "sha1");
    // BLAKE2, SM3 and MD5-SHA1 are OAEP digests in OpenSSL that the RSA primitives here do not have.
    if (hash === undefined) throw unsupportedDigest(digest?.name ?? "sha1");
    const label = request.label ?? new Uint8Array(0);
    return withRsaErrors(() => secret === undefined || encrypting ? oaepEncrypt(material, hash, hash, label, data, entropy) : oaepDecrypt(secret, hash, hash, label, data, entropy), queue);
  }
  if (padding === RSA_PADDING.pkcs1) {
    return withRsaErrors(() => secret === undefined || encrypting ? pkcs1v15Encrypt(material, data, entropy) : pkcs1v15Decrypt(secret, data, entropy), queue);
  }
  if (encrypting) {
    if (data.length < size) throw opensslError(SIGN_OSSL.dataTooSmallForKeySize);
    if (data.length > size) throw opensslError(SIGN_OSSL.dataTooLargeForKeySize);
  }
  return withRsaErrors(() => secret === undefined || encrypting ? rawPublic(material, data) : rawPrivate(secret, data, entropy), queue);
}

/** `privateEncrypt` and `publicDecrypt`: OpenSSL's signature and its recovery, which know nothing of OAEP. */
function signature(operation: "privateEncrypt" | "publicDecrypt", material: KeyMaterial, isPrivate: boolean, request: Request): Uint8Array {
  const signing = operation === "privateEncrypt";
  switch (material.kind) {
    case "x25519": case "x448": case "dh": throw opensslError(SIGN_OSSL.keytypeUnsupported);
    case "ec": case "ed25519": case "ed448": throw signing ? emptyOpensslError() : opensslError(SIGN_OSSL.signatureNotSupported);
    case "rsa-pss":
      if (!signing) throw opensslError(SIGN_OSSL.providerKeytypeUnsupported);
      throw request.padding === RSA_PADDING.pss ? opensslError(SIGN_OSSL.invalidDigestLength, [SIGN_OSSL.signatureFailure]) : opensslError(SIGN_OSSL.illegalPaddingMode);
    case "rsa": break;
  }
  const { padding, data } = request;
  if (padding === RSA_PADDING.x931) throw opensslError(SIGN_OSSL.invalidX931Digest);
  if (padding === RSA_PADDING.pss && signing) throw opensslError(SIGN_OSSL.invalidDigestLength, [SIGN_OSSL.signatureFailure]);
  if (padding !== RSA_PADDING.pkcs1 && padding !== RSA_PADDING.none) throw opensslError(SIGN_OSSL.illegalPaddingMode);
  if (request.digest !== undefined) throw opensslError(SIGN_OSSL.invalidOperation);
  if (request.label !== undefined && request.label.length > 0) throw opensslError(SIGN_OSSL.commandNotSupported);
  const queue = [SIGN_OSSL.signatureFailure, SIGN_OSSL.rsaLib];
  const size = modulusLength(material);
  if (signing) {
    const secret = isPrivate ? privateOf(material) : undefined;
    if (secret === undefined) throw opensslError(OSSL.rsaMissingPrivateKey, queue);
    if (padding === RSA_PADDING.none) {
      if (data.length < size) throw opensslError(SIGN_OSSL.dataTooSmallForKeySize, queue);
      if (data.length > size) throw opensslError(SIGN_OSSL.dataTooLargeForKeySize, queue);
    }
    return withRsaErrors(() => padding === RSA_PADDING.none ? rawPrivate(secret, data, entropy) : pkcs1v15Sign(secret, null, data, entropy), () => queue);
  }
  if (padding === RSA_PADDING.none) return withRsaErrors(() => rawPublic(material, data), () => queue);
  const recovered = withRsaErrors(() => pkcs1v15Recover(material, data), main =>
    main === SIGN_OSSL.dataGreaterThanModLen || main === SIGN_OSSL.dataTooLargeForModulus ? queue : [...queue, SIGN_OSSL.paddingCheckFailed]);
  // OpenSSL reports a recovered payload of no bytes as a failure.
  if (recovered.length === 0) throw opensslError(SIGN_OSSL.rsaLib, [SIGN_OSSL.signatureFailure]);
  return recovered;
}

/** `publicEncrypt`, `privateDecrypt`, `privateEncrypt` and `publicDecrypt`. */
export function createCryptoRsaCrypt(keys: Keys) {
  const operationFor = (operation: Operation, defaultPadding: number) => {
    const needsPrivate = operation === "privateDecrypt" || operation === "privateEncrypt";
    return named((key?: unknown, buffer?: unknown): Buffer => {
      // Node checks the shape of the key argument first and has OpenSSL read the key after the other arguments.
      let given: KeyInput | undefined, failure: unknown;
      try { given = needsPrivate ? keys.keyFromInput(key, "private", "privateKey") : keys.keyFromInput(key, "public"); }
      catch (error) {
        if (error instanceof TypeError) throw error;
        failure = error;
        // An encoded public key is read here too (not by `sign`); the operation then misses its private half.
        if (needsPrivate) { try { given = keys.keyFromInput(key, "public", "privateKey"); } catch { given = undefined; } }
      }
      const padding = paddingOf(member(key, "padding"), defaultPadding);
      const oaepHash = member(key, "oaepHash"), oaepLabel = member(key, "oaepLabel"), encoding = member(key, "encoding");
      if (oaepHash !== undefined) validateString(oaepHash, "key.oaepHash");
      const label = oaepLabel === undefined ? undefined : bytesOf(oaepLabel, "key.oaepLabel", encoding);
      const data = bytesOf(buffer, "buffer", encoding);
      if (given === undefined) throw failure;
      let digest: Digest | undefined;
      if (oaepHash !== undefined) {
        digest = digestFor(oaepHash);
        if (digest === undefined) throw invalidDigestUsed();
        if (digest.kind === "unsupported") throw unsupportedDigest(oaepHash);
      }
      const request: Request = { padding, digest, label, data };
      const result = operation === "publicEncrypt" || operation === "privateDecrypt" ? cipher(operation, given.material, request) : signature(operation, given.material, given.isPrivate, request);
      return Buffer.from(result);
    }, "");
  };
  return {
    publicEncrypt: operationFor("publicEncrypt", RSA_PADDING.oaep), privateDecrypt: operationFor("privateDecrypt", RSA_PADDING.oaep),
    privateEncrypt: operationFor("privateEncrypt", RSA_PADDING.pkcs1), publicDecrypt: operationFor("publicDecrypt", RSA_PADDING.pkcs1),
  };
}
