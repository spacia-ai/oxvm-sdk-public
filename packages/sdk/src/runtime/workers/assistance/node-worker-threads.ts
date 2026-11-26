import { VMError } from "../../errors.ts";
import type { AsyncContext } from "./async-context.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import type { Writable } from "./node-streams.js";
import { invalidInstance, named, templateText, validateFunction } from "./node-util-validators.ts";

export interface WorkerThreadProcess {
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: readonly string[];
  readonly stdout: Writable;
  readonly stderr: Writable;
  cwd(): string;
}
export interface WorkerThreadRuntime {
  readonly module: Readonly<Record<string, unknown>>;
  readonly hasPending: boolean;
  idle(): Promise<void>;
  dispose(): void;
}
export type WorkerThreadFactory = (context: AsyncContext, scheduler: ProcessScheduler, process: WorkerThreadProcess) => WorkerThreadRuntime;

type LockMode = "exclusive" | "shared";
interface LockInfo { readonly name: string; readonly mode: LockMode }
type LockCallback = (lock: LockInfo | null) => unknown;
interface HeldLock extends LockInfo { released: boolean; readonly steal: () => void }
interface PendingLock extends LockInfo { readonly grant: () => void }
interface LockOptions { readonly mode: LockMode; readonly ifAvailable: boolean; readonly steal: boolean; readonly signal: AbortSignal | undefined }

