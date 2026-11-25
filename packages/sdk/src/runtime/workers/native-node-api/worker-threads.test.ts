import { expect, it, vi } from "vitest";
import { decodeJSIdentity, JS_MAILBOX_BYTES, Reader } from "../../js-process/codec.js";
import { LinuxClient } from "../../js-process/transport.js";
import { createAsyncContext } from "../assistance/async-context.js";
import { createOutputStream } from "../assistance/node-streams.js";
import { ProcessScheduler } from "../assistance/process-scheduler.js";
import { NativeBridge } from "./bridge.js";
import { NativeWorkers } from "./worker-threads.js";

it("rejects disabled descriptor cleanup before creating a native task", () => {
  const channel = new MessageChannel(), control = new MessageChannel();
  const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const context = createAsyncContext(), scheduler = new ProcessScheduler(context, error => { throw error; });
  const output = createOutputStream(() => undefined, context);
  const bridge = new NativeBridge(client, { read() { throw new Error("Unexpected read"); }, writeAll() { throw new Error("Unexpected write"); } }, 3, 4, { changed() {}, failed(error) { throw error; }, uncaught(error) { throw error; } });
  const workers = new NativeWorkers({ client, bridge, identity: decodeJSIdentity(1n, 1n), control: control.port1, thread: null, metadata: null }, context, scheduler, { env: {}, execArgv: [], stdout: output, stderr: output, cwd: () => "/workspace" });
  const sync = vi.spyOn(client, "sync").mockImplementation(() => { throw new Error("Unexpected process effect"); });
  try {
    const Worker = workers.module["Worker"]; expect(typeof Worker).toBe("function");
    if (typeof Worker === "function") expect((): unknown => Reflect.construct(Worker, ["./worker.cjs", { trackUnmanagedFds: false }])).toThrow(/not qualified/u);
    expect(sync).not.toHaveBeenCalled();
  } finally { workers.dispose(); scheduler.dispose(); client.dispose(); channel.port2.close(); control.port2.close(); output.destroy(); }
});

it("accepts a string worker name and refuses any other, as Node does", () => {
  const channel = new MessageChannel(), control = new MessageChannel();
  const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const context = createAsyncContext(), scheduler = new ProcessScheduler(context, error => { throw error; });
  const output = createOutputStream(() => undefined, context);
  const bridge = new NativeBridge(client, { read() { throw new Error("Unexpected read"); }, writeAll() { throw new Error("Unexpected write"); } }, 3, 4, { changed() {}, failed(error) { throw error; }, uncaught(error) { throw error; } });
  const workers = new NativeWorkers({ client, bridge, identity: decodeJSIdentity(1n, 1n), control: control.port1, thread: null, metadata: null }, context, scheduler, { env: {}, execArgv: [], stdout: output, stderr: output, cwd: () => "/workspace" });
  const sync = vi.spyOn(client, "sync").mockImplementation(() => { throw new Error("Reached the Linux task"); });
  try {
    const Worker = workers.module["Worker"]; expect(typeof Worker).toBe("function");
    if (typeof Worker !== "function") return;
    // Emscripten's thread pool names its workers; the name only labels the thread.
    expect((): unknown => Reflect.construct(Worker, ["1", { eval: true, name: "em-pthread" }])).toThrow("Reached the Linux task");
    expect((): unknown => Reflect.construct(Worker, ["1", { eval: true, name: "" }])).toThrow("Reached the Linux task");
    sync.mockClear();
    expect((): unknown => Reflect.construct(Worker, ["1", { eval: true, name: 7 }])).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(sync).not.toHaveBeenCalled();
  } finally { workers.dispose(); scheduler.dispose(); client.dispose(); channel.port2.close(); control.port2.close(); output.destroy(); }
});

it.each([true, 1, "enabled", {}])("captures eval worker source as exact UTF-16 with eval=%s before preparing the Linux task", evaluated => {
  const channel = new MessageChannel(), control = new MessageChannel();
  const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const context = createAsyncContext(), scheduler = new ProcessScheduler(context, error => { throw error; });
  const output = createOutputStream(() => undefined, context);
  const bridge = new NativeBridge(client, { read() { throw new Error("Unexpected read"); }, writeAll() { throw new Error("Unexpected write"); } }, 3, 4, { changed() {}, failed(error) { throw error; }, uncaught(error) { throw error; } });
  const workers = new NativeWorkers({ client, bridge, identity: decodeJSIdentity(1n, 1n), control: control.port1, thread: null, metadata: null }, context, scheduler, { env: {}, execArgv: [], stdout: output, stderr: output, cwd: () => "/workspace" });
  const source = "/*\0" + String.fromCharCode(0xd800) + "*/require('node:worker_threads');";
  const sync = vi.spyOn(client, "sync").mockImplementation(request => {
    expect(request.number).toBe(65546);
    const reader = new Reader(request.payload);
    const bytes = reader.blob(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length).toBe(source.length * 2);
    expect(Array.from({ length: source.length }, (_, index) => view.getUint16(index * 2, true))).toEqual(Array.from({ length: source.length }, (_, index) => source.charCodeAt(index)));
    expect(reader.strings()).toEqual([]); expect(reader.strings()).toEqual([]); reader.end();
    throw new Error("Captured eval source reaches Linux admission");
  });
  try {
    const Worker = workers.module["Worker"]; expect(typeof Worker).toBe("function");
    if (typeof Worker === "function") expect((): unknown => Reflect.construct(Worker, [source, { eval: evaluated }])).toThrow("Captured eval source reaches Linux admission");
    expect(sync).toHaveBeenCalledTimes(1);
  } finally { workers.dispose(); scheduler.dispose(); client.dispose(); channel.port2.close(); control.port2.close(); output.destroy(); }
});
