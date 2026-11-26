import { Buffer } from "buffer";
import { expect, it } from "vitest";
import { createNodeUtf8Stream } from "./node-files-utf8-stream.ts";
import { createStreamPorts } from "./node-files-utf8-stream.test-support.ts";

/** Faults of the process's own `fs` (the injected port, not a program's `options.fs`): the recorded scenarios cover the
 * same faults through `options.fs`, where Node could be recorded; these cover the path that holds the process. */
type Done = (error: unknown, value?: unknown) => void;
type Fault = { readonly error: string } | { readonly bytes: number } | undefined;
const failure = (code: string): Error => Object.assign(new Error(code), { code });

function faulty(plan: { readonly write?: Fault[]; readonly open?: Fault[]; readonly fsync?: Fault[]; readonly close?: Fault[] } = {}) {
  const ports = createStreamPorts(), calls: unknown[][] = [], chunks: Buffer[] = [];
  const next = (name: "write" | "open" | "fsync" | "close"): Fault => plan[name]?.shift();
  const later = (done: Done, error: unknown, value?: unknown): void => { setImmediate(() => { if (error === null) done(null, value); else done(error); }); };
  /** Writes what the plan allows of `data` and answers the byte count, or throws the planned error. */
  const put = (data: string | Buffer): number => {
    const bytes = Buffer.from(data), fault = next("write");
    if (fault !== undefined && "error" in fault) throw failure(fault.error);
    const part = bytes.subarray(0, fault === undefined ? bytes.length : fault.bytes);
    chunks.push(Buffer.from(part));
    return part.length;
  };
  const fs = {
    open(path: string, flags: string, mode: unknown, done: Done): void { calls.push(["open", path, flags, mode]); const fault = next("open"); later(done, fault !== undefined && "error" in fault ? failure(fault.error) : null, 7); },
    openSync(path: string, flags: string, mode: unknown): number { calls.push(["openSync", path, flags, mode]); const fault = next("open"); if (fault !== undefined && "error" in fault) throw failure(fault.error); return 7; },
    write(fd: number, data: string | Buffer, ...rest: unknown[]): void {
      const done = rest.pop();
      calls.push(["write", fd, typeof data === "string" ? data : data.toString("hex"), ...rest]);
      if (typeof done !== "function") throw new TypeError("no callback");
      let written = 0, error: unknown = null;
      try { written = put(data); } catch (caught) { error = caught; }
      setImmediate(() => { if (error === null) Reflect.apply(done, undefined, [null, written, data]); else Reflect.apply(done, undefined, [error]); });
    },
    writeSync(fd: number, data: string | Buffer, ...rest: unknown[]): number { calls.push(["writeSync", fd, typeof data === "string" ? data : data.toString("hex"), ...rest]); return put(data); },
    fsync(fd: number, done: Done): void { calls.push(["fsync", fd]); const fault = next("fsync"); later(done, fault !== undefined && "error" in fault ? failure(fault.error) : null); },
    fsyncSync(fd: number): void { calls.push(["fsyncSync", fd]); const fault = next("fsync"); if (fault !== undefined && "error" in fault) throw failure(fault.error); },
    close(fd: number, done: Done): void { calls.push(["close", fd]); const fault = next("close"); later(done, fault !== undefined && "error" in fault ? failure(fault.error) : null); },
    mkdir(path: string, options: unknown, done: Done): void { calls.push(["mkdir", path, options]); later(done, null); },
    mkdirSync(path: string, options: unknown): void { calls.push(["mkdirSync", path, options]); },
  };
  const { Utf8Stream } = createNodeUtf8Stream({ ...ports.scheduling, fs });
  const record = (stream: InstanceType<typeof Utf8Stream>): unknown[][] => {
    const seen: unknown[][] = [];
    for (const name of ["ready", "drain", "write", "finish", "close", "error"]) stream.on(name, (...args) => { seen.push([name, ...args.map(value => value instanceof Error ? value.message : value)]); });
    return seen;
  };
  return { ...ports, Utf8Stream, calls, record, written: () => Buffer.concat(chunks) };
}

it("retries an asynchronous write the file service refuses with EAGAIN or EBUSY after 100 ms", async () => {
  const retries: unknown[][] = [];
  const { Utf8Stream, calls, record, written, timers, held, settle, advance } = faulty({ write: [{ error: "EAGAIN" }, { error: "EBUSY" }] });
  const stream = new Utf8Stream({ dest: "/log", retryEAGAIN: (error: unknown, writing: unknown, remaining: unknown) => { retries.push([Reflect.get(Object(error), "code"), writing, remaining]); return true; } });
  const seen = record(stream);
  expect(held.now).toBe(1);
  stream.write("one\n"); stream.write("two\n");
  await settle();
  // The refused write is not in flight any more: only the referenced retry timer keeps the process.
  expect([held.now, [...timers].map(timer => [timer.due, timer.referenced]), written().toString()]).toEqual([0, [[100, true]], ""]);
  await advance(99);
  expect(retries).toEqual([["EAGAIN", 8, 0]]);
  await advance(1);
  expect([retries, [...timers].map(timer => timer.due)]).toEqual([[["EAGAIN", 8, 0], ["EBUSY", 8, 0]], [200]]);
  await advance(100);
  expect([written().toString(), seen, held.now, timers.size]).toEqual(["one\ntwo\n", [["ready"], ["write", 8], ["drain"]], 0, 0]);
  // The process's own fs is asked with the position spelled out, where Node's stream passes the encoding in its place.
  expect(calls).toEqual([["open", "/log", "a", undefined], ["write", 7, "one\ntwo\n", null, "utf8"], ["write", 7, "one\ntwo\n", null, "utf8"], ["write", 7, "one\ntwo\n", null, "utf8"]]);
});

