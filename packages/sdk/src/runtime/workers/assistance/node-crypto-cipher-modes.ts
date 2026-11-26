import { unsafe } from "@noble/ciphers/aes.js";
import { chacha20 } from "@noble/ciphers/chacha.js";

/**
 * The unauthenticated cipher modes behind `node:crypto`'s Cipheriv: each engine is the streaming state one
 * OpenSSL cipher context keeps (@noble/ciphers is one-shot), and reports failures as the errors Node throws.
 */
export interface AeadEngine {
  /** False when OpenSSL would refuse the additional data in the current state. */
  setAAD(aad: Uint8Array, plaintextLength: number): boolean;
  /** The tag of a finished encryption, or undefined when there is none. */
  tag(): Uint8Array | undefined;
  /** Whether a tag of this many bytes may be given to a decryption. */
  acceptsTag(length: number): boolean;
  setTag(tag: Uint8Array): void;
}
export interface CipherEngine {
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
  setPadding?(enabled: boolean): void;
  readonly aead?: AeadEngine;
}

const BLOCK = 16;
const EMPTY = new Uint8Array(0);

type OpensslReason = "bad decrypt" | "wrong final block length" | "tag not set";
const opensslReasons: Record<OpensslReason, readonly [number: string, code: string]> = {
  "bad decrypt": ["1C800064", "ERR_OSSL_BAD_DECRYPT"],
  "wrong final block length": ["1C80006B", "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH"],
  "tag not set": ["1C800077", "ERR_OSSL_TAG_NOT_SET"],
};
/** An OpenSSL provider failure as Node 24 (OpenSSL 3.5) decorates it. */
export function opensslFailure(reason: OpensslReason): Error {
  const [number, code] = opensslReasons[reason];
  const message = `error:${number}:Provider routines::${reason}`;
  return Object.assign(new Error(message), { opensslErrorStack: [message], library: "Provider routines", reason, code });
}
/** What Node throws when `EVP_CipherUpdate` fails. */
export function unsupportedState(): Error { return new Error("Trying to add data in unsupported state"); }
/** What Node throws when the final step of an authenticated cipher fails. */
export function authenticationFailure(): Error { return new Error("Unsupported state or unable to authenticate data"); }

/** A 4-byte aligned copy of `data` with `lead` bytes placed before the first aligned position. */
function alignedCopy(data: Uint8Array, lead: number): Uint8Array {
  const shift = (4 - (lead & 3)) & 3;
  const backing = new Uint8Array(shift + data.length + 3);
  backing.set(data, shift);
  return backing.subarray(shift, shift + data.length);
}
function words(bytes: Uint8Array): Uint32Array { return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2); }

/**
 * A keystream cipher over whole blocks: keeps the unused tail of the last keystream block between calls.
 * `whole` transforms whole blocks in place and advances the counter; `next` fills one keystream block.
 */
