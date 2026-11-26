/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/readline/callbacks.js and lib/internal/readline/promises.js; modified for OxVM's process owner.
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
import { invalidInstance, invalidValue, named, templateText, validateBoolean, validateFunction, validateInteger } from "./node-util-validators.ts";

const ESCAPE = "\x1b";
const CLEAR_TO_LINE_BEGINNING = `${ESCAPE}[1K`, CLEAR_TO_LINE_END = `${ESCAPE}[0K`, CLEAR_LINE = `${ESCAPE}[2K`, CLEAR_SCREEN_DOWN = `${ESCAPE}[0J`;

export type NextTick = (callback: () => void) => void;

/** `stream.write(data, callback)` on whatever the caller passed as the stream. */
function write(stream: unknown, data: string, callback?: unknown): unknown {
  const method: unknown = typeof stream === "object" || typeof stream === "function" ? Reflect.get(Object(stream), "write") : undefined;
  if (typeof method !== "function") throw new TypeError("stream.write is not a function");
  return Reflect.apply(method, stream, [data, callback]);
}
/** The number JavaScript compares a loosely typed distance as. */
function numeric(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" ? Number(value) : Number.NaN;
}
/** Relative cursor movement; a positive distance is written as the caller gave it, a negative one negated. */
function movement(dx: unknown, dy: unknown): string {
  const x = numeric(dx), y = numeric(dy);
  let data = "";
  if (x < 0) data += `${ESCAPE}[${String(-x)}D`; else if (x > 0) data += `${ESCAPE}[${templateText(dx)}C`;
  if (y < 0) data += `${ESCAPE}[${String(-y)}A`; else if (y > 0) data += `${ESCAPE}[${templateText(dy)}B`;
  return data;
}
function lineClear(dir: unknown): string {
  const direction = numeric(dir);
  return direction < 0 ? CLEAR_TO_LINE_BEGINNING : direction > 0 ? CLEAR_TO_LINE_END : CLEAR_LINE;
}

export interface ReadlineCallbacks {
  readonly cursorTo: (stream: unknown, x: unknown, y?: unknown, callback?: unknown) => unknown;
  readonly moveCursor: (stream: unknown, dx: unknown, dy: unknown, callback?: unknown) => unknown;
  readonly clearLine: (stream: unknown, dir: unknown, callback?: unknown) => unknown;
  readonly clearScreenDown: (stream: unknown, callback?: unknown) => unknown;
}

/** `readline.cursorTo`, `moveCursor`, `clearLine` and `clearScreenDown`: each writes one CSI sequence and returns
 * what `stream.write` returned; without a stream (or with nothing to do) the callback runs on the next tick. */
export function createReadlineCallbacks(nextTick: NextTick): ReadlineCallbacks {
  const later = (callback: unknown): true => {
    if (typeof callback === "function") nextTick(() => { Reflect.apply(callback, undefined, [null]); });
    return true;
  };
  function cursorTo(stream: unknown, x: unknown, y?: unknown, callback?: unknown): unknown {
    if (callback !== undefined) validateFunction(callback, "callback");
    let row = y, done: unknown = callback;
    if (typeof row === "function") { done = row; row = undefined; }
    if (Number.isNaN(x)) throw invalidValue("x", x);
    if (Number.isNaN(row)) throw invalidValue("y", row);
    if (stream === null || stream === undefined || (typeof x !== "number" && typeof row !== "number")) return later(done);
    if (typeof x !== "number") throw Object.assign(new TypeError("Cannot set cursor row without setting its column"), { code: "ERR_INVALID_CURSOR_POS" });
    return write(stream, typeof row !== "number" ? `${ESCAPE}[${String(x + 1)}G` : `${ESCAPE}[${String(row + 1)};${String(x + 1)}H`, done);
  }
  function moveCursor(stream: unknown, dx: unknown, dy: unknown, callback?: unknown): unknown {
    if (callback !== undefined) validateFunction(callback, "callback");
    if (stream === null || stream === undefined || !(Boolean(dx) || Boolean(dy))) return later(callback);
    return write(stream, movement(dx, dy), callback);
  }
  function clearLine(stream: unknown, dir: unknown, callback?: unknown): unknown {
    if (callback !== undefined) validateFunction(callback, "callback");
    if (stream === null || stream === undefined) return later(callback);
    return write(stream, lineClear(dir), callback);
  }
  function clearScreenDown(stream: unknown, callback?: unknown): unknown {
    if (callback !== undefined) validateFunction(callback, "callback");
    if (stream === null || stream === undefined) return later(callback);
    return write(stream, CLEAR_SCREEN_DOWN, callback);
  }
  return { cursorTo: named(cursorTo, "cursorTo"), moveCursor: named(moveCursor, "moveCursor"), clearLine: named(clearLine, "clearLine"), clearScreenDown: named(clearScreenDown, "clearScreenDown") };
}

