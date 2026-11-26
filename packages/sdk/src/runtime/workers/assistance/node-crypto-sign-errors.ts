/**
 * The errors `node:crypto` reports for signatures and RSA encryption: Node's own coded errors and the ones it
 * builds from OpenSSL's error queue. Every shape was recorded from Node.js v24.18.1 (OpenSSL 3.5.7); see
 * `node-crypto-sign.controls.json` and `node-crypto-rsa-crypt.controls.json`.
 */
import { OSSL, codedError, opensslError, type OpensslEntry } from "./node-crypto-key-errors.ts";
import { RsaError, type RsaErrorDetail } from "./node-crypto-rsa.ts";

function entry(number: string, library: string, reason: string, code: string): OpensslEntry {
  return Object.freeze({ text: `error:${number}:${library}::${reason}`, library, reason, code });
}
const RSA = "rsa routines", EVP = "digital envelope routines", PROVIDER = "Provider routines";
function rsa(number: string, reason: string): OpensslEntry { return entry(number, RSA, reason, `ERR_OSSL_RSA_${reason.toUpperCase().replaceAll(" ", "_")}`); }
function evp(number: string, reason: string): OpensslEntry { return entry(number, EVP, reason, `ERR_OSSL_EVP_${reason.toUpperCase().replaceAll(" ", "_")}`); }
function provider(number: string, reason: string): OpensslEntry { return entry(number, PROVIDER, reason, `ERR_OSSL_${reason.toUpperCase().replaceAll(" ", "_")}`); }

export const SIGN_OSSL = Object.freeze({
  blockTypeNot01: rsa("0200006A", "block type is not 01"),
  dataGreaterThanModLen: rsa("0200006C", "data greater than mod len"),
  dataTooLargeForKeySize: rsa("0200006E", "data too large for key size"),
  dataTooSmall: rsa("0200006F", "data too small"),
  digestTooBig: rsa("02000070", "digest too big for rsa key"),
  paddingCheckFailed: rsa("02000072", "padding check failed"),
  unknownPaddingType: rsa("02000076", "unknown padding type"),
  oaepDecoding: rsa("02000079", "oaep decoding error"),
  dataTooSmallForKeySize: rsa("0200007A", "data too small for key size"),
  dataTooLargeForModulus: rsa("02000084", "data too large for modulus"),
  invalidPadding: rsa("0200008A", "invalid padding"),
  invalidLength: rsa("020000B5", "invalid length"),
  badFixedHeader: rsa("02000066", "bad fixed header decrypt"),
  nullBeforeBlockMissing: rsa("02000071", "null before block missing"),
  badPadByteCount: rsa("02000067", "bad pad byte count"),
  commandNotSupported: evp("03000093", "command not supported"),
  invalidOperation: evp("03000094", "invalid operation"),
  keytypeUnsupported: evp("03000096", "operation not supported for this keytype"),
  signatureFailure: evp("030000EA", "provider signature failure"),
  signatureNotSupported: evp("030000ED", "provider signature not supported"),
  evpUnsupported: evp("0308010C", "unsupported"),
  initializationError: evp("03000086", "initialization error"),
  mallocFailure: entry("078C0100", "common libcrypto routines", "malloc failure", "ERR_OSSL_CRYPTO_MALLOC_FAILURE"),
  invalidSaltLength: provider("1C800070", "invalid salt length"),
  invalidDigest: provider("1C80007A", "invalid digest"),
  failedToDecrypt: provider("1C8000A2", "failed to decrypt"),
  illegalPaddingMode: provider("1C8000A5", "illegal or unsupported padding mode"),
  invalidDigestLength: provider("1C8000A6", "invalid digest length"),
  invalidPaddingMode: provider("1C8000A8", "invalid padding mode"),
  invalidX931Digest: provider("1C8000AA", "invalid x931 digest"),
  saltLengthTooSmall: provider("1C8000AC", "pss saltlen too small"),
  digestNotAllowed: provider("1C8000AE", "digest not allowed"),
  providerKeytypeUnsupported: provider("1C8000B2", "operation not supported for this keytype"),
  rsaLib: OSSL.rsaLib,
});

const BY_DETAIL: Readonly<Partial<Record<RsaErrorDetail, OpensslEntry>>> = {
  "data too large for key size": SIGN_OSSL.dataTooLargeForKeySize, "data greater than mod len": SIGN_OSSL.dataGreaterThanModLen,
  "data too large for modulus": SIGN_OSSL.dataTooLargeForModulus, "data too small for key size": SIGN_OSSL.dataTooSmallForKeySize,
  "digest too big for rsa key": SIGN_OSSL.digestTooBig, "oaep decoding error": SIGN_OSSL.oaepDecoding, "invalid padding": SIGN_OSSL.invalidPadding,
  "block type is not 01": SIGN_OSSL.blockTypeNot01, "bad fixed header decrypt": SIGN_OSSL.badFixedHeader, "null before block missing": SIGN_OSSL.nullBeforeBlockMissing,
  "bad pad byte count": SIGN_OSSL.badPadByteCount, "invalid salt length": SIGN_OSSL.invalidSaltLength, "invalid digest length": SIGN_OSSL.invalidDigestLength,
};

/** The OpenSSL entry for a failure of the RSA primitives; `undefined` for anything else. */
export function rsaEntry(error: unknown): OpensslEntry | undefined {
  return error instanceof RsaError ? BY_DETAIL[error.detail] : undefined;
}
/** Runs RSA arithmetic and rewords its failures as OpenSSL does, with the queue `stack` gives for the failure. */
export function withRsaErrors<Result>(work: () => Result, stack: (main: OpensslEntry) => readonly OpensslEntry[] | undefined): Result {
  try { return work(); }
  catch (error) {
    const main = rsaEntry(error);
    if (main === undefined) throw error;
    throw opensslError(main, stack(main));
  }
}

/** OpenSSL's report without a library or a reason: what Node shows when the queue was empty. */
export function emptyOpensslError(): Error { return new Error("error:00000000:lib(0)::reason(0)"); }
export const signKeyRequired = (): Error => codedError(Error, "ERR_CRYPTO_SIGN_KEY_REQUIRED", "No key provided to sign");
export const notInitialised = (): Error => codedError(Error, "ERR_CRYPTO_INVALID_STATE", "Not initialised");
export const unsupportedOperation = (): Error => codedError(Error, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
export const malformedSignature = (): Error => codedError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Malformed signature");
export const contextUnsupported = (): Error => codedError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Context parameter is unsupported");
export const contextTooLong = (): Error => codedError(RangeError, "ERR_OUT_OF_RANGE", "context string must be at most 255 bytes");
export const invalidDigestUsed = (): Error => codedError(Error, "ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest used");
export const invalidDigestName = (): Error => codedError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");

/**
 * What a callback form hands its callback for a failure of the job itself: Node builds that error from the queue
 * alone, so it has the message and `opensslErrorStack` but no `code`, `library` or `reason`, and a failure Node
 * words itself arrives as "Deriving bits failed".
 */
export function jobError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.message.startsWith("error:")) {
    const stack: unknown = Reflect.get(error, "opensslErrorStack");
    return stack === undefined ? new Error(error.message) : Object.assign(new Error(error.message), { opensslErrorStack: stack });
  }
  return Reflect.get(error, "code") === "ERR_CRYPTO_OPERATION_FAILED" ? new Error("Deriving bits failed") : error;
}
