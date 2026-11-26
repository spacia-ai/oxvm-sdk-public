/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/util/diff.js and lib/internal/assert/myers_diff.js; modified for OxVM's process owner.
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
import { named, outOfRange, validateString } from "./node-util-validators.ts";

/** One step of a diff: -1 deletes, 0 keeps, 1 inserts. */
export type DiffEntry = [operation: -1 | 0 | 1, value: string];

function validateInput(value: unknown, name: string): asserts value is string | string[] {
  if (!Array.isArray(value)) { validateString(value, name); return; }
  const items: unknown[] = value;
  for (let index = 0; index < items.length; index++) validateString(items[index], `${name}[${String(index)}]`);
}

/** An Int32Array read as JavaScript reads it: a missing index is `undefined`, which compares and stores as NaN does. */
function at(values: Int32Array, index: number): number { return values[index] ?? Number.NaN; }

function backtrack(trace: readonly Int32Array[], actual: string | readonly string[], expected: string | readonly string[]): DiffEntry[] {
  const max = actual.length + expected.length;
  let x = actual.length, y = expected.length;
  const result: DiffEntry[] = [];
  for (let level = trace.length - 1; level >= 0; level--) {
    const v = trace[level];
    if (v === undefined) continue;
    const diagonal = x - y, offset = diagonal + max;
    const previousDiagonal = diagonal === -level || (diagonal !== level && at(v, offset - 1) < at(v, offset + 1)) ? diagonal + 1 : diagonal - 1;
    const previousX = at(v, previousDiagonal + max), previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) { result.push([0, actual[x - 1] ?? ""]); x--; y--; }
    if (level > 0) {
      if (x > previousX) result.push([1, actual[--x] ?? ""]);
      else result.push([-1, expected[--y] ?? ""]);
    }
  }
  return result;
}

/** Node's Myers diff. It returns nothing when both inputs are empty, exactly as Node's does. */
function myersDiff(actual: string | readonly string[], expected: string | readonly string[]): DiffEntry[] | undefined {
  const actualLength = actual.length, expectedLength = expected.length, max = actualLength + expectedLength;
  if (max > 2 ** 31 - 1) throw outOfRange("myersDiff input size", "< 2^31", max);
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  for (let level = 0; level <= max; level++) {
    trace.push(new Int32Array(v));
    for (let diagonal = -level; diagonal <= level; diagonal += 2) {
      const offset = diagonal + max;
      const previousOffset = at(v, offset - 1), nextOffset = at(v, offset + 1);
      let x = diagonal === -level || (diagonal !== level && previousOffset < nextOffset) ? nextOffset : previousOffset + 1;
      let y = x - diagonal;
      while (x < actualLength && y < expectedLength && actual[x] === expected[y]) { x++; y++; }
      v[offset] = x;
      if (x >= actualLength && y >= expectedLength) return backtrack(trace, actual, expected);
    }
  }
  return undefined;
}

/** `util.diff(actual, expected)`: the differences between two strings (by UTF-16 code unit) or two string arrays. */
export const diff = named(function diff(actual: unknown, expected: unknown): DiffEntry[] {
  if (actual === expected) return [];
  validateInput(actual, "actual");
  validateInput(expected, "expected");
  const steps = myersDiff(actual, expected);
  // Node reverses the missing result of two empty arrays, which is this engine error.
  if (steps === undefined) throw new TypeError("Cannot convert undefined or null to object");
  return steps.reverse();
}, "diff");
