import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nodeStreamConsumers as consumers } from "./node-stream-consumers.ts";

/** Expected values recorded from `require("stream/consumers")` in `node:24.18.1-alpine`. */
const field = (value: unknown, key: string): unknown => typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const failure = async (run: () => Promise<unknown>): Promise<unknown[]> => {
  try { await run(); } catch (error) { return [error instanceof Error ? error.constructor.name : typeof error, field(error, "code"), field(error, "message")]; }
  return [];
};
async function* parts(...values: unknown[]): AsyncGenerator<unknown, void, undefined> { await Promise.resolve(); yield* values; }

describe("stream/consumers", () => {
  it("has Node's six async functions", () => {
    expect(Object.entries(consumers).map(([key, value]) => `${key}:${value.name}/${String(value.length)}:${value.constructor.name}`)).toEqual([
      "arrayBuffer:arrayBuffer/1:AsyncFunction", "blob:blob/1:AsyncFunction", "buffer:buffer/1:AsyncFunction", "bytes:bytes/1:AsyncFunction", "text:text/1:AsyncFunction", "json:json/1:AsyncFunction",
    ]);
  });

  it("drains readables, async iterables, iterables and web streams", async () => {
    expect(await consumers.text(Readable.from(["a", "b", Buffer.from("c")]))).toBe("abc");
    expect(await consumers.text(parts(Buffer.from([0xe2, 0x82]), Buffer.from([0xac])))).toBe("€");
    expect(await consumers.text(parts(Buffer.from([0xe2, 0x82])))).toBe("�");
    expect(await consumers.text(parts(Buffer.from([0xef, 0xbb, 0xbf, 0x61])))).toBe("a");
    expect(await consumers.text(parts(new Uint8Array([104]).buffer))).toBe("h");
    expect(await consumers.text(["a", "b"])).toBe("ab");
    expect(await consumers.text(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([104, 105])); controller.close(); } }))).toBe("hi");
    expect(await consumers.json(parts("{\"a\":", "1}"))).toEqual({ a: 1 });
    const buffer = await consumers.buffer(parts("a", Buffer.from("b")));
    expect([Buffer.isBuffer(buffer), buffer.toString("hex")]).toEqual([true, "6162"]);
    const bytes = await consumers.bytes(parts("a", Buffer.from("b")));
    expect([bytes.constructor.name, [...bytes]]).toEqual(["Uint8Array", [97, 98]]);
    const arrayBuffer = await consumers.arrayBuffer(parts("ab"));
    expect([arrayBuffer instanceof ArrayBuffer, [...new Uint8Array(arrayBuffer)]]).toEqual([true, [97, 98]]);
    const blob = await consumers.blob(parts("ab", new Uint8Array([99])));
    expect([blob instanceof Blob, blob.size, blob.type, await blob.text()]).toEqual([true, 3, "", "abc"]);
    expect((await consumers.buffer(parts(1, 2))).toString("hex")).toBe("3132");
    expect((await consumers.buffer(parts({ a: 1 }))).toString()).toBe("[object Object]");
  });

  it("fails as Node does", async () => {
    expect(await failure(() => consumers.text(parts(1, 2)))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "The \"input\" argument must be an instance of ArrayBuffer or ArrayBufferView. Received type number (1)"]);
    expect(await failure(() => consumers.text(5))).toEqual(["TypeError", undefined, "stream is not async iterable"]);
    expect(await failure(() => consumers.text(undefined))).toEqual(["TypeError", undefined, "Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')"]);
    expect(await failure(() => consumers.json(parts("{")))).toEqual(["SyntaxError", undefined, "Expected property name or '}' in JSON at position 1 (line 1 column 2)"]);
    expect(await failure(() => consumers.text((async function* (): AsyncGenerator<string> { await Promise.resolve(); yield "x"; throw new RangeError("bad"); })()))).toEqual(["RangeError", undefined, "bad"]);
  });
});
