/*!
 * `fs.watchFile`, `fs.unwatchFile`, `StatWatcher` and `fs.promises.watch`, adapted from Node.js v24.18.1 lib/fs.js and
 * lib/internal/fs/watchers.js; the polling rules are libuv's `uv_fs_poll` (src/fs-poll.c, MIT License).
 * Copyright Node.js contributors. All rights reserved. MIT License: see node-files-dir.ts for the full text.
 */
import { Buffer } from "buffer";
import { codeError, errorCode, validatedPath, invalidOneOf, type FileScheduling } from "./node-files-args.ts";
import { matchesGlob } from "./node-files-glob-pattern.ts";
import { createNodePath } from "./node-path.js";
import { BigIntStats, statsOf, type Stats } from "./node-stats.ts";
import { EventEmitter } from "./node-streams.js";
import { SYSTEM_ERROR_NUMBERS } from "./node-system-errors.ts";
import { invalidType, invalidValue, named, outOfRange, validateAbortSignal, validateBoolean, validateFunction, validateInteger, validateObject } from "./node-util-validators.ts";

/** A repeating timer of the process: `ref` makes it keep the process alive (the default) and `unref` stops that. */
export interface PollTimer { ref(): unknown; unref(): unknown }
/** A watcher of `fs.watch`: `change` carries the event type and the name, `error` an error. */
export interface ChangeWatcher {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close(): void;
}
export interface PollPorts extends FileScheduling {
  /** `fs.promises.stat(path, { bigint })`. */
  readonly stat: (path: string, options: { readonly bigint: boolean }) => Promise<Stats | BigIntStats>;
  /** The process's own interval timers, so that a persistent stat watcher keeps the process alive as a timer does. */
  readonly timers: { readonly setInterval: (callback: () => void, milliseconds: number) => PollTimer; readonly clearInterval: (timer: PollTimer) => void };
  /** `fs.watch(path, options)`. */
  readonly watch: (path: string, options: { readonly persistent: boolean; readonly recursive: boolean; readonly encoding: string }) => ChangeWatcher;
  readonly cwd: () => string;
  /** `process.emitWarning(message, type)`. */
  readonly warn?: (message: string, type: string) => void;
}

interface PollHandle { ref(): void; unref(): void; close(): void }
interface WatcherState { bigint: boolean; oldStatus: number; references: number; maximum: number }
const states = new WeakMap<object, WatcherState>();
function stateOf(watcher: object): WatcherState {
  const state = states.get(watcher);
  if (state === undefined) throw new TypeError("Illegal invocation");
  return state;
}

/** Node's `fs.StatWatcher`: what `watchFile` returns. It emits `change` with the current and the previous `Stats`. */
export class StatWatcher extends EventEmitter {
  _handle: PollHandle | null = null;
  declare start: () => void;
  declare stop: () => void;
  declare ref: () => this;
  declare unref: () => this;
  constructor(bigint: unknown) {
    super();
    states.set(this, { bigint: Boolean(bigint), oldStatus: -1, references: 1, maximum: 1 });
  }
}
named(StatWatcher, "StatWatcher");
// Node assigns these to the prototype, where they are enumerable and have no name.
const method = (name: string, value: (this: StatWatcher) => unknown): void => {
  Object.defineProperty(StatWatcher.prototype, name, { value: named(value, ""), writable: true, enumerable: true, configurable: true });
};
method("start", () => undefined);
method("stop", function () {
  const handle = this._handle;
  if (handle === null) return;
  handle.close();
  this._handle = null;
});
method("ref", function () {
  const state = stateOf(this);
  if (state.references === state.maximum) return this;
  if (this._handle !== null && state.references++ === 0) this._handle.ref();
  return this;
});
method("unref", function () {
  const state = stateOf(this);
  if (state.references === 0) return this;
  if (this._handle !== null && --state.references === 0) this._handle.unref();
  return this;
});

const zeroStats = (bigint: boolean): Stats | BigIntStats => bigint ? new BigIntStats(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n)
  : statsOf({ dev: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0, blksize: 0, ino: 0, size: 0, blocks: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0 });
/** libuv's `statbuf_eq`: the fields whose change counts as a change of the file. */
const COMPARED = ["ctimeNs", "mtimeNs", "birthtimeNs", "ctimeMs", "mtimeMs", "birthtimeMs", "size", "mode", "uid", "gid", "ino", "dev"];
const unchanged = (left: object, right: object): boolean => COMPARED.every(key => Reflect.get(left, key) === Reflect.get(right, key));

