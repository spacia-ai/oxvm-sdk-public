/** V8's ValueSerializer wire format, version 15 (what Node.js v24.18.1 writes after the 0xFF 0x0F header),
 * written from the format's observable bytes: every tag below is covered by a control recorded from real Node.
 * This leaf owns bytes only. Node's `Serializer`/`Deserializer` classes and their hooks live in `node-v8-serdes.ts`. */

export const WIRE_FORMAT_VERSION = 15;

/** Thrown for malformed input; the Node layer turns it into its "Unable to deserialize cloned data." error. */
export class WireFailure extends Error {}

export interface WireWriterHost {
  /** The value to throw for an uncloneable value (Node calls `_getDataCloneError`). */
  cloneError(message: string): unknown;
  /** Writes the body of a host object; the tag is already written. */
  writeHostObject(object: object): void;
}
export interface WireReaderHost {
  /** Reads the body of a host object, or `undefined` when no reader is installed. */
  readHostObject(): object | undefined;
}

type Call = (self: unknown, ...args: unknown[]) => unknown;
function intrinsic(owner: object, name: string | symbol): Call {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  const operation: unknown = descriptor === undefined ? undefined : "value" in descriptor ? descriptor.value : Reflect.get(descriptor, "get");
  if (typeof operation !== "function") throw new TypeError(`Missing intrinsic ${String(name)}`);
  return (self, ...args) => { const result: unknown = Reflect.apply(operation, self, args); return result; };
}
function branded(check: Call, ...args: unknown[]): (value: object) => boolean {
  return value => { try { check(value, ...args); return true; } catch { return false; } };
}
const typedArrayPrototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
if (typeof typedArrayPrototype !== "object" || typedArrayPrototype === null) throw new TypeError("%TypedArray%.prototype is unavailable");
const typedArrayName = intrinsic(typedArrayPrototype, Symbol.toStringTag);
const objectToString = intrinsic(Object.prototype, "toString");
// Read when asked, not captured: the process installs a `toString` that answers with the program's own source text,
// where the engine's would show the text this runtime compiled.
const functionSource = (value: unknown): unknown => { const text: unknown = Reflect.get(Function.prototype, "toString"); return typeof text === "function" ? Reflect.apply(text, value, []) : undefined; };
const dateTime = intrinsic(Date.prototype, "getTime");
const regexpSource = intrinsic(RegExp.prototype, "source");
const mapEach = intrinsic(Map.prototype, "forEach"), setEach = intrinsic(Set.prototype, "forEach");
const booleanValue = intrinsic(Boolean.prototype, "valueOf"), numberValue = intrinsic(Number.prototype, "valueOf");
const stringValue = intrinsic(String.prototype, "valueOf"), bigintValue = intrinsic(BigInt.prototype, "valueOf");
const isDate = branded(dateTime), isMap = branded(intrinsic(Map.prototype, "has"), 0), isSet = branded(intrinsic(Set.prototype, "has"), 0);
const isRegExp = (value: object): boolean => value !== RegExp.prototype && branded(regexpSource)(value);
const isArrayBuffer = branded(intrinsic(ArrayBuffer.prototype, "byteLength"));
const isBoolean = branded(booleanValue), isNumber = branded(numberValue), isString = branded(stringValue), isBigInt = branded(bigintValue);
const isSymbol = branded(intrinsic(Symbol.prototype, "valueOf"));
const isWeakMap = branded(intrinsic(WeakMap.prototype, "has"), {}), isWeakSet = branded(intrinsic(WeakSet.prototype, "has"), {});
const isWeakRef = branded(intrinsic(WeakRef.prototype, "deref"));
const sharedPrototype: unknown = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer.prototype : undefined;
const isSharedBuffer = typeof sharedPrototype === "object" && sharedPrototype !== null ? branded(intrinsic(sharedPrototype, "byteLength")) : (): boolean => false;
const isError = ((): (value: object) => boolean => {
  const native: unknown = Reflect.get(Error, "isError");
  return typeof native === "function" ? value => Reflect.apply(native, Error, [value]) === true : value => value instanceof Error;
})();

