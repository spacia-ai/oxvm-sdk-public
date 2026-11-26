/*!
 * Portions adapted from Node.js v24.18.1 lib/tls.js (convertALPNProtocols and the defaults), lib/internal/tls/common.js
 * (SecureContext, createSecureContext, toV) and lib/internal/tls/secure-context.js (configSecureContext).
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
import { Buffer } from "buffer";
import { inspectValue, invalidInstance, invalidType, invalidValue, named, outOfRange, validateInteger, validateString } from "./node-util-validators.ts";

/** OpenSSL 3.5's cipher names as Node 24.18.1 lists them. The guest's own Node negotiates; this is its catalogue. */
export const TLS_CIPHERS = ["aes128-gcm-sha256", "aes128-sha", "aes128-sha256", "aes256-gcm-sha384", "aes256-sha", "aes256-sha256", "dhe-psk-aes128-cbc-sha", "dhe-psk-aes128-cbc-sha256", "dhe-psk-aes128-gcm-sha256",
  "dhe-psk-aes256-cbc-sha", "dhe-psk-aes256-cbc-sha384", "dhe-psk-aes256-gcm-sha384", "dhe-psk-chacha20-poly1305", "dhe-rsa-aes128-gcm-sha256", "dhe-rsa-aes128-sha", "dhe-rsa-aes128-sha256",
  "dhe-rsa-aes256-gcm-sha384", "dhe-rsa-aes256-sha", "dhe-rsa-aes256-sha256", "dhe-rsa-chacha20-poly1305", "ecdhe-ecdsa-aes128-gcm-sha256", "ecdhe-ecdsa-aes128-sha",
  "ecdhe-ecdsa-aes128-sha256", "ecdhe-ecdsa-aes256-gcm-sha384", "ecdhe-ecdsa-aes256-sha", "ecdhe-ecdsa-aes256-sha384", "ecdhe-ecdsa-chacha20-poly1305", "ecdhe-psk-aes128-cbc-sha",
  "ecdhe-psk-aes128-cbc-sha256", "ecdhe-psk-aes256-cbc-sha", "ecdhe-psk-aes256-cbc-sha384", "ecdhe-psk-chacha20-poly1305", "ecdhe-rsa-aes128-gcm-sha256", "ecdhe-rsa-aes128-sha",
  "ecdhe-rsa-aes128-sha256", "ecdhe-rsa-aes256-gcm-sha384", "ecdhe-rsa-aes256-sha", "ecdhe-rsa-aes256-sha384", "ecdhe-rsa-chacha20-poly1305", "psk-aes128-cbc-sha", "psk-aes128-cbc-sha256",
  "psk-aes128-gcm-sha256", "psk-aes256-cbc-sha", "psk-aes256-cbc-sha384", "psk-aes256-gcm-sha384", "psk-chacha20-poly1305", "rsa-psk-aes128-cbc-sha", "rsa-psk-aes128-cbc-sha256",
  "rsa-psk-aes128-gcm-sha256", "rsa-psk-aes256-cbc-sha", "rsa-psk-aes256-cbc-sha384", "rsa-psk-aes256-gcm-sha384", "rsa-psk-chacha20-poly1305", "srp-aes-128-cbc-sha", "srp-aes-256-cbc-sha",
  "srp-rsa-aes-128-cbc-sha", "srp-rsa-aes-256-cbc-sha", "tls_aes_128_ccm_8_sha256", "tls_aes_128_ccm_sha256", "tls_aes_128_gcm_sha256", "tls_aes_256_gcm_sha384", "tls_chacha20_poly1305_sha256"] as const;
/** The writable defaults `tls` exports, with Node's values when no command-line flag changes them. */
export const TLS_DEFAULTS = {
  CLIENT_RENEG_LIMIT: 3, CLIENT_RENEG_WINDOW: 600,
  DEFAULT_CIPHERS: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA",
  DEFAULT_ECDH_CURVE: "auto", DEFAULT_MIN_VERSION: "TLSv1.2", DEFAULT_MAX_VERSION: "TLSv1.3",
} as const;

