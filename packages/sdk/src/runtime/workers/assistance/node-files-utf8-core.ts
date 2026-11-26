/*!
 * Ported from Node.js v24.18.1 lib/internal/streams/fast-utf8-stream.js (`fs.Utf8Stream`), which is derived from the
 * SonicBoom module (https://github.com/pinojs/sonic-boom).
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
import { Buffer } from "buffer";
import { invalidInstance, invalidType, outOfRange, validateFunction, validateString } from "./node-util-validators.ts";
import type { Utf8StreamSettings } from "./node-files-utf8-options.ts";

// The state machine of Node's Utf8Stream, statement for statement, defects included: the stream is what programs see of
// Node 24.18.1, so a write the original loses or an exception it throws is lost or thrown here too (see the test's notes).

const BUSY_WRITE_TIMEOUT = 100;
const kEmptyBuffer = Buffer.allocUnsafe(0);

/** Any function: the stream calls its file operations with the argument lists Node's stream uses. */
type Operation = (...args: never[]) => unknown;
/** The `fs` operations the stream is built on, with the shapes of the process's own `fs` module. */
export interface Utf8StreamFiles {
  readonly open: Operation; readonly openSync: Operation; readonly write: Operation; readonly writeSync: Operation;
  readonly fsync: Operation; readonly fsyncSync: Operation; readonly close: Operation; readonly mkdir: Operation; readonly mkdirSync: Operation;
}
export const FILE_OPERATIONS = ["open", "openSync", "write", "writeSync", "fsync", "fsyncSync", "close", "mkdir", "mkdirSync"] as const;
export interface Utf8StreamTimer { unref(): unknown }
export interface Utf8StreamScheduling {
  readonly fs: Utf8StreamFiles;
  /** The process's timers: the retry timer is referenced, the periodic flush is not. */
  readonly timers: { readonly setTimeout: (callback: () => void, milliseconds: number) => unknown; readonly setInterval: (callback: () => void, milliseconds: number) => Utf8StreamTimer; readonly clearInterval: (timer: Utf8StreamTimer) => void };
  /** `process.nextTick`. */
  readonly nextTick: (callback: () => void) => void;
  /** Holds the process open until the returned function is called: an asynchronous open, write, fsync or close of the process's own `fs`. */
  readonly retain: () => () => void;
  /** `path.dirname`. */
  readonly dirname: (path: unknown) => string;
  /** Blocks the thread, as Node's internal `sleep` does between the retries of a synchronous write. */
  readonly sleep: (milliseconds: number) => void;
}
/** The stream object: its events, and the public methods Node's stream calls on itself. */
export interface Utf8StreamHost {
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  flush(cb?: unknown): void;
  reopen(file?: unknown): void;
  end(): void;
}

const truthy = (value: unknown): boolean => Boolean(value);
function codeOf(error: unknown): unknown { return error === null || error === undefined ? undefined : Reflect.get(Object(error), "code"); }
function invalidState(message: string): Error { return Object.assign(new Error(`Invalid state: ${message}`), { code: "ERR_INVALID_STATE" }); }
/** A byte count as the arithmetic of the original reads it. */
function count(value: unknown, whole: number): number { return typeof value === "number" ? value : value === undefined ? whole : Number(value); }
/** A descriptor as the comparisons of the original read it. */
function descriptorNumber(value: unknown): number { return typeof value === "number" ? value : value === undefined || typeof value === "symbol" || typeof value === "bigint" ? Number.NaN : Number(value); }
/** Node's `fs` refuses a descriptor that is not a non-negative 32-bit integer before it asks Linux. */
function checkDescriptor(fd: unknown): void {
  if (typeof fd !== "number") throw invalidType("fd", "number", fd);
  if (!Number.isInteger(fd)) throw outOfRange("fd", "an integer", fd);
  if (fd < 0 || fd > 2_147_483_647) throw outOfRange("fd", ">= 0 && <= 2147483647", fd);
}

