/*!
 * Portions adapted from Node.js v24.18.1 lib/util.js and lib/internal/errors.js (system error lookups, ErrnoException, ExceptionWithHostPort); modified for OxVM's process owner.
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
import { SYSTEM_ERROR_MESSAGES, SYSTEM_ERROR_NUMBERS } from "./node-system-errors.ts";
import { named, outOfRange, templateText, validateNumber } from "./node-util-validators.ts";

const NAMES: ReadonlyMap<number, string> = new Map(Object.entries(SYSTEM_ERROR_NUMBERS).map(([name, errno]) => [errno, name]));

function negativeInteger(value: unknown): number {
  validateNumber(value, "err");
  if (value >= 0 || !Number.isSafeInteger(value)) throw outOfRange("err", "a negative integer", value);
  return value;
}
function unknownError(errno: number): string { return `Unknown system error ${String(errno)}`; }
function errorName(errno: number): string { return NAMES.get(errno) ?? unknownError(errno); }

/** Whether Node's `port && port > 0` holds for a value of any type. */
function positive(port: unknown): boolean {
  if (typeof port === "bigint") return port > 0n;
  return (typeof port === "number" || typeof port === "string" || typeof port === "boolean") && Number(port) > 0;
}

/** A new error whose stack starts at the caller of `above`, as Node's `captureLargerStackTrace` leaves it. */
function failure(message: string, above: object): Error {
  const error = new Error(message);
  const capture: unknown = Reflect.get(Error, "captureStackTrace");
  if (typeof capture === "function") Reflect.apply(capture, Error, [error, above]);
  return error;
}

export interface NodeSystemErrors {
  readonly getSystemErrorName: (err: unknown) => string;
  readonly getSystemErrorMessage: (err: unknown) => string;
  readonly getSystemErrorMap: () => Map<number, [string, string]>;
  readonly _errnoException: (...args: unknown[]) => Error;
  readonly _exceptionWithHostPort: (...args: unknown[]) => Error;
}

/** `util.getSystemErrorName`, `getSystemErrorMessage`, `getSystemErrorMap`, `_errnoException` and
 * `_exceptionWithHostPort` over libuv's Linux table. One process sees one map object, as in Node. */
export function createSystemErrors(): NodeSystemErrors {
  let map: Map<number, [string, string]> | undefined;
  function getSystemErrorName(err: unknown): string { return errorName(negativeInteger(err)); }
  function getSystemErrorMessage(err: unknown): string {
    const errno = negativeInteger(err), name = NAMES.get(errno);
    // Node's native lookup reads the number as a C int, so anything below its range is reported as INT_MIN.
    return name === undefined ? unknownError(Math.max(errno, -2_147_483_648)) : SYSTEM_ERROR_MESSAGES[name] ?? unknownError(errno);
  }
  function getSystemErrorMap(): Map<number, [string, string]> {
    map ??= new Map(Object.entries(SYSTEM_ERROR_NUMBERS).map(([name, errno]) => [errno, [name, SYSTEM_ERROR_MESSAGES[name] ?? ""]]));
    return map;
  }
  function _errnoException(...args: unknown[]): Error {
    const [err, syscall, original] = args;
    const code = getSystemErrorName(err);
    const hasOriginal = Boolean(original), detail = hasOriginal ? ` ${templateText(original)}` : "";
    return Object.assign(failure(`${templateText(syscall)} ${code}${detail}`, _errnoException), { errno: err, code, syscall });
  }
  function _exceptionWithHostPort(...args: unknown[]): Error {
    const [err, syscall, address, port, additional] = args;
    const code = getSystemErrorName(err);
    const hasPort = Boolean(port), hasAddress = Boolean(address), hasAdditional = Boolean(additional);
    let details = "";
    if (hasPort && positive(port)) details = ` ${templateText(address)}:${templateText(port)}`;
    else if (hasAddress) details = ` ${templateText(address)}`;
    if (hasAdditional) details += ` - Local (${templateText(additional)})`;
    const error = Object.assign(failure(`${templateText(syscall)} ${code}${details}`, _exceptionWithHostPort), { errno: err, code, syscall, address });
    return hasPort ? Object.assign(error, { port }) : error;
  }
  return {
    getSystemErrorName: named(getSystemErrorName, "getSystemErrorName"), getSystemErrorMessage: named(getSystemErrorMessage, "getSystemErrorMessage"),
    getSystemErrorMap: named(getSystemErrorMap, "getSystemErrorMap"), _errnoException: named(_errnoException, "_errnoException"),
    _exceptionWithHostPort: named(_exceptionWithHostPort, "_exceptionWithHostPort"),
  };
}
