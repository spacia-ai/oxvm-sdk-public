import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { record } from "../../decode.js";
import { createNodeWorkerThreads } from "./node-worker-threads.js";

// Recorded from the real binary by the script under "recorder" (docker run --rm node:24.18.1-alpine node rec-locks.cjs).
const control = record(JSON.parse(readFileSync(new URL("./node-worker-locks.controls.json", import.meta.url), "utf8")), "locks controls");
const scenarios: unknown = control["scenarios"];
if (!Array.isArray(scenarios)) throw new TypeError("no scenarios");

/** The recorder's own description of an error and its own serialisation of a logged line. */
function show(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code: unknown = Reflect.get(error, "code");
  return { name: error.name, code, message: error.message, ctor: error.constructor.name, isDOMException: error instanceof DOMException };
}
function json(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value, (_key, item: unknown) => item === undefined ? "$undefined" : typeof item === "symbol" ? String(item) : item));
  return parsed;
}
async function run(code: string): Promise<unknown[]> {
  const lines: unknown[] = [];
  // A fresh manager per scenario, as each recording started with no lock held; the recorded process had pid 1.
  const locks = createNodeWorkerThreads(globalThis, { clientId: () => "node-1-0" })["locks"];
  const env = { locks, show, log: (...values: unknown[]): void => { lines.push(json(values)); }, turn: (): Promise<void> => new Promise(resolve => { setImmediate(resolve); }), gate: (): PromiseWithResolvers<unknown> => Promise.withResolvers<unknown>() };
  const scenario: unknown = runInThisContext(`(async function (env) {${code}\n})`);
  if (typeof scenario !== "function") throw new TypeError("not a scenario");
  try { await Reflect.apply(scenario, undefined, [env]); }
  catch (error) { lines.push(["SCENARIO THREW", json(show(error))]); }
  return lines;
}

describe("worker_threads.locks against Node.js v24.18.1", () => {
  it.each(scenarios.map((entry: unknown) => { const scenario = record(entry, "scenario"); return [String(scenario["name"]), scenario] as const; }))("%s", async (_name, scenario) => {
    expect(await run(String(scenario["code"]))).toEqual(scenario["log"]);
  });

  it("keeps each process's locks to itself", async () => {
    const first = createNodeWorkerThreads(globalThis)["locks"], second = createNodeWorkerThreads(globalThis, { clientId: () => "node-7-0" })["locks"];
    const request = (manager: unknown, ...args: unknown[]): Promise<unknown> => {
      const method: unknown = Reflect.get(Object(manager), "request");
      if (typeof method !== "function") throw new TypeError("no request");
      const result: unknown = Reflect.apply(method, manager, args);
      return Promise.resolve(result);
    };
    const gate = Promise.withResolvers<undefined>();
    const held = request(first, "shared-name", () => gate.promise);
    expect(await request(second, "shared-name", { ifAvailable: true }, (lock: unknown) => lock === null ? "busy" : "free")).toBe("free");
    expect(await request(first, "shared-name", { ifAvailable: true }, (lock: unknown) => lock === null ? "busy" : "free")).toBe("busy");
    gate.resolve(undefined);
    await held;
  });
});
