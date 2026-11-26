/*!
 * Portions adapted from Node.js v24.18.1 lib/domain.js, lib/internal/errors.js (ERR_DOMAIN_CALLBACK_NOT_AVAILABLE,
 * ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE, ERR_UNHANDLED_ERROR) and lib/internal/process/promises.js
 * (emitUnhandledRejection); modified for OxVM's async resource owner.
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
import type Emitter from "events/";
import type { AsyncHook } from "./async-resources.js";
import type { NodeEmitterClass } from "./node-events.ts";
import { named } from "./node-util-validators.ts";

// The trusted microtask primitive, taken before a process installs its own.
const defer = globalThis.queueMicrotask.bind(globalThis);

/** A domain as programs see it: an EventEmitter with Node's methods on its prototype. */
export interface NodeDomainInstance extends Emitter {
  members: unknown[];
  domain?: unknown;
  _errorHandler(er: unknown): boolean;
  enter(): void;
  exit(): void;
  add(ee: { domain?: unknown }): void;
  remove(ee: { domain?: unknown }): void;
  run(fn: unknown, ...args: unknown[]): unknown;
  intercept(cb: unknown): (this: unknown, ...args: unknown[]) => unknown;
  bind(cb: unknown): (this: unknown, ...args: unknown[]) => unknown;
}

/** `require("domain")`, in Node's key order. Node reads `active` and `Domain` back from this object, so a program's
 * assignment counts; `_stack` is replaced while an emitter's 'error' is routed to its domain. */
export interface NodeDomainModule {
  _stack: unknown[];
  Domain: new () => NodeDomainInstance;
  createDomain: () => NodeDomainInstance;
  create: () => NodeDomainInstance;
  active: unknown;
}

export interface NodeDomainDeps {
  /** `require("events")` of this process (`createNodeEvents(...).module`): `Domain` extends it, and while the module is
   * loaded its `init` and `prototype.emit` are wrapped and its `usingDomains` is true, as Node's lib/domain.js does. */
  readonly events: NodeEmitterClass;
  /** `async_hooks.createHook` of this process: the domain of each async resource is recorded and re-entered through it. */
  readonly createHook: (callbacks: unknown) => AsyncHook;
  /** The process object. It gains the `domain` accessor and the 'uncaughtException' bookkeeping listeners, and its
   * `setUncaughtExceptionCaptureCallback` / `hasUncaughtExceptionCaptureCallback` (node-process-extras.ts) are read from
   * it when the module loads: the domain takes the capture callback over, exactly as Node's does. */
  readonly process: Emitter;
  /** Receives what undoes the load when the process ends; the emitter class is shared by the worker's processes. */
  readonly install: (restore: () => void) => void;
}

/** Every domain constructed in this worker; a promise's `domain` property is honoured only when it is one of them. */
const domains = new WeakSet<object>();

/** Node's `emitUnhandledRejection`: an unhandled rejection of a promise that belongs to a domain is emitted as that
 * domain's 'error' instead of the process's 'unhandledRejection'. Node keeps the domain that was active when the promise
 * was rejected; this runtime is not told about rejections, so it is the domain the promise was created in. */
export function rejectionDomain(promise: unknown): Pick<Emitter, "emit"> | undefined {
  if (typeof promise !== "object" || promise === null) return undefined;
  const domain: unknown = Reflect.get(promise, "domain");
  return isDomain(domain) ? domain : undefined;
}
function isDomain(value: unknown): value is NodeDomainInstance { return typeof value === "object" && value !== null && domains.has(value); }

