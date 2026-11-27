import { expect, it } from "vitest";
import { createSyncFiles } from "./node-files.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";

// Recorded from Node.js: on Linux `fs.symlink` validates its Windows-only `type` argument and then ignores it.
// npm's bin-links passes "file" for every `node_modules/.bin` link.
const RULE = "The argument 'type' must be one of: 'dir', 'file', 'junction', null, undefined.";

function files() {
  const operations: AssistanceOperation[] = [];
  const fs = createSyncFiles(operation => { operations.push(operation); return { kind: "unit" }; }, () => "/workspace");
  return { fs, operations };
}

it("accepts and ignores every symlink type Node accepts", () => {
  const { fs, operations } = files();
  for (const type of [undefined, null, "file", "dir", "junction"]) Reflect.apply(fs.symlinkSync, fs, ["../eslint/bin/eslint.js", "link", type]);
  expect(operations).toEqual(Array.from({ length: 5 }, () => ({ kind: "symlink", path: "link", target: "../eslint/bin/eslint.js" })));
});

it("refuses any other symlink type with Node's error before guest I/O", () => {
  const { fs, operations } = files();
  for (const [type, received] of [["x", "'x'"], [5, "5"], [{}, "{}"]] as const) {
    let failure: unknown;
    try { Reflect.apply(fs.symlinkSync, fs, ["target", "link", type]); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ code: "ERR_INVALID_ARG_VALUE", message: `${RULE} Received ${received}` });
  }
  expect(operations).toEqual([]);
});
