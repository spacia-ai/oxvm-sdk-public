/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/process/finalization.js (createFinalization).
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

import { invalidArgType, type Inspect } from "./node-arg-type.js";

type ExitEvent = "exit" | "beforeExit";
type Entry = { readonly ref: WeakRef<object>; readonly fn: unknown };

/** What `process.finalization` needs of its process. */
export interface FinalizationHost {
  on(event: ExitEvent, listener: () => void): unknown;
  removeListener(event: ExitEvent, listener: () => void): unknown;
  emitWarning(warning: string, type: string): void;
}

/**
 * Node's `process.finalization`: a callback runs at 'exit' (or 'beforeExit') for every registered object that is still
 * alive. Objects are held weakly, and the process listens only while something is registered.
 */
export function createFinalization(process: FinalizationHost, inspect: Inspect) {
  let registry: FinalizationRegistry<Entry> | null = null;
  const refs: Record<ExitEvent, Entry[]> = { exit: [], beforeExit: [] };
  const warned = new Set<string>();
  const listeners: Record<ExitEvent, () => void> = {
    exit: () => { callRefsToFree(refs.exit, "exit"); },
    beforeExit: () => { callRefsToFree(refs.beforeExit, "beforeExit"); },
  };
  function experimental(feature: string): void {
    if (warned.has(feature)) return;
    warned.add(feature);
    process.emitWarning(`${feature} is an experimental feature and might change at any time`, "ExperimentalWarning");
  }
  function install(event: ExitEvent): void {
    if (refs[event].length > 0) return;
    process.on(event, listeners[event]);
  }
  function uninstall(event: ExitEvent): void {
    if (refs[event].length > 0) return;
    process.removeListener(event, listeners[event]);
    if (refs.exit.length === 0 && refs.beforeExit.length === 0) registry = null;
  }
  function callRefsToFree(entries: Entry[], event: ExitEvent): void {
    for (const entry of entries) {
      const obj = entry.ref.deref();
      if (obj === undefined) continue;
      // Node does not check the callback when it is registered; it fails here.
      if (typeof entry.fn !== "function") throw new TypeError("fn is not a function");
      Reflect.apply(entry.fn, undefined, [obj, event]);
    }
    entries.length = 0;
  }
  /** A collected object leaves both lists. The second argument is Node's own (`index + 1`, not `1`). */
  function clear(entry: Entry): void {
    for (const event of ["exit", "beforeExit"] as const) {
      const index = refs[event].indexOf(entry);
      refs[event].splice(index, index + 1);
      uninstall(event);
    }
  }
  function add(event: ExitEvent, obj: unknown, fn: unknown): void {
    // Node's validateObject, functions allowed.
    if (obj === null || Array.isArray(obj) || (typeof obj !== "object" && typeof obj !== "function")) throw invalidArgType("obj", "object", obj, inspect);
    install(event);
    const entry: Entry = { ref: new WeakRef(obj), fn };
    registry ??= new FinalizationRegistry<Entry>(clear);
    registry.register(obj, entry);
    refs[event].push(entry);
  }
  function register(obj: unknown, fn: unknown): void {
    experimental("process.finalization.register");
    add("exit", obj, fn);
  }
  function registerBeforeExit(obj: unknown, fn: unknown): void {
    experimental("process.finalization.registerBeforeExit");
    add("beforeExit", obj, fn);
  }
  function unregister(obj: unknown): void {
    experimental("process.finalization.unregister");
    if (registry === null) return;
    // V8's refusal of a token that cannot be held weakly, in its words.
    if ((typeof obj !== "object" || obj === null) && typeof obj !== "function" && typeof obj !== "symbol") throw new TypeError(`Invalid unregisterToken ('${String(obj)}')`);
    registry.unregister(obj);
    for (const event of ["exit", "beforeExit"] as const) {
      refs[event] = refs[event].filter(entry => { const held = entry.ref.deref(); return held !== undefined && held !== obj; });
      uninstall(event);
    }
  }
  // Production code is minified; programs read these names.
  Object.defineProperty(register, "name", { value: "register" });
  Object.defineProperty(registerBeforeExit, "name", { value: "registerBeforeExit" });
  Object.defineProperty(unregister, "name", { value: "unregister" });
  return { register, registerBeforeExit, unregister };
}
