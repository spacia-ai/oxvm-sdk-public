/*!
 * Portions adapted from Node.js v24.18.1 lib/v8.js (DefaultSerializer, DefaultDeserializer, serialize, deserialize).
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
import { invalidArgType } from "./node-arg-type.ts";
import { nodeUtil } from "./node-util.ts";
import { WIRE_FORMAT_VERSION, WireFailure, WireReader, WireWriter, viewConstructor, viewName, type ViewConstructor } from "./node-v8-wire.ts";

const inspect = (value: unknown, options?: { readonly depth: number }): string => nodeUtil.inspect(value, options);
function coded(message: string): TypeError { return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" }); }
/** ECMAScript ToUint32, as the native methods convert their numeric arguments. */
function uint32(value: unknown): number { return Number(value) >>> 0; }
/** A Buffer over the caller's memory, as Node's FastBuffer; shared memory is copied because this Buffer cannot view it. */
function bufferOver(buffer: ArrayBufferLike, offset: number, length?: number): Buffer {
  return buffer instanceof ArrayBuffer ? Buffer.from(buffer, offset, length) : Buffer.from(new Uint8Array(buffer, offset, length));
}
function attempt<T>(operation: () => T): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } {
  try { return { ok: true, value: operation() }; } catch (error) { return { ok: false, error }; }
}
function pin(target: object, name: string): void { Object.defineProperty(target, "name", { value: name, configurable: true }); }
/** Native prototype methods are enumerable; class syntax defines them hidden. */
function enumerable(prototype: object, names: readonly string[]): void {
  for (const name of names) Object.defineProperty(prototype, name, { enumerable: true });
}

