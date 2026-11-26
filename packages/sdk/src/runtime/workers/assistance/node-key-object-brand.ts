/**
 * Which objects are `node:crypto` KeyObjects. A leaf with no imports, so `util.types.isKeyObject` can ask without
 * loading the key code, and the key code can answer without loading `node:util`.
 */
const keyObjects = new WeakSet<object>();

export function markKeyObject(key: object): void { keyObjects.add(key); }

export function isKeyObject(value: unknown): boolean { return typeof value === "object" && value !== null && keyObjects.has(value); }
