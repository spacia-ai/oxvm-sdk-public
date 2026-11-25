import { expect, it, vi } from "vitest";
import { restrictProcessControls } from "./process-controls.js";

const refusal = /private to the process owner/u;
/** A worker scope as browsers lay one out: the operations either on the global object itself or on a prototype. */
function scopes(own: boolean) {
  const postMessage = vi.fn(), close = vi.fn(), prototype: object = own ? {} : { postMessage, close }, root: object = { postMessage, close };
  Object.setPrototypeOf(prototype, root);
  const scope: object = own ? { postMessage, close } : {}; Object.setPrototypeOf(scope, prototype);
  Object.defineProperty(scope, "self", { get: () => scope, enumerable: true, configurable: true });
  let handler: unknown = null;
  Object.defineProperty(scope, "onmessage", { get: () => handler, set: (value: unknown) => { handler = value; }, enumerable: true, configurable: true });
  return { scope, prototype, root, postMessage, close, handler: () => handler };
}
/** Every value reachable under a name from the scope, however the program asks. */
function reachable(scope: object, name: string): unknown[] {
  const found: unknown[] = [Reflect.get(scope, name)];
  for (let object: object | null = scope; object !== null; object = Reflect.getPrototypeOf(object)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, name);
    if (descriptor !== undefined) found.push(descriptor.value, descriptor.get, descriptor.set);
  }
  return found.filter(value => value !== undefined);
}

for (const own of [true, false]) {
  it(`keeps the platform controls private after the owner captured its transport (operations ${own ? "on the global object" : "on a prototype"})`, () => {
    const { scope, prototype, root, postMessage, close } = scopes(own);
    const ownerPost = postMessage.bind(scope);
    restrictProcessControls(scope);
    ownerPost("owner"); expect(postMessage).toHaveBeenCalledWith("owner");
    for (const key of ["postMessage", "close"]) {
      for (const value of reachable(scope, key)) {
        expect(value).not.toBe(postMessage); expect(value).not.toBe(close);
        if (typeof value !== "function") throw new TypeError("not a function");
        expect((): unknown => Reflect.apply(value, scope, ["guest"])).toThrow(refusal);
      }
      // Final on every prototype that had one.
      for (const object of own ? [root] : [prototype, root]) {
        expect(Reflect.set(object, key, vi.fn(), object)).toBe(false);
        expect(Reflect.deleteProperty(object, key)).toBe(false);
        expect(Reflect.defineProperty(object, key, { get: () => postMessage })).toBe(false);
      }
    }
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it(`lets the program define its own postMessage and close without ever handing back the platform's (operations ${own ? "on the global object" : "on a prototype"})`, () => {
    const { scope, postMessage, close } = scopes(own);
    restrictProcessControls(scope);
    for (const key of ["postMessage", "close"]) {
      // Nothing the program does to the name uncovers what was there before.
      expect(Reflect.deleteProperty(scope, key)).toBe(false);
      expect(Reflect.defineProperty(scope, key, { get: () => undefined })).toBe(false);
      expect(Reflect.defineProperty(scope, key, { value: 1, configurable: true })).toBe(false);
      const mine = vi.fn(() => "mine");
      expect(Reflect.set(scope, key, mine)).toBe(true);
      expect(Reflect.get(scope, key)).toBe(mine);
      Object.assign(scope, { [key]: mine });
      expect(Reflect.deleteProperty(scope, key)).toBe(false);
      for (const value of reachable(scope, key)) { expect(value).not.toBe(postMessage); expect(value).not.toBe(close); }
      const current: unknown = Reflect.get(scope, key);
      expect(typeof current === "function" ? Reflect.apply(current, scope, ["x"]) : undefined).toBe("mine");
    }
    expect(postMessage).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
}

it("makes self and the message handler slots the program's plain properties, leaving the platform's slots untouched", () => {
  const { scope, handler } = scopes(true);
  const owner = vi.fn(); Reflect.set(scope, "onmessage", owner);
  restrictProcessControls(scope);
  expect(Reflect.get(scope, "self")).toBe(scope);
  expect(handler()).toBe(owner);
  const mine = vi.fn(), other = {};
  Object.assign(scope, { self: scope, onmessage: mine });
  expect([Reflect.get(scope, "onmessage"), handler()]).toEqual([mine, owner]);
  expect(Reflect.set(scope, "self", other)).toBe(true);
  expect(Reflect.get(scope, "self")).toBe(other);
  expect(Reflect.get(scope, "onmessageerror")).toBeNull();
});

it("leaves a slot it cannot redefine as it is", () => {
  const scope = {}; Object.defineProperty(scope, "self", { get: () => scope, configurable: false });
  expect(() => { restrictProcessControls(scope); }).not.toThrow();
  expect(Reflect.get(scope, "self")).toBe(scope);
});
