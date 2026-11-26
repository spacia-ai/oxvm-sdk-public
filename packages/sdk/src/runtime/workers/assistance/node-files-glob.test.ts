import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryFs, readScenarios, runScenario, scenarioHelpers } from "./node-files-gaps.test-support.ts";

/** `fs.glob`, `fs.globSync` and `fs.promises.glob`: every scenario ran in `node:24.18.1-alpine` and runs again here,
 * unchanged. The results are compared in Node's order, which follows from its walk over sorted directory listings. */
const scenarios = readScenarios(readFileSync(new URL("./node-files-glob.controls.json", import.meta.url), "utf8"));
const scenario = (name: string) => { const found = scenarios.find(item => item.name === name); if (found === undefined) throw new TypeError(`no scenario ${name}`); return found; };
const rows = (value: unknown): unknown[] => { const cases: unknown = Reflect.get(Object(value), "cases"); return Array.isArray(cases) ? cases : []; };

describe("fs.glob", () => {
  it("answers every recorded pattern in Node's order, in all three forms", async () => {
    const { source, result } = scenario("tree"), memory = createMemoryFs(), warnings: unknown[] = [];
    const actual = await runScenario(source, memory.fs, scenarioHelpers(warnings)), expected = rows(result), answered = rows(actual);
    expect(expected.length).toBeGreaterThanOrEqual(100);
    // Each row is compared apart so that a failure names its pattern.
    expected.forEach((row, index) => { expect(answered[index], JSON.stringify([Reflect.get(Object(row), "pattern"), Reflect.get(Object(row), "options")])).toEqual(row); });
    expect(actual).toEqual(result);
    // Node 24.18.1 no longer warns that glob is experimental.
    expect(Reflect.get(Object(result), "warnings")).toEqual([]);
    expect(memory.held.now).toBe(0);
  });

  it("validates its arguments as Node does", async () => {
    const { source, result } = scenario("errors"), memory = createMemoryFs();
    expect(await runScenario(source, memory.fs, scenarioHelpers([]))).toEqual(result);
  });
});
