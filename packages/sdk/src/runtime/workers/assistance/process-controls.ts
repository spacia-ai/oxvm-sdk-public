import { VMError } from "../../errors.js";

/**
 * Takes the worker's own transport and termination away from the program.
 *
 * Wherever `postMessage` and `close` are defined on the global object or its prototypes, the platform function is replaced
 * by a refusal, so no reference to it stays reachable from the scope: the owner captured its own before calling this.
 * On the prototypes the replacement is final. On the global object itself the name stays assignable and cannot be
 * deleted: Node has no such globals, so a Node program may define its own `postMessage` (worker shims written for both
 * Node and browsers do), and what it defines is its own function, never the platform's.
 *
 * `self` and the `onmessage` handler slots are also the program's to assign, as plain properties: the browser's
 * read-only `self` and its message handler slots do not exist in Node. The owner listens with `addEventListener`, which
 * an assignment to `onmessage` cannot replace.
 */
export function restrictProcessControls(globals: object): void {
  const denied = () => { throw new VMError("FEATURE_NOT_AVAILABLE", "Native worker transport and termination are private to the process owner"); };
  let scope: object | null = globals;
  while (scope !== null) {
    for (const name of ["postMessage", "close"]) {
      if (scope !== globals && Object.getOwnPropertyDescriptor(scope, name) === undefined) continue;
      // Also replace prototype methods: shadowing only the global property
      // would leave an application-callable, unaccounted transport bypass.
      Object.defineProperty(scope, name, { value: denied, writable: scope === globals, enumerable: true, configurable: false });
    }
    const parent: unknown = Object.getPrototypeOf(scope);
    if (parent !== null && typeof parent !== "object") throw new TypeError("Invalid process global prototype");
    scope = parent;
  }
  for (const [name, value] of [["self", globals], ["onmessage", null], ["onmessageerror", null]] as const) {
    if (Object.getOwnPropertyDescriptor(globals, name)?.configurable === false) continue;
    Object.defineProperty(globals, name, { value, writable: true, enumerable: true, configurable: true });
  }
}
