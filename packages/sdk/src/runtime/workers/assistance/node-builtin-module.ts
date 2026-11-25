import { isNodeBuiltin } from "./commonjs.ts";
import { invalidArgType, type Inspect } from "./node-arg-type.ts";

/**
 * Node's `process.getBuiltinModule(id)`: the built-in for a built-in's name, with or without `node:`, and undefined
 * for anything else. `load` is the process's own `require`, so a built-in this runtime lacks fails there, as a
 * `require` of it does.
 */
export function createGetBuiltinModule(load: (id: string) => unknown, inspect: Inspect): (id: unknown) => unknown {
  return function getBuiltinModule(id: unknown): unknown {
    if (typeof id !== "string") throw invalidArgType("id", "string", id, inspect);
    return isNodeBuiltin(id) ? load(id) : undefined;
  };
}
