import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { createProcessBinding } from "./node-process-binding.js";

const constants = { fs: Object.freeze({ O_RDONLY: 0, O_CREAT: 64 }), os: Object.freeze({ signals: Object.freeze({ SIGINT: 2 }) }) };

it("returns the file and operating-system constants for process.binding('constants')", () => {
  const binding = createProcessBinding(constants);
  expect(binding.name).toBe("binding");
  const result = binding("constants");
  expect(result).toEqual({ fs: constants.fs, os: constants.os });
  // Emscripten's file layer reads the open flags from here.
  expect(result).toMatchObject({ fs: { O_CREAT: 64 } });
});

it("refuses every other internal binding as a remembered limitation", () => {
  const binding = createProcessBinding(constants);
  for (const name of ["fs", "natives", "", 7, undefined]) {
    let thrown: unknown;
    try { binding(name); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(VMError);
    expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin" } });
  }
  expect(() => binding("fs")).toThrow(/process\.binding\('fs'\)/u);
});