/** Node's `v8.Serializer`: the wire writer plus the `_writeHostObject` and `_getDataCloneError` hooks. */
export class Serializer {
  readonly #wire: WireWriter;
  constructor() {
    this.#wire = new WireWriter({
      cloneError: message => this.#cloneError(message),
      writeHostObject: object => {
        const write: unknown = Reflect.get(this, "_writeHostObject");
        if (typeof write !== "function") throw this.#cloneError(`${Object.prototype.toString.call(object)} could not be cloned.`);
        Reflect.apply(write, this, [object]);
      },
    });
  }
  #cloneError(message: string): unknown {
    const create: unknown = Reflect.get(this, "_getDataCloneError");
    if (typeof create !== "function") return new Error(message);
    const error: unknown = Reflect.apply(create, this, [message]);
    return error;
  }
  writeHeader(): undefined { this.#wire.header(); return undefined; }
  writeValue(...args: unknown[]): boolean { this.#wire.value(args[0]); return true; }
  releaseBuffer(): Buffer {
    const bytes = this.#wire.release();
    return Buffer.from(bytes.buffer, 0, bytes.length);
  }
  transferArrayBuffer(...args: unknown[]): undefined {
    const buffer = args[1];
    if (!(buffer instanceof ArrayBuffer)) throw coded("arrayBuffer must be an ArrayBuffer");
    this.#wire.transfer(uint32(args[0]), buffer);
    return undefined;
  }
  writeUint32(...args: unknown[]): undefined { this.#wire.varint(uint32(args[0])); return undefined; }
  writeUint64(...args: unknown[]): undefined { this.#wire.varint64((BigInt(uint32(args[0])) << 32n) | BigInt(uint32(args[1]))); return undefined; }
  writeDouble(...args: unknown[]): undefined { this.#wire.double(Number(args[0])); return undefined; }
  writeRawBytes(...args: unknown[]): undefined {
    const source = args[0];
    if (!ArrayBuffer.isView(source)) throw coded("source must be a TypedArray or a DataView");
    this.#wire.raw(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    return undefined;
  }
  _setTreatArrayBufferViewsAsHostObjects(...args: unknown[]): undefined { this.#wire.viewsAreHostObjects = Boolean(args[0]); return undefined; }
}
pin(Serializer, "Serializer");
enumerable(Serializer.prototype, ["writeHeader", "writeValue", "releaseBuffer", "transferArrayBuffer", "writeUint32", "writeUint64", "writeDouble", "writeRawBytes", "_setTreatArrayBufferViewsAsHostObjects"]);
Object.defineProperty(Serializer.prototype, "_getDataCloneError", { value: Error, writable: true, enumerable: true, configurable: true });

/** Node's `v8.Deserializer`. It reads the caller's memory in place, as Node does: `readRawBytes` answers a view of it. */
export class Deserializer {
  buffer: ArrayBufferView;
  readonly #wire: WireReader;
  constructor(buffer: unknown) {
    if (!ArrayBuffer.isView(buffer)) throw coded("buffer must be a TypedArray or a DataView");
    this.buffer = buffer;
    this.#wire = new WireReader(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
      readHostObject: () => {
        const read: unknown = Reflect.get(this, "_readHostObject");
        if (typeof read !== "function") return undefined;
        const value: unknown = Reflect.apply(read, this, []);
        if (typeof value !== "object" || value === null) throw new TypeError("readHostObject must return an object");
        return value;
      },
    });
  }
  #read<T>(operation: () => T, failure: string): T {
    const outcome = attempt(operation);
    if (outcome.ok) return outcome.value;
    // Node reports malformed input with a fresh error and no cause; a hook's own error passes through.
    throw outcome.error instanceof WireFailure ? new Error(failure) : outcome.error;
  }
  readHeader(): boolean {
    const version = this.#read(() => { this.#wire.header(); return this.#wire.version; }, "Unable to deserialize cloned data due to invalid or unsupported version.");
    if (version < 13 || version > WIRE_FORMAT_VERSION) throw new Error("Unable to deserialize cloned data due to invalid or unsupported version.");
    return true;
  }
  readValue(): unknown { return this.#read(() => this.#wire.value(), "Unable to deserialize cloned data."); }
  getWireFormatVersion(): number { return this.#wire.version; }
  transferArrayBuffer(...args: unknown[]): undefined {
    const buffer = args[1];
    if (!(buffer instanceof ArrayBuffer) && !(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)) {
      throw coded("arrayBuffer must be an ArrayBuffer or SharedArrayBuffer");
    }
    this.#wire.transfer(uint32(args[0]), buffer);
    return undefined;
  }
  readUint32(): number { return this.#read(() => this.#wire.varint(), "ReadUint32() failed"); }
  readUint64(): [number, number] {
    const value = this.#read(() => this.#wire.varint64(), "ReadUint64() failed");
    return [Number(value >> 32n), Number(value & 0xffffffffn)];
  }
  readDouble(): number { return this.#read(() => this.#wire.double(), "ReadDouble() failed"); }
  _readRawBytes(...args: unknown[]): number {
    const length = Math.trunc(Number(args[0]));
    return this.#read(() => this.#wire.rawOffset(Number.isNaN(length) ? 0 : length), "ReadRawBytes() failed");
  }
  readRawBytes(length?: unknown): Buffer {
    const offset = this._readRawBytes(length);
    return bufferOver(this.buffer.buffer, this.buffer.byteOffset + offset, length === undefined ? undefined : Math.trunc(Number(length)) || 0);
  }
}
pin(Deserializer, "Deserializer");
enumerable(Deserializer.prototype, ["readHeader", "readValue", "getWireFormatVersion", "transferArrayBuffer", "readUint32", "readUint64", "readDouble", "_readRawBytes", "readRawBytes"]);

/** lib/v8.js numbers the view types it writes as host objects; 10 is Node's Buffer. */
const VIEW_INDEX: readonly (string | undefined)[] = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "DataView", undefined, "BigInt64Array", "BigUint64Array", "Float16Array"];
const BUFFER_INDEX = 10;

/** Views are written as their own bytes, never as their whole (often pooled) ArrayBuffer. */
export class DefaultSerializer extends Serializer {
  constructor() {
    super();
    this._setTreatArrayBufferViewsAsHostObjects(true);
  }
  _writeHostObject(abView: ArrayBufferView): void {
    let index = BUFFER_INDEX;
    if (abView.constructor !== Buffer) {
      index = VIEW_INDEX.indexOf(viewName(abView));
      if (index === -1) {
        const create: unknown = Reflect.get(this, "_getDataCloneError");
        const message = `Unserializable host object: ${inspect(abView)}`;
        throw typeof create === "function" ? Reflect.construct(create, [message]) : new Error(message);
      }
    }
    this.writeUint32(index);
    this.writeUint32(abView.byteLength);
    this.writeRawBytes(new Uint8Array(abView.buffer, abView.byteOffset, abView.byteLength));
  }
}
pin(DefaultSerializer, "DefaultSerializer");

export class DefaultDeserializer extends Deserializer {
  _readHostObject(): ArrayBufferView {
    const typeIndex = this.readUint32();
    const name = VIEW_INDEX[typeIndex];
    const constructor: ViewConstructor | undefined = typeIndex === BUFFER_INDEX ? undefined : name === undefined ? undefined : viewConstructor(name);
    if (typeIndex !== BUFFER_INDEX && constructor === undefined) throw new TypeError("Cannot read properties of undefined (reading 'BYTES_PER_ELEMENT')");
    const byteLength = this.readUint32();
    const byteOffset = this._readRawBytes(byteLength);
    const size: unknown = constructor === undefined ? 1 : Reflect.get(constructor, "BYTES_PER_ELEMENT");
    const bytesPerElement = typeof size === "number" && size !== 0 ? size : 1;
    const create = (buffer: ArrayBufferLike, offset: number): ArrayBufferView => constructor === undefined
      ? bufferOver(buffer, offset, byteLength) : new constructor(buffer, offset, byteLength / bytesPerElement);
    const offset = this.buffer.byteOffset + byteOffset;
    if (offset % bytesPerElement === 0) return create(this.buffer.buffer, offset);
    // Copy to an aligned buffer first.
    const copy = new Uint8Array(byteLength);
    copy.set(new Uint8Array(this.buffer.buffer, offset, byteLength));
    return create(copy.buffer, 0);
  }
}
pin(DefaultDeserializer, "DefaultDeserializer");

/** The value `v8.cachedDataVersionTag()` answers in Node.js v24.18.1 (linux x64, default flags). No code cache exists here to match it against. */
const CACHED_DATA_VERSION_TAG = 3480456349;

/** The serialization half of the `v8` builtin. Method syntax keeps each function's `name` through minification. */
export const nodeV8Serialization = {
  Serializer, Deserializer, DefaultSerializer, DefaultDeserializer,
  serialize(value: unknown): Buffer {
    const ser = new DefaultSerializer();
    ser.writeHeader();
    ser.writeValue(value);
    return ser.releaseBuffer();
  },
  deserialize(buffer: unknown): unknown {
    const der = new DefaultDeserializer(buffer);
    der.readHeader();
    return der.readValue();
  },
  cachedDataVersionTag(): number { return CACHED_DATA_VERSION_TAG; },
  /** approximation: V8 answers how it happens to store the string; this answers whether it can be stored one byte per character. */
  isStringOneByteRepresentation(content: unknown): boolean {
    if (typeof content !== "string") throw invalidArgType("content", "string", content, inspect);
    for (let index = 0; index < content.length; index++) if (content.charCodeAt(index) > 255) return false;
    return true;
  },
};