function holder(value: unknown): value is Record<string, unknown> { return (typeof value === "object" && value !== null) || typeof value === "function"; }
/** A method call on a value a program may have replaced (`process.domain = x`, `emitter.domain = x`). */
function invoke(target: unknown, method: string, args: unknown[]): unknown {
  const fn: unknown = holder(target) ? Reflect.get(target, method) : undefined;
  if (typeof fn !== "function") throw new TypeError(`domain.${method} is not a function`);
  return Reflect.apply(fn, target, args);
}
/** Node's `ReflectApply(fn, thisArg, args)`, with V8's wording (as of Node 24) for a value that cannot be called. */
function applyCallback(fn: unknown, self: unknown, args: unknown[]): unknown {
  if (typeof fn === "function") return Reflect.apply(fn, self, args);
  const shown = typeof fn === "object" && fn !== null ? `#<${constructorName(fn)}>` : typeof fn === "symbol" ? fn.toString() : String(fn);
  const kind = fn === null ? "null" : typeof fn === "object" ? "an object" : `a ${typeof fn}`;
  throw new TypeError(`Function.prototype.apply was called on ${shown}, which is ${kind} and not a function`);
}
function constructorName(value: object): string {
  const constructor: unknown = Reflect.get(value, "constructor"), name: unknown = typeof constructor === "function" ? constructor.name : undefined;
  return typeof name === "string" && name !== "" ? name : "Object";
}
function truthy(value: unknown): boolean { return Boolean(value); }
/** Node's hidden `domain` property of emitters, errors, bound functions and async resources. */
function setDomain(target: object, value: unknown): void {
  Object.defineProperty(target, "domain", { configurable: true, enumerable: false, value, writable: true });
}
/** An internal Node error: its class is not Error itself, yet it is named "Error"; `code` is its only enumerable key
 * and the stack header carries it. */
class NodeError extends Error {
  constructor(code: string, message: string) {
    super(message);
    Object.defineProperty(this, "code", { value: code, enumerable: true, writable: true, configurable: true });
    const stack = this.stack;
    if (typeof stack === "string" && stack.startsWith("Error: ")) this.stack = `Error [${code}]: ${stack.slice("Error: ".length)}`;
  }
}
named(NodeError, "Error");
function nodeError(code: string, message: string): Error { return new NodeError(code, message); }

/** The resource types whose callbacks Node enters from native code. An exception leaves such a callback with its domain
 * still entered; the scopes of JavaScript resources (`AsyncResource`, `queueMicrotask`) leave theirs on the way out. */
const nativeScopes = new Set(["Timeout", "TickObject", "Immediate", "OxideVMCallback"]);
const moduleKeys = ["_stack", "Domain", "createDomain", "create", "active"] as const;

/** Loads Node's `domain` module into this process now, with every side effect Node's has, and returns it. */
export function createNodeDomain(deps: NodeDomainDeps): NodeDomainModule {
  return loadNodeDomain(deps, {});
}

/**
 * The module for a built-in table that cannot construct on first `require`: an object that loads Node's module the
 * first time a program reads, writes or lists anything on it, and is that module from then on. Until then the process
 * is untouched, which differs from Node for a program that requires `domain` and never touches the result. A load that
 * fails (ERR_DOMAIN_CALLBACK_NOT_AVAILABLE) throws from that first use instead of from `require`, and the next use
 * tries again. Asking whether one of Node's five exports exists loads nothing.
 */
