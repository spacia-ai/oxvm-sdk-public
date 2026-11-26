/*!
 * Ported from the constructor of Node.js v24.18.1 lib/internal/streams/fast-utf8-stream.js (`fs.Utf8Stream`), which is
 * derived from the SonicBoom module (https://github.com/pinojs/sonic-boom).
 *
 * MIT License
 * Copyright (c) 2017 Matteo Collina
 * Copyright Node.js contributors. All rights reserved.
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
import { invalidValue, validateBoolean, validateFunction, validateInteger, validateObject } from "./node-util-validators.ts";

// 16 KB. Don't write more than docker buffer size.
// https://github.com/moby/moby/blob/513ec73831269947d38a644c278ce3cac36783b2/daemon/logger/copier.go#L13
const kMaxWrite = 16 * 1024;
const kHighWaterMark = 16_387;
const UINT32_MAX = 4_294_967_295;

/** The options of a stream as its constructor read them, before anything is validated. */
export interface Utf8StreamOptions {
  readonly fd: unknown; readonly minLength: unknown; readonly maxLength: unknown; readonly maxWrite: unknown; readonly periodicFlush: unknown;
  readonly sync: unknown; readonly append: unknown; readonly mkdir: unknown; readonly retryEAGAIN: unknown; readonly fsync: unknown;
  readonly contentMode: unknown; readonly mode: unknown; readonly fs: unknown;
}
/** The validated options. `fd` is the descriptor, the path, or whatever else was passed, which the stream refuses. */
export interface Utf8StreamSettings {
  readonly fd: unknown; readonly hwm: number; readonly minLength: number; readonly maxLength: number; readonly maxWrite: number; readonly periodicFlush: number;
  readonly sync: boolean; readonly fsync: boolean; readonly append: boolean; readonly mkdir: boolean; readonly mode: unknown; readonly binary: boolean;
  readonly retryEAGAIN: (...args: unknown[]) => unknown;
  /** The process's file operations with the program's `options.fs` laid over them. */
  readonly fs: Readonly<Record<string, unknown>>;
}

/** `a || b` of JavaScript, for values of any type. */
function or(value: unknown, fallback: unknown): unknown { const truthy: boolean = Boolean(value); return truthy ? value : fallback; }

/** The destructuring at the top of the constructor: the properties are read once, in this order, before `super()`. */
export function readUtf8StreamOptions(options: unknown): Utf8StreamOptions {
  validateObject(options, "options");
  const read = (name: string): unknown => Reflect.get(options, name);
  const given = read("fd"), dest = read("dest"), minLength = read("minLength"), maxLength = read("maxLength"), maxWrite = read("maxWrite"), periodicFlush = read("periodicFlush"),
    sync = read("sync"), append = read("append"), mkdir = read("mkdir"), retryEAGAIN = read("retryEAGAIN"), fsync = read("fsync"), contentMode = read("contentMode"), mode = read("mode"), fs = read("fs");
  return { fd: given ?? dest, minLength, maxLength, maxWrite, periodicFlush, sync, append: append === undefined ? true : append, mkdir, retryEAGAIN, fsync,
    contentMode: contentMode === undefined ? "utf8" : contentMode, mode, fs: fs === undefined ? {} : fs };
}

/** The validation of the constructor, in its order. `files` are the process's own operations. */
export function validateUtf8StreamOptions(options: Utf8StreamOptions, files: Readonly<Record<string, unknown>>): Utf8StreamSettings {
  validateObject(options.fs, "options.fs");
  const fs: Readonly<Record<string, unknown>> = { ...files, ...options.fs };
  for (const name of ["write", "writeSync", "fsync", "fsyncSync", "close", "open", "mkdir", "mkdirSync"]) validateFunction(fs[name], `options.fs.${name}`);

  // Math.max converts its arguments as the original's call does: a symbol throws, text becomes NaN.
  const highest: unknown = Reflect.apply(Math.max, undefined, [or(options.minLength, 0), kHighWaterMark]);
  const hwm = typeof highest === "number" ? highest : Number.NaN;
  const minLength = or(options.minLength, 0), maxLength = or(options.maxLength, 0), maxWrite = or(options.maxWrite, kMaxWrite), periodicFlush = or(options.periodicFlush, 0);
  const sync = or(options.sync, false), fsync = or(options.fsync, false), append = or(options.append, false), mkdir = or(options.mkdir, false);
  const retryEAGAIN = or(options.retryEAGAIN, () => true);

  validateInteger(hwm, "options.hwm", 0, UINT32_MAX);
  validateInteger(minLength, "options.minLength", 0, UINT32_MAX);
  validateInteger(maxLength, "options.maxLength", 0, UINT32_MAX);
  validateInteger(maxWrite, "options.maxWrite", 0, UINT32_MAX);
  validateInteger(periodicFlush, "options.periodicFlush", 0, UINT32_MAX);
  validateBoolean(sync, "options.sync");
  validateBoolean(fsync, "options.fsync");
  validateBoolean(append, "options.append");
  validateBoolean(mkdir, "options.mkdir");
  validateFunction(retryEAGAIN, "options.retryEAGAIN");
  if (options.contentMode !== "buffer" && options.contentMode !== "utf8") throw invalidValue("options.contentMode", options.contentMode, "must be one of: 'buffer', 'utf8'");

  return { fd: options.fd, hwm, minLength, maxLength, maxWrite, periodicFlush, sync, fsync, append, mkdir, mode: options.mode, binary: options.contentMode === "buffer", retryEAGAIN, fs };
}
