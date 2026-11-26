import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readScenarios, runScenario, withDeviation } from "./node-files-gaps.test-support.ts";
import { createStreamFs } from "./node-files-utf8-stream.test-support.ts";

/** `fs.Utf8Stream`: every scenario ran in `node:24.18.1-alpine` on a tmpfs and runs again here, unchanged, over the
 * runtime's own `fs` on a memory Linux. The recording holds Node 24.18.1 as it is, with three defects of its stream:
 * `contentMode: "buffer"` loses the chunk that opens each group and then fails on a list it already consumed,
 * `periodicFlush` throws an uncaught ERR_INVALID_ARG_TYPE every period, and a partial write that ends inside a
 * multi-byte character writes that character's first bytes twice. */
const controls = readFileSync(new URL("./node-files-utf8-stream.controls.json", import.meta.url), "utf8");
const scenarios = readScenarios(controls);

describe("fs.Utf8Stream as recorded from Node", () => {
  it("has the recorded scenarios", () => { expect(scenarios.length).toBe(47); });

  /** Where the replay knowingly differs from the recording. */
  const deviations: Readonly<Record<string, (result: unknown) => unknown>> = {
    // The retry of a synchronous write blocks the thread for 100 ms in Node; the replay's sleep is counted instead.
    "eagain-sync": result => withDeviation(result, ["waited"], false),
  };

  it.each(scenarios)("$name answers as Node does", async ({ name, source, result }) => {
    const memory = createStreamFs(`/work/${name}`);
    expect(await runScenario(source, memory.fs, memory.h)).toEqual(deviations[name]?.(result) ?? result);
    await memory.settle();
    // Nothing the stream started is still holding the process, and no timer of it is referenced.
    expect(memory.held.now).toBe(0);
    expect([...memory.timers].filter(timer => timer.referenced)).toEqual([]);
    if (name === "eagain-sync") expect(memory.slept).toEqual([100, 100, 100]);
  });
});

/** What each whole program printed and how it ended in Node, by name. */
function lifetime(name: string): { readonly status: unknown; readonly stdout: unknown; readonly stderr: unknown } {
  const parsed: unknown = JSON.parse(controls);
  const entry: unknown = Reflect.get(Object(Reflect.get(Object(parsed), "lifetime")), name);
  return { status: Reflect.get(Object(entry), "status"), stdout: Reflect.get(Object(entry), "stdout"), stderr: Reflect.get(Object(entry), "stderr") };
}

describe("fs.Utf8Stream and the life of the process", () => {
  it("holds the process while an asynchronous open or write is in flight", async () => {
    // Node: the program ends by itself with every byte in the file.
    expect(lifetime("pending-write")).toEqual({ status: 0, stdout: JSON.stringify({ size: 1_048_576, writing: false }), stderr: [] });
    const { fs, h, held, settle } = createStreamFs("/work/lifetime");
    const stream = new fs.Utf8Stream({ dest: "/work/lifetime/a.log" });
    expect(held.now).toBeGreaterThan(0);
    for (let index = 0; index < 64; index += 1) stream.write(`${"x".repeat(16_383)}\n`);
    let complete = false;
    while (!complete) {
      // Until the last write has landed, something of the stream holds the process.
      expect(held.now).toBeGreaterThan(0);
      await new Promise(resolve => { setImmediate(resolve); });
      complete = h.text("/work/lifetime/a.log").length === 1_048_576 && !stream.writing;
    }
    await settle();
    expect(held.now).toBe(0);
  });

  it("does not hold the process for buffered text or for the periodic flush", async () => {
    expect(lifetime("buffered-at-exit")).toEqual({ status: 0, stdout: JSON.stringify({ size: 0, early: true }), stderr: [] });
    const { fs, h, held, timers, settle } = createStreamFs("/work/lifetime");
    const stream = new fs.Utf8Stream({ dest: "/work/lifetime/b.log", minLength: 100, periodicFlush: 60_000 });
    stream.write("never written\n");
    await settle();
    expect(held.now).toBe(0);
    expect([...timers].map(timer => [timer.period, timer.referenced])).toEqual([[60_000, false]]);
    expect(h.text("/work/lifetime/b.log")).toBe("");
    stream.destroy();
    await settle();
    expect(timers.size).toBe(0);
  });

  it("waits for the retry of a refused write on a referenced timer", async () => {
    expect(lifetime("retry-timer")).toEqual({ status: 0, stdout: JSON.stringify({ text: "after the retry\n" }), stderr: [] });
    const { fs, h, held, timers, settle, advance } = createStreamFs("/work/lifetime");
    let fail = true;
    const stream = new fs.Utf8Stream({ dest: "/work/lifetime/c.log", fs: { write(fd: number, data: string, encoding: string, callback: (error: unknown, written?: number) => void): void {
      if (fail) { fail = false; callback(Object.assign(new Error("again"), { code: "EAGAIN" })); return; }
      fs.write(fd, data, null, encoding, callback);
    } } });
    stream.write("after the retry\n");
    await settle();
    expect([held.now, [...timers].map(timer => [timer.period, timer.due, timer.referenced])]).toEqual([0, [[undefined, 100, true]]]);
    await advance(100);
    expect([h.text("/work/lifetime/c.log"), timers.size, held.now]).toEqual(["after the retry\n", 0, 0]);
  });

  it("calls a pending flush callback before the process may end", async () => {
    expect(lifetime("pending-flush")).toEqual({ status: 0, stdout: JSON.stringify({ called: true, text: "flushed\n" }), stderr: [] });
    const { fs, h, held } = createStreamFs("/work/lifetime");
    const stream = new fs.Utf8Stream({ dest: "/work/lifetime/d.log", minLength: 100 });
    stream.write("flushed\n");
    let called = false;
    stream.flush(() => { called = true; });
    while (held.now > 0) await new Promise(resolve => { setImmediate(resolve); });
    expect([called, h.text("/work/lifetime/d.log")]).toEqual([true, "flushed\n"]);
  });

  it("throws out of the periodic flush as Node 24.18.1 does", async () => {
    // Node: the first period ends the program with the uncaught error.
    expect(lifetime("periodic-flush-crash")).toEqual({ status: 1, stdout: "", stderr: ['TypeError [ERR_INVALID_ARG_TYPE]: The "cb" argument must be of type function. Received null', "code: 'ERR_INVALID_ARG_TYPE'"] });
    const { fs, uncaught, advance } = createStreamFs("/work/lifetime");
    const stream = new fs.Utf8Stream({ dest: "/work/lifetime/e.log", minLength: 100, periodicFlush: 50 });
    stream.write("x\n");
    await advance(120);
    expect(uncaught).toEqual([1, 2].map(() => ({ name: "TypeError", ctor: "TypeError", code: "ERR_INVALID_ARG_TYPE", message: 'The "cb" argument must be of type function. Received null' })));
    stream.destroy();
  });
});
