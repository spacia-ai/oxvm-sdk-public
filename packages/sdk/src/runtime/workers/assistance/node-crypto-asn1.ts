/**
 * A small strict DER reader and writer for the key encodings of `node:crypto` (SPKI, PKCS#8, PKCS#1, SEC1,
 * PBES2 parameters and the outline of an X.509 certificate). Only definite, minimal lengths and single-byte
 * tags are accepted; a reader refuses bytes left over after the value it was asked for.
 */

export const TAG = Object.freeze({
  integer: 0x02, bitString: 0x03, octetString: 0x04, null: 0x05, oid: 0x06, utf8String: 0x0c,
  printableString: 0x13, sequence: 0x30, set: 0x31,
});

/** Why a value could not be read, in the terms OpenSSL's own ASN.1 decoder reports. */
export type Asn1FailureReason = "wrong-tag" | "too-long" | "not-enough-data" | "invalid";

/** A decoding failure. `depth` counts the constructed values entered before it (0 = the outermost value). */
export class Asn1Error extends Error {
  readonly reason: Asn1FailureReason;
  readonly depth: number;
  constructor(reason: Asn1FailureReason, depth: number, detail: string) {
    super(`Invalid DER: ${detail}`);
    this.name = "Asn1Error";
    this.reason = reason;
    this.depth = depth;
  }
}

/** One tag-length-value: `content` is the value's bytes, `raw` the whole encoding. */
export interface Asn1Value { readonly tag: number; readonly content: Uint8Array; readonly raw: Uint8Array }

/** The context-specific tag `[number]`, constructed (explicit wrappers and implicit constructed values) or primitive. */
export function contextTag(number: number, constructed = true): number { return 0x80 | (constructed ? 0x20 : 0) | number; }

