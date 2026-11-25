/**
 * Node's `ref()`, `unref()` and `hasRef()` for the platform's own message ports.
 *
 * In Node the global `MessageChannel` is the `worker_threads` class, so its ports can hold the event loop open without a
 * listener: runtimes written for Node keep a process alive across asynchronous work by referencing such a port, and skip
 * the call where the method is missing. A browser port has no such methods, so a program doing this ended early.
 * The methods are defined once on the platform prototype of the process's worker, which is the program's own realm; the
 * returned owner says whether any port is referenced. Closing a port releases it.
 *
 * shortcut: a referenced port that is transferred away stays referenced here; Node releases it. Release it before transferring.
 */
export function createPlatformPortReferences(prototype: object, changed: () => void): { readonly hasReferences: boolean } {
  const referenced = new Set<object>();
  // A realm whose ports already have the methods (Node itself) keeps its own.
  if (Reflect.has(prototype, "ref")) return { get hasReferences() { return false; } };
  const close: unknown = Reflect.get(prototype, "close");
  const port = (value: unknown): object => {
    if (typeof value !== "object" || value === null || !Object.prototype.isPrototypeOf.call(prototype, value)) throw new TypeError("Illegal invocation");
    return value;
  };
  const method = (value: (this: unknown) => unknown) => ({ value, writable: true, enumerable: true, configurable: true });
  Object.defineProperties(prototype, {
    ref: method(function ref(this: unknown): unknown { referenced.add(port(this)); changed(); return this; }),
    unref: method(function unref(this: unknown): unknown { referenced.delete(port(this)); changed(); return this; }),
    hasRef: method(function hasRef(this: unknown): boolean { return referenced.has(port(this)); }),
    close: method(function close_(this: unknown): unknown {
      if (referenced.delete(port(this))) changed();
      return typeof close === "function" ? Reflect.apply(close, this, []) : undefined;
    }),
  });
  return { get hasReferences() { return referenced.size !== 0; } };
}
