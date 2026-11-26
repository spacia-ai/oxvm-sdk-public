/*!
 * The class surface of Node.js v24.18.1 lib/internal/streams/fast-utf8-stream.js (`fs.Utf8Stream`), which is derived
 * from the SonicBoom module (https://github.com/pinojs/sonic-boom).
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
import { FILE_OPERATIONS, Utf8StreamCore, type Utf8StreamHost, type Utf8StreamScheduling } from "./node-files-utf8-core.ts";
import { readUtf8StreamOptions, validateUtf8StreamOptions } from "./node-files-utf8-options.ts";
import { named } from "./node-util-validators.ts";

export type { Utf8StreamFiles } from "./node-files-utf8-core.ts";

/** The events of an EventEmitter that the stream uses. */
export interface Utf8StreamEmitter {
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
}
export interface Utf8StreamPorts extends Omit<Utf8StreamScheduling, "sleep"> {
  /** The class `require("events")` answers: the stream extends it. */
  readonly EventEmitter: new () => Utf8StreamEmitter;
  /** Blocks the thread for the retry of a synchronous write. Without it the thread waits on `Atomics.wait`. */
  readonly sleep?: (milliseconds: number) => void;
}
/** A stream as programs see it; the events come from the EventEmitter it extends. */
export interface NodeUtf8Stream extends Utf8StreamEmitter {
  write(data: unknown): boolean;
  flush(cb?: unknown): void;
  flushSync(): void;
  reopen(file?: unknown): void;
  end(): void;
  destroy(): void;
  readonly mode: unknown; readonly file: unknown; readonly fd: unknown; readonly minLength: number; readonly maxLength: number; readonly writing: boolean;
  readonly sync: boolean; readonly fsync: boolean; readonly append: boolean; readonly periodicFlush: number; readonly contentMode: "buffer" | "utf8"; readonly mkdir: boolean;
  [Symbol.dispose](): void;
}
export type NodeUtf8StreamClass = new (options?: unknown) => NodeUtf8Stream;

/** Node's internal `sleep`: the thread waits on a word nobody wakes. */
function atomicSleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
const kNullPrototype: unknown = Object.create(null);

/**
 * Node's `fs.Utf8Stream` (SonicBoom) over the process's own `fs` operations. Linux owns the files: the stream only
 * decides when to call `open`, `write`, `fsync` and `close`, exactly as Node's does.
 */
export function createNodeUtf8Stream(ports: Utf8StreamPorts): { readonly Utf8Stream: NodeUtf8StreamClass } {
  const scheduling: Utf8StreamScheduling = { fs: ports.fs, timers: ports.timers, nextTick: ports.nextTick, retain: ports.retain, dirname: ports.dirname, sleep: ports.sleep ?? atomicSleep };
  /** The operations a stream starts from; a program's `options.fs` is laid over them. */
  const files = (): Record<string, unknown> => Object.fromEntries(FILE_OPERATIONS.map(name => [name, ports.fs[name]]));
  // The state lives beside the object, as the private fields of Node's class do: the stream has no own property but the emitter's.
  const cores = new WeakMap<object, Utf8StreamCore>();
  const core = (stream: object): Utf8StreamCore => {
    const found = cores.get(stream);
    if (found === undefined) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return found;
  };
  class Utf8Stream extends ports.EventEmitter implements Utf8StreamHost {
    constructor(options: unknown = kNullPrototype) {
      const read = readUtf8StreamOptions(options);
      super();
      cores.set(this, new Utf8StreamCore(scheduling, this, validateUtf8StreamOptions(read, files())));
    }
    write(data: unknown): boolean { return core(this).write(data); }
    flush(cb: unknown = function (): void { /* Node's default callback does nothing. */ }): void { core(this).flush(cb); }
    flushSync(): void { core(this).flushSync(); }
    reopen(file: unknown): void { core(this).reopen(file); }
    end(): void { core(this).end(); }
    destroy(): void { core(this).destroy(); }
    get mode(): unknown { return core(this).mode; }
    get file(): unknown { return core(this).file; }
    get fd(): unknown { return core(this).fd; }
    get minLength(): number { return core(this).minLength; }
    get maxLength(): number { return core(this).maxLength; }
    get writing(): boolean { return core(this).writing; }
    get sync(): boolean { return core(this).sync; }
    get fsync(): boolean { return core(this).fsync; }
    get append(): boolean { return core(this).append; }
    get periodicFlush(): number { return core(this).periodicFlush; }
    get contentMode(): "buffer" | "utf8" { return core(this).contentMode; }
    get mkdir(): boolean { return core(this).mkdir; }
    [Symbol.dispose](): void { this.destroy(); }
  }
  // The bundle renames classes; programs read this one's name.
  return { Utf8Stream: named(Utf8Stream, "Utf8Stream") };
}