export class DerReader {
  readonly #bytes: Uint8Array;
  readonly #depth: number;
  #offset = 0;
  constructor(bytes: Uint8Array, depth = 0) { this.#bytes = bytes; this.#depth = depth; }

  get depth(): number { return this.#depth; }
  get atEnd(): boolean { return this.#offset >= this.#bytes.length; }
  /** The next value's tag, or `undefined` at the end. */
  peekTag(): number | undefined { return this.#bytes[this.#offset]; }
  #fail(reason: Asn1FailureReason, detail: string): never { throw new Asn1Error(reason, this.#depth, detail); }

  /** Reads the next value; with `expected`, its tag must be that one. */
  read(expected?: number): Asn1Value {
    const bytes = this.#bytes, start = this.#offset;
    const tag = bytes[start];
    if (tag === undefined) this.#fail("not-enough-data", "missing value");
    if ((tag & 0x1f) === 0x1f) this.#fail("invalid", "multi-byte tag");
    const first = bytes[start + 1];
    if (first === undefined) this.#fail("not-enough-data", "missing length");
    let length = first, header = 2;
    if (first === 0x80) this.#fail("invalid", "indefinite length");
    if (first > 0x80) {
      const count = first & 0x7f;
      if (count > 4) this.#fail("too-long", "length of more than four bytes");
      length = 0;
      for (let index = 0; index < count; index += 1) {
        const byte = bytes[start + 2 + index];
        if (byte === undefined) this.#fail("not-enough-data", "truncated length");
        length = length * 256 + byte;
      }
      if (length < 0x80 || length < 256 ** (count - 1)) this.#fail("invalid", "non-minimal length");
      header = 2 + count;
    }
    const end = start + header + length;
    if (end > bytes.length) this.#fail("too-long", "value runs past the end");
    if (expected !== undefined && tag !== expected) this.#fail("wrong-tag", `expected tag ${expected.toString(16)}, found ${tag.toString(16)}`);
    this.#offset = end;
    return { tag, content: bytes.subarray(start + header, end), raw: bytes.subarray(start, end) };
  }
  /** Reads the next value only when its tag is `tag`. */
  optional(tag: number): Asn1Value | undefined { return this.peekTag() === tag ? this.read(tag) : undefined; }
  /** Enters a constructed value with the given tag. */
  enter(tag: number): DerReader { return new DerReader(this.read(tag).content, this.#depth + 1); }
  optionalEnter(tag: number): DerReader | undefined { return this.peekTag() === tag ? this.enter(tag) : undefined; }
  sequence(): DerReader { return this.enter(TAG.sequence); }
  set(): DerReader { return this.enter(TAG.set); }
  /** The content of an explicit `[number]` wrapper. */
  explicit(number: number): DerReader { return this.enter(contextTag(number)); }
  optionalExplicit(number: number): DerReader | undefined { return this.optionalEnter(contextTag(number)); }
  /** The content bytes of an implicitly tagged primitive `[number]`. */
  implicit(number: number, constructed = false): Uint8Array { return this.read(contextTag(number, constructed)).content; }

  /** An INTEGER's content bytes (two's complement, minimal). */
  integerBytes(): Uint8Array {
    const { content } = this.read(TAG.integer);
    const [first, second] = content;
    if (first === undefined) this.#fail("invalid", "empty INTEGER");
    if (second !== undefined && ((first === 0 && second < 0x80) || (first === 0xff && second >= 0x80))) this.#fail("invalid", "non-minimal INTEGER");
    return content;
  }
  integer(): bigint { return integerFromBytes(this.integerBytes()); }
  /** A non-negative INTEGER small enough to be a JavaScript number. */
  smallInteger(): number {
    const value = this.integer();
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) this.#fail("invalid", "INTEGER out of range");
    return Number(value);
  }
  /** A BIT STRING's bytes; only whole bytes (no unused bits) are accepted. */
  bitString(): Uint8Array {
    const { content } = this.read(TAG.bitString);
    if (content[0] !== 0) this.#fail("invalid", "BIT STRING with unused bits");
    return content.subarray(1);
  }
  octetString(): Uint8Array { return this.read(TAG.octetString).content; }
  null(): void { if (this.read(TAG.null).content.length !== 0) this.#fail("invalid", "NULL with content"); }
  /** An OBJECT IDENTIFIER in dotted form. */
  oid(): string {
    const { content } = this.read(TAG.oid);
    if (content.length === 0) this.#fail("invalid", "empty OBJECT IDENTIFIER");
    const arcs: bigint[] = [];
    let value = 0n, pending = false;
    for (const byte of content) {
      if (!pending && byte === 0x80) this.#fail("invalid", "non-minimal OBJECT IDENTIFIER arc");
      value = (value << 7n) | BigInt(byte & 0x7f);
      pending = (byte & 0x80) !== 0;
      if (!pending) { arcs.push(value); value = 0n; }
    }
    if (pending) this.#fail("invalid", "truncated OBJECT IDENTIFIER");
    const [head = 0n, ...rest] = arcs;
    const top = head < 40n ? 0n : head < 80n ? 1n : 2n;
    return [top, head - top * 40n, ...rest].map(String).join(".");
  }
  utf8String(): string { return decodeText(this.read(TAG.utf8String).content); }
  printableString(): string { return decodeText(this.read(TAG.printableString).content); }
  /** Refuses bytes after the last value read. */
  end(): void { if (!this.atEnd) this.#fail("invalid", "trailing bytes"); }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
function decodeText(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); }
  catch { throw new Asn1Error("invalid", 0, "malformed string"); }
}

/** Reads one complete value: the bytes hold exactly one value with the given tag. */
export function readDer(bytes: Uint8Array, tag: number = TAG.sequence): DerReader {
  const reader = new DerReader(bytes);
  const inner = reader.enter(tag);
  reader.end();
  return inner;
}

/** A two's-complement big-endian integer. */
export function integerFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const first = bytes[0];
  return first !== undefined && first >= 0x80 ? value - (1n << BigInt(bytes.length * 8)) : value;
}
/** An unsigned big-endian integer. */
export function unsignedFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}
/** The unsigned big-endian bytes of a non-negative integer: minimal, or left-padded to `length`. */
export function unsignedToBytes(value: bigint, length?: number): Uint8Array {
  if (value < 0n) throw new RangeError("Negative integer");
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const minimal = value === 0n ? 0 : hex.length / 2;
  const size = length ?? Math.max(minimal, 1);
  if (minimal > size) throw new RangeError("Integer does not fit");
  const bytes = new Uint8Array(size);
  for (let index = 0; index < minimal; index += 1) bytes[size - minimal + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Encodes one value with a minimal definite length. */
export function der(tag: number, ...content: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of content) length += part.length;
  const header = [tag];
  if (length < 0x80) header.push(length);
  else {
    const digits: number[] = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) digits.unshift(rest % 256);
    header.push(0x80 | digits.length, ...digits);
  }
  return concatBytes(Uint8Array.from(header), ...content);
}
export function derSequence(...content: readonly Uint8Array[]): Uint8Array { return der(TAG.sequence, ...content); }
export function derSet(...content: readonly Uint8Array[]): Uint8Array { return der(TAG.set, ...content); }
/** An INTEGER from two's-complement content bytes, as given. */
export function derIntegerBytes(content: Uint8Array): Uint8Array { return der(TAG.integer, content); }
export function derInteger(value: bigint): Uint8Array {
  if (value >= 0n) {
    const magnitude = unsignedToBytes(value);
    return der(TAG.integer, (magnitude[0] ?? 0) >= 0x80 ? concatBytes(Uint8Array.of(0), magnitude) : magnitude);
  }
  let size = 1;
  while (value < -(1n << BigInt(size * 8 - 1))) size += 1;
  return der(TAG.integer, unsignedToBytes((1n << BigInt(size * 8)) + value, size));
}
export function derBitString(bytes: Uint8Array): Uint8Array { return der(TAG.bitString, Uint8Array.of(0), bytes); }
export function derOctetString(bytes: Uint8Array): Uint8Array { return der(TAG.octetString, bytes); }
export function derNull(): Uint8Array { return Uint8Array.of(TAG.null, 0); }
export function derOid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(part => {
    if (!/^(0|[1-9]\d*)$/u.test(part)) throw new RangeError(`Invalid object identifier ${dotted}`);
    return BigInt(part);
  });
  const [top, second, ...rest] = arcs;
  if (top === undefined || second === undefined || top > 2n || (top < 2n && second > 39n)) throw new RangeError(`Invalid object identifier ${dotted}`);
  const content: number[] = [];
  for (const arc of [top * 40n + second, ...rest]) {
    const group = [Number(arc & 0x7fn)];
    for (let value = arc >> 7n; value > 0n; value >>= 7n) group.unshift(Number(value & 0x7fn) | 0x80);
    content.push(...group);
  }
  return der(TAG.oid, Uint8Array.from(content));
}
/** An explicit `[number]` wrapper around already encoded values. */
export function derExplicit(number: number, ...content: readonly Uint8Array[]): Uint8Array { return der(contextTag(number), ...content); }
/** An implicitly tagged `[number]` value holding the given content bytes. */
export function derImplicit(number: number, content: Uint8Array, constructed = false): Uint8Array { return der(contextTag(number, constructed), content); }
const encoder = new TextEncoder();
export function derUtf8String(text: string): Uint8Array { return der(TAG.utf8String, encoder.encode(text)); }
export function derPrintableString(text: string): Uint8Array {
  if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/u.test(text)) throw new RangeError("Not a PrintableString");
  return der(TAG.printableString, encoder.encode(text));
}
