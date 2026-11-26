import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryFs, readScenarios, runScenario, scenarioHelpers, withDeviation } from "./node-files-gaps.test-support.ts";

/** `exists`, the vectored reads and writes, `openAsBlob`, `_toUnixTimestamp`, the disposable temporary directories and
 * the small aliases: every scenario ran in `node:24.18.1-alpine` and runs again here, unchanged. */
const scenarios = readScenarios(readFileSync(new URL("./node-files-misc.controls.json", import.meta.url), "utf8"));

describe("small fs additions", () => {
  it("has the recorded scenarios", () => { expect(scenarios.map(scenario => scenario.name)).toEqual(["aliases", "blob", "exists", "temporary", "timestamp", "vectored"]); });

  /** Where this layer knowingly differs from the recording. */
  const deviations: Readonly<Record<string, (result: unknown) => unknown>> = {
    // Node's module object holds the stream classes behind accessors; the runtime's `fs` holds them as plain values.
    aliases: result => withDeviation(result, ["descriptors"], [null, null, null, null].map(() => ["undefined", "undefined", true, true, true])),
    // Node answers a Blob of the directory's size that then fails to read; the bytes are read here, so opening fails.
    blob: result => withDeviation(result, ["errors", "directory"], { error: { name: "TypeError", ctor: "TypeError", message: "Unable to open file as blob", code: "ERR_INVALID_ARG_VALUE" } }),
  };

  it.each(scenarios)("$name answers as Node does", async ({ name, source, result }) => {
    const memory = createMemoryFs();
    expect(await runScenario(source, memory.fs, scenarioHelpers([]))).toEqual(deviations[name]?.(result) ?? result);
    expect(memory.held.now).toBe(0);
  });
});
