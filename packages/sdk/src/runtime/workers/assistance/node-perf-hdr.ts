/*!
 * The bucket layout, recording, statistics and percentile iteration follow HdrHistogram_c
 * (https://github.com/HdrHistogram/HdrHistogram_c, src/hdr_histogram.c), the library behind Node.js v24.18.1's
 * histograms. Written by Michael Barker and Gil Tene and released to the public domain (CC0 1.0), alternatively
 * under the BSD 2-Clause License:
 *
 * Copyright (c) 2012, 2013, 2014 Gil Tene
 * Copyright (c) 2014 Michael Barker
 * Copyright (c) 2014 Matt Warren
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
 * following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
 *    following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
 *    following disclaimer in the documentation and/or other materials provided with the distribution.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
 * USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

export const INT64_MAX = (1n << 63n) - 1n;

function bitLength(value: bigint): number { return value === 0n ? 0 : value.toString(2).length; }

/**
 * One HDR histogram of 64-bit values. Values are bigint, because the default range reaches 2^63; counts are
 * kept only for the slots that were recorded, where the C library allocates the whole table.
 */
export class HdrHistogram {
  readonly #unit: number;
  readonly #halfMagnitude: number;
  readonly #subBuckets: number;
  readonly #half: number;
  readonly #mask: bigint;
  readonly #length: number;
  readonly #limit: bigint;
  readonly #counts = new Map<number, number>();
  #sorted: readonly (readonly [number, number])[] | undefined;
  #total = 0;
  #min = INT64_MAX;
  #max = 0n;

  /** `hdr_init`; the caller has checked `1 <= lowest`, `2 * lowest <= highest` and `1 <= figures <= 5`. */
  constructor(lowest: bigint, highest: bigint, figures: number) {
    const magnitude = Math.ceil(Math.log(2 * 10 ** figures) / Math.log(2));
    this.#halfMagnitude = Math.max(magnitude, 1) - 1;
    // The C library truncates the same quotient of logarithms.
    this.#unit = Math.trunc(Math.log(Number(lowest)) / Math.log(2));
    this.#subBuckets = 2 ** (this.#halfMagnitude + 1);
    this.#half = this.#subBuckets / 2;
    this.#mask = BigInt(this.#subBuckets - 1) << BigInt(this.#unit);
    let untrackable = BigInt(this.#subBuckets) << BigInt(this.#unit), buckets = 1;
    while (untrackable <= highest) {
      if (untrackable > INT64_MAX / 2n) { buckets += 1; break; }
      untrackable <<= 1n;
      buckets += 1;
    }
    this.#length = (buckets + 1) * this.#half;
    this.#limit = highest;
  }

  get total(): number { return this.#total; }

  #bucket(value: bigint): number { return bitLength(value | this.#mask) - this.#unit - (this.#halfMagnitude + 1); }
  #index(value: bigint): number {
    const bucket = this.#bucket(value), sub = Number(value >> BigInt(bucket + this.#unit));
    return (bucket + 1) * this.#half + (sub - this.#half);
  }
  #valueAt(index: number): bigint {
    let bucket = Math.floor(index / this.#half) - 1, sub = (index % this.#half) + this.#half;
    if (bucket < 0) { sub -= this.#half; bucket = 0; }
    return BigInt(sub) << BigInt(bucket + this.#unit);
  }
  #lowest(value: bigint): bigint {
    const shift = BigInt(this.#bucket(value) + this.#unit);
    return (value >> shift) << shift;
  }
  #size(value: bigint): bigint {
    const bucket = this.#bucket(value), sub = value >> BigInt(bucket + this.#unit);
    return 1n << BigInt(this.#unit + (sub >= BigInt(this.#subBuckets) ? bucket + 1 : bucket));
  }
  #highest(value: bigint): bigint { return this.#lowest(value) + this.#size(value) - 1n; }
  #median(value: bigint): bigint { return this.#lowest(value) + (this.#size(value) >> 1n); }
  #entries(): readonly (readonly [number, number])[] {
    this.#sorted ??= [...this.#counts].sort((left, right) => left[0] - right[0]);
    return this.#sorted;
  }

  /** `hdr_record_values`: false when the value lies outside the table. */
  record(value: bigint, count = 1): boolean {
    if (value < 0n || this.#limit < value) return false;
    const index = this.#index(value);
    if (index < 0 || this.#length <= index) return false;
    this.#counts.set(index, (this.#counts.get(index) ?? 0) + count);
    this.#sorted = undefined;
    this.#total += count;
    if (value < this.#min && value !== 0n) this.#min = value;
    if (value > this.#max) this.#max = value;
    return true;
  }

  /** `hdr_add`: each recorded slot of `other` is recorded here at its slot's value; what does not fit is dropped. */
  add(other: HdrHistogram): void {
    for (const [index, count] of other.#entries()) this.record(other.#valueAt(index), count);
  }

  reset(): void {
    this.#counts.clear();
    this.#sorted = undefined;
    this.#total = 0;
    this.#min = INT64_MAX;
    this.#max = 0n;
  }

  min(): bigint {
    if ((this.#counts.get(0) ?? 0) > 0) return 0n;
    return this.#min === INT64_MAX ? INT64_MAX : this.#lowest(this.#min);
  }
  max(): bigint { return this.#max === 0n ? 0n : this.#highest(this.#max); }

  mean(): number {
    let sum = 0n;
    for (const [index, count] of this.#entries()) sum += BigInt(count) * this.#median(this.#valueAt(index));
    // The C library sums in a signed 64-bit integer.
    return Number(BigInt.asIntN(64, sum)) / this.#total;
  }
  stddev(): number {
    const mean = this.mean();
    let sum = 0;
    for (const [index, count] of this.#entries()) {
      const deviation = Number(this.#median(this.#valueAt(index))) - mean;
      sum += deviation * deviation * count;
    }
    return Math.sqrt(sum / this.#total);
  }

  /** `hdr_value_at_percentile`. */
  percentile(percentile: number): bigint {
    const requested = percentile < 100 ? percentile : 100;
    const wanted = Math.max(Math.trunc((requested / 100) * this.#total + 0.5), 1);
    let seen = 0, value = 0n;
    for (const [index, count] of this.#entries()) {
      seen += count;
      if (seen >= wanted) { value = this.#valueAt(index); break; }
    }
    return percentile === 0 ? this.#lowest(value) : this.#highest(value);
  }

  /** `hdr_iter_percentile_init(…, 1)` and its iteration, as Node walks it: each step's percentile and slot value. */
  percentiles(visit: (percentile: number, value: bigint) => void): void {
    const entries = this.#entries(), total = this.#total;
    let position = -1, cumulative = 0, count = 0, value = 0n, target = 0, last = false;
    const advance = (): boolean => {
      if (cumulative >= total) return false;
      const entry = entries[position + 1];
      if (entry === undefined) return false;
      position += 1;
      count = entry[1];
      cumulative += count;
      value = this.#valueAt(entry[0]);
      return true;
    };
    for (;;) {
      if (cumulative >= total) {
        if (last) return;
        last = true;
        visit(100, value);
        continue;
      }
      if (position === -1 && !advance()) return;
      let reported = false;
      do {
        const current = (100 * cumulative) / total;
        if (count !== 0 && target <= current) {
          const percentile = target;
          const halvings = Math.trunc(Math.log(100 / (100 - target)) / Math.log(2)) + 1;
          target += 100 / Math.trunc(2 ** halvings);
          visit(percentile, value);
          reported = true;
          break;
        }
      } while (advance());
      if (!reported) return;
    }
  }
}
