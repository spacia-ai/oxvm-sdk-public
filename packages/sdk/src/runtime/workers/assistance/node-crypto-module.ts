import { cryptoExtras } from "./node-crypto-extra.ts";
import { createCryptoCiphers } from "./node-crypto-cipher.ts";
import { createCryptoDh } from "./node-crypto-dh.ts";
import { createCryptoEcdh } from "./node-crypto-ecdh.ts";
import { createCryptoKdf } from "./node-crypto-kdf.ts";
import { createCryptoKeygen } from "./node-crypto-keygen.ts";
import { createCryptoKeys } from "./node-crypto-keys.ts";
import { createCryptoMisc } from "./node-crypto-misc.ts";
import type { CryptoPorts } from "./node-crypto-ports.ts";
import { createCryptoPrimes } from "./node-crypto-prime-api.ts";
import { createCryptoRsaCrypt } from "./node-crypto-rsa-crypt.ts";
import { createCryptoSign } from "./node-crypto-sign.ts";

/** `util.deprecate`, as the process's own `node:util` provides it. */
type Deprecate = (fn: unknown, message: string, code: string) => unknown;
/** `process.emitWarning`, for the deprecation warnings some members emit themselves. */
type Warn = (message: string, type: string, code: string) => void;

/**
 * Assembles `node:crypto` from its owners: random values and WebCrypto (`base`), hashing, key derivation, ciphers, key
 * objects, signatures, RSA encryption, key generation and key agreement. Everything here is synchronous JavaScript, as Node's module is synchronous; WebCrypto stays what the
 * browser provides.
 */
export function createNodeCryptoModule(base: object, ports: CryptoPorts, deprecate: Deprecate, warn: Warn): Readonly<Record<string, unknown>> {
  const keys = createCryptoKeys();
  const { keyBytes } = keys;
  const { Hash, Hmac, constants, ...misc } = createCryptoMisc(ports, { keyBytes });
  const module = {
    ...base, ...cryptoExtras, ...createCryptoKdf(ports, { keyBytes }), ...misc, ...createCryptoCiphers({ keyBytes }),
    ...createCryptoSign(ports, keys), ...createCryptoRsaCrypt(keys), ...createCryptoKeygen(ports, keys, { emitWarning: warn }), ...createCryptoPrimes(ports),
    ...createCryptoEcdh(warn), ...createCryptoDh(ports, keys),
    KeyObject: keys.KeyObject, createSecretKey: keys.createSecretKey, createPublicKey: keys.createPublicKey, createPrivateKey: keys.createPrivateKey,
    // Node keeps both constructors callable and warns once when a program calls one.
    Hash: deprecate(Hash, "crypto.Hash constructor is deprecated.", "DEP0179"),
    Hmac: deprecate(Hmac, "crypto.Hmac constructor is deprecated.", "DEP0181"),
  };
  Object.defineProperty(module, "constants", { value: constants, enumerable: true, writable: false, configurable: false });
  return module;
}
