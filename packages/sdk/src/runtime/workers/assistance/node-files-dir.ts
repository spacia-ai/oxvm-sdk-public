/// <reference lib="esnext.disposable" />
/*!
 * `fs.Dir`, `fs.opendir`, `fs.opendirSync` and `fs.promises.opendir`, adapted from Node.js v24.18.1 lib/internal/fs/dir.js.
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
import { Dirent } from "./node-file-operations.js";
import { codeError, encodedName, encodingOptions, failureOf, reissued, shaped, systemError, validatedPath, type EncodingName, type FileScheduling } from "./node-files-args.ts";
import { createNodePath } from "./node-path.js";
import { invalidType, named, outOfRange, validateFunction } from "./node-util-validators.ts";

/** What a directory is read through: the runtime's own `readdir` with file types, in both forms. Linux answers one
 * whole listing per directory (the file service has no `getdents` cursor), so a `Dir` is a snapshot taken at open. */
export interface DirectoryPorts extends FileScheduling {
  readonly readdirSync: (path: string, options: { readonly withFileTypes: true }) => unknown;
  readonly readdir: (path: string, options: { readonly withFileTypes: true }) => Promise<unknown>;
}

const join = createNodePath(() => "/").join;
const closedError = (): Error => codeError(Error, "ERR_DIR_CLOSED", "Directory handle was closed");
const concurrentError = (): Error => codeError(Error, "ERR_DIR_CONCURRENT_OPERATION", "Cannot do synchronous work on directory handle with concurrent asynchronous operations");

function typeOf(entry: Dirent): number {
  return entry.isFile() ? 8 : entry.isDirectory() ? 4 : entry.isSymbolicLink() ? 10 : entry.isBlockDevice() ? 6 : entry.isCharacterDevice() ? 2 : entry.isFIFO() ? 1 : entry.isSocket() ? 12 : 0;
}
/** One directory's entries as Node's `Dirent`s under `parent`, with the names in the asked encoding. */
function entriesOf(listed: unknown, parent: string | Uint8Array, encoding: EncodingName | null): Dirent[] {
  if (!Array.isArray(listed)) throw new TypeError("Invalid directory listing");
  return listed.map((item: unknown) => {
    if (!(item instanceof Dirent)) throw new TypeError("Invalid directory entry");
    const name = encodedName(item.name, encoding);
    if (typeof name === "string" && typeof parent === "string") return new Dirent(name, typeOf(item), parent);
    // A Buffer name or parent is kept as Node keeps it; the class declares the usual strings.
    const entry = new Dirent(item.name, typeOf(item), "");
    Reflect.set(entry, "name", name); Reflect.set(entry, "parentPath", parent);
    return entry;
  });
}