function classTag(value: object): string {
  const text = objectToString(value);
  return typeof text === "string" ? text.slice(8, -1) : "Object";
}
/** Receivers V8 has no wire form for: anything that is not a plain object, an array or a listed built-in. */
function uncloneable(value: object): boolean {
  if (value instanceof Promise || isWeakMap(value) || isWeakSet(value) || isWeakRef(value) || isSharedBuffer(value) || isSymbol(value)) return true;
  const tag = classTag(value);
  return tag === "Generator" || tag === "AsyncGenerator" || tag === "Arguments" || tag === "FinalizationRegistry" || tag.endsWith(" Iterator")
    || tag.startsWith("Intl.") || tag.startsWith("WebAssembly.");
}
/** A data property through the prototype chain, never running a getter. */
function dataProperty(value: object, key: string | symbol): unknown {
  for (let current: object | null = value; current !== null; current = Reflect.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) { const found: unknown = descriptor.value; return found; }
  }
  return undefined;
}
const OMITTED = "...<omitted>...";
/** How V8 names a value inside "… could not be cloned." (recorded from Node 24.18.1, truncation included). */
export function cloneSubject(value: unknown): string {
  if (typeof value === "symbol") {
    const text = value.description ?? "";
    return `Symbol(${text.length > 128 ? text.slice(0, 56) + OMITTED + text.slice(-56) : text})`;
  }
  if (typeof value === "function") {
    const source = functionSource(value);
    const text = typeof source === "string" ? source : "";
    return text.length > 128 ? text.slice(0, 111) + OMITTED + text.slice(-2) : text;
  }
  if (typeof value !== "object" || value === null) return String(value);
  if (dataProperty(value, "toString") === Object.prototype.toString) {
    const constructor = dataProperty(value, "constructor");
    const name: unknown = typeof constructor === "function" ? Reflect.get(constructor, "name") : undefined;
    if (typeof name === "string" && name !== "") return `#<${name}>`;
  }
  const tag = dataProperty(value, Symbol.toStringTag);
  return `[object ${typeof tag === "string" ? tag : classTag(value)}]`;
}

/** View kind → wire sub-tag, in V8's ArrayBufferViewTag numbering. */
const VIEW_TAGS: Readonly<Record<string, number>> = {
  Int8Array: 0x62, Uint8Array: 0x42, Uint8ClampedArray: 0x43, Int16Array: 0x77, Uint16Array: 0x57, Int32Array: 0x64, Uint32Array: 0x44,
  Float16Array: 0x68, Float32Array: 0x66, Float64Array: 0x46, BigInt64Array: 0x71, BigUint64Array: 0x51, DataView: 0x3f,
};
export type ViewConstructor = new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => ArrayBufferView;
function isViewConstructor(value: unknown): value is ViewConstructor { return typeof value === "function"; }
/** The view constructors of this realm by name; `Float16Array` is absent on older engines. */
export function viewConstructor(name: string): ViewConstructor | undefined {
  if (!Object.hasOwn(VIEW_TAGS, name)) return undefined;
  const value: unknown = Reflect.get(globalThis, name);
  return isViewConstructor(value) ? value : undefined;
}
export function viewName(view: ArrayBufferView): string {
  const name = typedArrayName(view);
  return typeof name === "string" ? name : "DataView";
}
const ERROR_TAGS: Readonly<Record<string, number>> = { EvalError: 0x45, RangeError: 0x52, ReferenceError: 0x46, SyntaxError: 0x53, TypeError: 0x54, URIError: 0x55 };
const ERROR_CONSTRUCTORS: ReadonlyMap<number, ErrorConstructor> = new Map([
  [0x45, EvalError], [0x52, RangeError], [0x46, ReferenceError], [0x53, SyntaxError], [0x54, TypeError], [0x55, URIError],
]);
/** JSRegExp flag bits in V8's order; bit 6 (`linear`) has no JavaScript letter outside a V8 flag. */
const REGEXP_FLAGS: readonly (readonly [string, number])[] = [["g", 1], ["i", 2], ["m", 4], ["y", 8], ["u", 16], ["s", 32], ["d", 128], ["v", 256]];

