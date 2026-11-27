import { expect, it, onTestFinished } from "vitest";
import * as native from "node:zlib";
import { Buffer } from "buffer";
import { createAsyncContext } from "./async-context.ts";
import { createNodeZlib } from "./node-zlib-stream.ts";
import { createNodeStreamModule } from "./node-streams.ts";
import { ProcessScheduler } from "./process-scheduler.ts";

// minizlib (inside npm's tar) drives a zlib stream synchronously through Node's `_handle` and
// `_processChunk`. Every expectation here is compared with the same calls on Node's own stream.
function fixture() {
  const context = createAsyncContext();
  const failures: unknown[] = [];
  const scheduler = new ProcessScheduler(context, error => { failures.push(error); });
  const streams = createNodeStreamModule(context, () => () => {}, scheduler.nextTick);
  onTestFinished(() => { streams.restore(); scheduler.dispose(); expect(failures).toEqual([]); });
  return createNodeZlib(context, scheduler);
}
function payload(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 73 + Math.floor(i / 17)) & 255;
  return bytes;
}
function joined(value: unknown): Buffer {
  const parts: unknown[] = Array.isArray(value) ? value : [value];
  return Buffer.concat(parts.map(part => { if (!(part instanceof Uint8Array)) throw new TypeError("bytes expected"); return part; }));
}
function call(stream: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(stream, name);
  if (typeof method !== "function") throw new TypeError(`${name} is not a function`);
  return Reflect.apply(method, stream, args);
}
/** minizlib's write: the handle and the stream must survive the call, and `Buffer.concat` is a pass-through. */
function keptOpen(stream: object, chunk: Uint8Array, flush: number): unknown {
  const handle: unknown = Reflect.get(stream, "_handle");
  if (typeof handle !== "object" || handle === null) throw new TypeError("no handle");
  const handleClose: unknown = Reflect.get(handle, "close"), streamClose: unknown = Reflect.get(stream, "close"), concat: unknown = Reflect.get(Buffer, "concat");
  Reflect.set(handle, "close", () => undefined); Reflect.set(stream, "close", () => undefined);
  Reflect.set(Buffer, "concat", (list: unknown) => list);
  try { return call(stream, "_processChunk", chunk, flush); }
  finally {
    Reflect.set(Buffer, "concat", concat);
    Reflect.set(stream, "_handle", handle); Reflect.set(handle, "close", handleClose); Reflect.set(stream, "close", streamClose);
  }
}

it("inflates one whole input synchronously and releases its handle as Node does", () => {
  const zlib = fixture(), input = payload(200_000), packed = native.gzipSync(input);
  for (const stream of [new zlib.Gunzip(), new native.Gunzip()]) {
    expect(typeof Reflect.get(Object(Reflect.get(stream, "_handle")), "close")).toBe("function");
    expect(joined(call(stream, "_processChunk", packed, native.constants.Z_FINISH)).equals(input)).toBe(true);
    expect(Reflect.get(stream, "_handle")).toBeNull();
  }
});

it("inflates split input chunk by chunk when the caller keeps the handle, as minizlib does", () => {
  const zlib = fixture(), input = payload(300_000), packed = native.gzipSync(input);
  for (const stream of [new zlib.Unzip(), new native.Unzip()]) {
    const output: Buffer[] = [];
    for (let offset = 0; offset < packed.length; offset += 4096) {
      output.push(joined(keptOpen(stream, packed.subarray(offset, offset + 4096), native.constants.Z_SYNC_FLUSH)));
    }
    output.push(joined(keptOpen(stream, Buffer.alloc(0), native.constants.Z_FINISH)));
    expect(Buffer.concat(output).equals(input)).toBe(true);
    expect(typeof Reflect.get(stream, "_handle")).toBe("object");
  }
});

it("returns the output buffers unjoined while Buffer.concat is a pass-through", () => {
  const zlib = fixture(), packed = native.gzipSync(payload(200_000));
  for (const stream of [new zlib.Gunzip(), new native.Gunzip()]) {
    const result = keptOpen(stream, packed, native.constants.Z_SYNC_FLUSH);
    expect(Array.isArray(result) && result.length > 1).toBe(true);
  }
});

it("deflates synchronously to a stream Node inflates", () => {
  const zlib = fixture(), input = payload(120_000);
  const packed = joined(call(new zlib.Gzip(), "_processChunk", input, native.constants.Z_FINISH));
  expect(native.gunzipSync(packed).equals(input)).toBe(true);
});

it("throws Node's data error for corrupt input and releases the handle", () => {
  const zlib = fixture(), corrupt = Buffer.from(native.gzipSync(payload(4000)));
  corrupt.fill(0xff, 12, 40);
  for (const stream of [new zlib.Gunzip(), new native.Gunzip()]) {
    stream.on("error", () => undefined);
    let failure: unknown;
    try { call(stream, "_processChunk", corrupt, native.constants.Z_FINISH); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "Z_DATA_ERROR" });
    expect(Reflect.get(stream, "_handle")).toBeNull();
  }
});

it("refuses output past maxOutputLength with Node's error", () => {
  const zlib = fixture(), packed = native.gzipSync(payload(100_000));
  for (const stream of [new zlib.Gunzip({ maxOutputLength: 1000 }), new native.Gunzip({ maxOutputLength: 1000 })]) {
    let failure: unknown;
    try { call(stream, "_processChunk", packed, native.constants.Z_FINISH); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "ERR_BUFFER_TOO_LARGE" });
  }
});