function byteLengthError(index: number, length: number): RangeError {
  return Object.assign(new RangeError(`The byte length of the protocol at index ${String(index)} exceeds the maximum length. It must be <= 255. Received ${String(length)}`), { code: "ERR_OUT_OF_RANGE" });
}
/** `tls.convertALPNProtocols`: the protocols in OpenSSL's wire form (each name after its length), set on `out`. */
export const convertALPNProtocols = named(function (protocols: unknown, out: unknown): void {
  let wire: Buffer;
  if (Array.isArray(protocols)) {
    const names: unknown[] = protocols, parts: Buffer[] = [];
    for (const [index, name] of names.entries()) {
      if (typeof name !== "string") throw invalidType("string", "string or an instance of Buffer or ArrayBuffer", name);
      const bytes = Buffer.from(name, "utf8");
      if (bytes.length > 255) throw byteLengthError(index, bytes.length);
      parts.push(Buffer.from([bytes.length]), bytes);
    }
    wire = Buffer.concat(parts);
  } else if (ArrayBuffer.isView(protocols)) {
    // A copy of the view's bytes, whatever its element type.
    wire = Buffer.from(new Uint8Array(protocols.buffer, protocols.byteOffset, protocols.byteLength));
  } else return;
  if (out === null || out === undefined) throw new TypeError(`Cannot set properties of ${String(out)} (setting 'ALPNProtocols')`);
  if (typeof out !== "object" && typeof out !== "function") return;
  if (!Reflect.set(out, "ALPNProtocols", wire)) throw new TypeError("Cannot add property ALPNProtocols, object is not extensible");
}, "convertALPNProtocols");

const VERSIONS = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];
const METHODS = new Set(["SSLv23_method", "SSLv23_client_method", "SSLv23_server_method", "TLS_method", "TLS_client_method", "TLS_server_method", "TLSv1_method", "TLSv1_client_method", "TLSv1_server_method",
  "TLSv1_1_method", "TLSv1_1_client_method", "TLSv1_1_server_method", "TLSv1_2_method", "TLSv1_2_client_method", "TLSv1_2_server_method"]);
const truthy = (value: unknown): boolean => Boolean(value);
const present = (value: unknown): boolean => value !== undefined && value !== null;
function coded(error: Error, code: string): Error { return Object.assign(error, { code }); }
function version(which: "minimum" | "maximum", value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && VERSIONS.includes(value)) return;
  const quoted: unknown = JSON.stringify(value);
  throw coded(new TypeError(`${typeof quoted === "string" ? quoted : inspectValue(value)} is not a valid ${which} TLS protocol version`), "ERR_TLS_INVALID_PROTOCOL_VERSION");
}
function keyOrCert(name: string, value: unknown): void {
  if (typeof value !== "string" && !ArrayBuffer.isView(value)) throw invalidType(name, "string or an instance of Buffer, TypedArray, or DataView", value);
}
function each(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [value]; }
function stringOrNullish(name: string, value: unknown): TypeError {
  const error = invalidType(name, "T", value);
  error.message = error.message.replace("must be of type T.", "must be of type string or one of null or undefined.");
  return error;
}

/** The checks of `new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion)` that need no OpenSSL. */
function checkProtocol(secureProtocol: unknown, secureOptions: unknown, minVersion: unknown, maxVersion: unknown): void {
  if (truthy(secureProtocol)) {
    for (const bound of [minVersion, maxVersion]) {
      if (present(bound)) throw coded(new TypeError(`TLS protocol version ${JSON.stringify(bound)} conflicts with secureProtocol ${JSON.stringify(secureProtocol)}`), "ERR_TLS_PROTOCOL_VERSION_CONFLICT");
    }
  }
  version("minimum", minVersion); version("maximum", maxVersion);
  if (typeof secureProtocol === "string" && !METHODS.has(secureProtocol)) {
    const family = /^SSLv([23])_/u.exec(secureProtocol)?.[1];
    throw coded(new TypeError(family === undefined ? `Unknown method: ${secureProtocol}` : `SSLv${family} methods disabled`), "ERR_TLS_INVALID_PROTOCOL_METHOD");
  }
  if (truthy(secureOptions)) validateInteger(secureOptions, "secureOptions");
}
/** The argument checks of Node's `configSecureContext`, in its order. Nothing is parsed: OpenSSL is not here. */
function checkOptions(options: Readonly<Record<string, unknown>>): void {
  const { ca, cert, ciphers, clientCertEngine, crl, dhparam, ecdhCurve = TLS_DEFAULTS.DEFAULT_ECDH_CURVE, key, passphrase, privateKeyIdentifier, privateKeyEngine, sessionIdContext, sessionTimeout, sigalgs, ticketKeys } = options;
  if (present(ciphers)) validateString(ciphers, "options.ciphers");
  if (truthy(ca)) for (const item of each(ca)) keyOrCert("options.ca", item);
  if (truthy(cert)) for (const item of each(cert)) keyOrCert("options.cert", item);
  if (truthy(key)) {
    for (const item of each(key)) {
      const inner: unknown = Array.isArray(key) && typeof item === "object" && item !== null ? Reflect.get(item, "pem") : undefined, own: unknown = Array.isArray(key) && typeof item === "object" && item !== null ? Reflect.get(item, "passphrase") : undefined;
      keyOrCert("options.key", inner === undefined ? item : inner);
      const secret = own === undefined ? passphrase : own;
      if (present(secret)) validateString(secret, "options.passphrase");
    }
  }
  if (present(sigalgs)) { validateString(sigalgs, "options.sigalgs"); if (sigalgs === "") throw invalidValue("options.sigalgs", sigalgs); }
  if (present(privateKeyIdentifier)) {
    if (!present(privateKeyEngine)) throw invalidValue("options.privateKeyEngine", privateKeyEngine);
    if (truthy(key)) throw invalidValue("options.privateKeyIdentifier", privateKeyIdentifier);
    if (typeof privateKeyIdentifier !== "string") throw stringOrNullish("options.privateKeyIdentifier", privateKeyIdentifier);
    if (typeof privateKeyEngine !== "string") throw stringOrNullish("options.privateKeyEngine", privateKeyEngine);
    throw coded(new Error("Custom engines not supported by this OpenSSL"), "ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED");
  }
  validateString(ecdhCurve, "options.ecdhCurve");
  if (present(dhparam)) keyOrCert("options.dhparam", dhparam);
  if (present(crl)) for (const item of each(crl)) keyOrCert("options.crl", item);
  if (present(sessionIdContext)) validateString(sessionIdContext, "options.sessionIdContext");
  if (typeof clientCertEngine === "string") throw coded(new Error("Custom engines not supported by this OpenSSL"), "ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED");
  if (present(clientCertEngine)) throw stringOrNullish("options.clientCertEngine", clientCertEngine);
  if (present(ticketKeys)) {
    if (!ArrayBuffer.isView(ticketKeys)) throw invalidInstance("options.ticketKeys", "Buffer, TypedArray, or DataView", ticketKeys);
    if (ticketKeys.byteLength !== 48) throw invalidValue("options.ticketKeys", ticketKeys.byteLength, "must be exactly 48 bytes");
  }
  if (present(sessionTimeout)) {
    validateInteger(sessionTimeout, "options.sessionTimeout", -2_147_483_648, 2_147_483_647);
    if (sessionTimeout < 0) throw outOfRange("options.sessionTimeout", ">= 0 && <= 2147483647", sessionTimeout);
  }
}