/**
 * Release the text after `fs.write` wrote `n` bytes of it: `n` is a byte count, the text is cut by characters, and a
 * write that ended inside a multi-byte character is backed up to the start of that character.
 */
function releaseText(text: string, len: number, written: unknown): { readonly text: string; readonly len: number } {
  const byteLength = Buffer.byteLength(text);
  let n = count(written, byteLength);
  if (byteLength !== n) {
    const buf = Buffer.from(text);
    while (n > 0 && ((buf[n] ?? 0) & 0xc0) === 0x80) n--;
    n = buf.toString("utf8", 0, n).length;
  }
  return { len: Math.max(len - n, 0), text: text.slice(n) };
}
function mergeBuf(bufs: readonly Buffer[] | undefined, len: number | undefined): Buffer {
  // The original reads `bufs.length` of a list it has already shifted away.
  if (bufs === undefined) throw new TypeError("Cannot read properties of undefined (reading 'length')");
  if (bufs.length === 0) return kEmptyBuffer;
  const [only] = bufs;
  if (bufs.length === 1 && only !== undefined) return only;
  return Buffer.concat([...bufs], len);
}

export class Utf8StreamCore {
  #len = 0;
  #fd: unknown = -1;
  #texts: string[] = [];
  #groups: Buffer[][] = [];
  #lens: number[] = [];
  #writing = false;
  #ending = false;
  #reopening = false;
  #asyncDrainScheduled = false;
  #flushPending = false;
  #file: unknown = null;
  #destroyed = false;
  #opening = false;
  #periodicFlushTimer: Utf8StreamTimer | undefined;
  #writingText = "";
  #writingBytes: Buffer = kEmptyBuffer;
  readonly #settings: Utf8StreamSettings;
  readonly #binary: boolean;
  readonly #fs: Readonly<Record<string, unknown>>;
  readonly #ports: Utf8StreamScheduling;
  readonly #stream: Utf8StreamHost;