function typeError(code: string, message: string): TypeError { return Object.assign(new TypeError(message), { code }); }
/** WebIDL's `LockOptions` dictionary as Node converts it. */
function lockOptions(value: unknown): LockOptions {
  if (value === undefined || value === null || typeof value === "function") return { mode: "exclusive", ifAvailable: false, steal: false, signal: undefined };
  if (typeof value !== "object") throw typeError("ERR_INVALID_ARG_TYPE", "Value cannot be converted to a dictionary");
  const given: unknown = Reflect.get(value, "mode"), mode = given === undefined ? "exclusive" : templateText(given);
  if (mode !== "shared" && mode !== "exclusive") throw typeError("ERR_INVALID_ARG_VALUE", `mode '${mode}' is not a valid enum value of type LockMode.`);
  const signal: unknown = Reflect.get(value, "signal");
  if (signal !== undefined && (typeof signal !== "object" || signal === null)) throw typeError("ERR_INVALID_ARG_TYPE", "signal is not an object.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalidInstance("options.signal", "AbortSignal", signal);
  return { mode, ifAvailable: Boolean(Reflect.get(value, "ifAvailable")), steal: Boolean(Reflect.get(value, "steal")), signal };
}
function truthy(value: unknown): boolean { return Boolean(value); }
function notSupported(message: string): DOMException { return new DOMException(message, "NotSupportedError"); }
function aborted(): DOMException { return new DOMException("The operation was aborted", "AbortError"); }

/**
 * Node's `worker_threads.locks`: the Web Locks manager of one process. The platform's `navigator.locks` spans every
 * tab of its origin, so the queue lives here instead. Recorded quirks of Node.js v24.18.1 are kept: a callback that
 * throws synchronously leaves its lock held, only a real promise holds the lock until it settles, and the guards of
 * the two classes fail with a TypeError that names a missing constructor.
 */
function createLockManager(clientId: () => string): object {
  /** Held locks by name; `query` lists the newest name first. */
  const held = new Map<string, HeldLock[]>();
  const pending: PendingLock[] = [];
  const identities = new WeakMap<object, LockInfo>();
  let admitted = false;

  class Lock {
    constructor() { if (!admitted) throw new TypeError("ERR_ILLEGAL_CONSTRUCTOR is not a constructor"); }
    get name(): string | undefined {
      if (!(this instanceof Lock)) throw new TypeError("ERR_INVALID_THIS is not a constructor");
      return identities.get(this)?.name;
    }
    get mode(): string | undefined {
      if (!(this instanceof Lock)) throw new TypeError("ERR_INVALID_THIS is not a constructor");
      return identities.get(this)?.mode;
    }
  }
  named(Lock, "Lock");
  const createLock = (info: LockInfo | null): Lock | null => {
    if (info === null) return null;
    admitted = true;
    try { const lock = new Lock(); identities.set(lock, info); return lock; } finally { admitted = false; }
  };

  const grantable = (request: LockInfo, before: number): boolean => {
    for (let index = 0; index < before; index++) if (pending[index]?.name === request.name) return false;
    const holders = held.get(request.name) ?? [];
    return holders.length === 0 || (request.mode === "shared" && holders.every(holder => holder.mode === "shared"));
  };
  const processQueue = (): void => {
    for (let index = 0; index < pending.length;) {
      const request = pending[index];
      if (request === undefined || !grantable(request, index)) { index += 1; continue; }
      pending.splice(index, 1);
      // A granted callback may release at once or request again: start over.
      request.grant();
      index = 0;
    }
  };
  const release = (lock: HeldLock): void => {
    if (lock.released) return;
    lock.released = true;
    const holders = (held.get(lock.name) ?? []).filter(holder => holder !== lock);
    if (holders.length === 0) held.delete(lock.name); else held.set(lock.name, holders);
    processQueue();
  };
  /** The native request: settles with the callback's result once the lock is released, or rejects when it is stolen. */
  const acquire = (info: LockInfo, steal: boolean, ifAvailable: boolean, callback: LockCallback): Promise<unknown> => {
    const settled = Promise.withResolvers<unknown>(), fail: (reason: unknown) => void = settled.reject;
    const run = (lock: HeldLock | undefined): void => {
      let result: unknown;
      // A synchronous throw leaves the lock held, as it does in Node.
      try { result = callback(lock === undefined ? null : info); } catch (error) { fail(error); return; }
      if (result instanceof Promise) {
        // The request settles before the next waiter's callback runs.
        result.then((value: unknown) => { settled.resolve(value); if (lock !== undefined) release(lock); }, (error: unknown) => { fail(error); if (lock !== undefined) release(lock); });
        return;
      }
      // Node's native layer resolves two promises with the result: a thenable that is not a promise is asked twice.
      Promise.resolve(result).catch(() => undefined);
      settled.resolve(result);
      if (lock !== undefined) release(lock);
    };
    const grant = (): void => {
      const lock: HeldLock = { ...info, released: false, steal: () => { lock.released = true; fail(aborted()); } };
      held.set(info.name, [...(held.get(info.name) ?? []), lock]);
      run(lock);
    };
    if (steal) {
      for (const holder of held.get(info.name) ?? []) holder.steal();
      held.delete(info.name);
      pending.unshift({ ...info, grant });
    } else if (ifAvailable && !grantable(info, pending.length)) {
      run(undefined);
      return settled.promise;
    } else pending.push({ ...info, grant });
    processQueue();
    return settled.promise;
  };

  class LockManager {
    constructor() { if (!admitted) throw new TypeError("ERR_ILLEGAL_CONSTRUCTOR is not a constructor"); }
    async request(name: unknown, options: unknown, ...rest: unknown[]): Promise<unknown> {
      const callback = rest[0];
      const given = callback === undefined ? options : callback, dictionary = callback === undefined ? undefined : options;
      if (typeof name === "symbol") throw typeError("ERR_INVALID_ARG_TYPE", "Value is a Symbol and cannot be converted to a string.");
      const text = String(name);
      validateFunction(given, "callback");
      const { mode, ifAvailable, steal, signal } = lockOptions(dictionary);
      signal?.throwIfAborted();
      if (text.startsWith("-")) throw notSupported("Lock name may not start with hyphen");
      if (ifAvailable && steal) throw notSupported("ifAvailable and steal are mutually exclusive");
      if (mode !== "exclusive" && steal) throw notSupported("mode: \"shared\" and steal are mutually exclusive");
      if (signal !== undefined && (steal || ifAvailable)) throw notSupported("signal cannot be used with steal or ifAvailable");
      const info: LockInfo = { name: text, mode };
      if (signal === undefined) return acquire(info, steal, ifAvailable, lock => given(createLock(lock)));
      return new Promise<unknown>((resolve, reject) => {
        const fail: (reason: unknown) => void = reject;
        let granted = false;
        const abortListener = (): void => { if (!granted) { const reason: unknown = signal.reason; fail(truthy(reason) ? reason : aborted()); } };
        signal.addEventListener("abort", abortListener, { once: true });
        // The request keeps its place in the queue after an abort; its turn then passes without the callback.
        const wrapped: LockCallback = lock => Promise.resolve().then(() => {
          if (signal.aborted) return undefined;
          granted = true;
          return given(createLock(lock));
        });
        acquire(info, steal, ifAvailable, wrapped).then(resolve, fail).finally(() => { signal.removeEventListener("abort", abortListener); }).catch(() => undefined);
      });
    }
    async query(): Promise<{ held: unknown[]; pending: unknown[] }> {
      if (!(this instanceof LockManager)) throw new TypeError("ERR_INVALID_THIS is not a constructor");
      const snapshot = (lock: LockInfo): unknown => ({ name: lock.name, mode: lock.mode, clientId: clientId() });
      return Promise.resolve({ held: [...held.values()].reverse().flat().map(snapshot), pending: pending.map(snapshot) });
    }
  }
  named(LockManager, "LockManager");
  for (const [prototype, tag, names] of [[Lock.prototype, "Lock", ["name", "mode"]], [LockManager.prototype, "LockManager", ["request", "query"]]] as const) {
    for (const name of names) Object.defineProperty(prototype, name, { enumerable: true });
    Object.defineProperty(prototype, Symbol.toStringTag, { value: tag, writable: false, enumerable: false, configurable: true });
  }
  admitted = true;
  try { return new LockManager(); } finally { admitted = false; }
}

/** What `worker_threads` takes from its process. */
export interface WorkerThreadPorts {
  /** Node's identity of a lock client, `node-<pid>-<threadId>`, as `locks.query()` reports it. */
  readonly clientId?: () => string;
}

/** The `worker_threads` builtin for the assisted process, which is always a
 * main thread: thread identity, the platform's message ports and the marking
 * helpers are real; constructing a `Worker` is refused explicitly. */
export function createNodeWorkerThreads(globals: unknown, ports: WorkerThreadPorts = {}): Readonly<Record<string, unknown>> {
  if (typeof globals !== "object" || globals === null) throw new VMError("FEATURE_NOT_AVAILABLE", "worker_threads requires the platform's global scope");
  const port = (name: string): unknown => {
    const value: unknown = Reflect.get(globals, name);
    if (typeof value !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", `worker_threads is unavailable: the platform lacks ${name}`, { builtin: "worker_threads", missing: name });
    return value;
  };
  const environmentData = new Map<unknown, unknown>();
  const untransferable = new WeakSet<object>();
  const refuseWorker = (): never => {
    throw new VMError("FEATURE_NOT_AVAILABLE", "worker_threads Worker is not supported in the assisted process", { builtin: "worker_threads", export: "Worker" });
  };
  class Worker {
    constructor() { refuseWorker(); }
    postMessage(): never { return refuseWorker(); }
    terminate(): never { return refuseWorker(); }
  }
  const unsupported = (name: string) => (): never => {
    throw new VMError("FEATURE_NOT_AVAILABLE", `worker_threads.${name} is not supported`, { builtin: "worker_threads", export: name });
  };
  return Object.freeze({
    isMainThread: true, isInternalThread: false, threadId: 0, threadName: "", parentPort: null, workerData: null, resourceLimits: Object.freeze({}), SHARE_ENV: Symbol("nodejs.worker_threads.SHARE_ENV"),
    MessageChannel: port("MessageChannel"), MessagePort: port("MessagePort"), BroadcastChannel: port("BroadcastChannel"), Worker,
    markAsUncloneable: (): undefined => undefined,
    markAsUntransferable: (value: unknown): undefined => { if (typeof value === "object" && value !== null) untransferable.add(value); return undefined; },
    isMarkedAsUntransferable: (value: unknown): boolean => typeof value === "object" && value !== null && untransferable.has(value),
    getEnvironmentData: (key: unknown): unknown => environmentData.get(key),
    setEnvironmentData: (key: unknown, value?: unknown): undefined => { if (value === undefined) environmentData.delete(key); else environmentData.set(key, value); return undefined; },
    moveMessagePortToContext: unsupported("moveMessagePortToContext"), receiveMessageOnPort: unsupported("receiveMessageOnPort"),
    postMessageToThread: unsupported("postMessageToThread"),
    locks: createLockManager(ports.clientId ?? (() => "node-0-0")),
  });
}
