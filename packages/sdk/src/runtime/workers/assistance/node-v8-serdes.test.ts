import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nodeV8Memory } from "./node-memory.ts";

/** Bytes and messages recorded from `node:24.18.1-alpine` (`v8.serialize`, a plain `v8.Serializer`, and refusals). */
interface Controls { readonly cachedDataVersionTag: number; readonly values: readonly Case[]; readonly plain: readonly Case[]; readonly errors: readonly Refusal[] }
interface Case { readonly expr: string; readonly hex: string }
interface Refusal { readonly expr: string; readonly name: string; readonly message: string }
function field(value: unknown, key: string): unknown { return (typeof value === "object" || typeof value === "function") && value !== null ? Reflect.get(value, key) : undefined; }
function text(value: unknown, key: string): string {
  const item = field(value, key);
  if (typeof item !== "string") throw new TypeError(`control field ${key} must be a string`);
  return item;
}
function list(value: unknown, key: string): readonly unknown[] {
  const item = field(value, key);
  if (!Array.isArray(item)) throw new TypeError(`control field ${key} must be an array`);
  return item;
}
function decode(value: unknown): Controls {
  const tag = field(value, "cachedDataVersionTag");
  if (typeof tag !== "number") throw new TypeError("control tag must be a number");
  const cases = (key: string): Case[] => list(value, key).map(item => ({ expr: text(item, "expr"), hex: text(item, "hex") }));
  return { cachedDataVersionTag: tag, values: cases("values"), plain: cases("plain"),
    errors: list(value, "errors").map(item => ({ expr: text(item, "expr"), name: text(item, "name"), message: text(item, "message") })) };
}
const controls = decode(JSON.parse(readFileSync(new URL("./node-v8-serdes.controls.json", import.meta.url), "utf8")));
const evaluate = (expr: string): unknown => runInThisContext(expr);
const v8 = nodeV8Memory;
const PROTOTYPE_LOST = new Set(["new (class Foo{constructor(){this.a=1}})()", "Object.create(null)", "Object.assign(Object.create({inh:1}),{own:2})"]);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
/** Calls a method by name: the native methods answer `undefined`, which is the value under test. */
const invoke = (target: object, name: string, ...args: unknown[]): unknown => {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new TypeError(`${name} is not a method`);
  const result: unknown = Reflect.apply(method, target, args);
  return result;
};
const failure = (run: () => unknown): unknown => { try { run(); } catch (error) { return error; } return undefined; };
const describeError = (error: unknown): unknown[] => [error instanceof Error ? error.constructor.name : typeof error, field(error, "code"), field(error, "message")];