function smi(value: number): boolean {
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0);
}
/** A canonical array index (0 … 2^32-2), which V8 writes as a number key. */
function indexKey(key: string): number | undefined {
  if (key.length === 0 || key.length > 10) return undefined;
  const value = Number(key);
  return Number.isInteger(value) && value >= 0 && value <= 4294967294 && String(value) === key ? value : undefined;
}
function varintSize(value: number): number { let size = 1; for (let rest = value; rest >= 128; rest = Math.floor(rest / 128)) size++; return size; }

export class WireWriter {
  readonly #host: WireWriterHost;
  #bytes = new Uint8Array(64);
  #length = 0;
  readonly #ids = new Map<object, number>();
  readonly #transfers = new Map<object, number>();
  viewsAreHostObjects = false;

  constructor(host: WireWriterHost) { this.#host = host; }

  /** The bytes written so far, in a buffer of exactly that size; the writer starts over. */
  release(): Uint8Array<ArrayBuffer> {
    const bytes = this.#bytes.slice(0, this.#length);
    this.#bytes = new Uint8Array(64); this.#length = 0;
    return bytes;
  }
  transfer(id: number, buffer: object): void { this.#transfers.set(buffer, id); }
  header(): void { this.#byte(0xff); this.varint(WIRE_FORMAT_VERSION); }

  #reserve(count: number): number {
    const start = this.#length;
    if (start + count > this.#bytes.length) {
      const grown = new Uint8Array(Math.max(this.#bytes.length * 2, start + count));
      grown.set(this.#bytes.subarray(0, start)); this.#bytes = grown;
    }
    this.#length = start + count;
    return start;
  }
  // Each writer reserves first: growing replaces the array an earlier read of `#bytes` would still hold.
  #byte(value: number): void { const at = this.#reserve(1); this.#bytes[at] = value; }
  varint(value: number): void {
    let rest = value;
    while (rest >= 128) { this.#byte((rest % 128) | 0x80); rest = Math.floor(rest / 128); }
    this.#byte(rest);
  }
  varint64(value: bigint): void {
    let rest = BigInt.asUintN(64, value);
    while (rest >= 128n) { this.#byte(Number(rest & 127n) | 0x80); rest >>= 7n; }
    this.#byte(Number(rest));
  }
  double(value: number): void { const at = this.#reserve(8); new DataView(this.#bytes.buffer).setFloat64(at, value, true); }
  raw(bytes: Uint8Array): void { const at = this.#reserve(bytes.length); this.#bytes.set(bytes, at); }

  #string(text: string): void {
    let oneByte = true;
    for (let index = 0; index < text.length && oneByte; index++) oneByte = text.charCodeAt(index) < 256;
    if (oneByte) {
      this.#byte(0x22); this.varint(text.length);
      const start = this.#reserve(text.length);
      for (let index = 0; index < text.length; index++) this.#bytes[start + index] = text.charCodeAt(index);
      return;
    }
    const size = text.length * 2;
    // V8 keeps two-byte characters on an even offset by writing one padding byte first.
    if (((this.#length + 1 + varintSize(size)) & 1) !== 0) this.#byte(0x00);
    this.#byte(0x63); this.varint(size);
    const start = this.#reserve(size);
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      this.#bytes[start + index * 2] = unit & 0xff; this.#bytes[start + index * 2 + 1] = unit >> 8;
    }
  }
  #bigint(value: bigint): void {
    let magnitude = value < 0n ? -value : value;
    const digits: bigint[] = [];
    for (; magnitude > 0n; magnitude >>= 64n) digits.push(magnitude & 0xffffffffffffffffn);
    this.varint(digits.length * 16 + (value < 0n ? 1 : 0));
    for (const digit of digits) { const at = this.#reserve(8); new DataView(this.#bytes.buffer).setBigUint64(at, digit, true); }
  }
  #number(value: number): void {
    if (smi(value)) { this.#byte(0x49); this.varint(((value << 1) ^ (value >> 31)) >>> 0); } else { this.#byte(0x4e); this.double(value); }
  }
  #fail(value: unknown): never { throw this.#host.cloneError(`${cloneSubject(value)} could not be cloned.`); }

  value(value: unknown): void {
    switch (typeof value) {
      case "undefined": this.#byte(0x5f); return;
      case "boolean": this.#byte(value ? 0x54 : 0x46); return;
      case "number": this.#number(value); return;
      case "bigint": this.#byte(0x5a); this.#bigint(value); return;
      case "string": this.#string(value); return;
      case "object": if (value === null) this.#byte(0x30); else this.#receiver(value); return;
      case "symbol": case "function": this.#fail(value);
    }
  }

  #receiver(value: object): void {
    const view = ArrayBuffer.isView(value) ? value : undefined;
    // A view's buffer is written, and numbered, before the view itself.
    if (view !== undefined && !this.viewsAreHostObjects && !this.#ids.has(view)) this.#receiver(view.buffer);
    const known = this.#ids.get(value);
    if (known !== undefined) { this.#byte(0x5e); this.varint(known); return; }
    this.#ids.set(value, this.#ids.size);
    if (Array.isArray(value)) { this.#array(value); return; }
    if (view !== undefined) {
      if (this.viewsAreHostObjects) { this.#byte(0x5c); this.#host.writeHostObject(view); } else this.#view(view);
      return;
    }
    if (isArrayBuffer(value)) { this.#buffer(value); return; }
    if (isDate(value)) { this.#byte(0x44); this.double(Number(dateTime(value))); return; }
    if (isRegExp(value)) { this.#regexp(value); return; }
    if (isMap(value)) { this.#collection(0x3b, 0x3a, value, mapEach, true); return; }
    if (isSet(value)) { this.#collection(0x27, 0x2c, value, setEach, false); return; }
    if (isBoolean(value)) { this.#byte(booleanValue(value) === true ? 0x79 : 0x78); return; }
    if (isNumber(value)) { this.#byte(0x6e); this.double(Number(numberValue(value))); return; }
    if (isString(value)) { this.#byte(0x73); this.#string(String(stringValue(value))); return; }
    if (isBigInt(value)) { const inner = bigintValue(value); this.#byte(0x7a); this.#bigint(typeof inner === "bigint" ? inner : 0n); return; }
    if (isError(value)) { this.#error(value); return; }
    if (uncloneable(value)) this.#fail(value);
    this.#byte(0x6f); this.varint(this.#properties(value, Object.keys(value)));
  }
  /** Own enumerable string-keyed properties, then the closing tag; answers the property count. */
  #properties(value: object, keys: readonly string[], end = 0x7b): number {
    for (const key of keys) {
      const index = indexKey(key);
      if (index === undefined) this.#string(key); else this.#number(index);
      this.value(Reflect.get(value, key));
    }
    this.#byte(end);
    return keys.length;
  }
  #array(value: readonly unknown[]): void {
    const length = value.length, keys = Object.keys(value);
    let elements = 0;
    while (elements < keys.length && indexKey(keys[elements] ?? "") !== undefined) elements++;
    if (elements !== length) {
      // A holey array is written as its present properties only.
      this.#byte(0x61); this.varint(length); this.varint(this.#properties(value, keys, 0x40)); this.varint(length);
      return;
    }
    this.#byte(0x41); this.varint(length);
    // V8 keeps an all-number array holding a non-integer as raw doubles, and writes every element as one.
    const doubles = length !== 0 && value.every(item => typeof item === "number") && value.some(item => typeof item === "number" && !smi(item));
    for (let index = 0; index < length; index++) {
      const item = value[index];
      if (doubles && typeof item === "number") { this.#byte(0x4e); this.double(item); } else this.value(item);
    }
    this.varint(this.#properties(value, keys.slice(elements), 0x24)); this.varint(length);
  }
  #buffer(value: object): void {
    const transferred = this.#transfers.get(value);
    if (transferred !== undefined) { this.#byte(0x74); this.varint(transferred); return; }
    if (!(value instanceof ArrayBuffer)) return this.#fail(value);
    if (value.detached) throw this.#host.cloneError("An ArrayBuffer is detached and could not be cloned.");
    if (value.resizable) { this.#byte(0x7e); this.varint(value.byteLength); this.varint(value.maxByteLength); } else { this.#byte(0x42); this.varint(value.byteLength); }
    this.raw(new Uint8Array(value));
  }
  #view(view: ArrayBufferView): void {
    const tag = VIEW_TAGS[viewName(view)];
    if (tag === undefined) return this.#fail(view);
    const buffer = view.buffer;
    const resizable = buffer instanceof ArrayBuffer && buffer.resizable;
    // approximation: JavaScript cannot ask whether a view tracks its resizable buffer's length; one that reaches the buffer's end is taken to.
    const tracking = resizable && view.byteOffset + view.byteLength === buffer.byteLength;
    this.#byte(0x56); this.#byte(tag); this.varint(view.byteOffset); this.varint(tracking ? 0 : view.byteLength);
    this.varint((tracking ? 1 : 0) | (resizable ? 2 : 0));
  }
  #regexp(value: object): void {
    const flags: unknown = Reflect.get(value, "flags");
    let bits = 0;
    for (const [letter, bit] of REGEXP_FLAGS) if (typeof flags === "string" && flags.includes(letter)) bits |= bit;
    this.#byte(0x52); this.#string(String(regexpSource(value))); this.varint(bits);
  }
  #collection(open: number, close: number, value: object, each: Call, pairs: boolean): void {
    // Entries are copied first, as V8 does: a getter that runs while writing cannot change what is written.
    const entries: unknown[] = [];
    each(value, (item: unknown, key: unknown) => { if (pairs) entries.push(key); entries.push(item); });
    this.#byte(open);
    for (const entry of entries) this.value(entry);
    this.#byte(close); this.varint(entries.length);
  }
  #error(value: object): void {
    this.#byte(0x72);
    const name: unknown = Reflect.get(value, "name");
    const kind = typeof name === "string" && Object.hasOwn(ERROR_TAGS, name) ? ERROR_TAGS[name] : undefined;
    if (kind !== undefined) this.varint(kind);
    const message = Object.getOwnPropertyDescriptor(value, "message");
    if (message !== undefined) { this.varint(0x6d); this.#string(String(message.value)); }
    const stack: unknown = Reflect.get(value, "stack");
    if (typeof stack === "string") { this.varint(0x73); this.#string(stack); }
    if (Object.hasOwn(value, "cause")) { this.varint(0x63); this.value(Reflect.get(value, "cause")); }
    this.varint(0x2e);
  }
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return text;
}
function utf16(bytes: Uint8Array): string {
  let text = "";
  const units: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 2) {
    units.push((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8));
    if (units.length === 8192) { text += String.fromCharCode(...units); units.length = 0; }
  }
  return text + String.fromCharCode(...units);
}

export class WireReader {
  readonly #host: WireReaderHost;
  readonly #bytes: Uint8Array;
  #position = 0;
  #version = 0;
  readonly #objects = new Map<number, object>();
  #nextId = 0;
  readonly #transfers = new Map<number, object>();

  constructor(bytes: Uint8Array, host: WireReaderHost) { this.#bytes = bytes; this.#host = host; }

  get version(): number { return this.#version; }
  get position(): number { return this.#position; }
  transfer(id: number, buffer: object): void { this.#transfers.set(id, buffer); }
  /** Reads the version when the input starts with one; the Node layer decides which versions it admits. */
  header(): void {
    if (this.#bytes[this.#position] !== 0xff) return;
    this.#position++;
    this.#version = this.varint();
  }
  #fail(): never { throw new WireFailure("Unable to deserialize cloned data."); }
  #next(): number {
    const value = this.#bytes[this.#position];
    if (value === undefined) return this.#fail();
    this.#position++;
    return value;
  }
  /** The low 32 bits of a varint of any length, as V8's ReadVarint<uint32_t>. */
  varint(): number { return Number(BigInt.asUintN(32, this.varint64())); }
  varint64(): bigint {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = this.#next();
      if (shift < 64n) value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return BigInt.asUintN(64, value);
    }
  }
  double(): number {
    const start = this.rawOffset(8);
    return new DataView(this.#bytes.buffer, this.#bytes.byteOffset + start, 8).getFloat64(0, true);
  }
  /** Skips `length` bytes and answers where they start. */
  rawOffset(length: number): number {
    if (!(length >= 0) || length > this.#bytes.length - this.#position) return this.#fail();
    const start = this.#position;
    this.#position += length;
    return start;
  }
  #raw(length: number): Uint8Array { const start = this.rawOffset(length); return this.#bytes.subarray(start, start + length); }
  /** The next tag, past the padding bytes a writer inserts for alignment. */
  #tag(consume: boolean): number | undefined {
    while (this.#bytes[this.#position] === 0x00) this.#position++;
    const tag = this.#bytes[this.#position];
    if (consume && tag !== undefined) this.#position++;
    return tag;
  }
  #register<T extends object>(id: number, value: T): T { this.#objects.set(id, value); return value; }
  #bigint(): bigint {
    const bitfield = this.varint();
    const bytes = this.#raw(Math.floor(bitfield / 2));
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index] ?? 0);
    return (bitfield & 1) === 0 ? value : -value;
  }
  #text(): string {
    const value = this.value();
    return typeof value === "string" ? value : this.#fail();
  }

  value(): unknown {
    const result = this.#object();
    // A view is written after its buffer and takes the buffer's place.
    if (result instanceof ArrayBuffer && this.#tag(false) === 0x56) { this.#position++; return this.#view(result); }
    return result;
  }
  #object(): unknown {
    const tag = this.#tag(true);
    switch (tag) {
      case 0x3f: this.varint(); return this.#object();
      case 0x5f: return undefined;
      case 0x30: return null;
      case 0x54: return true;
      case 0x46: return false;
      case 0x49: { const raw = this.varint(); return (raw >>> 1) ^ -(raw & 1); }
      case 0x55: return this.varint();
      case 0x4e: return this.double();
      case 0x5a: return this.#bigint();
      case 0x53: return new TextDecoder().decode(this.#raw(this.varint()));
      case 0x22: return latin1(this.#raw(this.varint()));
      case 0x63: { const size = this.varint(); return size % 2 === 0 ? utf16(this.#raw(size)) : this.#fail(); }
      case 0x5e: return this.#objects.get(this.varint()) ?? this.#fail();
      case 0x6f: { const target = this.#register(this.#nextId++, {}); if (this.#properties(target, 0x7b) !== this.varint()) this.#fail(); return target; }
      case 0x61: return this.#sparse();
      case 0x41: return this.#dense();
      case 0x44: return this.#register(this.#nextId++, new Date(this.double()));
      case 0x79: return this.#register(this.#nextId++, Object(true));
      case 0x78: return this.#register(this.#nextId++, Object(false));
      case 0x6e: return this.#register(this.#nextId++, Object(this.double()));
      case 0x7a: return this.#register(this.#nextId++, Object(this.#bigint()));
      case 0x73: return this.#register(this.#nextId++, Object(this.#text()));
      case 0x52: return this.#regexp();
      case 0x3b: return this.#map();
      case 0x27: return this.#set();
      case 0x42: { const bytes = this.#raw(this.varint()); return this.#register(this.#nextId++, bytes.slice().buffer); }
      case 0x7e: return this.#resizable();
      case 0x74: return this.#register(this.#nextId++, this.#transfers.get(this.varint()) ?? this.#fail());
      case 0x72: return this.#error();
      case 0x5c: return this.#hostObject();
      case undefined: default: return this.#fail();
    }
  }
  #hostObject(): object {
    const id = this.#nextId++;
    return this.#register(id, this.#host.readHostObject() ?? this.#fail());
  }
  #properties(target: object, end: number): number {
    let count = 0;
    for (; ; count++) {
      if (this.#tag(false) === end) { this.#position++; return count; }
      const key = this.value();
      if (typeof key !== "string" && typeof key !== "number") return this.#fail();
      Object.defineProperty(target, typeof key === "number" ? String(key) : key, { value: this.value(), writable: true, enumerable: true, configurable: true });
    }
  }
  #sparse(): unknown[] {
    const length = this.varint();
    const target = this.#register(this.#nextId++, new Array<unknown>(length));
    if (this.#properties(target, 0x40) !== this.varint() || this.varint() !== length) this.#fail();
    return target;
  }
  #dense(): unknown[] {
    const length = this.varint();
    // Every element takes at least one byte, so a longer array than the input is malformed.
    if (length > this.#bytes.length - this.#position) this.#fail();
    const target = this.#register(this.#nextId++, new Array<unknown>(length));
    for (let index = 0; index < length; index++) {
      if (this.#tag(false) === 0x2d) this.#position++; else target[index] = this.value();
    }
    if (this.#properties(target, 0x24) !== this.varint() || this.varint() !== length) this.#fail();
    return target;
  }
  #regexp(): RegExp {
    const id = this.#nextId++, source = this.#text(), bits = this.varint();
    let flags = "";
    for (const [letter, bit] of REGEXP_FLAGS) if ((bits & bit) !== 0) flags += letter;
    if ((bits & ~0x1bf) !== 0) this.#fail();
    try { return this.#register(id, new RegExp(source, flags)); } catch { return this.#fail(); }
  }
  #map(): Map<unknown, unknown> {
    const target = this.#register(this.#nextId++, new Map<unknown, unknown>());
    let count = 0;
    for (; this.#tag(false) !== 0x3a; count += 2) { const key = this.value(); target.set(key, this.value()); }
    this.#position++;
    if (this.varint() !== count) this.#fail();
    return target;
  }
  #set(): Set<unknown> {
    const target = this.#register(this.#nextId++, new Set<unknown>());
    let count = 0;
    for (; this.#tag(false) !== 0x2c; count++) target.add(this.value());
    this.#position++;
    if (this.varint() !== count) this.#fail();
    return target;
  }
  #resizable(): ArrayBuffer {
    const length = this.varint(), maxByteLength = this.varint();
    if (length > maxByteLength) this.#fail();
    const bytes = this.#raw(length);
    let buffer: ArrayBuffer;
    try { buffer = new ArrayBuffer(length, { maxByteLength }); } catch { return this.#fail(); }
    new Uint8Array(buffer).set(bytes);
    return this.#register(this.#nextId++, buffer);
  }
  #view(buffer: ArrayBuffer): ArrayBufferView {
    const tag = this.#next(), byteOffset = this.varint(), byteLength = this.varint();
    const flags = this.#version >= 14 ? this.varint() : 0;
    const name = Object.keys(VIEW_TAGS).find(key => VIEW_TAGS[key] === tag);
    const constructor = name === undefined ? undefined : viewConstructor(name);
    if (constructor === undefined || byteOffset > buffer.byteLength || byteLength > buffer.byteLength - byteOffset) return this.#fail();
    const size: unknown = Reflect.get(constructor, "BYTES_PER_ELEMENT");
    const element = typeof size === "number" ? size : 1;
    if (byteOffset % element !== 0 || byteLength % element !== 0) return this.#fail();
    const tracking = (flags & 1) !== 0;
    if (tracking && !buffer.resizable) return this.#fail();
    return this.#register(this.#nextId++, tracking ? new constructor(buffer, byteOffset) : new constructor(buffer, byteOffset, byteLength / element));
  }
  /** The error is built before its cause is read, so a cause may refer back to it. */
  #error(): Error {
    const id = this.#nextId++;
    let tag = this.varint();
    const constructor = ERROR_CONSTRUCTORS.get(tag) ?? Error;
    if (constructor !== Error) tag = this.varint();
    let message: string | undefined, stack: string | undefined;
    if (tag === 0x6d) { message = this.#text(); tag = this.varint(); }
    if (tag === 0x73) { stack = this.#text(); tag = this.varint(); }
    const error = this.#register(id, message === undefined ? new constructor() : new constructor(message));
    Reflect.set(error, "stack", stack);
    if (tag === 0x63) {
      Object.defineProperty(error, "cause", { value: this.value(), writable: true, enumerable: false, configurable: true });
      tag = this.varint();
    }
    return tag === 0x2e ? error : this.#fail();
  }
}
