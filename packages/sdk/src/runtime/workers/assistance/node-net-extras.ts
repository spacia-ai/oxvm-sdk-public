/*!
 * Portions adapted from Node.js v24.18.1 lib/net.js (normalizeArgs, isPipeName).
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
import { unavailableNodeApi } from "./node-capability.ts";
import { named } from "./node-util-validators.ts";

/** The mark Node puts on an argument list it has already normalized. */
const normalizedArgsSymbol = Symbol("normalizedArgs");

function member(value: unknown, key: string | number): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${String(key)}')`);
  const boxed: unknown = Object(value);
  return (typeof boxed === "object" || typeof boxed === "function") && boxed !== null ? Reflect.get(boxed, key) : undefined;
}
function marked(options: unknown, callback: unknown): unknown[] {
  const result: unknown[] = [options, callback];
  Object.defineProperty(result, normalizedArgsSymbol, { value: true, enumerable: true, writable: true, configurable: true });
  return result;
}
/** A string that is not a port number names a pipe. */
function isPipeName(value: unknown): boolean { return typeof value === "string" && !(Number(value) >= 0); }

/**
 * Node's `net._normalizeArgs`: `(options[, cb])`, `(path[, cb])` or `([port][, host][, cb])` as `[options, cb]`,
 * where a missing callback is `null`.
 */
export const normalizeArgs = named(function (args: unknown): unknown[] {
  const length: unknown = member(args, "length");
  if (length === 0) return marked({}, null);
  const first: unknown = member(args, 0);
  let options: unknown;
  if (typeof first === "object" && first !== null) options = first;
  else if (isPipeName(first)) options = { path: first };
  else {
    const second: unknown = typeof length === "number" && length > 1 ? member(args, 1) : undefined;
    options = typeof second === "string" ? { port: first, host: second } : { port: first };
  }
  const callback: unknown = member(args, Number(length) - 1);
  return marked(options, typeof callback === "function" ? callback : null);
}, "normalizeArgs");

/**
 * Node's internal `net._createServerHandle` hands out a libuv handle. Linux owns this process's listeners, and no
 * handle of that kind exists here, so the call is refused.
 */
export const createServerHandle = named(function (): never {
  return unavailableNodeApi("net._createServerHandle");
}, "createServerHandle");
Object.defineProperty(createServerHandle, "length", { value: 5, configurable: true });