const contexts = new WeakMap<object, Readonly<Record<string, unknown>>>();
/** The options a context made by `createSecureContext` holds, or `undefined` for any other value. */
export function secureContextOptions(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null ? contexts.get(value) : undefined;
}
/**
 * Node's `tls.SecureContext`, callable with or without `new`. There is no OpenSSL context in this process: the
 * object holds the validated options, and `tls.connect` passes on the ones the guest's TLS takes.
 */
export const SecureContext: (this: unknown, secureProtocol?: unknown, secureOptions?: unknown, minVersion?: unknown, maxVersion?: unknown) => object = named(function (this: unknown, secureProtocol?: unknown, secureOptions?: unknown, minVersion?: unknown, maxVersion?: unknown): object {
  if (!(this instanceof SecureContext)) return construct([secureProtocol, secureOptions, minVersion, maxVersion]);
  checkProtocol(secureProtocol, secureOptions, minVersion, maxVersion);
  Object.defineProperty(this, "context", { value: Object.freeze({}), enumerable: true, writable: true, configurable: true });
  contexts.set(this, { ...(truthy(secureProtocol) ? { secureProtocol } : {}), ...(truthy(secureOptions) ? { secureOptions } : {}), ...(present(minVersion) ? { minVersion } : {}), ...(present(maxVersion) ? { maxVersion } : {}) });
  return this;
}, "SecureContext");
Object.defineProperty(SecureContext, "length", { value: 4, configurable: true });
function construct(args: readonly unknown[]): object {
  const made: unknown = Reflect.construct(SecureContext, args);
  if (typeof made !== "object" || made === null) throw new TypeError("SecureContext did not construct an object");
  return made;
}

/** Node's `tls.createSecureContext(options)`. */
export const createSecureContext = named(function (options?: unknown): object {
  const given: unknown = truthy(options) ? options : {};
  const source: Readonly<Record<string, unknown>> = typeof given === "object" && given !== null ? { ...given } : {};
  const honorCipherOrder = source["honorCipherOrder"], secureOptions: unknown = truthy(honorCipherOrder) ? Number(source["secureOptions"] ?? 0) | 0x0040_0000 : source["secureOptions"];
  const context = construct([source["secureProtocol"], secureOptions, source["minVersion"], source["maxVersion"]]);
  if (given === null || Array.isArray(given) || typeof given !== "object") throw invalidType("options", "object", given);
  checkOptions(source);
  contexts.set(context, Object.freeze(source));
  return context;
}, "createSecureContext");
Object.defineProperty(createSecureContext, "length", { value: 1, configurable: true });
