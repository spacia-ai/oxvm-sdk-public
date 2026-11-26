import { unsafe } from "@noble/ciphers/aes.js";
import { authenticationFailure, unsupportedState, type CipherEngine } from "./node-crypto-cipher-modes.ts";

const BLOCK = 16;

function xorInto(target: Uint8Array, source: Uint8Array, offset = 0): void {
  for (let index = 0; index < BLOCK; index++) target[index] = (target[index] ?? 0) ^ (source[offset + index] ?? 0);
}
/** Doubling in GF(2^128) (RFC 7253, section 2). */
function double(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(BLOCK), carry = (block[0] ?? 0) >>> 7;
  for (let index = 0; index < BLOCK; index++) out[index] = (((block[index] ?? 0) << 1) | ((block[index + 1] ?? 0) >>> 7)) & 0xff;
  out[BLOCK - 1] = (out[BLOCK - 1] ?? 0) ^ (carry * 0x87);
  return out;
}
function trailingZeros(value: number): number { return 31 - Math.clz32(value & -value); }

/** AES-OCB (RFC 7253). Whole blocks leave `update` as they fill; a tag length of zero is a context OpenSSL cannot use. */
export function ocb(key: Uint8Array, iv: Uint8Array, encrypting: boolean, tagLength: number): CipherEngine {
  const forward = unsafe.expandKeyLE(key), backward = encrypting ? forward : unsafe.expandKeyDecLE(key);
  const encrypt = (block: Uint8Array): Uint8Array => unsafe.encryptBlock(forward, block);
  const star = encrypt(new Uint8Array(BLOCK)), dollar = double(star);
  const table: Uint8Array[] = [double(dollar)];
  const tableAt = (index: number): Uint8Array => {
    let last = table[table.length - 1] ?? dollar;
    while (table.length <= index) { last = double(last); table.push(last); }
    return table[index] ?? last;
  };
  const nonce = new Uint8Array(BLOCK);
  nonce[0] = (((tagLength * 8) % 128) << 1) & 0xff;
  nonce.set(iv, BLOCK - iv.length);
  nonce[BLOCK - 1 - iv.length] = (nonce[BLOCK - 1 - iv.length] ?? 0) | 1;
  const bottom = (nonce[BLOCK - 1] ?? 0) & 63;
  nonce[BLOCK - 1] = (nonce[BLOCK - 1] ?? 0) & 0xc0;
  const stretch = new Uint8Array(BLOCK + 9);
  stretch.set(encrypt(nonce));
  for (let index = 0; index < 8; index++) stretch[BLOCK + index] = (stretch[index] ?? 0) ^ (stretch[index + 1] ?? 0);
  const offset = new Uint8Array(BLOCK);
  for (let index = 0, at = bottom >>> 3, shift = bottom & 7; index < BLOCK; index++, at++) {
    offset[index] = (((stretch[at] ?? 0) << shift) | ((stretch[at + 1] ?? 0) >>> (8 - shift))) & 0xff;
  }
  const checksum = new Uint8Array(BLOCK), pending = new Uint8Array(BLOCK), scratch = new Uint8Array(BLOCK);
  let pendingLength = 0, blocks = 0;
  const sum = new Uint8Array(BLOCK), aadOffset = new Uint8Array(BLOCK), aadPending = new Uint8Array(BLOCK);
  let aadLength = 0, aadBlocks = 0;
  let wanted: Uint8Array | undefined, produced: Uint8Array | undefined;

  const block = (data: Uint8Array, at: number): void => {
    xorInto(offset, tableAt(trailingZeros(++blocks)));
    if (encrypting) xorInto(checksum, data, at);
    scratch.set(data.subarray(at, at + BLOCK));
    xorInto(scratch, offset);
    if (encrypting) unsafe.encryptBlock(forward, scratch); else unsafe.decryptBlock(backward, scratch);
    xorInto(scratch, offset);
    data.set(scratch, at);
    if (!encrypting) xorInto(checksum, scratch);
  };
  const aadBlock = (data: Uint8Array, at: number): void => {
    xorInto(aadOffset, tableAt(trailingZeros(++aadBlocks)));
    scratch.set(data.subarray(at, at + BLOCK));
    xorInto(scratch, aadOffset);
    xorInto(sum, encrypt(scratch));
  };
  /** Runs `each` over the whole blocks of the held bytes followed by `data`; returns what it wrote. */
  const blocksOf = (held: Uint8Array, heldLength: number, data: Uint8Array, each: (out: Uint8Array, at: number) => void): { out: Uint8Array; rest: number } => {
    const joined = new Uint8Array(heldLength + data.length);
    joined.set(held.subarray(0, heldLength)); joined.set(data, heldLength);
    const whole = joined.length & ~(BLOCK - 1);
    for (let at = 0; at < whole; at += BLOCK) each(joined, at);
    held.set(joined.subarray(whole));
    return { out: joined.subarray(0, whole), rest: joined.length - whole };
  };
  return {
    update(data) {
      if (tagLength === 0) throw unsupportedState();
      const { out, rest } = blocksOf(pending, pendingLength, data, block);
      pendingLength = rest;
      return out;
    },
    final() {
      if (tagLength === 0) throw authenticationFailure();
      const out = pending.slice(0, pendingLength);
      if (pendingLength > 0) {
        xorInto(offset, star);
        const pad = encrypt(Uint8Array.from(offset));
        const plain = new Uint8Array(BLOCK);
        if (encrypting) plain.set(out);
        for (let index = 0; index < out.length; index++) out[index] = (out[index] ?? 0) ^ (pad[index] ?? 0);
        if (!encrypting) plain.set(out);
        plain[pendingLength] = 0x80;
        xorInto(checksum, plain);
      }
      if (aadLength > 0) {
        xorInto(aadOffset, star);
        scratch.fill(0); scratch.set(aadPending.subarray(0, aadLength)); scratch[aadLength] = 0x80;
        xorInto(scratch, aadOffset);
        xorInto(sum, encrypt(scratch));
      }
      xorInto(checksum, offset); xorInto(checksum, dollar);
      const tag = encrypt(checksum);
      xorInto(tag, sum);
      if (encrypting) produced = tag.subarray(0, tagLength);
      else if (wanted === undefined || wanted.length !== tagLength || !matches(tag, wanted)) throw authenticationFailure();
      return out;
    },
    aead: {
      setAAD(data) { aadLength = blocksOf(aadPending, aadLength, data, aadBlock).rest; return true; },
      tag: () => produced,
      acceptsTag: length => length === tagLength,
      setTag(tag) { wanted = tag; },
    },
  };
}
function matches(computed: Uint8Array, tag: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < tag.length; index++) difference |= (computed[index] ?? 0) ^ (tag[index] ?? 0);
  return difference === 0;
}
