import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { fsModeConstants, nodeConstantsModule, osExtraConstants } from "./node-constants.ts";

// Recorded from the real binary (`docker run --rm node:24.18.1-alpine node --no-deprecation -e`), printing
// require("constants"), require("fs").constants and the priority, dlopen and UV_UDP_REUSEADDR of require("os").constants.
const control = record(JSON.parse(readFileSync(new URL("./node-constants.controls.json", import.meta.url), "utf8")), "constants controls");
const recorded = (name: string): Record<string, unknown> => record(control[name], name);
const shape = (table: object): string[] => Object.values(Object.getOwnPropertyDescriptors(table)).map(({ enumerable, writable, configurable }) => [enumerable, writable, configurable].join());

it("was recorded from pinned Node on Linux x64", () => {
  expect(control["node"]).toEqual({ version: "v24.18.1", arch: "x64", platform: "linux" });
});

it("holds exactly the constants module of pinned Node, in its key order", () => {
  const expected = recorded("constants");
  expect(nodeConstantsModule).toEqual(expected);
  expect(Reflect.ownKeys(nodeConstantsModule)).toEqual(Object.keys(expected));
  expect(Reflect.ownKeys(nodeConstantsModule)).toHaveLength(234);
  expect(Object.getPrototypeOf(nodeConstantsModule)).toBe(Object.prototype);
  expect(Object.isFrozen(nodeConstantsModule)).toBe(true);
  expect(nodeConstantsModule.defaultCoreCipherList.split(":").slice(0, 3)).toEqual(["TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256", "TLS_AES_128_GCM_SHA256"]);
  // Pinned Node has no `defaultCipherList` key in this module, only on crypto.constants.
  expect(Reflect.has(nodeConstantsModule, "defaultCipherList")).toBe(false);
});

it("holds exactly fs.constants of pinned Node with Node's property shape", () => {
  const expected = recorded("fs");
  expect({ ...fsModeConstants }).toEqual(expected);
  expect(Reflect.ownKeys(fsModeConstants)).toEqual(Object.keys(expected));
  expect(Reflect.ownKeys(fsModeConstants)).toHaveLength(56);
  expect(Object.getPrototypeOf(fsModeConstants)).toBeNull();
  expect(new Set(shape(fsModeConstants))).toEqual(new Set(["true,false,false"]));
  expect(Reflect.set(fsModeConstants, "O_RDONLY", 7)).toBe(false);
  expect(fsModeConstants.O_RDONLY).toBe(0);
  // Every fs constant is also a member of the `constants` module, with the same value.
  for (const [name, value] of Object.entries(fsModeConstants)) expect(Reflect.get(nodeConstantsModule, name)).toBe(value);
});

it("holds the priority, dlopen and UDP constants of os.constants", () => {
  const expected = recorded("os");
  expect(Reflect.ownKeys(osExtraConstants)).toEqual(["UV_UDP_REUSEADDR", "dlopen", "priority"]);
  expect(osExtraConstants.UV_UDP_REUSEADDR).toBe(expected["UV_UDP_REUSEADDR"]);
  for (const name of ["dlopen", "priority"] as const) {
    const table = osExtraConstants[name], control = record(expected[name], name);
    expect({ ...table }).toEqual(control);
    expect(Reflect.ownKeys(table)).toEqual(Object.keys(control));
    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(new Set(shape(table))).toEqual(new Set(["true,false,false"]));
  }
  expect(Object.getPrototypeOf(osExtraConstants)).toBeNull();
  expect(osExtraConstants.priority.PRIORITY_HIGHEST).toBe(-20);
});
