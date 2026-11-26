import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryFs, readScenarios, runScenario, scenarioHelpers } from "./node-files-gaps.test-support.ts";

/** `fs.cpSync`, `fs.cp` and `fs.promises.cp`: every scenario ran in `node:24.18.1-alpine` and runs again here, unchanged. The matrix records each
 * case for `cpSync` and for `fs.promises.cp`; Node implements the two apart (C++ and JavaScript) and they differ. */
const scenarios = readScenarios(readFileSync(new URL("./node-files-cp.controls.json", import.meta.url), "utf8"));
const scenario = (name: string) => { const found = scenarios.find(item => item.name === name); if (found === undefined) throw new TypeError(`no scenario ${name}`); return found; };
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

describe("fs.cpSync, fs.cp and fs.promises.cp", () => {
  it("answers every case of the recorded matrix as Node does", async () => {
    const { source, result } = scenario("matrix"), memory = createMemoryFs();
    const actual = record(await runScenario(source, memory.fs, scenarioHelpers([]))), expected = record(result);
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(70);
    for (const [name, value] of Object.entries(expected)) {
      if (name === "shapes") { expect(actual[name], name).toEqual(value); continue; }
      expect(record(actual[name])["sync"], `${name} (cpSync)`).toEqual(record(value)["sync"]);
      expect(record(actual[name])["promise"], `${name} (promises.cp)`).toEqual(record(value)["promise"]);
    }
    expect(memory.linux.openDescriptors()).toBe(0);
  });

  it.each(["metadata", "promise"])("keeps modes and, when asked, timestamps as Node does (%s)", async name => {
    const { source, result } = scenario(name), memory = createMemoryFs();
    expect(await runScenario(source, memory.fs, scenarioHelpers([]))).toEqual(result);
    expect(memory.held.now).toBe(0);
  });
});
