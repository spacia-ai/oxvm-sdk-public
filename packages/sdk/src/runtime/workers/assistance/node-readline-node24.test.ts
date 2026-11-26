import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "buffer";
import { record, string } from "../../decode.js";
import { PassThrough } from "readable-stream";
import { EventEmitter, Writable } from "./node-streams.js";
import { createNodeReadline, createNodeReadlinePromises } from "./node-readline.js";
import { decodeValue, encodeValue, errorRow, json, list, loadControls, row, shape } from "./node-util-node24.test-support.js";

const control = loadControls("./node-readline-node24.controls.json");
const ticks: (() => void)[] = [];
const readline = createNodeReadline({ nextTick: callback => { ticks.push(callback); } });
const drain = (): void => { for (let next = ticks.shift(); next !== undefined; next = ticks.shift()) next(); };
const hex = (value: unknown): Uint8Array => Buffer.from(string(value, "hex chunk"), "hex");
afterEach(() => { vi.useRealTimers(); });

describe("node readline cursor functions, key decoder and promises module (Node 24.18.1 controls)", () => {
  it("exports Node's members with Node's names and lengths", () => {
    for (const value of list(control["functions"])) { const c = row(value), name = string(c["name"], "name"); expect(shape(Reflect.get(readline, name)), name).toEqual({ fname: c["fname"], length: c["length"] }); }
    for (const value of list(control["promisesFunctions"])) { const c = row(value), name = string(c["name"], "name"); expect(shape(Reflect.get(readline.promises, name)), `promises.${name}`).toEqual({ fname: c["fname"], length: c["length"] }); }
    expect(Object.keys(readline.promises)).toEqual(control["promisesKeys"]);
    expect(createNodeReadlinePromises(readline) === readline.promises).toBe(control["promisesSame"]);
    expect(Object.getOwnPropertyNames(readline.promises.Readline.prototype)).toEqual(control["readlineProto"]);
    expect(Object.getPrototypeOf(readline.promises.Interface.prototype) === Object.getPrototypeOf(readline.Interface.prototype)).toBe(control["interfaceExtends"]);
  });

  it("writes the recorded CSI sequences, returns what the stream returned and validates as Node does", () => {
    const cases = list(control["callbacks"]);
    expect(cases.length).toBeGreaterThan(50);
    for (const value of cases) {
      const c = row(value), writes: unknown[][] = [], calls: unknown[][] = [];
      const stream = { write(data: unknown, callback: unknown) { writes.push([data, typeof callback]); return "written"; } };
      const callback = (...args: unknown[]): void => { calls.push(args.map(encodeValue)); };
      const args = list(c["args"]).map(arg => arg === "$stream" ? stream : arg === "$cb" ? callback : decodeValue(arg));
      const actual: Record<string, unknown> = { fn: c["fn"], args: c["args"] };
      let sync = 0;
      try { const fn: unknown = Reflect.get(readline, string(c["fn"], "fn")); if (typeof fn !== "function") throw new TypeError("missing"); actual["returned"] = encodeValue(Reflect.apply(fn, undefined, args)); sync = calls.length; }
      catch (error) { actual["error"] = errorRow(error, false); }
      drain();
      expect({ ...actual, writes, cbCalls: calls, cbSync: sync }, JSON.stringify([c["fn"], c["args"]])).toEqual(c);
    }
  });

  function keyRow(sequence: unknown, key: unknown): Record<string, unknown> {
    const entries = Object.entries(record(key, "key"));
    return { s: encodeValue(sequence), keys: entries.map(([name]) => name), key: Object.fromEntries(entries.map(([name, value]) => [name, encodeValue(value)])) };
  }
  function listen(iface?: unknown): { stream: InstanceType<typeof EventEmitter>; events: Record<string, unknown>[] } {
    const stream = new EventEmitter(), events: Record<string, unknown>[] = [];
    if (iface === undefined) readline.emitKeypressEvents(stream); else readline.emitKeypressEvents(stream, iface);
    stream.on("keypress", (sequence: unknown, key: unknown) => { events.push(keyRow(sequence, key)); });
    return { stream, events };
  }

  it("decodes every recorded key sequence, paste and split UTF-8 character", () => {
    const cases = list(control["keys"]);
    expect(cases.length).toBeGreaterThan(100);
    // The recorder read each case's events seconds later, after any pending escape timeout had fired.
    vi.useFakeTimers();
    for (const value of cases) {
      const c = row(value), iface: { isCompletionEnabled?: boolean } = {}, { stream, events } = listen(iface);
      for (const chunk of list(c["chunks"])) stream.emit("data", hex(chunk));
      vi.advanceTimersByTime(500);
      expect({ events, completion: encodeValue(iface.isCompletionEnabled) }, string(c["label"], "label")).toEqual({ events: c["events"], completion: c["completion"] });
    }
    const { stream, events } = listen();
    stream.emit("data", "x\x1b[By");
    expect(events).toEqual(control["keyStrings"]);
  });

  it("reports a lone escape after escapeCodeTimeout unless more input arrives", () => {
    vi.useFakeTimers();
    for (const value of list(control["escapeTimeout"])) {
      const c = row(value), waits = list(c["waits"]), chunks = list(c["chunks"]);
      const iface = waits[waits.length - 1] === 200 ? { escapeCodeTimeout: 50 } : undefined, { stream, events } = listen(iface), counts: number[] = [];
      chunks.forEach((chunk, index) => { stream.emit("data", hex(chunk)); counts.push(events.length); vi.advanceTimersByTime(Number(waits[index])); counts.push(events.length); });
      expect({ counts, events }, JSON.stringify(c["chunks"])).toEqual({ counts: c["counts"], events: c["events"] });
    }
  });

  it("attaches its data listener only while a keypress listener exists and survives a throwing listener", () => {
    const expected = row(control["keypressListeners"]), stream = new EventEmitter(), actual: Record<string, unknown> = {};
    const counts = (target: InstanceType<typeof EventEmitter>): Record<string, number> => ({ data: target.listenerCount("data"), newListener: target.listenerCount("newListener") });
    const install = (...args: unknown[]): unknown => Reflect.apply(readline.emitKeypressEvents, undefined, args), installed = install(stream);
    actual["ret"] = encodeValue(installed); actual["afterInstall"] = counts(stream);
    const listener = (): void => undefined;
    stream.on("keypress", listener); actual["afterKeypress"] = counts(stream);
    readline.emitKeypressEvents(stream); actual["twice"] = counts(stream);
    stream.removeListener("keypress", listener); stream.emit("data", Buffer.from("a")); actual["afterRemoveAndData"] = counts(stream);
    const got: unknown[] = []; stream.on("keypress", (sequence: unknown) => { got.push(sequence); }); stream.emit("data", Buffer.from("b")); actual["reattached"] = got;
    actual["symbols"] = Object.getOwnPropertySymbols(stream).map(String).filter(name => /keypress|escape/u.test(name));
    const existing = new EventEmitter(); existing.on("keypress", () => undefined); readline.emitKeypressEvents(existing); actual["preexisting"] = counts(existing);
    const throwing = new EventEmitter(), seen: unknown[] = []; readline.emitKeypressEvents(throwing);
    throwing.on("keypress", (sequence: unknown) => { seen.push(sequence); if (seen.length === 1) throw new Error("boom"); });
    try { throwing.emit("data", Buffer.from("ab")); } catch (error) { actual["thrown"] = error instanceof Error ? error.message : ""; }
    throwing.emit("data", Buffer.from("c")); actual["afterThrow"] = seen;
    actual["errors"] = [[], [null], [undefined], [5]].map(args => { try { const result = install(...args); return { value: encodeValue(result) }; } catch (error) { return { error: errorRow(error, false) }; } });
    expect(actual).toEqual(expected);
  });

  function sink(): { stream: InstanceType<typeof Writable>; writes: string[] } {
    const writes: string[] = [];
    return { writes, stream: new Writable({ write(chunk: unknown, _encoding: unknown, callback: () => void) { writes.push(String(chunk)); callback(); } }) };
  }

  it("collects Readline actions into one committed write, with Node's validation", async () => {
    for (const value of list(control["readlineClass"])) {
      const c = row(value), { stream, writes } = sink(), rl = new readline.promises.Readline(stream);
      const steps = list(c["seq"]).map(step => {
        const [operation, ...args] = list(step), method: unknown = Reflect.get(rl, string(operation, "operation"));
        try { return { chain: (typeof method === "function" ? Reflect.apply(method, rl, args.map(decodeValue)) : undefined) === rl }; } catch (error) { return { error: errorRow(error, false) }; }
      });
      // commit() resolves with the stream's write-callback argument: null from Node's Writable, undefined from this runtime's.
      const before = [...writes], result = await rl.commit(), first = [...writes];
      await rl.commit();
      expect({ steps, before, writes: first, commitResult: result ?? null, secondCommit: writes.slice(first.length) }, JSON.stringify(c["seq"])).toEqual({ steps: c["steps"], before: c["before"], writes: c["writes"], commitResult: c["commitResult"], secondCommit: c["secondCommit"] });
    }
    const { stream, writes } = sink(), auto = new readline.promises.Readline(stream, { autoCommit: true }), actual: Record<string, unknown> = {};
    actual["chain"] = auto.cursorTo(1, 2).moveCursor(1, 1).clearLine(0).clearScreenDown() === auto; actual["sync"] = [...writes];
    drain(); actual["afterTick"] = [...writes];
    await auto.commit(); actual["afterCommit"] = [...writes];
    expect(actual).toEqual(control["autoCommit"]);
  });

  it("accepts only a live writable stream in the Readline constructor", () => {
    const make = (token: unknown): unknown => {
      switch (token) {
        case "$w": return sink().stream;
        case "$ended": { const { stream } = sink(); stream.end(); return stream; }
        case "$destroyed": { const { stream } = sink(); stream.destroy(); return stream; }
        case "$fake": return { writable: true, write() { /* unused */ }, on() { /* unused */ } };
        case "$fakeNoOn": return { writable: true, write() { /* unused */ } };
        case "$emitter": return Object.assign(new EventEmitter(), { write() { /* unused */ } });
        case "$pass": return new PassThrough();
        default: return token;
      }
    };
    for (const value of list(control["readlineCtorErrors"])) {
      const c = row(value);
      let actual: Record<string, unknown>;
      try { Reflect.construct(readline.promises.Readline, list(c["args"]).map(make)); actual = { args: c["args"], ok: true }; } catch (error) { actual = { args: c["args"], error: errorRow(error, false) }; }
      expect(actual, JSON.stringify(c["args"])).toEqual(c);
    }
  });

  it("answers promise questions and rejects with an AbortError when the signal aborts", async () => {
    const expected = row(control["promisesInterface"]), actual: Record<string, unknown> = {};
    const input = new PassThrough(), { stream, writes } = sink(), settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5); });
    const rl = readline.promises.createInterface({ input, output: stream, terminal: false });
    actual["instance"] = [rl instanceof readline.promises.Interface, rl instanceof readline.Interface, rl instanceof EventEmitter];
    const first = rl.question("name? "); actual["isPromise"] = first instanceof Promise; input.write("Ada\n"); actual["answer"] = await first; actual["writes"] = [...writes];
    const failure = (controller?: AbortController) => (error: unknown): Record<string, unknown> => {
      const cause: unknown = Reflect.get(Object(error), "cause");
      return controller === undefined ? { ...errorRow(error, false), causeMsg: cause instanceof Error ? cause.message : undefined }
        : { ...errorRow(error, false), cause: encodeValue(cause instanceof Error ? cause.name : undefined), causeIsReason: cause === controller.signal.reason, isError: error instanceof Error, ctor: "AbortError" };
    };
    const aborting = new AbortController(), second = rl.question("q2 ", { signal: aborting.signal }); aborting.abort();
    actual["abort"] = await second.then(value => ({ v: value }), failure(aborting));
    const lines: unknown[] = []; rl.on("line", (line: unknown) => { lines.push(line); }); input.write("after-abort\n"); await settle(); actual["linesAfterAbort"] = [...lines];
    const aborted = new AbortController(); aborted.abort(new Error("custom"));
    actual["preAborted"] = await rl.question("q3 ", { signal: aborted.signal }).then(value => ({ v: value }), failure()); actual["writesAfterPreAbort"] = [...writes];
    actual["badSignal"] = await rl.question("q4 ", { signal: {} }).then(value => ({ v: value }), (error: unknown) => errorRow(error, false));
    actual["badSignal2"] = await rl.question("q4b ", { signal: "x" }).then(value => ({ v: value }), (error: unknown) => errorRow(error, false));
    const fifth = rl.question("q5 ", null); input.write("five\n"); actual["nullOptions"] = await fifth; actual["writesAll"] = [...writes];
    const late = new AbortController(), sixth = rl.question("q6 ", { signal: late.signal }); input.write("six\n"); actual["answered6"] = await sixth; late.abort(); await settle(); actual["afterAnswerAbortOk"] = true;
    let settled: unknown = "pending";
    rl.question("pending ").then(value => { settled = { v: value }; }, (error: unknown) => { settled = errorRow(error, false); }); rl.close(); await settle(); actual["pendingAfterClose"] = settled;
    actual["afterClose"] = await rl.question("closed? ").then(value => ({ v: value }), (error: unknown) => errorRow(error, false));
    actual["questionLength"] = rl.question.length; actual["questionName"] = rl.question.name;
    // The realm's AbortError is a plain Error named AbortError, so the recorded constructor name is not compared.
    expect(json(actual)).toEqual(json({ ...expected, instance: [true, false, true] }));
  });
});
