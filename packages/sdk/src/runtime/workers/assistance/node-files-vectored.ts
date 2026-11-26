/// <reference lib="esnext.disposable" />
import { codeError, systemError, type FileScheduling } from "./node-files-args.ts";
import { invalidType, named, outOfRange, validateFunction } from "./node-util-validators.ts";

/** The positional reads and writes `readv` and `writev` loop over: the runtime's `readSync`/`writeSync` and the
 * callback `read`/`write`. No vectored Linux operation exists, so a vector is several operations and not one atomic
 * `readv(2)`/`writev(2)`: another writer to the same file can interleave between two of its buffers. */
export interface VectoredPorts extends FileScheduling {
  readonly readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => number;
  readonly writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => number;
  readonly read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: (error: unknown, count?: unknown) => void) => void;
  readonly write: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: (error: unknown, count?: unknown) => void) => void;
  /** The caller's async context, kept for the callback. */
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
}

/** Node's `getValidatedFd`. */
function validatedFd(fd: unknown): number {
  if (typeof fd !== "number") throw invalidType("fd", "number", fd);
  if (!Number.isInteger(fd)) throw outOfRange("fd", "an integer", fd);
  if (fd < 0 || fd > 2_147_483_647) throw outOfRange("fd", ">= 0 && <= 2147483647", fd);
  return fd;
}
/** Node's `validateBufferArray`; each view is answered as the bytes it covers. */
function bufferArray(buffers: unknown): Uint8Array[] {
  if (Array.isArray(buffers) && buffers.every((item: unknown): item is ArrayBufferView => ArrayBuffer.isView(item))) {
    return buffers.map(view => view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  const base = invalidType("buffers", "x", buffers).message;
  throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "buffers" argument must be an ArrayBufferView[].${base.slice(base.indexOf(" Received "))}`);
}
const positionOf = (position: unknown): number | null => typeof position === "number" ? position : null;
const failure = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

type Transfer = (bytes: Uint8Array, offset: number, length: number, position: number | null) => Promise<number>;
/** One vector over a positional operation: each buffer in turn, at the moving position or at the descriptor's own,
 * until one comes back short. */
async function vector(views: readonly Uint8Array[], start: number | null, transfer: Transfer): Promise<number> {
  let total = 0, position = start;
  for (const view of views) {
    let done = 0;
    while (done < view.length) {
      const count = await transfer(view, done, view.length - done, position);
      if (count === 0) return total + done;
      done += count; if (position !== null) position += count;
    }
    total += done;
  }
  return total;
}
function vectorSync(views: readonly Uint8Array[], start: number | null, transfer: (bytes: Uint8Array, offset: number, length: number, position: number | null) => number): number {
  let total = 0, position = start;
  for (const view of views) {
    let done = 0;
    while (done < view.length) {
      const count = transfer(view, done, view.length - done, position);
      if (count === 0) return total + done;
      done += count; if (position !== null) position += count;
    }
    total += done;
  }
  return total;
}

/** What a FileHandle of `fs.promises.open` must offer for the vectored forms. */
export interface PositionalHandle {
  read(buffer: unknown, offset: unknown, length: unknown, position?: unknown): Promise<{ readonly bytesRead: number }>;
  write(buffer: unknown, offset?: unknown, length?: unknown, position?: unknown): Promise<{ readonly bytesWritten: number }>;
  close(): Promise<void>;
}
export interface VectoredHandle {
  readv(buffers: unknown, position: unknown): Promise<{ bytesRead: number; buffers: unknown }>;
  writev(buffers: unknown, position: unknown): Promise<{ bytesWritten: number; buffers: unknown }>;
  [Symbol.asyncDispose](): Promise<void>;
}
function extended<Handle extends PositionalHandle>(handle: Handle, additions: VectoredHandle): asserts handle is Handle & VectoredHandle {
  for (const key of Reflect.ownKeys(additions)) {
    Object.defineProperty(handle, key, { value: Reflect.get(additions, key), writable: true, configurable: true, enumerable: false });
  }
}
/** Adds Node's `readv`, `writev` and `[Symbol.asyncDispose]` to a FileHandle; they are prototype methods in Node, so
 * they are not enumerable here. */
export function withVectoredHandle<Handle extends PositionalHandle>(handle: Handle): Handle & VectoredHandle {
  const additions: VectoredHandle = {
    async readv(buffers: unknown, position: unknown) {
      const views = bufferArray(buffers);
      if (views.length === 0) throw systemError("EINVAL", "read");
      return { bytesRead: await vector(views, positionOf(position), async (bytes, offset, length, at) => (await handle.read(bytes, offset, length, at)).bytesRead), buffers };
    },
    async writev(buffers: unknown, position: unknown) {
      const views = bufferArray(buffers);
      if (views.length === 0) return { bytesWritten: 0, buffers };
      return { bytesWritten: await vector(views, positionOf(position), async (bytes, offset, length, at) => (await handle.write(bytes, offset, length, at)).bytesWritten), buffers };
    },
    async [Symbol.asyncDispose]() { await handle.close(); },
  };
  extended(handle, additions);
  return handle;
}

export interface NodeVectoredFiles {
  readonly readv: (fd: unknown, buffers: unknown, position: unknown, callback: unknown) => void;
  readonly readvSync: (fd: unknown, buffers: unknown, position: unknown) => number;
  readonly writev: (fd: unknown, buffers: unknown, position: unknown, callback: unknown) => void;
  readonly writevSync: (fd: unknown, buffers: unknown, position: unknown) => number;
}

export function createNodeVectoredFiles(ports: VectoredPorts): NodeVectoredFiles {
  const count = (value: unknown): number => typeof value === "number" ? value : 0;
  const promised = (operation: VectoredPorts["read"], fd: number): Transfer => (bytes, offset, length, position) =>
    new Promise((resolve, reject) => { operation(fd, bytes, offset, length, position, (error, value) => { if (error === null || error === undefined) resolve(count(value)); else reject(failure(error)); }); });
  /** Runs the vector while holding the process, then calls back from the process's queue in the caller's context. */
  function start(work: () => Promise<number>, done: (error: unknown, count: number) => void): void {
    const release = ports.retain(), run = ports.context?.capture() ?? (<Result>(inner: () => Result): Result => inner());
    const finish = (error: unknown, total: number): void => { ports.dispatch(() => { release(); run(() => { done(error, total); }); }); };
    work().then(total => { finish(null, total); }, (error: unknown) => { finish(error, 0); });
  }
  const readvSync = named(function (fd: unknown, buffers: unknown, position: unknown): number {
    const views = bufferArray(buffers), descriptor = validatedFd(fd);
    if (views.length === 0) throw systemError("EINVAL", "read");
    return vectorSync(views, positionOf(position), (bytes, offset, length, at) => ports.readSync(descriptor, bytes, offset, length, at));
  }, "readvSync");
  const writevSync = named(function (fd: unknown, buffers: unknown, position: unknown): number {
    const views = bufferArray(buffers);
    if (views.length === 0) return 0;
    const descriptor = validatedFd(fd);
    return vectorSync(views, positionOf(position), (bytes, offset, length, at) => ports.writeSync(descriptor, bytes, offset, length, at));
  }, "writevSync");
  const readv = named(function (fd: unknown, buffers: unknown, position: unknown, callback: unknown): void {
    const descriptor = validatedFd(fd), views = bufferArray(buffers), done = callback === undefined || callback === null ? position : callback;
    validateFunction(done, "cb");
    start(() => views.length === 0 ? Promise.reject(systemError("EINVAL", "read")) : vector(views, positionOf(position), promised(ports.read, descriptor)),
      (error, total) => { done(error, total, buffers); });
  }, "readv");
  const writev = named(function (fd: unknown, buffers: unknown, position: unknown, callback: unknown): void {
    const descriptor = validatedFd(fd), views = bufferArray(buffers), done = callback === undefined || callback === null ? position : callback;
    validateFunction(done, "cb");
    if (views.length === 0) { (ports.nextTick ?? ports.dispatch)(() => { done(null, 0, buffers); }); return; }
    start(() => vector(views, positionOf(position), promised(ports.write, descriptor)), (error, total) => { done(error, total, buffers); });
  }, "writev");
  return { readv, readvSync, writev, writevSync };
}
