import { unsafe } from "@noble/ciphers/aes.js";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { poly1305 } from "@noble/ciphers/_poly1305.js";
import { ghash } from "@noble/ciphers/_polyval.js";
import { aesCounterStream, authenticationFailure, chachaStream, opensslFailure, unsupportedState, type CipherEngine } from "./node-crypto-cipher-modes.ts";
import { ocb } from "./node-crypto-cipher-ocb.ts";

/** The authenticated cipher modes of `node:crypto`, streaming as OpenSSL's contexts do. */
const BLOCK = 16;
const EMPTY = new Uint8Array(0);

/** Whether `tag` equals the first bytes of `computed`; scans every byte. */
export function tagMatches(computed: Uint8Array, tag: Uint8Array | undefined): boolean {
  if (tag === undefined || tag.length === 0 || tag.length > computed.length) return false;
  let difference = 0;
  for (let index = 0; index < tag.length; index++) difference |= (computed[index] ?? 0) ^ (tag[index] ?? 0);
  return difference === 0;
}
/** GCM's tag lengths (NIST SP 800-38D): 4, 8 and 12 to 16 bytes. */
export function validGcmTagLength(length: number): boolean { return length === 4 || length === 8 || (length >= 12 && length <= 16); }

/** Feeds a block hash whole blocks only; @noble/ciphers' GHASH zero-pads every update. */
class BlockFeed {
  readonly #update: (data: Uint8Array) => void;
  readonly #pending = new Uint8Array(BLOCK);
  #length = 0;
  total = 0;
  constructor(update: (data: Uint8Array) => void) { this.#update = update; }
  write(data: Uint8Array): void {
    this.total += data.length;
    let at = 0;
    if (this.#length > 0) {
      at = Math.min(BLOCK - this.#length, data.length);
      this.#pending.set(data.subarray(0, at), this.#length);
      this.#length += at;
      if (this.#length < BLOCK) return;
      this.#update(this.#pending); this.#length = 0;
    }
    const bulk = (data.length - at) & ~(BLOCK - 1);
    if (bulk > 0) { this.#update(data.subarray(at, at + bulk)); at += bulk; }
    if (at < data.length) { this.#pending.set(data.subarray(at)); this.#length = data.length - at; }
  }
  pad(): void {
    if (this.#length === 0) return;
    this.#update(this.#pending.subarray(0, this.#length)); this.#length = 0;
  }
}
function bitLength(view: DataView, offset: number, bytes: number, littleEndian: boolean, bits: 1 | 8): void {
  const high = Math.floor((bytes * bits) / 2 ** 32), low = (bytes * bits) % 2 ** 32;
  view.setUint32(offset + (littleEndian ? 4 : 0), high, littleEndian);
  view.setUint32(offset + (littleEndian ? 0 : 4), low, littleEndian);
}

function gcm(key: Uint8Array, iv: Uint8Array, encrypting: boolean, tagLength: number | undefined): CipherEngine {
  const roundKeys = unsafe.expandKeyLE(key);
  const hashKey = unsafe.encryptBlock(roundKeys, new Uint8Array(BLOCK));
  const counter = new Uint8Array(BLOCK);
  if (iv.length === 12) { counter.set(iv); counter[15] = 1; }
  else {
    const lengths = new Uint8Array(BLOCK);
    bitLength(new DataView(lengths.buffer), 8, iv.length, false, 8);
    ghash.create(hashKey, iv.length + BLOCK).update(iv).update(lengths).digestInto(counter);
  }
  const mask = new Uint8Array(BLOCK);
  // Encrypting the zero block under the pre-counter block yields the tag mask and steps the counter.
  unsafe.ctr32(roundKeys, false, counter, mask, mask);
  const stream = aesCounterStream(roundKeys, counter, true);
  // A 4-bit window: about 50 MB/s, and a table cheap enough to build for every short message.
  const hash = ghash.create(hashKey, 4096);
  const aad = new BlockFeed(data => { hash.update(data); }), text = new BlockFeed(data => { hash.update(data); });
  let inText = false;
  let wanted: Uint8Array | undefined, produced: Uint8Array | undefined;
  return {
    update(data) {
      if (!inText) { aad.pad(); inText = true; }
      if (!encrypting) text.write(data);
      const out = stream.apply(data);
      if (encrypting) text.write(out);
      return out;
    },
    final() {
      if (!inText) aad.pad();
      text.pad();
      const lengths = new Uint8Array(BLOCK), view = new DataView(lengths.buffer);
      bitLength(view, 0, aad.total, false, 8); bitLength(view, 8, text.total, false, 8);
      const tag = hash.update(lengths).digest();
      for (let index = 0; index < BLOCK; index++) tag[index] = (tag[index] ?? 0) ^ (mask[index] ?? 0);
      if (encrypting) produced = tag.subarray(0, tagLength ?? BLOCK);
      else if (!tagMatches(tag, wanted)) throw authenticationFailure();
      return EMPTY;
    },
    aead: {
      setAAD(data) { if (inText) return false; aad.write(data); return true; },
      tag: () => produced,
      acceptsTag: length => (tagLength === undefined || tagLength === length) && validGcmTagLength(length),
      setTag(tag) { wanted = tag; },
    },
  };
}

/** ChaCha20-Poly1305 (RFC 8439) with OpenSSL's handling of additional data given after the text began. */
function chachaPoly(key: Uint8Array, iv: Uint8Array, encrypting: boolean, tagLength: number): CipherEngine {
  const secret = Uint8Array.from(key), nonce = Uint8Array.from(iv);
  const mac = poly1305.create(chacha20(secret, nonce, new Uint8Array(32), undefined, 0));
  const stream = chachaStream(secret, nonce, 1);
  const zeros = new Uint8Array(BLOCK);
  let aadLength = 0, textLength = 0, aadOpen = false;
  let wanted: Uint8Array | undefined, produced: Uint8Array | undefined;
  const pad = (length: number): void => { if (length % BLOCK !== 0) mac.update(zeros.subarray(length % BLOCK)); };
  const closeAad = (): void => { if (aadOpen) { pad(aadLength); aadOpen = false; } };
  return {
    update(data) {
      closeAad();
      if (!encrypting) mac.update(data);
      const out = stream.apply(data);
      if (encrypting) mac.update(out);
      textLength += data.length;
      return out;
    },
    final() {
      closeAad();
      pad(textLength);
      const lengths = new Uint8Array(BLOCK), view = new DataView(lengths.buffer);
      bitLength(view, 0, aadLength, true, 1); bitLength(view, 8, textLength, true, 1);
      const tag = mac.update(lengths).digest();
      if (encrypting) produced = tag.subarray(0, tagLength);
      // OpenSSL compares as many bytes as it was given: a decryption without a tag is accepted.
      else if (wanted !== undefined && !tagMatches(tag, wanted)) throw authenticationFailure();
      return EMPTY;
    },
    aead: {
      setAAD(data) { mac.update(data); aadLength += data.length; aadOpen = true; return true; },
      tag: () => produced,
      acceptsTag: length => length === tagLength,
      setTag(tag) { wanted = tag; },
    },
  };
}

function missingPlaintextLength(): TypeError {
  return Object.assign(new TypeError("options.plaintextLength required for CCM mode with AAD"), { code: "ERR_MISSING_ARGS" });
}
function invalidMessageLength(): RangeError {
  return Object.assign(new RangeError("Invalid message length"), { code: "ERR_CRYPTO_INVALID_MESSAGELEN" });
}

/** CCM (RFC 3610): the whole message goes through one update, as OpenSSL requires. */
function ccm(key: Uint8Array, iv: Uint8Array, encrypting: boolean, tagLength: number): CipherEngine {
  const roundKeys = unsafe.expandKeyLE(key);
  const lengthBytes = 15 - iv.length;
  // Node's own limit (`CheckCCMMessageLength`).
  const limit = iv.length === 13 ? 65_535 : iv.length === 12 ? 16_777_215 : 2_147_483_647;
  let aad: Uint8Array = EMPTY, declared: number | undefined;
  let phase: "fresh" | "done" | "broken" = "fresh", failed = false;
  let wanted: Uint8Array | undefined, produced: Uint8Array | undefined;
  const counterBlock = (): Uint8Array => { const block = new Uint8Array(BLOCK); block[0] = lengthBytes - 1; block.set(iv, 1); return block; };
  /** The tag over the additional data and `message`, declared as `length` bytes long. */
  const tagOf = (message: Uint8Array, length: number, masked = true): Uint8Array => {
    const state = new Uint8Array(BLOCK);
    state[0] = (aad.length > 0 ? 0x40 : 0) | (((tagLength - 2) / 2) << 3) | (lengthBytes - 1);
    state.set(iv, 1);
    for (let index = 15, rest = length; index > 15 - lengthBytes; index--, rest = Math.floor(rest / 256)) state[index] = rest & 0xff;
    unsafe.encryptBlock(roundKeys, state);
    let filled = 0;
    const absorb = (data: Uint8Array): void => {
      for (const byte of data) {
        state[filled] = (state[filled] ?? 0) ^ byte;
        if (++filled === BLOCK) { unsafe.encryptBlock(roundKeys, state); filled = 0; }
      }
    };
    const close = (): void => { if (filled > 0) { unsafe.encryptBlock(roundKeys, state); filled = 0; } };
    if (aad.length > 0) {
      absorb(aad.length < 0xff00 ? Uint8Array.of(aad.length >>> 8, aad.length & 0xff)
        : Uint8Array.of(0xff, 0xfe, aad.length >>> 24, (aad.length >>> 16) & 0xff, (aad.length >>> 8) & 0xff, aad.length & 0xff));
      absorb(aad); close();
    }
    absorb(message); close();
    if (!masked) return state.subarray(0, tagLength);
    const first = unsafe.encryptBlock(roundKeys, counterBlock());
    for (let index = 0; index < BLOCK; index++) state[index] = (state[index] ?? 0) ^ (first[index] ?? 0);
    return state.subarray(0, tagLength);
  };
  const crypt = (data: Uint8Array): Uint8Array => {
    const counter = counterBlock();
    counter[15] = 1;
    return aesCounterStream(roundKeys, counter, false).apply(data);
  };
  return {
    update(data) {
      if (data.length > limit) throw invalidMessageLength();
      if (encrypting) {
        if (phase !== "fresh") { phase = "broken"; throw unsupportedState(); }
        if (declared !== undefined && declared !== data.length) throw unsupportedState();
        phase = "done";
        produced = tagOf(data, data.length);
        return crypt(data);
      }
      if (phase !== "fresh") { failed = true; return EMPTY; }
      phase = "done";
      if (wanted === undefined || (declared !== undefined && declared !== data.length)) { failed = true; return EMPTY; }
      const plain = crypt(data);
      if (!tagMatches(tagOf(plain, plain.length), wanted)) { failed = true; return EMPTY; }
      return plain;
    },
    final() {
      if (!encrypting) { if (failed) throw authenticationFailure(); return EMPTY; }
      if (phase === "done") return EMPTY;
      produced = undefined;
      throw phase === "fresh" ? opensslFailure("tag not set") : authenticationFailure();
    },
    aead: {
      setAAD(data, plaintextLength) {
        if (plaintextLength < 0) throw missingPlaintextLength();
        if (plaintextLength > limit) throw invalidMessageLength();
        aad = Uint8Array.from(data); declared = plaintextLength;
        // OpenSSL restarts the MAC here: after the text, the tag it hands out is the unmasked MAC of the additional data alone.
        if (encrypting && phase === "done") produced = tagOf(EMPTY, plaintextLength, false);
        return true;
      },
      tag: () => produced,
      acceptsTag: length => length === tagLength,
      setTag(tag) { wanted = tag; },
    },
  };
}

export type AeadMode = "gcm" | "ccm" | "ocb" | "chacha20-poly1305";
/** The engine of an authenticated cipher; key, IV and tag lengths were already checked (GCM's may be absent). */
export function createAeadEngine(mode: AeadMode, key: Uint8Array, iv: Uint8Array, encrypting: boolean, tagLength: number | undefined): CipherEngine {
  switch (mode) {
    case "gcm": return gcm(key, iv, encrypting, tagLength);
    case "ccm": return ccm(key, iv, encrypting, tagLength ?? BLOCK);
    case "ocb": return ocb(key, iv, encrypting, tagLength ?? BLOCK);
    case "chacha20-poly1305": return chachaPoly(key, iv, encrypting, tagLength ?? BLOCK);
  }
}
