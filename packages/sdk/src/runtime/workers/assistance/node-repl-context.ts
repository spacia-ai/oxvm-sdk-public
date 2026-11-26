/** JavaScript's own truthiness of a value from the program (`if (value)` in Node's sources). */
export function truthy(value: unknown): boolean { return Boolean(value); }

/** What REPLs define on the process's global object, and how to take it back. A browser worker has one realm, so a
 * REPL's context is the global object itself (Node's `useGlobal: true`). */
export interface ReplGlobals {
  /** Defines a property, remembering what the name held before the first definition. */
  readonly define: (name: string, descriptor: PropertyDescriptor) => void;
  /** Node's REPL globals for modules: `require`, and each built-in under its own name, loaded on first use. */
  readonly defineModules: (require: (id: string) => unknown, builtinLibs: readonly string[]) => void;
  readonly restore: () => void;
}

export function createReplGlobals(): ReplGlobals {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, descriptor: PropertyDescriptor): void => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    // A global the program declared itself (a top-level `var`) cannot be redefined and stays the program's.
    if (previous?.configurable === false) return;
    if (!saved.has(name)) saved.set(name, previous);
    Object.defineProperty(globalThis, name, descriptor);
  };
  return {
    define,
    defineModules(require, builtinLibs): void {
      // A `require` the program already has (an evaluated entry's) resolves like the program's own code: keep it.
      if (typeof Reflect.get(globalThis, "require") !== "function") define("require", { configurable: true, writable: true, value: require });
      for (const name of builtinLibs) {
        // Neither modules with a slash in their name (`fs/promises`), nor ones a global already carries the name of.
        // Node's REPL binds `module` to its own module object, which this runtime does not have.
        if (name.includes("/") || name === "module" || Object.hasOwn(globalThis, name)) continue;
        // Assigning the name replaces the accessor with an ordinary property, as if no global had existed.
        const setReal = (value: unknown): void => { Reflect.deleteProperty(globalThis, name); Reflect.set(globalThis, name, value); };
        define(name, { configurable: true, enumerable: false, set: setReal, get: (): unknown => {
          const lib = require(name);
          try { Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, get: () => lib, set: setReal }); } catch { /* The name keeps its lazy accessor. */ }
          return lib;
        } });
      }
    },
    restore(): void {
      for (const [name, previous] of saved) {
        if (previous === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, previous);
      }
      saved.clear();
    },
  };
}
