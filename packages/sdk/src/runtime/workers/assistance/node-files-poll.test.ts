import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryFs, readScenarios, runScenario, scenarioHelpers } from "./node-files-gaps.test-support.ts";

/** `fs.watchFile`, `fs.unwatchFile` and `fs.promises.watch`. The scenarios ran in `node:24.18.1-alpine`; `sequence`,
 * `api` and `watch` run again here unchanged, with the poll timer fired by hand where the recorder slept.
 * `watch-events` depends on inotify's own event sequences and is the source of the expectations written out below. */
const scenarios = readScenarios(readFileSync(new URL("./node-files-poll.controls.json", import.meta.url), "utf8"));
const scenario = (name: string) => { const found = scenarios.find(item => item.name === name); if (found === undefined) throw new TypeError(`no scenario ${name}`); return found; };
function replay(name: string) {
  const memory = createMemoryFs(), fire = (): void => { for (const timer of [...memory.intervals]) timer.callback(); };
  return { memory, run: runScenario(scenario(name).source, memory.fs, scenarioHelpers(memory.warnings, fire)) };
}

describe("fs.watchFile", () => {
  it("reports create, modify, delete and recreate as Node's stat watcher does", async () => {
    const { memory, run } = replay("sequence");
    expect(await run).toEqual(scenario("sequence").result);
    expect([memory.intervals.size, memory.held.now]).toEqual([0, 0]);
  });

  it("has Node's watcher object, listener bookkeeping and argument errors", async () => {
    const { memory, run } = replay("api");
    expect(await run).toEqual(scenario("api").result);
    expect(memory.intervals.size).toBe(0);
  });

  it("polls on the process's timer: persistent keeps it referenced, and the default interval is 5007", async () => {
    const memory = createMemoryFs({ f: "x" }), noop = (): void => undefined;
    const watcher = memory.fs.watchFile("f", noop, undefined);
    expect([...memory.intervals].map(timer => [timer.milliseconds, timer.referenced])).toEqual([[5007, true]]);
    watcher.unref();
    expect([...memory.intervals][0]?.referenced).toBe(false);
    watcher.ref();
    expect([...memory.intervals][0]?.referenced).toBe(true);
    memory.fs.unwatchFile("f", undefined);
    memory.fs.watchFile("f", { persistent: false, interval: 0 }, noop);
    // libuv never polls in a busy loop: an interval of 0 is 1 ms.
    expect([...memory.intervals].map(timer => [timer.milliseconds, timer.referenced])).toEqual([[1, false]]);
    // The first stat is under way: the process stays until its answer is in, even though the timer is not referenced.
    expect(memory.held.now).toBeGreaterThan(0);
    await new Promise(resolve => { setImmediate(resolve); });
    expect(memory.held.now).toBe(0);
    memory.fs.unwatchFile("f", undefined);
    expect(memory.intervals.size).toBe(0);
  });
});

describe("fs.promises.watch", () => {
  it("validates, aborts and ends as Node does", async () => {
    const { run } = replay("watch");
    expect(await run).toEqual(scenario("watch").result);
  });

  it("yields the watcher's events, in the asked encoding, and closes the watcher when the iteration ends", async () => {
    const memory = createMemoryFs({ "d/x": "" });
    const events = memory.fs.promises.watch("d", { encoding: "hex", persistent: false }), next = events.next();
    await Promise.resolve();
    expect(memory.watched.map(entry => [entry.path, entry.options, entry.closed])).toEqual([["d", { persistent: false, recursive: false, encoding: "hex" }, false]]);
    memory.watched[0]?.emitter.emit("change", "rename", "new.txt");
    const first = await next;
    // Recorded: `[false, ["eventType", "filename"], true, "rename", "new.txt"]`.
    expect([first.done, Object.keys(first.value ?? {}), Object.getPrototypeOf(first.value), first.value?.eventType, first.value?.filename]).toEqual([false, ["eventType", "filename"], null, "rename", "new.txt"]);
    expect(await events.return()).toEqual({ value: undefined, done: true });
    expect(memory.watched[0]?.closed).toBe(true);
  });

  it("bounds its queue: an error when asked, a warning otherwise", async () => {
    const memory = createMemoryFs({ "d/x": "" });
    const failing = memory.fs.promises.watch("d", { maxQueue: 1, overflow: "error" }), first = failing.next();
    await Promise.resolve();
    for (let index = 0; index < 3; index += 1) memory.watched[0]?.emitter.emit("change", "change", `q${String(index)}`);
    // Recorded: the overflow replaces what was queued.
    await expect(first).rejects.toMatchObject({ name: "Error", code: "ERR_FS_WATCH_QUEUE_OVERFLOW", message: "fs.watch() queued more than 1 events" });
    expect(await failing.next()).toEqual({ value: undefined, done: true });
    const dropping = memory.fs.promises.watch("d", { maxQueue: 1 }), kept = dropping.next();
    await Promise.resolve();
    for (let index = 0; index < 3; index += 1) memory.watched[1]?.emitter.emit("change", "change", `i${String(index)}`);
    expect((await kept).value).toMatchObject({ filename: "i0" });
    expect(memory.warnings).toEqual([["Warning", "fs.watch maxQueue exceeded"], ["Warning", "fs.watch maxQueue exceeded"]]);
    await dropping.return();
  });

  it("leaves out ignored names and passes a watcher error on", async () => {
    const memory = createMemoryFs({ "d/x": "" });
    const filtered = memory.fs.promises.watch("d", { ignore: ["*.log", /^skip/u, (name: string) => name === "fn.txt"] }), next = filtered.next();
    await Promise.resolve();
    for (const name of ["a.log", "skipped", "fn.txt", "kept.txt"]) memory.watched[0]?.emitter.emit("change", "rename", name);
    expect((await next).value?.filename).toBe("kept.txt");
    const pending = filtered.next();
    memory.watched[0]?.emitter.emit("error", new RangeError("lost"));
    await expect(pending).rejects.toThrow(RangeError);
    expect(memory.watched[0]?.closed).toBe(true);
  });
});
