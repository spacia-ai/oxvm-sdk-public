/*!
 * Adapted from Node.js v24.18.1 lib/internal/streams/duplexpair.js.
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

import { Duplex } from "readable-stream";
import browserProcess from "process/";

type DuplexOptions = ConstructorParameters<typeof Duplex>[0];
/** The stream library reads the options it knows and ignores the rest, as Node's Duplex does. */
function isOptions(value: unknown): value is DuplexOptions { return value === undefined || (typeof value === "object" && value !== null); }
type Callback = (error?: Error | null) => void;

const kCallback = Symbol("Callback");
const kInitOtherSide = Symbol("InitOtherSide");

class DuplexSide extends Duplex {
  #otherSide: DuplexSide | null = null;
  [kCallback]: Callback | null = null;

  constructor(options?: unknown) {
    super(isOptions(options) ? options : undefined);
  }

  [kInitOtherSide](otherSide: DuplexSide): void {
    // Ensure this can only be set once, to enforce encapsulation.
    if (this.#otherSide !== null) throw new TypeError("The other side of a duplex pair is already set");
    this.#otherSide = otherSide;
  }

  /** Chunks may be anything in object mode; the library's declared `push` only names bytes. */
  #deliver(chunk: unknown): void {
    const push: unknown = Reflect.get(this, "push");
    if (typeof push === "function") Reflect.apply(push, this, [chunk]);
  }

  _read(): void {
    const callback = this[kCallback];
    if (callback !== null) {
      this[kCallback] = null;
      callback();
    }
  }

  _write(chunk: unknown, _encoding: string, callback: Callback): void {
    const otherSide = this.#otherSide;
    if (otherSide === null || otherSide[kCallback] !== null) throw new TypeError("A duplex pair wrote before its other side was ready");
    const length: unknown = chunk === null || chunk === undefined ? undefined : Reflect.get(Object(chunk), "length");
    if (length === 0) {
      browserProcess.nextTick(() => { callback(); });
    } else {
      otherSide.#deliver(chunk);
      otherSide[kCallback] = callback;
    }
  }

  _final(callback: Callback): void {
    const otherSide = this.#otherSide;
    if (otherSide === null) throw new TypeError("A duplex pair ended before its other side was ready");
    otherSide.on("end", () => { callback(); });
    otherSide.#deliver(null);
  }

  _destroy(err: Error | null | undefined, callback: Callback): void {
    const otherSide = this.#otherSide;

    if (otherSide !== null && !otherSide.destroyed) {
      // Use nextTick to avoid crashing the current execution stack (like HTTP parser)
      browserProcess.nextTick(() => {
        if (otherSide.destroyed) return;

        if (err !== null && err !== undefined) {
          // Destroy the other side, without passing the 'err' object.
          // This closes the other side gracefully so it doesn't hang,
          // but prevents the "Unhandled error" crash.
          otherSide.destroy();
        } else {
          // Standard graceful close
          otherSide.#deliver(null);
        }
      });
    }

    callback(err);
  }
}
Object.defineProperty(DuplexSide, "name", { value: "DuplexSide" });

/** `stream.duplexPair(options)`: two Duplex streams, each reading what the other writes. */
export const duplexPair = { duplexPair: (options?: unknown): [Duplex, Duplex] => {
  const side0 = new DuplexSide(options);
  const side1 = new DuplexSide(options);
  side0[kInitOtherSide](side1);
  side1[kInitOtherSide](side0);
  return [side0, side1];
} }.duplexPair;