it("gives up on EAGAIN when retryEAGAIN says so, and sleeps between the retries of a synchronous write", async () => {
  const { Utf8Stream, record, written, slept, settle } = faulty({ write: [{ error: "EAGAIN" }, { error: "EAGAIN" }, undefined, { error: "EAGAIN" }] });
  let allow = true;
  const stream = new Utf8Stream({ dest: "/log", sync: true, retryEAGAIN: () => allow });
  const seen = record(stream);
  expect(stream.write("one\n")).toBe(true);
  expect([slept, written().toString()]).toEqual([[100, 100], "one\n"]);
  allow = false;
  stream.write("two\n");
  await settle();
  expect(seen).toEqual([["write", 0], ["write", 0], ["error", "EAGAIN"], ["ready"], ["drain"]]);
  expect(stream.writing).toBe(false);
});

it("re-slices a partial write by bytes and backs up to the start of a split character", async () => {
  // "a€b" is 61 e2 82 ac 62: two bytes end inside the euro sign, so only "a" counts as written.
  const { Utf8Stream, calls, record, written, settle } = faulty({ write: [{ bytes: 2 }, { bytes: 3 }, { bytes: 0 }] });
  const stream = new Utf8Stream({ dest: "/log" });
  const seen = record(stream);
  stream.write("a€b");
  await settle();
  expect(calls.filter(call => call[0] === "write").map(call => call[2])).toEqual(["a€b", "€b", "b", "b"]);
  expect(seen).toEqual([["ready"], ["write", 2], ["write", 3], ["write", 0], ["write", 1], ["drain"]]);
  // As in Node, the first byte of the split character reached the file twice.
  expect(written().toString("hex")).toBe("61e2" + "e282ac" + "62");
  const sync = faulty({ write: [{ bytes: 5 }, { bytes: 1 }] }), other = new sync.Utf8Stream({ dest: "/log", sync: true });
  other.write("🙂🙂!");
  expect(sync.calls.filter(call => call[0] === "writeSync").map(call => call[2])).toEqual(["🙂🙂!", "🙂!", "🙂!"]);
  expect(sync.written().toString("hex")).toBe("f09f9982f0" + "f0" + "f09f998221");
  await sync.settle();
});

it("answers a failed fsync to the flush callback, ignores EBADF, and closes whatever fsync said", async () => {
  const { Utf8Stream, calls, record, held, settle } = faulty({ fsync: [{ error: "EIO" }, { error: "EBADF" }, { error: "EIO" }] });
  const stream = new Utf8Stream({ dest: "/log", minLength: 10 });
  const seen = record(stream);
  await settle();
  const flush = (): Promise<unknown> => new Promise(resolve => { stream.flush((error: unknown) => { resolve(error instanceof Error ? error.message : error); }); });
  stream.write("a\n");
  const pending = flush();
  expect(held.now).toBe(1);
  expect(await pending).toBe("EIO");
  stream.write("b\n");
  expect(await flush()).toBeUndefined();
  stream.end();
  await settle();
  expect(seen).toEqual([["ready"], ["write", 2], ["drain"], ["write", 2], ["drain"], ["finish"], ["close"]]);
  expect(calls.slice(-2)).toEqual([["fsync", 7], ["close", 7]]);
  expect(held.now).toBe(0);
});

it("reports a failed open and a failed close as error events and lets go of the process", async () => {
  const { Utf8Stream, calls, record, held, settle } = faulty({ open: [{ error: "EACCES" }, undefined], close: [{ error: "EIO" }] });
  const stream = new Utf8Stream({ dest: "/dir/log", mkdir: true, append: false, mode: 0o600 });
  const seen = record(stream);
  stream.write("kept\n");
  await settle();
  expect([seen, held.now, stream.fd, stream.file, stream.writing]).toEqual([[["error", "EACCES"]], 0, -1, null, false]);
  expect(calls).toEqual([["mkdir", "/dir", { recursive: true }], ["open", "/dir/log", "w", 0o600]]);
  // A synchronous stream throws the same failure out of its constructor.
  const sync = faulty({ open: [{ error: "ENOENT" }] });
  expect(() => new sync.Utf8Stream({ dest: "/missing/log", sync: true, mkdir: true })).toThrow(expect.objectContaining({ code: "ENOENT" }));
  expect(sync.calls).toEqual([["mkdirSync", "/missing", { recursive: true }], ["openSync", "/missing/log", "a", undefined]]);
  await sync.settle();
  expect(sync.uncaught).toEqual([]);
  // The close of an ended stream fails: 'error', and neither 'finish' nor 'close'.
  const closing = faulty({ close: [{ error: "EIO" }] }), ended = new closing.Utf8Stream({ dest: "/log" }), events = closing.record(ended);
  ended.write("x\n"); ended.end();
  await closing.settle();
  expect([events, closing.held.now]).toEqual([[["ready"], ["write", 2], ["error", "EIO"]], 0]);
});

it("keeps the class shape a minified build would lose", () => {
  const { Utf8Stream } = faulty();
  expect([Utf8Stream.name, Utf8Stream.length, Object.getOwnPropertyDescriptor(Utf8Stream, "name")?.configurable]).toEqual(["Utf8Stream", 0, true]);
  const stream = new Utf8Stream({ fd: 7 });
  const prototype: unknown = Utf8Stream.prototype, write: unknown = Reflect.get(Object(prototype), "write");
  expect(() => { if (typeof write === "function") Reflect.apply(write, {}, ["x"]); }).toThrow(TypeError);
  expect(Object.keys(stream).every(key => key.startsWith("_"))).toBe(true);
});