  /** The constructor of the original from the point where its options are validated. */
  constructor(ports: Utf8StreamScheduling, stream: Utf8StreamHost, settings: Utf8StreamSettings) {
    this.#ports = ports; this.#stream = stream; this.#settings = settings; this.#fs = settings.fs; this.#binary = settings.binary;
    const { fd } = settings;
    if (typeof fd === "number") {
      this.#fd = fd;
      ports.nextTick(() => { stream.emit("ready"); });
    } else if (typeof fd === "string") {
      this.#openFile(fd);
    } else {
      throw Object.assign(new TypeError(invalidType("fd", "number", fd).message.replace("must be of type number.", "must be one of type number or string.")), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if (settings.minLength >= settings.maxWrite) {
      throw Object.assign(new RangeError(`The argument 'minLength' should be smaller than maxWrite (${String(settings.maxWrite)}). Received ${String(settings.minLength)}`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    stream.on("newListener", name => { if (name === "drain") this.#asyncDrainScheduled = false; });
    if (settings.periodicFlush !== 0) {
      // The original passes null, which its own flush refuses: every period ends in an uncaught ERR_INVALID_ARG_TYPE.
      this.#periodicFlushTimer = ports.timers.setInterval(() => { stream.flush(null); }, settings.periodicFlush);
      this.#periodicFlushTimer.unref();
    }
  }

  get mode(): unknown { return this.#settings.mode; }
  get file(): unknown { return this.#file; }
  get fd(): unknown { return this.#fd; }
  get minLength(): number { return this.#settings.minLength; }
  get maxLength(): number { return this.#settings.maxLength; }
  get writing(): boolean { return this.#writing; }
  get sync(): boolean { return this.#settings.sync; }
  get fsync(): boolean { return this.#settings.fsync; }
  get append(): boolean { return this.#settings.append; }
  get periodicFlush(): number { return this.#settings.periodicFlush; }
  get contentMode(): "buffer" | "utf8" { return this.#binary ? "buffer" : "utf8"; }
  get mkdir(): boolean { return this.#settings.mkdir; }

  write(data: unknown): boolean { return this.#binary ? this.#writeBuffer(data) : this.#writeUtf8(data); }
  flush(cb: unknown): void {
    validateFunction(cb, "cb");
    if (this.#destroyed) { cb(invalidState("Utf8Stream is destroyed")); return; }
    if (this.#settings.minLength <= 0) { cb(); return; }
    this.#callFlushCallbackOnDrain(cb);
    if (this.#writing) return;
    if (this.#binary) {
      if (this.#groups.length === 0) { this.#groups.push([]); this.#lens.push(0); }
    } else if (this.#texts.length === 0) this.#texts.push("");
    this.#actualWrite();
  }
  flushSync(): void { if (this.#binary) this.#flushBufferSync(); else this.#flushSyncUtf8(); }

  reopen(file: unknown): void {
    if (this.#destroyed) throw invalidState("Utf8Stream is destroyed");
    if (this.#opening) { this.#stream.once("ready", () => { this.#stream.reopen(file); }); return; }
    if (this.#ending) return;
    if (!truthy(this.#file)) throw Object.assign(new Error("Operation failed: Unable to reopen a file descriptor, you must pass a file to SonicBoom"), { code: "ERR_OPERATION_FAILED" });
    if (truthy(file)) this.#file = file;
    this.#reopening = true;
    if (this.#writing) return;
    const fd = this.#fd;
    this.#stream.once("ready", () => {
      if (fd !== this.#fd) this.#later("close", [fd], err => { if (truthy(err)) this.#stream.emit("error", err); });
    });
    this.#openFile(this.#file);
  }

  end(): void {
    if (this.#destroyed) throw invalidState("Utf8Stream is destroyed");
    if (this.#opening) { this.#stream.once("ready", () => { this.#stream.end(); }); return; }
    if (this.#ending) return;
    this.#ending = true;
    if (this.#writing) return;
    if (this.#len > 0 && descriptorNumber(this.#fd) >= 0) this.#actualWrite();
    else this.#actualClose();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#actualClose();
  }

  // ---- the file operations ------------------------------------------------------------------------------------------

  /** Whether the operation is the process's own `fs`, and not one the program passed in `options.fs`. */
  #own(name: string): boolean { return this.#fs[name] === Reflect.get(this.#ports.fs, name); }
  /**
   * The argument list for the process's own `fs`. Node's stream passes the encoding where `fs.write` takes the position,
   * which Node's `fs` reads as "the current position"; the file service wants that said. A mode in octal text is the
   * number, and a bad descriptor is refused in Node's words.
   */
  #ownArguments(name: string, args: readonly unknown[]): readonly unknown[] {
    if (name === "write" || name === "writeSync" || name === "fsync" || name === "fsyncSync" || name === "close") checkDescriptor(args[0]);
    if ((name === "write" || name === "writeSync") && typeof args[1] === "string") return [args[0], args[1], null, "utf8"];
    if ((name === "open" || name === "openSync") && typeof args[2] === "string" && /^[0-7]+$/u.test(args[2])) return [args[0], args[1], Number.parseInt(args[2], 8)];
    return args;
  }
  #invoke(name: string, args: readonly unknown[]): unknown {
    const operation = this.#fs[name];
    if (typeof operation !== "function") throw new TypeError(`this.#fs.${name} is not a function`);
    const result: unknown = Reflect.apply(operation, this.#fs, [...args]);
    return result;
  }
  #now(name: string, args: readonly unknown[]): unknown { return this.#invoke(name, this.#own(name) ? this.#ownArguments(name, args) : args); }
  /** An asynchronous operation. The process's own `fs` is held open until the callback has run; what a program's own
   * `fs` keeps alive is its business, as in Node. */
  #later(name: string, args: readonly unknown[], done: (...results: unknown[]) => void): void {
    if (!this.#own(name)) { this.#invoke(name, [...args, done]); return; }
    const own = this.#ownArguments(name, args);
    const release = this.#ports.retain();
    try { this.#invoke(name, [...own, (...results: unknown[]): void => { try { done(...results); } finally { release(); } }]); }
    catch (error) { release(); throw error; }
  }
  #writingLength(): number { return this.#binary ? this.#writingBytes.length : this.#writingText.length; }
  #released(written: unknown): void {
    if (this.#binary) {
      const n = count(written, Number.NaN);
      this.#len = Math.max(this.#len - n, 0);
      this.#writingBytes = this.#writingBytes.slice(Number.isNaN(n) ? 0 : n);
    } else {
      const released = releaseText(this.#writingText, this.#len, written);
      this.#len = released.len; this.#writingText = released.text;
    }
  }
  #fsWriteSync(): unknown { return this.#now("writeSync", this.#binary ? [this.#fd, this.#writingBytes] : [this.#fd, this.#writingText, "utf8"]); }
  #fsWrite(): void {
    this.#later("write", this.#binary ? [this.#fd, this.#writingBytes] : [this.#fd, this.#writingText, "utf8"], (err, n) => { this.#release(err, n); });
  }
  #retry(err: unknown, writing: number): boolean { return truthy(this.#settings.retryEAGAIN(err, writing, this.#len - writing)); }

  // ---- the state machine --------------------------------------------------------------------------------------------

  #release(err: unknown, n?: unknown): void {
    if (truthy(err)) {
      const code = codeOf(err);
      if ((code === "EAGAIN" || code === "EBUSY") && this.#retry(err, this.#writingLength())) {
        if (this.#settings.sync) {
          // This error code should not happen in sync mode, because it is not using the underlining operating system
          // asynchronous functions. However it happens, and so we handle it. Ref: https://github.com/pinojs/pino/issues/783
          try {
            this.#ports.sleep(BUSY_WRITE_TIMEOUT);
            this.#release(undefined, 0);
          } catch (error) {
            this.#release(error);
          }
        } else {
          // Let's give the destination some time to process the chunk.
          this.#ports.timers.setTimeout(() => { this.#fsWrite(); }, BUSY_WRITE_TIMEOUT);
        }
      } else {
        this.#writing = false;
        this.#stream.emit("error", err);
      }
      return;
    }

    this.#stream.emit("write", n);
    this.#released(n);

    if (this.#writingLength() !== 0) {
      if (!this.#settings.sync) { this.#fsWrite(); return; }
      try {
        do { this.#released(this.#fsWriteSync()); } while (this.#writingLength() !== 0);
      } catch (error) {
        this.#release(error);
        return;
      }
    }

    if (this.#settings.fsync) this.#now("fsyncSync", [this.#fd]);

    const len = this.#len;
    if (this.#reopening) {
      this.#writing = false;
      this.#reopening = false;
      this.#stream.reopen();
    } else if (len > this.#settings.minLength) {
      this.#actualWrite();
    } else if (this.#ending) {
      if (len > 0) this.#actualWrite();
      else { this.#writing = false; this.#actualClose(); }
    } else {
      this.#writing = false;
      if (this.#settings.sync) {
        if (!this.#asyncDrainScheduled) {
          this.#asyncDrainScheduled = true;
          this.#ports.nextTick(() => { this.#emitDrain(); });
        }
      } else {
        this.#stream.emit("drain");
      }
    }
  }

  #openFile(file: unknown): void {
    this.#opening = true;
    this.#writing = true;
    this.#asyncDrainScheduled = false;
    const { sync } = this.#settings, stream = this.#stream;

    // NOTE: 'error' and 'ready' events emitted below only relevant when sonic.sync===false
    // for sync mode, there is no way to add a listener that will receive these
    const fileOpened = (err: unknown, fd?: unknown): void => {
      if (truthy(err)) {
        this.#reopening = false;
        this.#writing = false;
        this.#opening = false;
        if (sync) this.#ports.nextTick(() => { if (stream.listenerCount("error") > 0) stream.emit("error", err); });
        else stream.emit("error", err);
        return;
      }
      const reopening = this.#reopening;
      this.#fd = fd;
      this.#file = file;
      this.#reopening = false;
      this.#opening = false;
      this.#writing = false;
      if (sync) this.#ports.nextTick(() => { stream.emit("ready"); });
      else stream.emit("ready");
      if (this.#destroyed) return;
      // start. A 'ready' listener may have started a write in the meantime.
      if ((!this.writing && this.#len > this.#settings.minLength) || this.#flushPending) this.#actualWrite();
      else if (reopening) this.#ports.nextTick(() => { stream.emit("drain"); });
    };

    const flags = this.#settings.append ? "a" : "w", mode = this.#settings.mode;
    if (sync) {
      try {
        if (this.#settings.mkdir) this.#now("mkdirSync", [this.#ports.dirname(file), { recursive: true }]);
        fileOpened(null, this.#now("openSync", [file, flags, mode]));
      } catch (error) {
        fileOpened(error);
        throw error;
      }
    } else if (this.#settings.mkdir) {
      this.#later("mkdir", [this.#ports.dirname(file), { recursive: true }], err => {
        if (truthy(err)) { fileOpened(err); return; }
        this.#later("open", [file, flags, mode], fileOpened);
      });
    } else {
      this.#later("open", [file, flags, mode], fileOpened);
    }
  }

  #emitDrain(): void {
    if (this.#stream.listenerCount("drain") <= 0) return;
    this.#asyncDrainScheduled = false;
    this.#stream.emit("drain");
  }

  #actualClose(): void {
    if (this.#fd === -1) {
      this.#stream.once("ready", () => { this.#actualClose(); });
      return;
    }
    if (this.#periodicFlushTimer !== undefined) this.#ports.timers.clearInterval(this.#periodicFlushTimer);
    this.#destroyed = true;
    this.#texts = [];
    this.#groups = [];
    this.#lens = [];

    const done = (err?: unknown): void => {
      if (truthy(err)) { this.#stream.emit("error", err); return; }
      if (this.#ending && !this.#writing) this.#stream.emit("finish");
      this.#stream.emit("close");
    };
    const closeWrapped = (): void => {
      // We skip errors in fsync
      if (this.#fd !== 1 && this.#fd !== 2) this.#later("close", [this.#fd], done);
      else done();
    };
    try {
      this.#later("fsync", [this.#fd], closeWrapped);
    } catch {
      // Intentionally empty.
    }
  }

  #actualWrite(): void {
    this.#writing = true;
    if (this.#binary) {
      if (this.#writingBytes.length === 0) this.#writingBytes = mergeBuf(this.#groups.shift(), this.#lens.shift());
    } else if (this.#writingText === "") this.#writingText = this.#texts.shift() ?? "";

    if (this.#settings.sync) {
      try {
        const written = this.#fsWriteSync();
        this.#release(null, written);
      } catch (error) {
        this.#release(error);
      }
    } else {
      // fs.write will need to copy string to buffer anyway so we do it here to avoid the overhead of calculating the
      // buffer size in releaseWritingBuf.
      if (this.#binary) this.#writingBytes = Buffer.from(this.#writingBytes);
      this.#fsWrite();
    }
  }

  #checkFlushSync(): void {
    if (this.#destroyed) throw invalidState("Utf8Stream is destroyed");
    if (descriptorNumber(this.#fd) < 0) throw invalidState("Invalid file descriptor");
  }
  /** A refused write that is not retried is thrown; every other failure waits and tries again, as in the original. */
  #flushSyncFailure(err: unknown, pending: number): void {
    const code = codeOf(err);
    if ((code === "EAGAIN" || code === "EBUSY") && !this.#retry(err, pending)) throw err;
    this.#ports.sleep(BUSY_WRITE_TIMEOUT);
  }

  #flushBufferSync(): void {
    this.#checkFlushSync();
    if (!this.#writing && this.#writingBytes.length > 0) {
      this.#groups.unshift([this.#writingBytes]);
      this.#writingBytes = kEmptyBuffer;
    }
    let buf: Buffer = kEmptyBuffer;
    while (this.#groups.length !== 0 || buf.length !== 0) {
      if (buf.length <= 0) buf = mergeBuf(this.#groups[0], this.#lens[0]);
      try {
        const n = count(this.#now("writeSync", [this.#fd, buf]), Number.NaN);
        buf = buf.slice(Number.isNaN(n) ? 0 : n);
        this.#len = Math.max(this.#len - n, 0);
        if (buf.length <= 0) { this.#groups.shift(); this.#lens.shift(); }
      } catch (error) {
        this.#flushSyncFailure(error, buf.length);
      }
    }
  }

  #flushSyncUtf8(): void {
    this.#checkFlushSync();
    if (!this.#writing && this.#writingText.length > 0) {
      this.#texts.unshift(this.#writingText);
      this.#writingText = "";
    }
    let buf = "";
    while (this.#texts.length !== 0 || buf !== "") {
      if (buf.length <= 0) buf = this.#texts[0] ?? "";
      try {
        const released = releaseText(buf, this.#len, this.#now("writeSync", [this.#fd, buf, "utf8"]));
        buf = released.text;
        this.#len = released.len;
        if (buf.length <= 0) this.#texts.shift();
      } catch (error) {
        this.#flushSyncFailure(error, buf.length);
      }
    }
    try {
      this.#now("fsyncSync", [this.#fd]);
    } catch {
      // Skip the error. The fd might not support fsync.
    }
  }

  #callFlushCallbackOnDrain(cb: (...args: unknown[]) => unknown): void {
    this.#flushPending = true;
    const onDrain = (): void => {
      // Only if _fsync is false to avoid double fsync
      if (!this.#settings.fsync && !this.#destroyed) {
        try {
          this.#later("fsync", [this.#fd], err => {
            this.#flushPending = false;
            // If the fd is closed, we ignore the error.
            if (codeOf(err) === "EBADF") { cb(); return; }
            cb(err);
          });
        } catch (error) {
          this.#flushPending = false;
          cb(error);
        }
      } else {
        this.#flushPending = false;
        cb();
      }
      this.#stream.removeListener("error", onError);
    };
    const onError = (err: unknown): void => {
      this.#flushPending = false;
      cb(err);
      this.#stream.removeListener("drain", onDrain);
    };
    this.#stream.once("drain", onDrain);
    this.#stream.once("error", onError);
  }

  #writeBuffer(data: unknown): boolean {
    if (this.#destroyed) throw invalidState("Utf8Stream is destroyed");
    if (!Buffer.isBuffer(data)) throw invalidInstance("data", "Buffer", data);
    const { maxLength, maxWrite, minLength, hwm } = this.#settings;
    const len = this.#len + data.length, bufs = this.#groups, lens = this.#lens;
    if (maxLength !== 0 && len > maxLength) {
      this.#stream.emit("drop", data);
      return this.#len < hwm;
    }
    const last = lens.length - 1;
    if (bufs.length === 0 || (lens[last] ?? Number.NaN) + data.length > maxWrite) {
      // The original starts the new group without the chunk that opened it: those bytes are counted and never written.
      bufs.push([]);
      lens.push(data.length);
    } else {
      bufs[bufs.length - 1]?.push(data);
      lens[last] = (lens[last] ?? Number.NaN) + data.length;
    }
    this.#len = len;
    if (!this.#writing && this.#len >= minLength) this.#actualWrite();
    return this.#len < hwm;
  }

  #writeUtf8(data: unknown): boolean {
    if (this.#destroyed) throw invalidState("Utf8Stream is destroyed");
    validateString(data, "data");
    const { maxLength, maxWrite, minLength, hwm } = this.#settings;
    const len = this.#len + data.length, bufs = this.#texts;
    if (maxLength !== 0 && len > maxLength) {
      this.#stream.emit("drop", data);
      return this.#len < hwm;
    }
    const last = bufs.length - 1, tail = bufs[last];
    if (tail === undefined || tail.length + data.length > maxWrite) bufs.push(data);
    else bufs[last] = tail + data;
    this.#len = len;
    if (!this.#writing && this.#len >= minLength) this.#actualWrite();
    return this.#len < hwm;
  }
}