/** Node's native directory handle: a cursor over one listing. */
class Listing {
  #offset = 0;
  constructor(private readonly entries: readonly Dirent[], readonly ports: DirectoryPorts) {}
  /** The next `count` entries, or null at the end. */
  read(count: number): Dirent[] | null {
    if (this.#offset >= this.entries.length) return null;
    const chunk = this.entries.slice(this.#offset, this.#offset + count);
    this.#offset += chunk.length;
    return chunk;
  }
}

type ReadCallback = (error: unknown, entry?: Dirent | null) => void;

export class Dir {
  readonly #handle: Listing;
  readonly #path: unknown;
  readonly #buffered: Dirent[] = [];
  #closed = false;
  readonly #encoding: EncodingName | null;
  readonly #bufferSize: number;
  readonly #recursive: boolean;
  #operations: (() => void)[] | null = null;
  readonly #handlers: { readonly handle: Listing; readonly path: string }[] = [];
  declare [Symbol.asyncIterator]: () => AsyncGenerator<Dirent, void, undefined>;

  constructor(handle: unknown, path: unknown, options: unknown) {
    if (handle === null || handle === undefined) throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "handle" argument must be specified');
    // Node takes its native handle here; this layer's handles are made by opendir only.
    if (!(handle instanceof Listing)) throw invalidType("handle", "a directory handle opened by fs.opendir", handle);
    this.#handle = handle; this.#path = path;
    const selected = encodingOptions(options), bufferSize = selected.at("bufferSize") ?? 32;
    this.#encoding = selected.encoding; this.#recursive = Boolean(selected.at("recursive"));
    if (typeof bufferSize !== "number") throw invalidType("options.bufferSize", "number", bufferSize);
    if (!Number.isInteger(bufferSize)) throw outOfRange("options.bufferSize", "an integer", bufferSize);
    if (bufferSize < 1 || bufferSize > 4_294_967_295) throw outOfRange("options.bufferSize", ">= 1 && <= 4294967295", bufferSize);
    this.#bufferSize = bufferSize;
  }

  get path(): unknown {
    if (!(#path in this)) throw codeError(TypeError, "ERR_INVALID_THIS", 'Value of "this" must be of type Dir');
    return this.#path;
  }

  /** Moves entries of the sub-directories a recursive read has opened into the buffer; true when there is one to hand out. */
  #drainHandlers(): boolean {
    while (this.#handlers.length > 0) {
      const handler = this.#handlers.shift();
      if (handler === undefined) break;
      const result = handler.handle.read(this.#bufferSize);
      if (result !== null) { this.#buffered.push(...result); if (result.length > 0) this.#handlers.push(handler); }
      if (this.#buffered.length > 0) break;
    }
    return this.#buffered.length > 0;
  }
  /** The next buffered entry; a directory met by a recursive read is opened here, synchronously, as Node opens it. */
  #take(): Dirent | undefined {
    const entry = this.#buffered.shift();
    if (entry !== undefined && this.#recursive && entry.isDirectory()) {
      const parent: unknown = entry.parentPath, name: unknown = entry.name;
      if (typeof parent !== "string") throw invalidType("path", "string", parent);
      if (typeof name !== "string") throw invalidType("path", "string", name);
      const path = join(parent, name);
      let listed: unknown;
      try { listed = this.#handle.ports.readdirSync(path, { withFileTypes: true }); }
      catch (error) { throw reissued(error, "opendir"); }
      this.#handlers.push({ handle: new Listing(entriesOf(listed, path, this.#encoding), this.#handle.ports), path });
    }
    return entry;
  }
  #tick(callback: () => void): void { (this.#handle.ports.nextTick ?? this.#handle.ports.dispatch)(callback); }

  #readPromised(): Promise<Dirent | null> {
    return new Promise((resolve, reject) => { this.#readImpl(false, (error: unknown, entry?: Dirent | null) => { if (error !== null && error !== undefined) reject(failureOf(error)); else resolve(entry ?? null); }); });
  }
  #closePromised(): Promise<void> {
    return new Promise((resolve, reject) => { this.close((error: unknown) => { if (error !== null && error !== undefined) reject(failureOf(error)); else resolve(); }); });
  }

  read(callback?: unknown): unknown {
    if (callback === undefined) return this.#readPromised();
    this.#readImpl(true, callback);
    return undefined;
  }
  #readImpl(maybeSync: boolean, callback: unknown): void {
    if (this.#closed) throw closedError();
    validateFunction(callback, "callback");
    const done: ReadCallback = (error, entry) => { Reflect.apply(callback, undefined, entry === undefined ? [error] : [error, entry]); };
    if (this.#operations !== null) { this.#operations.push(() => { this.#readImpl(maybeSync, callback); }); return; }
    if (this.#drainHandlers()) {
      try {
        const entry = this.#take() ?? null;
        if (maybeSync) this.#tick(() => { done(null, entry); }); else done(null, entry);
      } catch (error) { done(error); }
      return;
    }
    // Node asks its thread pool here; the listing is already held, so the answer only waits for a later turn, during
    // which the synchronous forms are refused and the asynchronous ones queue, as they do in Node.
    this.#operations = [];
    const ports = this.#handle.ports, release = ports.retain();
    ports.dispatch(() => {
      release();
      this.#tick(() => { const queue = this.#operations ?? []; this.#operations = null; for (const operation of queue) operation(); });
      const result = this.#handle.read(this.#bufferSize);
      if (result === null) { done(null, null); return; }
      try { this.#buffered.push(...result); done(null, this.#take() ?? null); }
      catch (error) { done(error); }
    });
  }

  readSync(): Dirent | null {
    if (this.#closed) throw closedError();
    if (this.#operations !== null) throw concurrentError();
    if (this.#drainHandlers()) return this.#take() ?? null;
    const result = this.#handle.read(this.#bufferSize);
    if (result === null) return null;
    this.#buffered.push(...result);
    return this.#take() ?? null;
  }

  close(callback?: unknown): unknown {
    if (callback === undefined) return this.#closed ? Promise.reject(closedError()) : this.#closePromised();
    validateFunction(callback, "callback");
    if (this.#closed) { this.#tick(() => { callback(closedError()); }); return undefined; }
    if (this.#operations !== null) { this.#operations.push(() => { this.close(callback); }); return undefined; }
    this.#handlers.length = 0; this.#closed = true;
    const ports = this.#handle.ports, release = ports.retain();
    ports.dispatch(() => { release(); callback(null); });
    return undefined;
  }

  closeSync(): void {
    if (this.#closed) throw closedError();
    if (this.#operations !== null) throw concurrentError();
    this.#handlers.length = 0; this.#closed = true;
  }

  async *entries(): AsyncGenerator<Dirent, void, undefined> {
    try {
      for (;;) {
        const entry = await this.#readPromised();
        if (entry === null) break;
        yield entry;
      }
    } finally { await this.#closePromised(); }
  }

  [Symbol.dispose](): void { if (!this.#closed) this.closeSync(); }
  async [Symbol.asyncDispose](): Promise<void> { if (!this.#closed) await this.#closePromised(); }
}
// The bundle renames classes; programs read this one's name.
named(Dir, "Dir");
Object.defineProperty(Dir.prototype, Symbol.asyncIterator, { enumerable: false, writable: true, configurable: true, value: Object.getOwnPropertyDescriptor(Dir.prototype, "entries")?.value });

export interface NodeDirectories {
  readonly Dir: typeof Dir;
  readonly opendir: (path: unknown, options: unknown, callback: unknown) => void;
  readonly opendirSync: (path: unknown, options: unknown) => Dir;
  readonly promises: { readonly opendir: (path: unknown, options?: unknown) => Promise<Dir> };
}

export function createNodeDirectories(ports: DirectoryPorts): NodeDirectories {
  const opened = (listed: unknown, path: string | Uint8Array, options: unknown): Dir =>
    new Dir(new Listing(entriesOf(listed, path, encodingOptions(options).encoding), ports), path, options);
  /** Opens after the arguments are known to be valid; the answer is delivered as the process delivers callbacks. */
  function start(path: unknown, options: unknown, callback: (error: unknown, directory?: Dir) => void): void {
    const target = validatedPath(path), selected = typeof options === "function" ? undefined : options;
    encodingOptions(selected);
    const release = ports.retain();
    const finish = (deliver: () => void): void => { ports.dispatch(() => { release(); deliver(); }); };
    const listing = target.text === "" ? Promise.reject(systemError("ENOENT", "opendir", target.text)) : ports.readdir(target.text, { withFileTypes: true });
    listing.then(
      listed => { finish(() => { callback(null, opened(listed, target.given, selected)); }); },
      (error: unknown) => { finish(() => { callback(reissued(error, "opendir", target.text)); }); },
    );
  }
  const opendir = named(function (path: unknown, options: unknown, callback: unknown): void {
    const done = typeof options === "function" ? options : callback;
    validateFunction(done, "callback");
    start(path, options, (error, directory) => { Reflect.apply(done, undefined, directory === undefined ? [error] : [null, directory]); });
  }, "opendir");
  const opendirSync = named(function (path: unknown, options: unknown): Dir {
    const target = validatedPath(path);
    encodingOptions(options);
    let listed: unknown;
    // Node's synchronous form reports the failure without the path.
    try { listed = ports.readdirSync(target.text, { withFileTypes: true }); }
    catch (error) { throw reissued(error, "opendir"); }
    return opened(listed, target.given, options);
  }, "opendirSync");
  // Node's is `promisify(opendir)`, which keeps the three parameters.
  const promised = shaped(function (path: unknown, options: unknown): Promise<Dir> {
    return new Promise((resolve, reject) => {
      start(path, options, (error, directory) => { if (directory !== undefined) resolve(directory); else reject(failureOf(error)); });
    });
  }, "opendir", 3);
  return { Dir, opendir, opendirSync, promises: { opendir: promised } };
}
