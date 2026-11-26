import { readFileSync } from "node:fs";
import { deprecate, format, inspect } from "node:util";
import { runInThisContext } from "node:vm";
import { describe, expect, it, onTestFinished } from "vitest";
import { record } from "../../decode.js";
import { EventEmitter } from "./node-streams.js";
import { createNodeEvents } from "./node-events.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeAsyncHooks } from "./node-async-hooks.js";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node rec-events.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-events-on.controls.json", import.meta.url), "utf8")), "events controls");
const scenarios: unknown = control["scenarios"];
if (!Array.isArray(scenarios)) throw new TypeError("no scenarios");

function builtin() {
  const events = createNodeEvents(EventEmitter, createNodeAsyncHooks(createAsyncContext(), { deprecate, format, inspect }), callback => { process.nextTick(callback); });
  onTestFinished(events.restore);
  return events.module;
}
/** The recorder's own description of an error and its own serialisation of a logged line. */
function show(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code: unknown = Reflect.get(error, "code"), cause: unknown = error.cause;
  return { name: error.name, code, message: error.message, ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : cause }) };
}
function json(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value, (_key, item: unknown) => item === undefined ? "$undefined" : typeof item === "symbol" ? String(item) : item));
  return parsed;
}
async function run(code: string): Promise<unknown[]> {
  const lines: unknown[] = [];
  const env = { events: builtin(), show, log: (...values: unknown[]): void => { lines.push(json(values)); }, turn: (): Promise<void> => new Promise(resolve => { setImmediate(resolve); }) };
  const scenario: unknown = runInThisContext(`(async function (env) {${code}\n})`);
  if (typeof scenario !== "function") throw new TypeError("not a scenario");
  try { await Reflect.apply(scenario, undefined, [env]); }
  catch (error) { lines.push(["SCENARIO THREW", json(show(error))]); }
  return lines;
}

describe("events.on, events.once and the listener statics against Node.js v24.18.1", () => {
  it.each(scenarios.map((entry: unknown) => { const scenario = record(entry, "scenario"); return [String(scenario["name"]), scenario] as const; }))("%s", async (_name, scenario) => {
    expect(await run(String(scenario["code"]))).toEqual(scenario["log"]);
  });

  it("leaves a waiting next() to the emitter alone: nothing is retained for it", async () => {
    const events = builtin(), emitter = new events();
    const iterator = events.on(emitter, "x"), pending = iterator.next();
    // Only the listeners tie the iterator to the emitter; no timer, handle or retain exists to keep a process alive.
    expect([emitter.listenerCount("x"), emitter.listenerCount("error")]).toEqual([1, 1]);
    await iterator.return();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect([emitter.listenerCount("x"), emitter.listenerCount("error")]).toEqual([0, 0]);
  });
});
