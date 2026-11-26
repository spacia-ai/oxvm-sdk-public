/*!
 * Adapted from Node.js v24.18.1 lib/stream/consumers.js.
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

const inspect = (value: unknown, options?: { readonly depth: number }): string => nodeUtil.inspect(value, options);
function isAsyncIterable(value: object): value is AsyncIterable<unknown> { return typeof Reflect.get(value, Symbol.asyncIterator) === "function"; }
function isIterable(value: object): value is Iterable<unknown> { return typeof Reflect.get(value, Symbol.iterator) === "function"; }
function isReadableStream(value: object): value is ReadableStream<unknown> { return typeof ReadableStream === "function" && value instanceof ReadableStream; }
async function* readAll(stream: ReadableStream<unknown>): AsyncGenerator<unknown, void, undefined> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally { reader.releaseLock(); }
}
/** What `for await (const chunk of stream)` walks, with the failures V8 words for a value it cannot. */
function chunksOf(stream: unknown): AsyncIterable<unknown> | Iterable<unknown> {
  if (stream === null || stream === undefined) throw new TypeError(`Cannot read properties of ${String(stream)} (reading 'Symbol(Symbol.asyncIterator)')`);
  const source: unknown = Object(stream);
  if (typeof source === "object" && source !== null || typeof source === "function") {
    if (isAsyncIterable(source)) return source;
    // A browser without async iteration of web streams still reads one through its reader.
    if (isReadableStream(source)) return readAll(source);
    if (isIterable(source)) return source;
  }
  throw new TypeError("stream is not async iterable");
}
function isBlobPart(value: unknown): value is BlobPart {
  return typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob;
}
function decodable(value: unknown): value is ArrayBuffer | ArrayBufferView<ArrayBuffer> {
  return value instanceof ArrayBuffer || (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer);
}

/** The `stream/consumers` builtin: each function drains an async iterable, a Readable or a web ReadableStream. */
export const nodeStreamConsumers = {
  async arrayBuffer(stream: unknown): Promise<ArrayBuffer> {
    // Node reads the bytes back out of a Blob. The platform's Blob answers on a task of its own, which the process
    // does not know to wait for, so text and bytes are joined here; only a Blob chunk still goes through one.
    const parts: BlobPart[] = [];
    for await (const chunk of chunksOf(stream)) parts.push(isBlobPart(chunk) ? chunk : String(chunk));
    const pieces: Uint8Array[] = [];
    const encoder = new TextEncoder();
    for (const part of parts) {
      if (typeof part === "string") pieces.push(encoder.encode(part));
      else if (ArrayBuffer.isView(part)) pieces.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      else if (part instanceof Blob) return new Blob(parts).arrayBuffer();
      else pieces.push(new Uint8Array(part));
    }
    const joined = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
    let offset = 0;
    for (const piece of pieces) { joined.set(piece, offset); offset += piece.byteLength; }
    return joined.buffer;
  },
  async blob(stream: unknown): Promise<Blob> {
    const chunks: BlobPart[] = [];
    // A Blob takes text and bytes; anything else becomes its string, as the platform's Blob converts it.
    for await (const chunk of chunksOf(stream)) chunks.push(isBlobPart(chunk) ? chunk : String(chunk));
    return new Blob(chunks);
  },
  async buffer(stream: unknown): Promise<Buffer> {
    return Buffer.from(await nodeStreamConsumers.arrayBuffer(stream));
  },
  async bytes(stream: unknown): Promise<Uint8Array> {
    return new Uint8Array(await nodeStreamConsumers.arrayBuffer(stream));
  },
  async text(stream: unknown): Promise<string> {
    const dec = new TextDecoder();
    let str = "";
    for await (const chunk of chunksOf(stream)) {
      if (typeof chunk === "string") str += chunk;
      else if (decodable(chunk)) str += dec.decode(chunk, { stream: true });
      else {
        const received = invalidArgType("input", "x", chunk, inspect).message.split(". Received ").slice(1).join(". Received ");
        throw Object.assign(new TypeError(`The "input" argument must be an instance of ArrayBuffer or ArrayBufferView. Received ${received}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
    }
    // Flush the streaming TextDecoder so that any pending
    // incomplete multibyte characters are handled.
    str += dec.decode(undefined, { stream: false });
    return str;
  },
  async json(stream: unknown): Promise<unknown> {
    const str = await nodeStreamConsumers.text(stream);
    const value: unknown = JSON.parse(str);
    return value;
  },
};