/** Node's `isWritable(stream)` for the streams this runtime has: a live, unfinished writable with `write` and `on`. */
function writable(stream: unknown): boolean {
  if (typeof stream !== "object" || stream === null) return false;
  if (Reflect.get(stream, "writable") !== true || typeof Reflect.get(stream, "write") !== "function" || typeof Reflect.get(stream, "on") !== "function") return false;
  return Reflect.get(stream, "destroyed") !== true && Reflect.get(stream, "writableEnded") !== true;
}

/** The public shape of `readline/promises`' `Readline`. */
export interface ReadlineTransaction {
  cursorTo(x: unknown, ...rest: unknown[]): this;
  moveCursor(dx: unknown, dy: unknown): this;
  clearLine(dir: unknown): this;
  clearScreenDown(): this;
  /** Resolves with whatever the stream hands its write callback (`null` or `undefined`), as Node's does. */
  commit(): Promise<unknown>;
  rollback(): this;
}

/** `readline/promises`' `Readline`: cursor and clearing actions collected into one write by `commit()`, dropped by
 * `rollback()`, or written on the next tick when `autoCommit` is set. */
export function createReadlineTransaction(nextTick: NextTick): new (stream: unknown, ...rest: unknown[]) => ReadlineTransaction {
  class Readline implements ReadlineTransaction {
    #autoCommit = false;
    readonly #stream: unknown;
    #todo: string[] = [];
    // The rest parameters keep Node's `Readline.length` and `cursorTo.length` of 1.
    constructor(stream: unknown, ...[options]: unknown[]) {
      if (!writable(stream)) throw invalidInstance("stream", "Writable", stream);
      this.#stream = stream;
      const autoCommit: unknown = typeof options === "object" && options !== null || typeof options === "function" ? Reflect.get(options, "autoCommit") : undefined;
      if (autoCommit !== null && autoCommit !== undefined) { validateBoolean(autoCommit, "options.autoCommit"); this.#autoCommit = autoCommit; }
    }
    #add(data: string): this {
      if (this.#autoCommit) nextTick(() => { write(this.#stream, data); }); else this.#todo.push(data);
      return this;
    }
    cursorTo(x: unknown, ...[y]: unknown[]): this {
      validateInteger(x, "x");
      if (y === null || y === undefined) return this.#add(`${ESCAPE}[${String(x + 1)}G`);
      validateInteger(y, "y");
      return this.#add(`${ESCAPE}[${String(y + 1)};${String(x + 1)}H`);
    }
    moveCursor(dx: unknown, dy: unknown): this {
      if (!(Boolean(dx) || Boolean(dy))) return this;
      validateInteger(dx, "dx");
      validateInteger(dy, "dy");
      return this.#add(movement(dx, dy));
    }
    clearLine(dir: unknown): this {
      validateInteger(dir, "dir", -1, 1);
      return this.#add(lineClear(dir));
    }
    clearScreenDown(): this { return this.#add(CLEAR_SCREEN_DOWN); }
    commit(): Promise<unknown> {
      return new Promise(resolve => {
        const data = this.#todo.join("");
        this.#todo = [];
        write(this.#stream, data, resolve);
      });
    }
    rollback(): this { this.#todo = []; return this; }
  }
  return named(Readline, "Readline");
}
