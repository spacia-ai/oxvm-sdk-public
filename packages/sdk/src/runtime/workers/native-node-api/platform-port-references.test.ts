import { expect, it, vi } from "vitest";
import { createPlatformPortReferences } from "./platform-port-references.js";

function realm() {
  const close = vi.fn(), prototype: object = { close }, changed = vi.fn();
  const make = (): object => { const port: object = {}; Object.setPrototypeOf(port, prototype); return port; };
  const call = (port: object, name: string): unknown => { const method: unknown = Reflect.get(port, name); if (typeof method !== "function") throw new TypeError(name); return Reflect.apply(method, port, []); };
  return { prototype, close, changed, make, call };
}

it("holds the process open for a referenced port without a listener, until it is released or closed", () => {
  const { prototype, close, changed, make, call } = realm(), owner = createPlatformPortReferences(prototype, changed);
  const first = make(), second = make();
  expect([owner.hasReferences, call(first, "hasRef")]).toEqual([false, false]);
  expect(call(first, "ref")).toBe(first);
  expect(call(first, "ref")).toBe(first);
  expect([owner.hasReferences, call(first, "hasRef"), call(second, "hasRef")]).toEqual([true, true, false]);
  call(second, "ref");
  expect(call(first, "unref")).toBe(first);
  expect(owner.hasReferences).toBe(true);
  call(second, "close");
  expect([owner.hasReferences, call(second, "hasRef")]).toEqual([false, false]);
  expect(close).toHaveBeenCalledTimes(1);
  expect(close.mock.contexts).toEqual([second]);
  // Every change that can end the wait is reported; closing an unreferenced port is not one.
  const reported = changed.mock.calls.length;
  call(first, "close");
  expect([changed.mock.calls.length, close.mock.calls.length]).toEqual([reported, 2]);
  expect(reported).toBe(5);
});

it("refuses anything that is not a port of this realm", () => {
  const { prototype, changed } = realm(), owner = createPlatformPortReferences(prototype, changed);
  for (const name of ["ref", "unref", "hasRef", "close"]) {
    const method: unknown = Reflect.get(prototype, name);
    if (typeof method !== "function") throw new TypeError(name);
    for (const receiver of [undefined, null, {}, prototype, 1]) expect((): unknown => Reflect.apply(method, receiver, [])).toThrow(/Illegal invocation/u);
  }
  expect([owner.hasReferences, changed.mock.calls.length]).toEqual([false, 0]);
});

it("leaves a realm whose ports already have the methods as it is", () => {
  const ref = vi.fn(), close = vi.fn(), prototype: object = { ref, close };
  expect(createPlatformPortReferences(prototype, vi.fn()).hasReferences).toBe(false);
  expect([Reflect.get(prototype, "ref"), Reflect.get(prototype, "close"), Reflect.has(prototype, "unref")]).toEqual([ref, close, false]);
});
