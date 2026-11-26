/*!
 * Adapted from Punycode.js 2.1.0 <https://mths.be/punycode> as Node.js v24.18.1 ships it in lib/punycode.js;
 * typed for strict TypeScript, without the deprecation warning, which the module table owns.
 * Copyright Mathias Bynens <https://mathiasbynens.be/>
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** Highest positive signed 32-bit value. */
const maxInt = 2147483647;
/** Bootstring parameters of RFC 3492. */
const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128, delimiter = "-";
const regexPunycode = /^xn--/, regexNonASCII = /[^\0-\x7F]/, regexSeparators = /[\x2E。．｡]/g;
const errors = {
  "overflow": "Overflow: input needs wider integers to process",
  "not-basic": "Illegal input >= 0x80 (not a basic code point)",
  "invalid-input": "Invalid input",
} as const;
const baseMinusTMin = base - tMin, floor = Math.floor, stringFromCharCode = String.fromCharCode;

function error(type: keyof typeof errors): never {
  throw new RangeError(errors[type]);
}

/** Labels are converted last to first, as upstream's `map` does: of two bad labels the later one reports. */
function mapDomain(domain: string, callback: (label: string) => string): string {
  const parts = domain.split("@");
  let result = "";
  if (parts.length > 1) {
    // Only the domain of an email address is converted; upstream takes the part after the first `@`.
    result = `${parts[0] ?? ""}@`;
    domain = parts[1] ?? "";
  }
  const labels = domain.replace(regexSeparators, "\x2E").split(".");
  const encoded: string[] = [];
  let length = labels.length;
  while (length--) encoded[length] = callback(labels[length] ?? "");
  return result + encoded.join(".");
}

/** The code points of a UTF-16 string; an unmatched surrogate stays a code unit. */
function ucs2decode(string: string): number[] {
  const output: number[] = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xFC00) === 0xDC00) output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
      else { output.push(value); counter--; }
    } else output.push(value);
  }
  return output;
}

function ucs2encode(codePoints: readonly number[]): string {
  return String.fromCodePoint(...codePoints);
}

/** The digit a basic code point stands for, or `base` when it stands for none. */
function basicToDigit(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint < 0x3A) return 26 + (codePoint - 0x30);
  if (codePoint >= 0x41 && codePoint < 0x5B) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint < 0x7B) return codePoint - 0x61;
  return base;
}

/** 0..25 are a..z and 26..35 are 0..9; the encoder only writes the lowercase form. */
function digitToBasic(digit: number): number {
  return digit + 22 + (digit < 26 ? 75 : 0);
}

/** Bias adaptation, RFC 3492 section 3.4. */
function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let k = 0;
  delta = firstTime ? floor(delta / damp) : delta >> 1;
  delta += floor(delta / numPoints);
  for (; delta > baseMinusTMin * tMax >> 1; k += base) delta = floor(delta / baseMinusTMin);
  return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
}

function decode(input: string): string {
  const output: number[] = [];
  const inputLength = input.length;
  let i = 0, n = initialN, bias = initialBias;
  // The code points before the last delimiter are basic and copied as they are.
  let basic = input.lastIndexOf(delimiter);
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; ++j) {
    if (input.charCodeAt(j) >= 0x80) error("not-basic");
    output.push(input.charCodeAt(j));
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
    // One generalized variable-length integer is the distance to the next insertion.
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= inputLength) error("invalid-input");
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= base) error("invalid-input");
      if (digit > floor((maxInt - i) / w)) error("overflow");
      i += digit * w;
      const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
      if (digit < t) break;
      const baseMinusT = base - t;
      if (w > floor(maxInt / baseMinusT)) error("overflow");
      w *= baseMinusT;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (floor(i / out) > maxInt - n) error("overflow");
    n += floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function encode(input: string): string {
  const output: string[] = [];
  const codePoints = ucs2decode(input);
  const inputLength = codePoints.length;
  let n = initialN, delta = 0, bias = initialBias;
  for (const currentValue of codePoints) if (currentValue < 0x80) output.push(stringFromCharCode(currentValue));
  const basicLength = output.length;
  let handledCPCount = basicLength;
  if (basicLength) output.push(delimiter);
  while (handledCPCount < inputLength) {
    // Every code point below n is handled; m is the next one.
    let m = maxInt;
    for (const currentValue of codePoints) if (currentValue >= n && currentValue < m) m = currentValue;
    const handledCPCountPlusOne = handledCPCount + 1;
    if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) error("overflow");
    delta += (m - n) * handledCPCountPlusOne;
    n = m;
    for (const currentValue of codePoints) {
      if (currentValue < n && ++delta > maxInt) error("overflow");
      if (currentValue === n) {
        let q = delta;
        for (let k = base; ; k += base) {
          const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
          if (q < t) break;
          const qMinusT = q - t, baseMinusT = base - t;
          output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT)));
          q = floor(qMinusT / baseMinusT);
        }
        output.push(stringFromCharCode(digitToBasic(q)));
        bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
        delta = 0;
        ++handledCPCount;
      }
    }
    ++delta;
    ++n;
  }
  return output.join("");
}

function toUnicode(input: string): string {
  return mapDomain(input, string => regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string);
}

function toASCII(input: string): string {
  return mapDomain(input, string => regexNonASCII.test(string) ? `xn--${encode(string)}` : string);
}

// The bundle renames functions; programs read these names.
for (const [callee, name] of [[ucs2decode, "ucs2decode"], [ucs2encode, "ucs2encode"], [decode, "decode"], [encode, "encode"], [toASCII, "toASCII"], [toUnicode, "toUnicode"]] as const) {
  Object.defineProperty(callee, "name", { value: name });
}

/** Node's deprecated `punycode` builtin (DEP0040): Punycode.js 2.1.0, with exactly its exports. */
export const nodePunycode = {
  version: "2.1.0",
  ucs2: { decode: ucs2decode, encode: ucs2encode },
  decode,
  encode,
  toASCII,
  toUnicode,
};