export function deferNodeDomain(deps: NodeDomainDeps): object {
  const exports = {};
  let loaded = false;
  const load = (): void => { if (!loaded) { loadNodeDomain(deps, exports); loaded = true; } };
  const names: readonly PropertyKey[] = moduleKeys;
  return new Proxy(exports, {
    get(target, key, receiver): unknown { load(); return Reflect.get(target, key, receiver); },
    set(target, key, value, receiver): boolean { load(); return Reflect.set(target, key, value, receiver); },
    has(target, key): boolean { if (names.includes(key)) return true; load(); return Reflect.has(target, key); },
    ownKeys(target): (string | symbol)[] { load(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined { load(); return Reflect.getOwnPropertyDescriptor(target, key); },
    defineProperty(target, key, descriptor): boolean { load(); return Reflect.defineProperty(target, key, descriptor); },
    deleteProperty(target, key): boolean { load(); return Reflect.deleteProperty(target, key); },
  });
}

function isModule(value: object): value is NodeDomainModule { return moduleKeys.every(key => Object.hasOwn(value, key)); }

function loadNodeDomain(deps: NodeDomainDeps, target: object): NodeDomainModule {
  const { events: EventEmitter, process } = deps;
  /** Node's stack and active domain when a native callback ended; see `unwound` below. */
  interface Unwound { readonly stack: NodeDomainInstance[]; readonly active: unknown }
  let unwound: Unwound | undefined;
  const undo: (() => void)[] = [];
  const restore = (): void => { for (const step of undo.reverse()) step(); undo.length = 0; };

  // Overwrite process.domain with a getter/setter, as Node does.
  const _domain: [unknown] = [null];
  const previousDomain = Object.getOwnPropertyDescriptor(process, "domain");
  Object.defineProperty(process, "domain", {
    enumerable: true, configurable: true,
    // Between a native callback's throw and its delivery the process is still inside that callback's domain.
    get: named(function (): unknown { return unwound === undefined ? _domain[0] : unwound.active; }, "get"),
    set: named(function (arg: unknown): void { _domain[0] = arg; }, "set"),
  });
  const active = (): unknown => _domain[0];

  // It's possible to enter one domain while already inside another one. The stack is each entered domain.
  let stack: NodeDomainInstance[] = [];
  /** `unwound`: the stack and active domain a native callback had when it ended. An exception such a callback throws reaches the
   * process after this runtime's scope has already left the domain, where Node would still be inside it; the capture
   * callback puts this state back first. Dropped by the next callback, by any enter or exit, and at the next microtask. */
  function forget(): void {
    if (unwound === undefined) return;
    unwound = undefined;
    updateExceptionCapture();
  }

  const pairing = new Map<number, { readonly domain: unknown; readonly native: boolean }>();
  const asyncHook = deps.createHook({
    init(asyncId: number, type: unknown, _trigger: unknown, resource: unknown): void {
      const current = active();
      if (current === null || current === undefined) return;
      // If this operation is created while in a domain, let's mark it.
      pairing.set(asyncId, { domain: current, native: typeof type === "string" && nativeScopes.has(type) });
      // Node's resources are objects. Here a queued callback can be its own resource; a program's function gets no property.
      if (typeof resource === "object" && resource !== null) setDomain(resource, current);
    },
    before(asyncId: number): void {
      forget();
      const current = pairing.get(asyncId);
      if (current !== undefined) invoke(current.domain, "enter", []);
    },
    after(asyncId: number): void {
      const current = pairing.get(asyncId);
      if (current === undefined) return;
      const left = current.native && unwound === undefined && active() !== null && active() !== undefined ? { stack: [...stack], active: active() } : undefined;
      invoke(current.domain, "exit", []);
      if (left === undefined) return;
      unwound = left;
      updateExceptionCapture();
      defer(() => { if (unwound === left) forget(); });
    },
    destroy(asyncId: number): void { pairing.delete(asyncId); },
  });
  undo.push(() => { asyncHook.disable(); pairing.clear(); });

  // When domains are in use, they claim full ownership of the uncaught exception capture callback.
  const hasCapture: unknown = Reflect.get(process, "hasUncaughtExceptionCaptureCallback");
  const setCapture: unknown = Reflect.get(process, "setUncaughtExceptionCaptureCallback");
  if (typeof hasCapture !== "function" || typeof setCapture !== "function") throw new TypeError("process has no uncaught exception capture callback");
  const alreadyCaptured: unknown = Reflect.apply(hasCapture, process, []);
  if (alreadyCaptured === true) {
    // Node leaves the accessor defined when its module fails to load here.
    undo.length = 0;
    throw nodeError("ERR_DOMAIN_CALLBACK_NOT_AVAILABLE", "A callback was registered through process.setUncaughtExceptionCaptureCallback(), which is mutually exclusive with using the `domain` module");
  }
  undo.push(() => { if (previousDomain === undefined) Reflect.deleteProperty(process, "domain"); else Object.defineProperty(process, "domain", previousDomain); });
  // The stack trace at the point where `domain` was required.
  const domainRequireStack = new Error("require(`domain`) at this point").stack ?? "";
  const setUncaughtExceptionCaptureCallback = (fn: ((er: unknown) => unknown) | null): void => { Reflect.apply(setCapture, process, [fn]); };
  // Node's replacement declares the callback it refuses: `function(fn)`.
  Reflect.set(process, "setUncaughtExceptionCaptureCallback", Object.defineProperty(named(function (): never {
    const err = nodeError("ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE", "The `domain` module is in use, which is mutually exclusive with calling process.setUncaughtExceptionCaptureCallback()");
    err.stack = `${err.stack ?? ""}\n${"-".repeat(40)}\n${domainRequireStack}`;
    throw err;
  }, ""), "length", { value: 1 }));
  undo.push(() => { setUncaughtExceptionCaptureCallback(null); Reflect.set(process, "setUncaughtExceptionCaptureCallback", setCapture); });

  const capture = (er: unknown): unknown => {
    const left = unwound;
    if (left !== undefined) {
      // The callback that threw has been left already: be where Node is when it calls this.
      unwound = undefined;
      stack.length = 0;
      stack.push(...left.stack);
      exports.active = _domain[0] = left.active;
    }
    return invoke(active(), "_errorHandler", [er]);
  };
  const updateExceptionCapture = named(function (): void {
    const quiet = (domain: NodeDomainInstance): boolean => domain.listenerCount("error") === 0;
    setUncaughtExceptionCaptureCallback(null);
    if (!(stack.every(quiet) && (unwound === undefined || unwound.stack.every(quiet)))) setUncaughtExceptionCaptureCallback(capture);
  }, "updateExceptionCapture");

  const domainUncaughtExceptionClear = named(function (): void {
    stack.length = 0;
    exports.active = _domain[0] = null;
    unwound = undefined;
    updateExceptionCapture();
  }, "domainUncaughtExceptionClear");
  const onNewListener = (name: unknown, listener: unknown): void => {
    if (name === "uncaughtException" && listener !== domainUncaughtExceptionClear) {
      // Make sure the first listener for `uncaughtException` always clears the domain stack.
      process.removeListener("uncaughtException", domainUncaughtExceptionClear);
      process.prependListener("uncaughtException", domainUncaughtExceptionClear);
    }
  };
  const onRemoveListener = (name: unknown, listener: unknown): void => {
    if (name === "uncaughtException" && listener !== domainUncaughtExceptionClear) {
      // If the domain listener would be the only remaining one, remove it.
      const listeners: unknown = invoke(process, "listeners", ["uncaughtException"]);
      if (Array.isArray(listeners) && listeners.length === 1 && listeners[0] === domainUncaughtExceptionClear) process.removeListener("uncaughtException", domainUncaughtExceptionClear);
    }
  };
  process.on("newListener", onNewListener);
  process.on("removeListener", onRemoveListener);
  undo.push(() => {
    process.removeListener("newListener", onNewListener);
    process.removeListener("removeListener", onRemoveListener);
    process.removeListener("uncaughtException", domainUncaughtExceptionClear);
  });

  class Domain extends EventEmitter {
    declare members: unknown[];
    declare domain?: unknown;
    declare _errorHandler: NodeDomainInstance["_errorHandler"];
    declare enter: NodeDomainInstance["enter"];
    declare exit: NodeDomainInstance["exit"];
    declare add: NodeDomainInstance["add"];
    declare remove: NodeDomainInstance["remove"];
    declare run: NodeDomainInstance["run"];
    declare intercept: NodeDomainInstance["intercept"];
    declare bind: NodeDomainInstance["bind"];
    constructor() {
      super();
      this.members = [];
      domains.add(this);
      asyncHook.enable();
      this.on("removeListener", updateExceptionCapture);
      this.on("newListener", updateExceptionCapture);
    }
  }
  // The bundle renames classes; programs read this one's name.
  named(Domain, "Domain");
  const createDomain = named(function (): NodeDomainInstance { return new Domain(); }, "createDomain");
  // The active domain is always the one that we're currently in.
  const fresh: NodeDomainModule = { _stack: stack, Domain, createDomain, create: createDomain, active: null };
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(fresh));
  if (!isModule(target)) throw new TypeError("domain exports were not defined");
  const exports = target;
  /** Node's prototype assignments: enumerable, and each function anonymous. */
  const method = <Key extends keyof NodeDomainInstance>(key: Key, value: NodeDomainInstance[Key]): void => {
    Object.defineProperty(Domain.prototype, key, { value: typeof value === "function" ? named(value, "") : value, writable: true, enumerable: true, configurable: true });
  };
  Object.defineProperty(Domain.prototype, "members", { value: undefined, writable: true, enumerable: true, configurable: true });

  // Called by the uncaught exception capture callback in case an error was thrown.
  method("_errorHandler", function (this: NodeDomainInstance, er: unknown): boolean {
    let caught = false;
    if (holder(er)) {
      setDomain(er, this);
      er["domainThrown"] = true;
    }
    // Pop all adjacent duplicates of the currently active domain from the stack, so that a domain's error handler
    // does not run within the context of itself.
    while (exports.active === this) this.exit();

    // The top-level domain-handler is handled separately.
    if (stack.length === 0) {
      // If there's no error handler, do not emit an 'error' event as this would throw an error, make the process
      // exit, and thus prevent the process 'uncaughtException' event from being emitted if a listener is set.
      if (this.listenerCount("error") > 0) {
        setUncaughtExceptionCaptureCallback(null);
        try { caught = this.emit("error", er); }
        finally { updateExceptionCapture(); }
      }
    } else {
      // Wrap this in a try/catch so we don't get infinite throwing.
      try {
        caught = this.emit("error", er);
      } catch (er2) {
        // The domain error handler threw! See if another domain can catch THIS error, or else crash on the original one.
        updateExceptionCapture();
        const parent = stack[stack.length - 1];
        // Pass on to the next exception handler.
        if (parent === undefined) throw er2;
        exports.active = _domain[0] = parent;
        caught = truthy(invoke(active(), "_errorHandler", [er2]));
      }
    }
    // Exit all domains on the stack. Uncaught exceptions end the current tick and no domains should be left on the
    // stack between ticks.
    domainUncaughtExceptionClear();
    return caught;
  });

  method("enter", function (this: NodeDomainInstance): void {
    // Note that this might be a no-op, but we still need to push it onto the stack so that we can pop it later.
    unwound = undefined;
    exports.active = _domain[0] = this;
    stack.push(this);
    updateExceptionCapture();
  });

  method("exit", function (this: NodeDomainInstance): void {
    // Don't do anything if this domain is not on the stack.
    const index = stack.lastIndexOf(this);
    if (index === -1) return;
    // Exit all domains until this one.
    unwound = undefined;
    stack.splice(index);
    exports.active = stack.length === 0 ? undefined : stack[stack.length - 1];
    _domain[0] = exports.active;
    updateExceptionCapture();
  });

  // note: this works for timers as well.
  method("add", function (this: NodeDomainInstance, ee: { domain?: unknown }): void {
    // If the domain is already added, then nothing left to do.
    if (ee.domain === this) return;
    // Has a domain already - remove it first.
    if (truthy(ee.domain)) invoke(ee.domain, "remove", [ee]);
    // Check for circular Domain->Domain links. They cause big issues.
    if (truthy(this.domain) && ee instanceof Domain) {
      for (let d: unknown = this.domain; truthy(d); d = holder(d) ? d["domain"] : undefined) if (ee === d) return;
    }
    setDomain(ee, this);
    this.members.push(ee);
  });

  method("remove", function (this: NodeDomainInstance, ee: { domain?: unknown }): void {
    ee.domain = null;
    const index = this.members.indexOf(ee);
    if (index !== -1) this.members.splice(index, 1);
  });

  // Node declares `run(fn)` and reads the rest from `arguments`; nothing leaves the domain when `fn` throws.
  method("run", Object.defineProperty(function (this: NodeDomainInstance, ...input: unknown[]): unknown {
    this.enter();
    const ret = applyCallback(input[0], this, input.slice(1));
    this.exit();
    return ret;
  }, "length", { value: 1 }));

  const intercepted = (self: NodeDomainInstance, cb: unknown) => named(function (this: unknown, ...fnargs: unknown[]): unknown {
    const er = fnargs[0];
    if (er instanceof Error) {
      Object.assign(er, { domainBound: cb, domainThrown: false });
      setDomain(er, self);
      self.emit("error", er);
      return undefined;
    }
    self.enter();
    const ret = applyCallback(cb, this, fnargs.slice(1));
    self.exit();
    return ret;
  }, "runIntercepted");
  method("intercept", function (this: NodeDomainInstance, cb: unknown) { return intercepted(this, cb); });

  const bound = (self: NodeDomainInstance, cb: unknown) => named(function (this: unknown, ...fnargs: unknown[]): unknown {
    self.enter();
    const ret = applyCallback(cb, this, fnargs);
    self.exit();
    return ret;
  }, "runBound");
  method("bind", function (this: NodeDomainInstance, cb: unknown) {
    const runBound = bound(this, cb);
    setDomain(runBound, this);
    return runBound;
  });

  // Override EventEmitter methods to make it domain-aware.
  const usingDomains = Object.getOwnPropertyDescriptor(EventEmitter, "usingDomains");
  Reflect.set(EventEmitter, "usingDomains", true);
  const eventInit: unknown = Reflect.get(EventEmitter, "init");
  Reflect.set(EventEmitter, "init", named(function (this: object, opts: unknown): unknown {
    setDomain(this, null);
    const current = exports.active, DomainClass: unknown = exports.Domain;
    if (truthy(current) && !(typeof DomainClass === "function" && this instanceof DomainClass)) Reflect.set(this, "domain", current);
    return typeof eventInit === "function" ? Reflect.apply(eventInit, this, [opts]) : undefined;
  }, ""));

  const emitDescriptor = Object.getOwnPropertyDescriptor(EventEmitter.prototype, "emit");
  const eventEmit: unknown = emitDescriptor?.value;
  if (emitDescriptor === undefined || typeof eventEmit !== "function") throw new TypeError("EventEmitter has no emit");
  const emit = function emit(this: Emitter, ...args: unknown[]): unknown {
    const domain: unknown = Reflect.get(this, "domain");
    const type = args[0];
    const shouldEmitError = type === "error" && this.listenerCount("error") > 0;
    // Just call original `emit` if current EE instance has `error` handler, there's no active domain or this is process.
    if (shouldEmitError || domain === null || domain === undefined || this === process) return Reflect.apply(eventEmit, this, args);

    if (type === "error") {
      const er = args.length > 1 && truthy(args[1]) ? args[1] : nodeError("ERR_UNHANDLED_ERROR", "Unhandled error.");
      if (typeof er === "object" && holder(er)) {
        er["domainEmitter"] = this;
        setDomain(er, domain);
        er["domainThrown"] = false;
      }
      // Remove the current domain (and its duplicates) from the domains stack and set the active domain to its parent
      // (if any) so that the domain's error handler doesn't run in its own context.
      const origDomainsStack = stack.slice();
      const origActiveDomain = active();
      // Travel the domains stack from top to bottom to find the first domain instance that is not a duplicate of the
      // current active domain.
      let idx = stack.length - 1;
      while (idx > -1 && active() === stack[idx]) --idx;
      // Change the stack to not contain the current active domain, and only the domains above it on the stack.
      if (idx < 0) stack.length = 0; else stack.splice(idx + 1);
      // Change the current active domain.
      exports.active = _domain[0] = stack.length > 0 ? stack[stack.length - 1] : null;
      updateExceptionCapture();
      invoke(domain, "emit", ["error", er]);
      // Now that the domain's error handler has completed, restore the domains stack and the active domain.
      exports._stack = stack = origDomainsStack;
      exports.active = _domain[0] = origActiveDomain;
      updateExceptionCapture();
      return false;
    }

    invoke(domain, "enter", []);
    const ret: unknown = Reflect.apply(eventEmit, this, args);
    invoke(domain, "exit", []);
    return ret;
  };
  // The bundle renames functions; programs read this one's name.
  Object.defineProperty(EventEmitter.prototype, "emit", { ...emitDescriptor, value: named(emit, "emit") });
  undo.push(() => {
    Object.defineProperty(EventEmitter.prototype, "emit", emitDescriptor);
    Reflect.set(EventEmitter, "init", eventInit);
    if (usingDomains === undefined) Reflect.deleteProperty(EventEmitter, "usingDomains"); else Object.defineProperty(EventEmitter, "usingDomains", usingDomains);
  });
  deps.install(restore);
  return exports;
}
