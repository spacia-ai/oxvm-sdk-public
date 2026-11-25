import { inspect } from "node:util";
import { expect, it } from "vitest";
import { createGetBuiltinModule } from "./node-builtin-module.js";

it("returns a built-in by either name, undefined for anything else, and validates its argument", () => {
  const loaded: string[] = [], fs = { marker: "fs" };
  const getBuiltinModule = createGetBuiltinModule(id => { loaded.push(id); return fs; }, inspect);
  expect(getBuiltinModule("fs")).toBe(fs);
  expect(getBuiltinModule("node:fs")).toBe(fs);
  for (const id of ["left-pad", "./fs", "/fs", "", "node:", "node:nope", "FS"]) expect(getBuiltinModule(id), id).toBeUndefined();
  expect(loaded).toEqual(["fs", "node:fs"]);
  for (const id of [undefined, null, 1, {}, Symbol("fs")]) expect(() => getBuiltinModule(id)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect([getBuiltinModule.name, getBuiltinModule.length]).toEqual(["getBuiltinModule", 1]);
});

it("lets a built-in this runtime lacks fail as the loader reports it", () => {
  const refusal = new Error("builtin is not supported");
  const getBuiltinModule = createGetBuiltinModule(() => { throw refusal; }, inspect);
  expect(() => getBuiltinModule("node:inspector")).toThrow(refusal);
});