const callable = (value: unknown): value is (...args: unknown[]) => void => typeof value === "function";
class AbortError extends Error {
  readonly code = "ABORT_ERR";
  constructor(cause: unknown) { super("The operation was aborted", { cause }); this.name = "AbortError"; }
}
named(AbortError, "AbortError");

export interface NodeFilePolling {
  readonly watchFile: (filename: unknown, options: unknown, listener: unknown) => StatWatcher;
  readonly unwatchFile: (filename: unknown, listener: unknown) => void;
  readonly promises: { readonly watch: (filename: unknown, options?: unknown) => AsyncGenerator<{ eventType: unknown; filename: unknown }, void, undefined> };
}

export function createNodeFilePolling(ports: PollPorts): NodeFilePolling {
  const path = createNodePath(ports.cwd), watchers = new Map<string, StatWatcher>();
  const tick = ports.nextTick ?? ports.dispatch;
  const absolute = (filename: unknown): string => {
    const { given } = validatedPath(filename);
    // Node resolves the validated path, which refuses a Buffer.
    if (typeof given !== "string") throw invalidType("paths[0]", "string", given);
    return path.resolve(given);
  };

  /** libuv's `uv_fs_poll`: a stat now and one per interval. The first answer is only remembered; after that a change,
   * a failure that is new, and a success after a failure are reported, each with the last good status as "previous". */
  function start(watcher: StatWatcher, filename: string, persistent: boolean, interval: unknown): void {
    if (watcher._handle !== null) return;
    if (typeof interval !== "number") throw invalidType("interval", "number", interval);
    if (!Number.isInteger(interval)) throw outOfRange("interval", "an integer", interval);
    if (interval < 0 || interval > 4_294_967_295) throw outOfRange("interval", ">= 0 && <= 4294967295", interval);
    const state = stateOf(watcher);
    let busy = 0, previous = zeroStats(state.bigint), polling = false, closed = false;
    function changed(status: number, current: Stats | BigIntStats, before: Stats | BigIntStats): void {
      if (state.oldStatus === -1 && status === -1 && current.nlink === before.nlink) return;
      state.oldStatus = status;
      watcher.emit("change", current, before);
    }
    function poll(): void {
      if (polling || closed) return;
      polling = true;
      // The process stays alive until the answer has been delivered, also for a watcher that is not persistent.
      const release = ports.retain();
      const deliver = (work: () => void): void => { ports.dispatch(() => { release(); polling = false; if (!closed) work(); }); };
      ports.stat(filename, { bigint: state.bigint }).then(current => {
        deliver(() => {
          const report = busy !== 0 && (busy < 0 || !unchanged(previous, current)), before = previous;
          previous = current; busy = 1;
          if (report) changed(0, current, before);
        });
      }, (error: unknown) => {
        deliver(() => {
          const code = errorCode(error), errno = (code === undefined ? undefined : SYSTEM_ERROR_NUMBERS[code]) ?? -5;
          if (busy === errno) return;
          busy = errno;
          changed(errno, zeroStats(state.bigint), previous);
        });
      });
    }
    const timer = ports.timers.setInterval(poll, Math.max(1, interval));
    watcher._handle = { ref: () => { timer.ref(); }, unref: () => { timer.unref(); }, close: () => {
      closed = true; ports.timers.clearInterval(timer);
      tick(() => { watcher.emit("stop"); });
    } };
    if (!persistent) watcher.unref();
    state.oldStatus = -1;
    poll();
  }

  const watchFile = named(function (filename: unknown, options: unknown, listener: unknown): StatWatcher {
    const target = absolute(filename);
    const settings = options === null || typeof options !== "object" ? undefined : options, callback = settings === undefined ? options : listener;
    const at = (key: string, fallback: unknown): unknown => settings !== undefined && Reflect.has(settings, key) ? Reflect.get(settings, key) : fallback;
    validateFunction(callback, "listener");
    let watcher = watchers.get(target);
    if (watcher === undefined) {
      watcher = new StatWatcher(at("bigint", undefined));
      start(watcher, target, Boolean(at("persistent", true)), at("interval", 5007));
      watchers.set(target, watcher);
    } else { const state = stateOf(watcher); state.references++; state.maximum++; }
    watcher.addListener("change", callback);
    return watcher;
  }, "watchFile");

  const unwatchFile = named(function (filename: unknown, listener: unknown): void {
    const target = absolute(filename), watcher = watchers.get(target);
    if (watcher === undefined) return;
    const state = stateOf(watcher);
    if (callable(listener)) {
      const before = watcher.listenerCount("change");
      watcher.removeListener("change", listener);
      if (watcher.listenerCount("change") < before) { state.maximum--; watcher.unref(); }
    } else {
      watcher.removeAllListeners("change");
      state.maximum = 0; state.references = 0; watcher._handle?.unref();
    }
    if (watcher.listenerCount("change") === 0) { watcher.stop(); watchers.delete(target); }
  }, "unwatchFile");

  /** Node's `createIgnoreMatcher`: glob strings (a pattern without a slash is tried against the base name), regular
   * expressions and functions. */
  function ignoring(ignore: unknown): ((filename: string) => boolean) | undefined {
    if (ignore === null || ignore === undefined) return undefined;
    const tests = (Array.isArray(ignore) ? ignore : [ignore]).map((item: unknown, index): ((filename: string) => boolean) => {
      if (typeof item === "string") return filename => matchesGlob(item.includes("/") ? filename : path.basename(filename), item);
      if (item instanceof RegExp) return filename => item.exec(filename) !== null;
      if (typeof item === "function") return filename => Boolean(Reflect.apply(item, undefined, [filename]));
      throw invalidOneOf(Array.isArray(ignore) ? `options.ignore[${String(index)}]` : "options.ignore", "string or function or an instance of RegExp", item);
    });
    return filename => tests.some(test => test(filename));
  }

  const watch = named(async function* (filename: unknown, options: unknown = {}): AsyncGenerator<{ eventType: unknown; filename: unknown }, void, undefined> {
    validateObject(options, "options");
    const at = (key: string, fallback: unknown): unknown => { const value: unknown = Reflect.get(options, key); return value === undefined ? fallback : value; };
    const requested: unknown = Reflect.get(options, "recursive");
    if (requested !== null && requested !== undefined) validateBoolean(requested, "options.recursive");
    const target = validatedPath(filename).text;
    const persistent = at("persistent", true), recursive = at("recursive", false), encoding = at("encoding", "utf8"), maxQueue = at("maxQueue", 2048), overflow = at("overflow", "ignore");
    const signal: unknown = Reflect.get(options, "signal");
    validateBoolean(persistent, "options.persistent"); validateBoolean(recursive, "options.recursive"); validateInteger(maxQueue, "options.maxQueue");
    if (overflow !== "ignore" && overflow !== "error") throw invalidValue("options.overflow", overflow, "must be one of: 'ignore', 'error'");
    if (signal !== undefined) validateAbortSignal(signal, "options.signal");
    const ignored = ignoring(Reflect.get(options, "ignore"));
    if (Boolean(encoding) && (typeof encoding !== "string" || !Buffer.isEncoding(encoding))) throw invalidValue("encoding", encoding, "is invalid encoding");
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) throw new AbortError(signal?.reason);
    const queue: unknown[] = [];
    let waiting = Promise.withResolvers<undefined>(), handle: ChangeWatcher | undefined;
    const wake = (): void => { waiting.resolve(undefined); };
    const cancel = (): void => { handle?.close(); wake(); };
    try {
      signal?.addEventListener("abort", cancel, { once: true });
      try { handle = ports.watch(target, { persistent, recursive, encoding: typeof encoding === "string" && encoding !== "" ? encoding : "utf8" }); }
      catch (error) {
        // Node names the watched file on a failed start.
        if (error instanceof Error && errorCode(error) !== undefined && Reflect.get(error, "syscall") === "watch") Object.assign(error, { filename });
        throw error;
      }
      handle.on("error", error => { handle?.close(); queue.push(error instanceof Error ? error : new Error(String(error))); wake(); });
      handle.on("change", (eventType, name) => {
        if (typeof name === "string" && ignored?.(name) === true) return;
        if (queue.length < maxQueue) {
          const event: { eventType: unknown; filename: unknown } = { eventType, filename: name };
          Object.setPrototypeOf(event, null);
          queue.push(event); wake();
        } else if (overflow === "error") {
          queue.length = 0;
          queue.push(codeError(Error, "ERR_FS_WATCH_QUEUE_OVERFLOW", `fs.watch() queued more than ${String(maxQueue)} events`)); wake();
        } else ports.warn?.("fs.watch maxQueue exceeded", "Warning");
      });
      while (!aborted()) {
        await waiting.promise;
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          if (item instanceof Error) throw item;
          if (typeof item === "object" && item !== null && "eventType" in item && "filename" in item) yield item;
        }
        waiting = Promise.withResolvers<undefined>();
      }
      throw new AbortError(signal?.reason);
    } finally {
      handle?.close();
      signal?.removeEventListener("abort", cancel);
    }
  }, "_watch");
  return { watchFile, unwatchFile, promises: { watch } };
}