describe("v8 serialization", () => {
  it("has enough recorded controls", () => {
    expect(controls.values.length).toBeGreaterThanOrEqual(100);
    expect(controls.plain.length).toBeGreaterThanOrEqual(15);
    expect(controls.errors.length).toBeGreaterThanOrEqual(20);
  });

  it.each(controls.values)("serializes $expr to Node's bytes and reads them back", ({ expr, hex: expected }) => {
    const value = evaluate(expr);
    expect(hex(v8.serialize(value))).toBe(expected);
    const restored = v8.deserialize(Buffer.from(expected, "hex"));
    // A prototype is not part of the format: Node also answers a plain object for these two.
    if (PROTOTYPE_LOST.has(expr)) expect(restored).toEqual(value); else expect(restored).toStrictEqual(value);
    expect(hex(v8.serialize(restored))).toBe(expected);
  });

  it.each(controls.plain)("writes $expr through a plain Serializer as V8 does", ({ expr, hex: expected }) => {
    const serializer = new v8.Serializer();
    serializer.writeHeader();
    expect(serializer.writeValue(evaluate(expr))).toBe(true);
    expect(hex(serializer.releaseBuffer())).toBe(expected);
    const deserializer = new v8.Deserializer(Buffer.from(expected, "hex"));
    expect(deserializer.readHeader()).toBe(true);
    const restored = deserializer.readValue();
    const again = new v8.Serializer();
    again.writeHeader(); again.writeValue(restored);
    expect(hex(again.releaseBuffer())).toBe(expected);
  });

  it.each(controls.errors)("refuses $expr with Node's message", ({ expr, name, message }) => {
    const error = failure(() => v8.serialize(evaluate(expr)));
    expect(describeError(error)).toEqual([name, undefined, message]);
  });

  it("keeps cycles, shared references and object identity", () => {
    const shared = { x: 1 };
    const root: Record<string, unknown> = { a: shared, b: shared, list: [shared], map: new Map<unknown, unknown>([["k", shared]]), set: new Set<unknown>([shared]) };
    root["self"] = root;
    const restored = v8.deserialize(v8.serialize(root));
    const a = field(restored, "a");
    expect(field(restored, "self")).toBe(restored);
    expect(field(restored, "b")).toBe(a);
    expect(field(field(restored, "list"), "0")).toBe(a);
    const map = field(restored, "map"), set = field(restored, "set");
    expect(map instanceof Map && map.get("k") === a).toBe(true);
    expect(set instanceof Set && set.has(a)).toBe(true);
    const error = new Error("x"); error.stack = "S"; error.cause = error;
    const cyclic = v8.deserialize(v8.serialize(error));
    expect(hex(v8.serialize(error))).toBe("ff0f726d22017873220153635e002e");
    expect(field(cyclic, "cause")).toBe(cyclic);
  });

  it("restores errors with Node's property shapes", () => {
    const error = new TypeError("m", { cause: { a: 1 } });
    error.stack = "S"; Object.assign(error, { extra: 1 });
    const bytes = v8.serialize(error);
    expect(hex(bytes)).toBe("ff0f72546d22016d73220153636f22016149027b012e");
    const restored = v8.deserialize(bytes);
    expect(restored).toBeInstanceOf(TypeError);
    expect(field(restored, "stack")).toBe("S");
    expect(field(restored, "extra")).toBeUndefined();
    expect(typeof restored === "object" && restored !== null ? Object.getOwnPropertyDescriptor(restored, "cause") : undefined)
      .toEqual({ value: { a: 1 }, writable: true, enumerable: false, configurable: true });
    const bare = v8.deserialize(Buffer.from("ff0f722e", "hex"));
    expect(bare).toBeInstanceOf(Error);
    expect(field(bare, "stack")).toBeUndefined();
    expect(typeof bare === "object" && bare !== null && Object.hasOwn(bare, "message")).toBe(false);
    const named = new Error("m"); named.name = "RangeError"; named.stack = "S";
    expect(hex(v8.serialize(named))).toBe("ff0f72526d22016d732201532e");
    const odd = new Error("x"); Object.assign(odd, { message: 5, stack: 5 });
    expect(hex(v8.serialize(odd))).toBe("ff0f726d2201352e");
    const undefinedCause = new Error("x", { cause: undefined }); undefinedCause.stack = "S";
    expect(hex(v8.serialize(undefinedCause))).toBe("ff0f726d22017873220153635f2e");
  });

  it("drops what V8 drops and reads what only other writers emit", () => {
    expect(hex(v8.serialize({ get a() { return 1; }, b: 2 }))).toBe("ff0f6f220161490222016249047b02");
    expect(hex(v8.serialize(Object.defineProperty({ a: 1 }, "h", { value: 2 })))).toBe("ff0f6f22016149027b01");
    expect(hex(v8.serialize({ [Symbol("s")]: 1, a: 1 }))).toBe("ff0f6f22016149027b01");
    expect(hex(v8.serialize(Object.assign(new Map([[1, 2]]), { x: 1 })))).toBe("ff0f3b490249043a02");
    expect(hex(v8.serialize(new Array(2).fill(1)))).toBe("ff0f410249024902240002");
    expect(v8.deserialize(Buffer.from([255, 15, 0x55, 0xff, 0xff, 0xff, 0xff, 0x0f]))).toBe(4294967295);
    expect(v8.deserialize(Buffer.from([255, 15, 0x53, 3, 0xe2, 0x82, 0xac]))).toBe("€");
    // eslint-disable-next-line no-sparse-arrays -- the dense form with a hole tag is the value under test
    expect(v8.deserialize(Buffer.from("ff0f410349022d4906240003", "hex"))).toStrictEqual([1, , 3]);
    expect(v8.deserialize(Buffer.from([255, 15, 73, 2, 99, 99]))).toBe(1);
    expect(v8.deserialize(new DataView(new Uint8Array([255, 15, 73, 2]).buffer))).toBe(1);
    expect(v8.deserialize(new Uint16Array(new Uint8Array([255, 15, 73, 2]).buffer))).toBe(1);
    const regexp = /a/g; regexp.lastIndex = 3;
    expect(field(v8.deserialize(v8.serialize(regexp)), "lastIndex")).toBe(0);
  });

  it("reads default-serialized views in place over the input, copying only to align", () => {
    const bytes = v8.serialize([Buffer.from("ab"), new Uint16Array([1, 2]), new DataView(new ArrayBuffer(2)), new Uint8Array([7])]);
    const restored = v8.deserialize(bytes);
    if (!Array.isArray(restored)) throw new TypeError("expected an array");
    const views = restored.filter((item): item is ArrayBufferView => ArrayBuffer.isView(item));
    expect(views.map(view => [view.constructor.name, view.byteLength, view.byteOffset - bytes.byteOffset, view.buffer === bytes.buffer]))
      .toEqual([["Buffer", 2, 7, true], ["Uint16Array", 4, 12, true], ["DataView", 2, 19, true], ["Uint8Array", 1, 24, true]]);
    const odd = v8.deserialize(v8.serialize([new Uint16Array([513])]));
    const copy: unknown = field(odd, "0");
    expect(copy).toStrictEqual(new Uint16Array([513]));
    expect(ArrayBuffer.isView(copy) && copy.buffer.byteLength === 2).toBe(true);
  });

  it("matches the Serializer class surface and conversions", () => {
    const { Serializer, Deserializer, DefaultSerializer, DefaultDeserializer } = v8;
    expect([Serializer.name, Serializer.length, Deserializer.name, Deserializer.length, DefaultSerializer.name, DefaultSerializer.length, DefaultDeserializer.name, DefaultDeserializer.length])
      .toEqual(["Serializer", 0, "Deserializer", 1, "DefaultSerializer", 0, "DefaultDeserializer", 0]);
    expect(Object.keys(Serializer.prototype)).toEqual(["writeHeader", "writeValue", "releaseBuffer", "transferArrayBuffer", "writeUint32", "writeUint64", "writeDouble", "writeRawBytes", "_setTreatArrayBufferViewsAsHostObjects", "_getDataCloneError"]);
    expect(Object.keys(Deserializer.prototype)).toEqual(["readHeader", "readValue", "getWireFormatVersion", "transferArrayBuffer", "readUint32", "readUint64", "readDouble", "_readRawBytes", "readRawBytes"]);
    expect(Object.getOwnPropertyDescriptor(Serializer.prototype, "_getDataCloneError")).toEqual({ value: Error, writable: true, enumerable: true, configurable: true });
    for (const name of Object.keys(Serializer.prototype).slice(0, 9)) expect([name, field(field(Serializer.prototype, name), "name"), field(field(Serializer.prototype, name), "length")]).toEqual([name, name, 0]);
    for (const name of Object.keys(Deserializer.prototype)) expect([name, field(field(Deserializer.prototype, name), "name"), field(field(Deserializer.prototype, name), "length")]).toEqual([name, name, name === "readRawBytes" ? 1 : 0]);
    expect([DefaultSerializer.prototype._writeHostObject.length, DefaultDeserializer.prototype._readHostObject.length]).toEqual([1, 0]);
    expect([v8.serialize.name, v8.serialize.length, v8.deserialize.name, v8.deserialize.length, v8.cachedDataVersionTag.name, v8.cachedDataVersionTag.length, v8.isStringOneByteRepresentation.name, v8.isStringOneByteRepresentation.length])
      .toEqual(["serialize", 1, "deserialize", 1, "cachedDataVersionTag", 0, "isStringOneByteRepresentation", 1]);

    const serializer = new Serializer();
    expect(Object.getOwnPropertyNames(serializer)).toEqual([]);
    expect([invoke(serializer, "writeHeader"), invoke(serializer, "writeValue", 1), invoke(serializer, "writeUint32", 300), invoke(serializer, "writeUint64", 1, 2), invoke(serializer, "writeDouble", 1.5), invoke(serializer, "writeRawBytes", Buffer.from("ab"))])
      .toEqual([undefined, true, undefined, undefined, undefined, undefined]);
    const first = serializer.releaseBuffer();
    expect([hex(first), Buffer.isBuffer(first), first.buffer.byteLength, serializer.releaseBuffer().length]).toEqual(["ff0f4902ac028280808010000000000000f83f6162", true, 21, 0]);
    serializer.writeValue(1);
    expect(hex(serializer.releaseBuffer())).toBe("4902");
    const numbers = new Serializer();
    numbers.writeUint32("x"); numbers.writeUint32(-1); numbers.writeUint32(1.7); numbers.writeUint32(2 ** 32 + 5); numbers.writeUint32();
    numbers.writeUint64(0xffffffff, 0xffffffff); numbers.writeUint64(0, 127); numbers.writeUint64(); numbers.writeUint64(1);
    numbers.writeDouble("x"); numbers.writeDouble();
    expect(hex(numbers.releaseBuffer())).toBe("00ffffffff0f010500" + "ffffffffffffffffff017f008080808010" + "000000000000f87f000000000000f87f");
    expect(describeError(failure(() => new Serializer().writeRawBytes("x")))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "source must be a TypedArray or a DataView"]);
    expect(describeError(failure(() => new Serializer().writeRawBytes(new ArrayBuffer(1))))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "source must be a TypedArray or a DataView"]);
    expect(describeError(failure(() => new Serializer().transferArrayBuffer(1, {})))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "arrayBuffer must be an ArrayBuffer"]);
    expect(describeError(failure(() => new Deserializer(Buffer.alloc(1)).transferArrayBuffer(1, {})))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "arrayBuffer must be an ArrayBuffer or SharedArrayBuffer"]);
    expect(invoke(new Serializer(), "_setTreatArrayBufferViewsAsHostObjects", true)).toBeUndefined();
  });

  it("runs the host object and clone error hooks as Node does", () => {
    const bare = new v8.Serializer();
    bare._setTreatArrayBufferViewsAsHostObjects(true);
    expect(describeError(failure(() => bare.writeValue(new Uint8Array(1))))).toEqual(["Error", undefined, "[object Uint8Array] could not be cloned."]);
    const hooked = new v8.Serializer();
    const calls: unknown[] = [];
    hooked._setTreatArrayBufferViewsAsHostObjects(true);
    Object.assign(hooked, { _writeHostObject(this: unknown, ...args: unknown[]): number { calls.push(this === hooked, field(field(args[0], "constructor"), "name"), args.length); hooked.writeUint32(9); return 5; } });
    expect(hooked.writeValue([new Uint8Array(1), new DataView(new ArrayBuffer(1))])).toBe(true);
    expect(calls).toEqual([true, "Uint8Array", 1, true, "DataView", 1]);
    expect(hex(hooked.releaseBuffer())).toBe("41025c095c09240002");
    const shared = new v8.DefaultSerializer();
    const view = new Uint8Array([1, 2]);
    shared.writeValue([view, view, { u: view }]);
    expect(hex(shared.releaseBuffer())).toBe("41035c010201025e016f2201755e017b01240003");

    const custom = new v8.Serializer();
    let seen: unknown[] = [];
    Object.assign(custom, { _getDataCloneError: function (this: unknown, message: unknown): Error { seen = [this === custom, message]; return new RangeError("custom"); } });
    expect(describeError(failure(() => custom.writeValue(() => 1)))).toEqual(["RangeError", undefined, "custom"]);
    expect(seen).toEqual([true, "() => 1 could not be cloned."]);

    const transfer = new v8.Serializer();
    const buffer = new ArrayBuffer(2);
    expect(invoke(transfer, "transferArrayBuffer", 7, buffer)).toBeUndefined();
    transfer.writeHeader(); transfer.writeValue({ ab: buffer, u: new Uint8Array(buffer) });
    const transferred = transfer.releaseBuffer();
    expect(hex(transferred)).toBe("ff0f6f2202616274072201755e0156420002007b02");
    const receiver = new v8.Deserializer(transferred);
    const target = new ArrayBuffer(2);
    receiver.transferArrayBuffer(7, target); receiver.readHeader();
    const received = receiver.readValue();
    expect(field(received, "ab")).toBe(target);
    expect(field(field(received, "u"), "buffer")).toBe(target);
    const missing = new v8.Deserializer(Buffer.from("ff0f7407", "hex")); missing.readHeader();
    expect(describeError(failure(() => missing.readValue()))).toEqual(["Error", undefined, "Unable to deserialize cloned data."]);

    const host = (): InstanceType<typeof v8.Deserializer> => { const reader = new v8.Deserializer(Buffer.from("ff0f5c0101aa", "hex")); reader.readHeader(); return reader; };
    expect(describeError(failure(() => host().readValue()))).toEqual(["Error", undefined, "Unable to deserialize cloned data."]);
    expect(describeError(failure(() => Object.assign(host(), { _readHostObject: () => 5 }).readValue()))).toEqual(["TypeError", undefined, "readHostObject must return an object"]);
    const reading = host();
    Object.assign(reading, { _readHostObject(this: unknown, ...args: unknown[]): unknown[] { return [this === reading, args.length, reading.readUint32(), reading.readUint32(), reading.readRawBytes(1)]; } });
    expect(reading.readValue()).toEqual([true, 0, 1, 1, Buffer.from([0xaa])]);
  });

  it("matches the Deserializer's raw readers and failures", () => {
    const { Deserializer } = v8;
    for (const input of [undefined, "x", new ArrayBuffer(2)]) {
      expect(describeError(failure(() => new Deserializer(input)))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "buffer must be a TypedArray or a DataView"]);
    }
    expect(describeError(failure(() => v8.deserialize("x")))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "buffer must be a TypedArray or a DataView"]);
    const reader = new Deserializer(Buffer.from([255, 15, 73, 2]));
    expect([Object.getOwnPropertyNames(reader), Buffer.isBuffer(reader.buffer), reader.getWireFormatVersion(), reader.readHeader(), reader.getWireFormatVersion(), reader.readValue()])
      .toEqual([["buffer"], true, 0, true, 15, 1]);
    const eof = "Unable to deserialize cloned data due to invalid or unsupported version.";
    for (const bytes of [[1, 2], [], [255, 16], [255, 12]]) expect(describeError(failure(() => new Deserializer(Buffer.from(bytes)).readHeader()))).toEqual(["Error", undefined, eof]);
    const old = new Deserializer(Buffer.from([255, 13, 73, 2]));
    expect([old.readHeader(), old.getWireFormatVersion(), old.readValue()]).toEqual([true, 13, 1]);
    expect(new Deserializer(Buffer.from([73, 2])).readValue()).toBe(1);
    const padded = new Deserializer(Buffer.from([255, 15, 0, 0, 73, 2, 73, 4])); padded.readHeader();
    expect([padded.readValue(), padded.readValue()]).toEqual([1, 2]);
    for (const bytes of [[255, 15], [255, 15, 1], [255, 15, 0x5e, 5]]) {
      const bad = new Deserializer(Buffer.from(bytes)); bad.readHeader();
      expect(describeError(failure(() => bad.readValue()))).toEqual(["Error", undefined, "Unable to deserialize cloned data."]);
    }
    expect(describeError(failure(() => new Deserializer(Buffer.alloc(0)).readUint32()))).toEqual(["Error", undefined, "ReadUint32() failed"]);
    expect(describeError(failure(() => new Deserializer(Buffer.alloc(0)).readUint64()))).toEqual(["Error", undefined, "ReadUint64() failed"]);
    expect(describeError(failure(() => new Deserializer(Buffer.alloc(3)).readDouble()))).toEqual(["Error", undefined, "ReadDouble() failed"]);
    expect(describeError(failure(() => new Deserializer(Buffer.alloc(3)).readRawBytes(4)))).toEqual(["Error", undefined, "ReadRawBytes() failed"]);
    expect(describeError(failure(() => new Deserializer(Buffer.alloc(3))._readRawBytes(4)))).toEqual(["Error", undefined, "ReadRawBytes() failed"]);
    const source = new Uint8Array(Buffer.from("abcdef"));
    const raw = new Deserializer(source.subarray(1));
    const slice = raw.readRawBytes(2);
    expect([raw._readRawBytes(1), hex(slice), slice.buffer === source.buffer, slice.byteOffset, Buffer.isBuffer(slice)]).toEqual([2, "6263", true, 1, true]);
    expect(hex(new Deserializer(new Uint8Array(3)).readRawBytes("2"))).toBe("0000");
    expect(hex(new Deserializer(new Uint8Array(3)).readRawBytes())).toBe("000000");
    const numbers = new Deserializer(Buffer.from("ffffffffffffffffff01ac027f000000000000f83fffffffffff7f01", "hex"));
    expect([numbers.readUint64(), numbers.readUint32(), numbers.readUint32(), numbers.readDouble(), numbers.readUint32(), numbers.readUint32()])
      .toEqual([[4294967295, 4294967295], 300, 127, 1.5, 4294967295, 1]);
  });

  it("answers the version tag and the one-byte probe", () => {
    expect(v8.cachedDataVersionTag()).toBe(controls.cachedDataVersionTag);
    expect(["abc", "é", "€", ""].map(value => v8.isStringOneByteRepresentation(value))).toEqual([true, true, false, true]);
    expect(describeError(failure(() => v8.isStringOneByteRepresentation(1)))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "The \"content\" argument must be of type string. Received type number (1)"]);
    expect(describeError(failure(() => v8.isStringOneByteRepresentation(undefined)))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "The \"content\" argument must be of type string. Received undefined"]);
  });
});
