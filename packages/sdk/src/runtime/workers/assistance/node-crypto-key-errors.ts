/**
 * The errors `node:crypto` reports for keys: Node's own coded errors and the ones it builds from OpenSSL's
 * error queue (`code`, `library`, `reason`, `opensslErrorStack`). Every shape here was recorded from
 * Node.js v24.18.1 (OpenSSL 3.5.7); see `node-crypto-keys.controls.json`.
 */
import { Asn1Error } from "./node-crypto-asn1.ts";

/** A Node error with a `code`: its only own enumerable property, as Node's internal errors have it. */
export function codedError(base: ErrorConstructor, code: string, message: string): Error {
  return Object.assign(new base(message), { code });
}
export const invalidThis = (type: string): Error => codedError(TypeError, "ERR_INVALID_THIS", `Value of "this" must be of type ${type}`);
export const invalidJwk = (message: string): Error => codedError(TypeError, "ERR_CRYPTO_INVALID_JWK", message);
export const missingPrivateJwk = (): Error => invalidJwk("JWK does not contain private key material");
export const invalidCurve = (): Error => codedError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
export const unsupportedJwkKeyType = (): Error => codedError(Error, "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.");
export const incompatibleKeyOptions = (encoding: unknown, reason: string): Error =>
  codedError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", `The selected key encoding ${String(encoding)} ${reason}.`);
export const invalidKeyObjectType = (actual: string, expected: string): Error =>
  codedError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${actual}, expected ${expected}.`);
export const incompatibleKeyType = (): Error => codedError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding is incompatible with the key type");
export const invalidKeyData = (): Error => codedError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid key data");
export const missingPassphrase = (): Error => codedError(TypeError, "ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key");
export const unknownCipher = (): Error => codedError(Error, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
export const unknownEncoding = (encoding: string): Error => codedError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`);

/** One entry of OpenSSL's error queue as Node words it. */
export interface OpensslEntry { readonly text: string; readonly library: string; readonly reason: string; readonly code: string }
function entry(number: string, library: string, reason: string, code: string): OpensslEntry {
  return Object.freeze({ text: `error:${number}:${library}::${reason}`, library, reason, code });
}
const ASN1 = "asn1 encoding routines";
export const OSSL = Object.freeze({
  unsupported: entry("1E08010C", "DECODER routines", "unsupported", "ERR_OSSL_UNSUPPORTED"),
  nested: entry("0688010A", ASN1, "nested asn1 error", "ERR_OSSL_ASN1_NESTED_ASN1_ERROR"),
  wrongTag: entry("068000A8", ASN1, "wrong tag", "ERR_OSSL_ASN1_WRONG_TAG"),
  asn1Lib: entry("0688000D", ASN1, "ASN1 lib", "ERR_OSSL_ASN1_ASN1_LIB"),
  badObjectHeader: entry("06800066", ASN1, "bad object header", "ERR_OSSL_ASN1_BAD_OBJECT_HEADER"),
  tooLong: entry("0680009B", ASN1, "too long", "ERR_OSSL_ASN1_TOO_LONG"),
  notEnoughData: entry("0680008E", ASN1, "not enough data", "ERR_OSSL_ASN1_NOT_ENOUGH_DATA"),
  notProcType: entry("0480006B", "PEM routines", "not proc type", "ERR_OSSL_PEM_NOT_PROC_TYPE"),
  badPasswordRead: entry("04800068", "PEM routines", "bad password read", "ERR_OSSL_PEM_BAD_PASSWORD_READ"),
  pemBadDecrypt: entry("04800065", "PEM routines", "bad decrypt", "ERR_OSSL_PEM_BAD_DECRYPT"),
  interrupted: entry("07880109", "common libcrypto routines", "interrupted or cancelled", "ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED"),
  unableToGetPassphrase: entry("1C80009F", "Provider routines", "unable to get passphrase", "ERR_OSSL_UNABLE_TO_GET_PASSPHRASE"),
  badDecrypt: entry("1C800064", "Provider routines", "bad decrypt", "ERR_OSSL_BAD_DECRYPT"),
  cipherFinal: entry("11800074", "PKCS12 routines", "pkcs12 cipherfinal error", "ERR_OSSL_PKCS12_PKCS12_CIPHERFINAL_ERROR"),
  rsaMissingPrivateKey: entry("020000B3", "rsa routines", "missing private key", "ERR_OSSL_RSA_MISSING_PRIVATE_KEY"),
  rsaLib: entry("1C880004", "Provider routines", "RSA lib", "ERR_OSSL_RSA_LIB"),
  notAPrivateKey: entry("1C8000DD", "Provider routines", "not a private key", "ERR_OSSL_NOT_A_PRIVATE_KEY"),
  ecMissingPrivateKey: entry("0800007D", "elliptic curve routines", "missing private key", "ERR_OSSL_EC_MISSING_PRIVATE_KEY"),
});

/**
 * The error Node throws for a failed OpenSSL call: the message, `library`, `reason` and `code` of one queue
 * entry, and the queue as `opensslErrorStack` when Node reports one.
 */
export function opensslError(main: OpensslEntry, stack?: readonly OpensslEntry[]): Error {
  const error = new Error(main.text);
  if (stack !== undefined) Object.assign(error, { opensslErrorStack: stack.map(item => item.text) });
  return Object.assign(error, { library: main.library, reason: main.reason, code: main.code });
}
/** Node's own message for a public key OpenSSL could not read, with the queue OpenSSL left. */
export function failedToReadKey(stack: readonly OpensslEntry[]): Error {
  return Object.assign(new Error("Failed to read asymmetric key"), { opensslErrorStack: stack.map(item => item.text) });
}

/**
 * The queue OpenSSL's template decoder leaves for malformed DER: one "nested asn1 error" for each level it had
 * entered, then the cause. Failures this reader finds that OpenSSL words otherwise are reported as a wrong tag.
 */
export function asn1Queue(error: unknown): OpensslEntry[] {
  if (error instanceof Asn1Error && (error.reason === "too-long" || error.reason === "not-enough-data") && error.depth === 0) return [OSSL.nested, OSSL.badObjectHeader, OSSL.tooLong];
  const nested = error instanceof Asn1Error ? error.depth + 1 : 2;
  return [...Array.from({ length: nested }, () => OSSL.nested), OSSL.wrongTag];
}
