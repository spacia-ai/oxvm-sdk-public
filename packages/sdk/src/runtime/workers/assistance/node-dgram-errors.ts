/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/errors.js (the ERR_SOCKET_* errors, ErrnoException,
 * ExceptionWithHostPort and SystemError) and lib/internal/validators.js (validatePort).
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
import { linuxErrnoConstants } from "../../linux-errno.ts";
import { SYSTEM_ERROR_MESSAGES } from "./node-system-errors.ts";
import { invalidType } from "./node-util-validators.ts";

/** The Linux errors this module raises itself, where libuv answers before any system call. */
export const EBADF = linuxErrnoConstants.EBADF, EINVAL = linuxErrnoConstants.EINVAL, EAGAIN = linuxErrnoConstants.EAGAIN,
  EADDRINUSE = linuxErrnoConstants.EADDRINUSE, EAFNOSUPPORT = linuxErrnoConstants.EAFNOSUPPORT;

const names = new Map<number, string>();
for (const [name, number] of Object.entries(linuxErrnoConstants)) if (!names.has(number)) names.set(number, name);
/** libuv's name of a Linux errno; a number it has no name for is its UNKNOWN. */
function errorName(errno: number): string { return names.get(errno) ?? "UNKNOWN"; }

/** Node's wording of the value an argument received (`determineSpecificType`). */
function received(value: unknown): string {
  const prefix = "The \"v\" argument must be of type t. ";
  return invalidType("v", "t", value).message.slice(prefix.length);
}
function coded<Failure extends Error>(error: Failure, code: string): Failure { return Object.assign(error, { code }); }

export const badSocketType = (): TypeError => coded(new TypeError("Bad socket type specified. Valid types are: udp4, udp6"), "ERR_SOCKET_BAD_TYPE");
export const notRunning = (): Error => coded(new Error("Not running"), "ERR_SOCKET_DGRAM_NOT_RUNNING");
export const alreadyBound = (): Error => coded(new Error("Socket is already bound"), "ERR_SOCKET_ALREADY_BOUND");
export const isConnected = (): Error => coded(new Error("Already connected"), "ERR_SOCKET_DGRAM_IS_CONNECTED");
export const notConnected = (): Error => coded(new Error("Not connected"), "ERR_SOCKET_DGRAM_NOT_CONNECTED");
export const badBufferSize = (): TypeError => coded(new TypeError("Buffer size must be a positive integer"), "ERR_SOCKET_BAD_BUFFER_SIZE");
export const missingArgument = (name: string): TypeError => coded(new TypeError(`The "${name}" argument must be specified`), "ERR_MISSING_ARGS");
export const outOfBounds = (name: string): RangeError => coded(new RangeError(`"${name}" is outside of buffer bounds`), "ERR_BUFFER_OUT_OF_BOUNDS");
/** ERR_INVALID_ARG_TYPE for a datagram or a list of them. */
export function invalidBuffer(name: string, value: unknown): TypeError {
  return coded(new TypeError(`The "${name}" argument must be of type string or an instance of Buffer, TypedArray, or DataView. ${received(value)}`), "ERR_INVALID_ARG_TYPE");
}
/** ERR_INVALID_ARG_TYPE for a block list option, in Node's wording. */
export function invalidBlockListOption(name: string, value: unknown): TypeError {
  return coded(new TypeError(`The "${name}" property must be an net.BlockList. ${received(value)}`), "ERR_INVALID_ARG_TYPE");
}
/** What reading a method of the closed socket's handle throws in Node: the handle is null by then. */
export const closedHandle = (method: string): TypeError => new TypeError(`Cannot read properties of null (reading '${method}')`);

/** Node's `validatePort` without a zero: the port as an integer, or ERR_SOCKET_BAD_PORT. */
export function validatePort(port: unknown): number {
  const number = typeof port === "number" ? port : typeof port === "string" && port.trim().length !== 0 ? Number(port) : Number.NaN;
  if (number !== number >>> 0 || number > 0xffff || number === 0) throw coded(new RangeError(`Port should be > 0 and < 65536. ${received(port)}.`), "ERR_SOCKET_BAD_PORT");
  return number;
}

/** A host or a port as an error message names it. */
function shown(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ? `${value}` : value === undefined ? "undefined" : "";
}

/** Node's `ErrnoException`: a Linux errno under the name of the operation that met it. */
export function errnoException(errno: number, syscall: string): Error {
  const code = errorName(errno);
  return Object.assign(new Error(`${syscall} ${code}`), { errno: -errno, code, syscall });
}
/** Node's `ExceptionWithHostPort`: the address is always a property, the port only when there is one. */
export function exceptionWithHostPort(errno: number, syscall: string, address: unknown, port: unknown): Error {
  const code = errorName(errno), present = Boolean(port);
  const details = present && Number(port) > 0 ? ` ${shown(address)}:${shown(port)}` : address === undefined || shown(address) === "" ? "" : ` ${shown(address)}`;
  const error = Object.assign(new Error(`${syscall} ${code}${details}`), { errno: -errno, code, syscall, address });
  return present ? Object.assign(error, { port }) : error;
}
/** ERR_SOCKET_BUFFER_SIZE, a `SystemError` about libuv's `uv_recv_buffer_size` or `uv_send_buffer_size`. */
export function bufferSizeFailure(errno: number, receive: boolean): Error {
  const code = errorName(errno), syscall = receive ? "uv_recv_buffer_size" : "uv_send_buffer_size";
  const message = Object.hasOwn(SYSTEM_ERROR_MESSAGES, code) ? SYSTEM_ERROR_MESSAGES[code] ?? "unknown error" : "unknown error";
  const error = new Error(`Could not get or set buffer size: ${syscall} returned ${code} (${message})`);
  const info = { errno: -errno, code, message, syscall };
  Object.defineProperty(error, "name", { value: "SystemError", enumerable: false, writable: true, configurable: true });
  Object.defineProperty(error, "info", { value: info, enumerable: true, writable: false, configurable: true });
  Object.defineProperty(error, "errno", { get: () => info.errno, set: (value: number) => { info.errno = value; }, enumerable: true, configurable: true });
  Object.defineProperty(error, "syscall", { get: () => info.syscall, set: (value: string) => { info.syscall = value; }, enumerable: true, configurable: true });
  return coded(error, "ERR_SOCKET_BUFFER_SIZE");
}
