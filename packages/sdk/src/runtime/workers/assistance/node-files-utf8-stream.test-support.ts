import { createAsyncContext } from "./async-context.js";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";
import { createMemoryLinux, scenarioHelpers } from "./node-files-gaps.test-support.ts";
import { createNodeUtf8Stream, type Utf8StreamPorts } from "./node-files-utf8-stream.ts";
import { createNodePath } from "./node-path.ts";
import { EventEmitter } from "./node-streams.js";
import { inspectValue } from "./node-util-validators.ts";

const EVENTS = ["ready", "drain", "drop", "write", "finish", "close", "error"];
const immediate = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** The process ports a stream needs, driven by the test: a clock that only moves when told to, counted holds, and the
 * exceptions that would reach the process as uncaught. */
export function createStreamPorts() {
  const base = scenarioHelpers([]);
  const uncaught: unknown[] = [];
  const guarded = (callback: () => void) => (): void => { try { callback(); } catch (error) { uncaught.push(base.err(error)); } };
  const held = { now: 0, total: 0 };
  const retain = (): (() => void) => { held.now += 1; held.total += 1; let released = false; return () => { if (!released) { released = true; held.now -= 1; } }; };
  let clock = 0, order = 0;
  const timers = new Set<{ readonly callback: () => void; readonly period: number | undefined; due: number; readonly order: number; referenced: boolean; unref(): unknown }>();
  const arm = (callback: () => void, milliseconds: number, repeat: boolean) => {
    const timer = { callback, period: repeat ? milliseconds : undefined, due: clock + milliseconds, order: order++, referenced: true, unref() { timer.referenced = false; return timer; } };
    timers.add(timer); return timer;
  };
  const slept: number[] = [];
  /** Moves the clock, running each timer that comes due and whatever it started. */
  async function advance(milliseconds: number): Promise<void> {
    const until = clock + milliseconds;
    for (;;) {
      const next = [...timers].filter(timer => timer.due <= until).sort((left, right) => left.due - right.due || left.order - right.order)[0];
      if (next === undefined) break;
      clock = next.due;
      if (next.period === undefined) timers.delete(next); else next.due += next.period;
      guarded(next.callback)();
      await settle();
    }
    clock = until;
    await settle();
  }
  async function settle(): Promise<void> { for (let round = 0; round < 16; round += 1) await immediate(); }
  const scheduling = {
    timers: { setTimeout: (callback: () => void, milliseconds: number) => arm(callback, milliseconds, false), setInterval: (callback: () => void, milliseconds: number) => arm(callback, milliseconds, true),
      clearInterval: (timer: object): void => { for (const known of timers) if (known === timer) timers.delete(known); } },
    nextTick: (callback: () => void): void => { process.nextTick(guarded(callback)); },
    retain, dirname: createNodePath(() => "/work").dirname, sleep: (milliseconds: number): void => { slept.push(milliseconds); }, EventEmitter,
  } satisfies Omit<Utf8StreamPorts, "fs">;
  return { scheduling, base, uncaught, guarded, held, timers, slept, advance, settle };
}

/** `fs` with `Utf8Stream`, as the process runtime assembles it, over a memory Linux; and the recorder's `h`. */
export function createStreamFs(directory: string) {
  const ports = createStreamPorts(), { base, uncaught } = ports;
  const linux = createMemoryLinux("/work");
  linux.seed({ [directory]: null });
  const files = createSyncFiles(operation => linux.call(operation), () => "/work", 10, inspectValue);
  // Linux answers in a later turn of the event loop, as the file service does: after the ticks the caller queued.
  const asynchronous = createAsyncFiles(operation => immediate().then(() => linux.call(operation)), () => "/work", createAsyncContext(), ports.scheduling.retain,
    callback => { queueMicrotask(ports.guarded(callback)); }, { copyOpenMode: 10, inspect: inspectValue });
  const module = { ...files, ...asynchronous };
  const fs = { ...module, ...createNodeUtf8Stream({ ...ports.scheduling, fs: module }) };
  const show = (value: unknown): unknown => base.Buffer.isBuffer(value) ? { hex: value.toString("hex") } : value instanceof Error ? base.err(value) : value;
  const read = (stream: unknown, name: string): unknown => Reflect.get(Object(stream), name);
  const subscribe = (stream: unknown, method: "on" | "once", name: string, listener: (...args: unknown[]) => void): void => {
    const subscription: unknown = read(stream, method);
    if (typeof subscription !== "function") throw new TypeError("not an emitter");
    Reflect.apply(subscription, stream, [name, listener]);
  };
  const h = {
    Buffer: base.Buffer, dir: directory, uncaught, err: base.err, show, attempt: (run: () => unknown): unknown => base.attempt(run),
    log(stream: unknown, events: readonly string[] = EVENTS): unknown[] { const seen: unknown[] = []; for (const name of events) subscribe(stream, "on", name, (...args) => { seen.push([name, ...args.map(show)]); }); return seen; },
    event: (stream: unknown, name: string): Promise<unknown[]> => new Promise(resolve => { subscribe(stream, "once", name, (...args) => { resolve(args.map(show)); }); }),
    turns: ports.settle, sleep: ports.advance,
    text: (file: string): string => String(files.readFileSync(file, "utf8")),
    mode: (file: string): number => (files.statSync(file)?.mode ?? 0) & 0o777,
    state(stream: unknown): Record<string, unknown> {
      const mode = read(stream, "mode"), fd = read(stream, "fd");
      return { mode: mode === undefined ? "undefined" : mode, file: read(stream, "file"), fd: fd === -1 ? -1 : typeof fd === "number" ? "open" : typeof fd, minLength: read(stream, "minLength"), maxLength: read(stream, "maxLength"),
        writing: read(stream, "writing"), sync: read(stream, "sync"), fsync: read(stream, "fsync"), append: read(stream, "append"), periodicFlush: read(stream, "periodicFlush"), contentMode: read(stream, "contentMode"), mkdir: read(stream, "mkdir") };
    },
  };
  return { ...ports, linux, fs, h };
}
