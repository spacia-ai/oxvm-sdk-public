import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { controls } from "./node-controls.test-support.ts";
import { createProcessMemory } from "./node-process-memory.ts";
import { nodeV8Memory, processMemoryUsage } from "./node-memory.ts";

// Recorded from the real binary by the script embedded in the controls file.
const recorded = record(controls("node-process-memory.controls.json")["memoryUsage"], "memoryUsage");

/** The engine's `/proc/self/status` for a live task (crates/oxidevm-userspace/src/procfs/format.rs). */
const status = (resident: string): string => `Name:\tnode\nState:\tR (running)\nPid:\t7\nVmSize:\t  20480 kB\n${resident}VmLck:\t0 kB\nThreads:\t1\n`;
const proc = (text: string | undefined) => (path: string): string | undefined => path === "/proc/self/status" ? text : undefined;
const fn = (value: unknown): unknown => typeof value === "function" ? [typeof value, value.name, value.length] : undefined;
const descriptor = (target: object, key: string): unknown => {
  const found = Object.getOwnPropertyDescriptor(target, key);
  return found === undefined ? null : [typeof found.value, found.enumerable, found.writable, found.configurable];
};
function refusal(run: () => unknown): unknown {
  try { return { returned: run() }; }
  catch (error) { return error instanceof VMError ? [error.code, error.detail?.["api"], error.detail?.["lateFailure"]] : error; }
}

describe("process.memoryUsage on real sources only", () => {
  it("has the functions and properties of Node.js v24.18.1", () => {
    const { memoryUsage } = createProcessMemory({ readProc: proc(status("VmRSS:\t   8 kB\n")) });
    expect(fn(memoryUsage)).toEqual(recorded["fn"]);
    expect(fn(memoryUsage.rss)).toEqual(recorded["rssFn"]);
    expect(descriptor(memoryUsage, "rss")).toEqual(recorded["rssDescriptor"]);
    expect(Reflect.ownKeys(memoryUsage).map(String).sort()).toEqual(recorded["ownKeys"]);
  });

  it("reports the Linux task's resident set as rss, in bytes, read again on every call", () => {
    let text = status("VmRSS:\t   8 kB\n");
    const paths: string[] = [];
    const { memoryUsage } = createProcessMemory({ readProc: path => { paths.push(path); return text; } });
    expect(memoryUsage.rss()).toBe(8 * 1024);
    text = status("VmRSS:\t 123456 kB\n");
    expect(memoryUsage.rss()).toBe(123_456 * 1024);
    expect(paths).toEqual(["/proc/self/status", "/proc/self/status"]);
    // Node ignores arguments and the receiver.
    expect(Reflect.apply(memoryUsage.rss, null, [{}])).toBe(123_456 * 1024);
  });

  it("refuses rss when Linux does not state it, rather than answering 0", () => {
    const cases = [undefined, "", status(""), status("VmRSS:\t-1 kB\n"), status("VmRSS:\t8 MB\n"), status("VmRSS:\t8 kB\nVmRSS:\t9 kB\n"), status("VmRSS:\t99999999999999999999 kB\n")];
    for (const text of cases) {
      const { memoryUsage } = createProcessMemory({ readProc: proc(text) });
      expect(refusal(() => memoryUsage.rss()), String(text)).toEqual(["FEATURE_NOT_AVAILABLE", "process.memoryUsage.rss", "unavailable-builtin"]);
    }
  });

  it("refuses the whole of memoryUsage() without a heap source: no browser gives a worker one", () => {
    for (const ports of [{ readProc: proc(status("VmRSS:\t8 kB\n")) }, { readProc: proc(status("VmRSS:\t8 kB\n")), heap: () => undefined }]) {
      const { memoryUsage } = createProcessMemory(ports);
      expect(refusal(() => memoryUsage())).toEqual(["FEATURE_NOT_AVAILABLE", "process.memoryUsage", "unavailable-builtin"]);
      expect(memoryUsage.rss()).toBe(8192);
    }
  });

  it("with a heap source answers Node's object: measured rss and heap, and 0 only for the two fields nothing measures", () => {
    let heap = { used: 1_000_000, total: 2_500_000, limit: 4_000_000_000 };
    const { memoryUsage } = createProcessMemory({ readProc: proc(status("VmRSS:\t   8 kB\n")), heap: () => heap });
    const usage = memoryUsage();
    expect(Object.keys(usage)).toEqual(recorded["keys"]);
    expect(Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, typeof value]))).toEqual(recorded["types"]);
    expect(Object.getPrototypeOf(usage) === Object.prototype).toBe(recorded["proto"]);
    expect(usage).toEqual({ rss: 8192, heapTotal: 2_500_000, heapUsed: 1_000_000, external: 0, arrayBuffers: 0 });
    heap = { used: 3, total: 4, limit: 5 };
    expect(memoryUsage()).not.toBe(usage);
    expect(Reflect.apply(memoryUsage, null, [1, "x"])).toEqual({ rss: 8192, heapTotal: 4, heapUsed: 3, external: 0, arrayBuffers: 0 });
  });

  it("refuses when the heap source answers something that is not a heap size, or when rss is missing", () => {
    const bad = [{ used: -1, total: 5 }, { used: 1.5, total: 5 }, { used: Number.NaN, total: 5 }, { used: 6, total: 5 }, { used: 1, total: Number.POSITIVE_INFINITY }];
    for (const heap of bad) {
      const { memoryUsage } = createProcessMemory({ readProc: proc(status("VmRSS:\t8 kB\n")), heap: () => heap });
      expect(refusal(() => memoryUsage()), JSON.stringify(heap)).toEqual(["FEATURE_NOT_AVAILABLE", "process.memoryUsage", "unavailable-builtin"]);
    }
    const { memoryUsage } = createProcessMemory({ readProc: proc(status("")), heap: () => ({ used: 1, total: 2 }) });
    expect(refusal(() => memoryUsage())).toEqual(["FEATURE_NOT_AVAILABLE", "process.memoryUsage.rss", "unavailable-builtin"]);
  });

  it("lets a failure of the Linux read through unchanged", () => {
    const failure = new VMError("PROTOCOL_ERROR", "Invalid Linux OS information");
    const { memoryUsage } = createProcessMemory({ readProc: () => { throw failure; } });
    expect(() => memoryUsage.rss()).toThrow(failure);
  });
});

describe("what stays refused", () => {
  it("a process that was given no ports refuses both calls", () => {
    expect(refusal(() => processMemoryUsage())).toEqual(["FEATURE_NOT_AVAILABLE", "process.memoryUsage", "unavailable-builtin"]);
    expect(refusal(() => processMemoryUsage.rss())).toEqual(["FEATURE_NOT_AVAILABLE", "process.memoryUsage.rss", "unavailable-builtin"]);
  });

  it("v8 heap statistics: Node's 14 fields have at most three measurable counterparts", () => {
    const heap = record(controls("node-process-memory.controls.json")["heapStatistics"], "heapStatistics");
    expect(heap["keys"]).toHaveLength(14);
    // The one derivation that looked possible is not what Node reports.
    expect(heap["availableIsLimitMinusUsed"]).toBe(false);
    for (const name of ["getHeapStatistics", "getHeapSpaceStatistics", "getHeapCodeStatistics"] as const) {
      expect(refusal(() => nodeV8Memory[name]()), name).toEqual(["FEATURE_NOT_AVAILABLE", `v8.${name}`, "unavailable-builtin"]);
    }
  });
});