export class Keystream {
  readonly #block: Uint8Array;
  #used: number;
  readonly #whole: (data: Uint8Array) => void;
  constructor(blockLength: number, whole: (data: Uint8Array) => void) {
    this.#block = new Uint8Array(blockLength);
    this.#used = blockLength;
    this.#whole = whole;
  }
  apply(data: Uint8Array): Uint8Array {
    const block = this.#block, size = block.length;
    const lead = Math.min(size - this.#used, data.length);
    const out = alignedCopy(data, lead);
    let at = 0;
    for (; at < lead; at++, this.#used++) out[at] = (out[at] ?? 0) ^ (block[this.#used] ?? 0);
    const bulk = out.length - at - ((out.length - at) % size);
    if (bulk > 0) { this.#whole(out.subarray(at, at + bulk)); at += bulk; }
    if (at < out.length) {
      block.fill(0);
      this.#whole(block);
      for (this.#used = 0; at < out.length; at++, this.#used++) out[at] = (out[at] ?? 0) ^ (block[this.#used] ?? 0);
    }
    return out;
  }
}
/** AES-CTR over `counter`, which is advanced in place; GCM counts in the last 32 bits only. */
export function aesCounterStream(roundKeys: Uint32Array, counter: Uint8Array, wrap32: boolean): Keystream {
  return new Keystream(BLOCK, wrap32
    ? data => { unsafe.ctr32(roundKeys, false, counter, data, data); }
    : data => { unsafe.ctrCounter(roundKeys, counter, data, data); });
}
/** ChaCha20 (RFC 8439) from block `counter` on. */
export function chachaStream(key: Uint8Array, nonce: Uint8Array, counter: number): Keystream {
  let block = counter;
  return new Keystream(64, data => {
    const blocks = data.length / 64;
    // @noble/ciphers refuses the last block index; OpenSSL would carry into the nonce instead.
    if (block + blocks > 0xffff_ffff) throw new Error("chacha20: the 32-bit block counter is exhausted");
    chacha20(key, nonce, data, data, block);
    block += blocks;
  });
}
function streamEngine(apply: (data: Uint8Array) => Uint8Array): CipherEngine {
  return { update: apply, final: () => EMPTY };
}

/** OpenSSL's block buffering for ECB and CBC (`ossl_cipher_generic_block_update` / `_final`). */
function blockEngine(encrypting: boolean, transform: (blocks: Uint32Array) => void): CipherEngine {
  const held = new Uint8Array(BLOCK);
  let heldLength = 0, padding = true;
  return {
    setPadding(enabled) { padding = enabled; },
    update(data) {
      const out = new Uint8Array(data.length + BLOCK + 4);
      let read = 0, written = 0, left = data.length;
      let blocks: number;
      if (heldLength === 0) blocks = left & ~(BLOCK - 1);
      else {
        const take = Math.min(BLOCK - heldLength, left);
        held.set(data.subarray(0, take), heldLength);
        heldLength += take; read = take; left -= take;
        blocks = left & ~(BLOCK - 1);
      }
      // A decryption that pads keeps a whole last block back: it may hold the padding.
      if (heldLength === BLOCK && (encrypting || left > 0 || !padding)) { out.set(held, 0); written = BLOCK; heldLength = 0; }
      if (blocks > 0 && !encrypting && padding && blocks === left) blocks -= BLOCK;
      if (blocks > 0) { out.set(data.subarray(read, read + blocks), written); written += blocks; read += blocks; left -= blocks; }
      if (left > 0) { held.set(data.subarray(read, read + left), heldLength); heldLength += left; }
      if (written > 0) transform(new Uint32Array(out.buffer, 0, written >>> 2));
      return out.subarray(0, written);
    },
    final() {
      const out = new Uint8Array(BLOCK);
      if (encrypting) {
        if (padding) { out.set(held.subarray(0, heldLength)); out.fill(BLOCK - heldLength, heldLength); }
        else if (heldLength === 0) return EMPTY;
        else throw opensslFailure("wrong final block length");
        transform(words(out));
        return out;
      }
      if (heldLength !== BLOCK) {
        if (heldLength === 0 && !padding) return EMPTY;
        throw opensslFailure("wrong final block length");
      }
      out.set(held);
      transform(words(out));
      if (!padding) return out;
      const pad = out[BLOCK - 1] ?? 0;
      if (pad === 0 || pad > BLOCK) throw opensslFailure("bad decrypt");
      for (let index = BLOCK - pad; index < BLOCK; index++) if (out[index] !== pad) throw opensslFailure("bad decrypt");
      return out.subarray(0, BLOCK - pad);
    },
  };
}

function ecb(key: Uint8Array, encrypting: boolean): CipherEngine {
  const roundKeys = encrypting ? unsafe.expandKeyLE(key) : unsafe.expandKeyDecLE(key);
  const block = encrypting ? unsafe.encrypt : unsafe.decrypt;
  return blockEngine(encrypting, data => {
    for (let at = 0; at < data.length; at += 4) {
      const { s0, s1, s2, s3 } = block(roundKeys, data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0);
      data[at] = s0; data[at + 1] = s1; data[at + 2] = s2; data[at + 3] = s3;
    }
  });
}
function cbc(key: Uint8Array, iv: Uint8Array, encrypting: boolean): CipherEngine {
  const chain = words(Uint8Array.from(iv));
  let c0 = chain[0] ?? 0, c1 = chain[1] ?? 0, c2 = chain[2] ?? 0, c3 = chain[3] ?? 0;
  if (encrypting) {
    const roundKeys = unsafe.expandKeyLE(key);
    return blockEngine(true, data => {
      for (let at = 0; at < data.length; at += 4) {
        ({ s0: c0, s1: c1, s2: c2, s3: c3 } = unsafe.encrypt(roundKeys, (data[at] ?? 0) ^ c0, (data[at + 1] ?? 0) ^ c1, (data[at + 2] ?? 0) ^ c2, (data[at + 3] ?? 0) ^ c3));
        data[at] = c0; data[at + 1] = c1; data[at + 2] = c2; data[at + 3] = c3;
      }
    });
  }
  const roundKeys = unsafe.expandKeyDecLE(key);
  return blockEngine(false, data => {
    for (let at = 0; at < data.length; at += 4) {
      const n0 = data[at] ?? 0, n1 = data[at + 1] ?? 0, n2 = data[at + 2] ?? 0, n3 = data[at + 3] ?? 0;
      const { s0, s1, s2, s3 } = unsafe.decrypt(roundKeys, n0, n1, n2, n3);
      data[at] = s0 ^ c0; data[at + 1] = s1 ^ c1; data[at + 2] = s2 ^ c2; data[at + 3] = s3 ^ c3;
      c0 = n0; c1 = n1; c2 = n2; c3 = n3;
    }
  });
}

/** The feedback modes: one AES block per 16 bytes (CFB, OFB), per byte (CFB8) or per bit (CFB1). */
function feedback(key: Uint8Array, iv: Uint8Array, encrypting: boolean, mode: "cfb" | "cfb1" | "cfb8" | "ofb"): CipherEngine {
  const roundKeys = unsafe.expandKeyLE(key);
  const register = Uint8Array.from(iv), register32 = words(register);
  const stream = new Uint8Array(BLOCK), stream32 = words(stream);
  let used = BLOCK;
  const refill = (): void => {
    const { s0, s1, s2, s3 } = unsafe.encrypt(roundKeys, register32[0] ?? 0, register32[1] ?? 0, register32[2] ?? 0, register32[3] ?? 0);
    stream32[0] = s0; stream32[1] = s1; stream32[2] = s2; stream32[3] = s3;
  };
  const byteWise = (out: Uint8Array): void => {
    for (let at = 0; at < out.length; at++) {
      if (used === BLOCK) { refill(); used = 0; if (mode === "ofb") register.set(stream); }
      const input = out[at] ?? 0, output = input ^ (stream[used] ?? 0);
      if (mode === "cfb") register[used] = encrypting ? output : input;
      out[at] = output; used++;
    }
  };
  const shifted = (out: Uint8Array, bits: 1 | 8): void => {
    for (let at = 0; at < out.length; at++) {
      const input = out[at] ?? 0;
      let output = 0;
      for (let bit = 8 - bits; bit >= 0; bit -= bits) {
        refill();
        const mask = bits === 8 ? 0xff : 1;
        const source = (input >>> bit) & mask, result = source ^ (((stream[0] ?? 0) >>> (8 - bits)) & mask);
        const fed = encrypting ? result : source;
        if (bits === 8) { register.copyWithin(0, 1); register[BLOCK - 1] = fed; }
        else {
          for (let index = 0; index < BLOCK; index++) register[index] = (((register[index] ?? 0) << 1) | ((register[index + 1] ?? 0) >>> 7)) & 0xff;
          register[BLOCK - 1] = ((register[BLOCK - 1] ?? 0) & 0xfe) | fed;
        }
        output |= result << bit;
      }
      out[at] = output;
    }
  };
  return streamEngine(data => {
    const out = Uint8Array.from(data);
    if (mode === "cfb" || mode === "ofb") byteWise(out);
    else shifted(out, mode === "cfb8" ? 8 : 1);
    return out;
  });
}

/** AES key wrap (RFC 3394) with OpenSSL's choice of initial value; every update is one whole wrap. */
function keyWrap(key: Uint8Array, iv: Uint8Array, encrypting: boolean): CipherEngine {
  const roundKeys = encrypting ? unsafe.expandKeyLE(key) : unsafe.expandKeyDecLE(key);
  const block = new Uint8Array(BLOCK);
  const mix = (count: number): void => {
    for (let index = 7, rest = count; index >= 0 && rest > 0; index--, rest = Math.floor(rest / 256)) block[index] = (block[index] ?? 0) ^ (rest & 0xff);
  };
  const wrap = (data: Uint8Array): Uint8Array => {
    const blocks = data.length / 8, out = new Uint8Array(data.length + 8);
    out.set(data, 8); block.set(iv);
    for (let round = 0; round < 6; round++) for (let index = 1; index <= blocks; index++) {
      block.set(out.subarray(index * 8, index * 8 + 8), 8);
      unsafe.encryptBlock(roundKeys, block);
      mix(blocks * round + index);
      out.set(block.subarray(8), index * 8);
    }
    out.set(block.subarray(0, 8));
    return out;
  };
  const unwrap = (data: Uint8Array): Uint8Array => {
    const blocks = data.length / 8 - 1, out = Uint8Array.from(data.subarray(8));
    block.set(data.subarray(0, 8));
    for (let round = 5; round >= 0; round--) for (let index = blocks; index >= 1; index--) {
      mix(blocks * round + index);
      block.set(out.subarray((index - 1) * 8, index * 8), 8);
      unsafe.decryptBlock(roundKeys, block);
      out.set(block.subarray(8), (index - 1) * 8);
    }
    let difference = 0;
    for (let index = 0; index < 8; index++) difference |= (block[index] ?? 0) ^ (iv[index] ?? 0);
    if (difference !== 0) throw unsupportedState();
    return out;
  };
  return {
    update(data) {
      if (data.length === 0) return EMPTY;
      if (data.length % 8 !== 0 || data.length < (encrypting ? 16 : 24)) throw unsupportedState();
      return encrypting ? wrap(data) : unwrap(data);
    },
    final: () => EMPTY,
  };
}

export type PlainMode = "cbc" | "ecb" | "ctr" | "cfb" | "cfb1" | "cfb8" | "ofb" | "wrap" | "chacha20";
/** The engine of an unauthenticated cipher whose key and IV lengths were already checked. */
export function createPlainEngine(mode: PlainMode, key: Uint8Array, iv: Uint8Array, encrypting: boolean): CipherEngine {
  switch (mode) {
    case "ecb": return ecb(key, encrypting);
    case "cbc": return cbc(key, iv, encrypting);
    case "ctr": { const stream = aesCounterStream(unsafe.expandKeyLE(key), Uint8Array.from(iv), false); return streamEngine(data => stream.apply(data)); }
    case "cfb": case "cfb1": case "cfb8": case "ofb": return feedback(key, iv, encrypting, mode);
    case "wrap": return keyWrap(key, iv, encrypting);
    case "chacha20": {
      // OpenSSL's 16-byte IV is the 32-bit little-endian block counter followed by the RFC 8439 nonce.
      const counter = new DataView(iv.buffer, iv.byteOffset, 4).getUint32(0, true);
      const stream = chachaStream(Uint8Array.from(key), Uint8Array.from(iv.subarray(4)), counter);
      return streamEngine(data => stream.apply(data));
    }
  }
}
