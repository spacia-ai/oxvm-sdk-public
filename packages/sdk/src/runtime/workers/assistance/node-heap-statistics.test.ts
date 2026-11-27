import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { controls } from "./node-controls.test-support.ts";
import { createNodeV8, nodeV8Memory } from "./node-memory.ts";

// Recorded from the real binary by the script embedded in the controls file.
const recorded = record(controls("node-process-memory.controls.json")["heapStatistics"], "heapStatistics");
const GIB = 1024 * 1024 * 1024;

function refusal(run: () => unknown): unknown {
  try { return { returned: run() }; }
  catch (error) { return error instanceof VMError ? [error.code, error.detail?.["api"], error.detail?.["lateFailure"]] : error; }
}
function statistics(v8: { getHeapStatistics: (...args: unknown[]) => unknown }, ...args: unknown[]): Record<string, unknown> {
  return record(v8.getHeapStatistics(...args), "heap statistics");
}

describe("v8.getHeapStatistics: the VM's configured memory as the limit, zero where nothing is measured", () => {
  it("has the function, fields and field types of Node.js v24.18.1", () => {
    const v8 = createNodeV8({ heapLimit: () => 2 * GIB });
    const { getHeapStatistics } = v8;
    expect([typeof getHeapStatistics, getHeapStatistics.name, getHeapStatistics.length]).toEqual(recorded["fn"]);
    const answer = statistics(v8);
    expect(Object.keys(answer)).toEqual(recorded["keys"]);
    expect(Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, typeof value]))).toEqual(recorded["types"]);
    expect(Object.getPrototypeOf(answer) === Object.prototype).toBe(recorded["proto"]);
    // A fresh object on every call, and arguments are ignored, as in Node.
    expect(statistics(v8) !== answer).toBe(recorded["fresh"]);
    expect(Object.keys(statistics(v8, 1, "two", {}))).toHaveLength(Number(recorded["ignoresArguments"]));
  });

  it("states the configured memory as the limit and as what is available, one context, and zero for every other field", () => {
    expect(statistics(createNodeV8({ heapLimit: () => 2 * GIB }))).toEqual({
      total_heap_size: 0, total_heap_size_executable: 0, total_physical_size: 0, total_available_size: 2 * GIB,
      used_heap_size: 0, heap_size_limit: 2 * GIB, malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0,
      number_of_native_contexts: 1, number_of_detached_contexts: 0, total_global_handles_size: 0,
      used_global_handles_size: 0, external_memory: 0,
    });
  });

  it("reads the limit on every call", () => {
    let limit = GIB;
    const v8 = createNodeV8({ heapLimit: () => limit });
    expect(statistics(v8)["heap_size_limit"]).toBe(GIB);
    limit = 3 * GIB;
    expect(statistics(v8)["heap_size_limit"]).toBe(3 * GIB);
  });

  it("is refused without a configured limit, and for a limit that is not a positive count of bytes", () => {
    const refused = ["FEATURE_NOT_AVAILABLE", "v8.getHeapStatistics", "unavailable-builtin"];
    expect(refusal(() => nodeV8Memory.getHeapStatistics())).toEqual(refused);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(refusal(() => createNodeV8({ heapLimit: () => limit }).getHeapStatistics()), String(limit)).toEqual(refused);
    }
  });

  it("does not catch a failure of the limit's own source", () => {
    const failure = new VMError("PROTOCOL_ERROR", "Invalid Linux OS information");
    expect(() => createNodeV8({ heapLimit: () => { throw failure; } }).getHeapStatistics()).toThrow(failure);
  });

  it("leaves the per-space and code statistics refused", () => {
    const v8 = createNodeV8({ heapLimit: () => 2 * GIB });
    for (const name of ["getHeapSpaceStatistics", "getHeapCodeStatistics"] as const) {
      expect(refusal(() => v8[name]()), name).toEqual(["FEATURE_NOT_AVAILABLE", `v8.${name}`, "unavailable-builtin"]);
    }
  });
});
