# Symmetric ciphers for fast-path `node:crypto`

`@noble/ciphers` 2.0.1 is an MIT dependency with no dependencies of its own. Its exact package and
integrity digest are pinned in `pnpm-lock.yaml`. It joins `@noble/hashes` 2.0.1 and `@noble/curves`
2.0.1, by the same author and under the same license. No license allowlist changes are needed, and
`pnpm licenses:check` passes with it.

## Why it is needed

A fast-path process runs a program's JavaScript in a browser worker. Node's `node:crypto` is
synchronous: `createCipheriv(...).update(...)` returns bytes at once. The browser's WebCrypto is
asynchronous and has no streaming form, so it cannot back that interface. Without ciphers a program
that calls `createCipheriv` fails on the fast path and runs in full Linux on its next launch.

## What is used

Only the block and stream primitives are imported, statically:

- the AES block cipher and its ECB, CBC, CTR, CFB and key-wrap forms;
- GHASH and Poly1305, for the incremental GCM and ChaCha20-Poly1305 the SDK builds on them;
- ChaCha20.

The streaming behaviour of Node's `Cipheriv` and `Decipheriv` (partial blocks across `update` calls,
padding, authentication tags, output encodings) is first-party code in
`packages/sdk/src/runtime/workers/assistance/node-crypto-cipher*.ts`. The same package's AES-CBC also
decrypts and encrypts password-protected private keys (PKCS#8 with PBES2, and legacy PEM).

The library's `webcrypto` and `ff1` modules are not imported.

## What it does not change

- WebCrypto (`crypto.subtle`, `crypto.webcrypto`) stays the browser's own implementation.
- Nothing outside fast-path processes uses the library: image signatures, engine verification and the
  relay keep their existing code.
- JavaScript cannot guarantee constant-time execution. Tag comparison scans every byte, but timing
  can still vary with the engine's compiler and garbage collector. This matches the existing note on
  `timingSafeEqual` and is acceptable for a development environment in a browser tab; it is stated in
  `docs/acceleration.md`.

## Verification

Every provided cipher is compared with Node.js v24.18.1 (OpenSSL 3.5.7): ciphertext and tag equal
Node's for recorded inputs split across `update` calls at awkward boundaries, Node's ciphertext
decrypts here, and a changed tag, ciphertext or additional data is refused. Error class, `code` and
message are compared with recordings. The vectors and the script that recorded them are in
`node-crypto-cipher.controls.json`.

[Upstream documentation](https://github.com/paulmillr/noble-ciphers/tree/2.0.1) describes the
implementation, its audits and its test vectors.
