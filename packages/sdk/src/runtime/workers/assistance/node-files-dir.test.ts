import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryFs, readScenarios, runScenario, scenarioHelpers } from "./node-files-gaps.test-support.ts";

/** `fs.Dir` and the `opendir` forms: every scenario ran in `node:24.18.1-alpine` and runs again here, unchanged. */
const scenarios = readScenarios(readFileSync(new URL("./node-files-dir.controls.json", import.meta.url), "utf8"));

describe("fs.Dir and opendir", () => {
  it("has the recorded scenarios", () => { expect(scenarios.map(scenario => scenario.name)).toEqual(["async", "errors", "options", "shape", "sync"]); });

  it.each(scenarios)("$name answers as Node does", async ({ source, result }) => {
    const memory = createMemoryFs();
    expect(await runScenario(source, memory.fs, scenarioHelpers([]))).toEqual(result);
    expect(memory.held.now).toBe(0);
  });

  it("keeps the process alive while an asynchronous read or open is pending", async () => {
    const memory = createMemoryFs({ "d/a": "" });
    const directory = memory.fs.opendirSync("d", undefined);
    const before = memory.held.now, pending = directory.read();
    expect(memory.held.now).toBe(before + 1);
    await pending;
    expect(memory.held.now).toBe(before);
    const opening = memory.fs.promises.opendir("d");
    expect(memory.held.now).toBeGreaterThan(before);
    await (await opening).close();
    expect(memory.held.now).toBe(before);
  });
});
