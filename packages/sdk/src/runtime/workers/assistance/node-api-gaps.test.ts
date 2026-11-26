import { describe, expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNodeBuffer } from "./node-buffer.ts";
import { createNodeStreamModule } from "./node-streams.js";
import { createNodeVm, realmEvaluator } from "./node-vm.ts";
import { createNodeWorkerThreads } from "./node-worker-threads.ts";
import { nodeZlib } from "./node-zlib.ts";

/** Small builtin members Node.js v24.18.1 has; every expected value was recorded from `node:24.18.1-alpine`. */
const field = (value: unknown, key: string): unknown => (typeof value === "object" || typeof value === "function") && value !== null ? Reflect.get(value, key) : undefined;
const call = (value: unknown, ...args: unknown[]): unknown => {
  if (typeof value !== "function") throw new TypeError("expected a function");
  const result: unknown = Reflect.apply(value, undefined, args);
  return result;
};
const failure = (run: () => unknown): unknown[] => {
  try { run(); } catch (error) { return [error instanceof Error ? error.constructor.name : typeof error, field(error, "code"), field(error, "message")]; }
  return [];
};
interface Side { on(event: string, listener: (...args: unknown[]) => void): unknown; write(chunk: unknown, callback?: () => void): boolean; end(callback?: () => void): unknown; destroy(error?: Error): unknown; resume(): unknown; readonly destroyed: boolean }
function isSide(value: unknown): value is Side { return typeof field(value, "write") === "function" && typeof field(value, "on") === "function" && typeof field(value, "resume") === "function"; }
function pair(value: unknown): [Side, Side] {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError("expected two sides");
  const first: unknown = value[0], second: unknown = value[1];
  if (!isSide(first) || !isSide(second)) throw new TypeError("expected duplex sides");
  return [first, second];
}
const closed = (side: Side): Promise<void> => new Promise(resolve => { side.on("close", () => { resolve(); }); });

describe("zlib.codes", () => {
  it("maps each return code both ways, frozen", () => {
    expect(JSON.stringify(nodeZlib.codes)).toBe("{\"0\":\"Z_OK\",\"1\":\"Z_STREAM_END\",\"2\":\"Z_NEED_DICT\",\"Z_OK\":0,\"Z_STREAM_END\":1,\"Z_NEED_DICT\":2,\"Z_ERRNO\":-1,\"Z_STREAM_ERROR\":-2,\"Z_DATA_ERROR\":-3,\"Z_MEM_ERROR\":-4,\"Z_BUF_ERROR\":-5,\"Z_VERSION_ERROR\":-6,\"-1\":\"Z_ERRNO\",\"-2\":\"Z_STREAM_ERROR\",\"-3\":\"Z_DATA_ERROR\",\"-4\":\"Z_MEM_ERROR\",\"-5\":\"Z_BUF_ERROR\",\"-6\":\"Z_VERSION_ERROR\"}");
    expect(Object.isFrozen(nodeZlib.codes)).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(nodeZlib, "codes");
    expect([descriptor?.writable, descriptor?.enumerable, descriptor?.configurable]).toEqual([false, true, false]);
  });
});

describe("buffer.resolveObjectURL", () => {
  it("answers undefined for every id, as Node does for one it does not hold", () => {
    const { resolveObjectURL } = createNodeBuffer(globalThis, Buffer);
    expect([resolveObjectURL.name, resolveObjectURL.length]).toEqual(["resolveObjectURL", 1]);
    for (const id of ["blob:nodedata:nope", "x", undefined, 5, "blob:other:abc", "blob:nodedata:a:b"]) expect(call(resolveObjectURL, id)).toBeUndefined();
    expect(failure(() => resolveObjectURL(Symbol("s")))).toEqual(["TypeError", undefined, "Cannot convert a Symbol value to a string"]);
  });
});

describe("vm additions", () => {
  const vm = createNodeVm(realmEvaluator());
  it("creates scripts through createScript", () => {
    expect([vm.createScript.name, vm.createScript.length]).toEqual(["createScript", 2]);
    const script = vm.createScript("1 + 1", { filename: "a.js" });
    expect(script).toBeInstanceOf(vm.Script);
    expect(script.runInThisContext()).toBe(2);
  });
  it("exposes the two frozen constant symbols", () => {
    expect(Object.getOwnPropertyNames(vm.constants)).toEqual(["USE_MAIN_CONTEXT_DEFAULT_LOADER", "DONT_CONTEXTIFY"]);
    expect([Object.getPrototypeOf(vm.constants), Object.isFrozen(vm.constants)]).toEqual([null, true]);
    expect([vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER.toString(), vm.constants.DONT_CONTEXTIFY.toString()]).toEqual(["Symbol(vm_dynamic_import_main_context_default)", "Symbol(vm_context_no_contextify)"]);
    expect(createNodeVm(realmEvaluator()).constants).toBe(vm.constants);
  });
  it("validates measureMemory options, then rejects with Node's uninitialized-context error", async () => {
    expect([vm.measureMemory.name, vm.measureMemory.length]).toEqual(["measureMemory", 0]);
    expect(failure(() => vm.measureMemory(5))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "The \"options\" argument must be of type object. Received type number (5)"]);
    expect(failure(() => vm.measureMemory(null))).toEqual(["TypeError", "ERR_INVALID_ARG_TYPE", "The \"options\" argument must be of type object. Received null"]);
    expect(failure(() => vm.measureMemory({ mode: "x" }))).toEqual(["TypeError", "ERR_INVALID_ARG_VALUE", "The property 'options.mode' must be one of: 'summary', 'detailed'. Received 'x'"]);
    expect(failure(() => vm.measureMemory({ execution: "x" }))).toEqual(["TypeError", "ERR_INVALID_ARG_VALUE", "The property 'options.execution' must be one of: 'default', 'eager'. Received 'x'"]);
    for (const options of [undefined, { mode: "detailed", execution: "eager" }]) {
      const outcome = await vm.measureMemory(options).then(() => [], (error: unknown) => [error instanceof Error ? error.constructor.name : "", field(error, "code"), field(error, "message")]);
      expect(outcome).toEqual(["Error", "ERR_CONTEXT_NOT_INITIALIZED", "context used is not initialized"]);
    }
  });
});

describe("worker_threads identity", () => {
  it("names the main thread as Node does", () => {
    const module = createNodeWorkerThreads(globalThis);
    expect([module["threadName"], module["isInternalThread"]]).toEqual(["", false]);
  });
});

describe("stream additions", () => {
  const withStream = async (run: (stream: object) => Promise<void>): Promise<void> => {
    const { module, restore } = createNodeStreamModule(createAsyncContext(), () => () => {});
    try { await run(module); } finally { restore(); }
  };
  it("exports duplexPair and _isArrayBufferView only while the module is installed", async () => {
    let seen: object | undefined;
    await withStream(stream => {
      seen = stream;
      expect(field(stream, "_isArrayBufferView")).toBe(field(ArrayBuffer, "isView"));
      const duplexPair = field(stream, "duplexPair");
      expect([field(duplexPair, "name"), field(duplexPair, "length")]).toEqual(["duplexPair", 1]);
      const Duplex = field(stream, "Duplex");
      const [a, b] = pair(call(duplexPair));
      expect([field(field(a, "constructor"), "name"), typeof Duplex === "function" && a instanceof Duplex, Object.getPrototypeOf(a) === Object.getPrototypeOf(b)]).toEqual(["DuplexSide", true, true]);
      expect([field(a, "readableObjectMode"), field(pair(call(duplexPair, { objectMode: true }))[0], "readableObjectMode")]).toEqual([false, true]);
      return Promise.resolve();
    });
    expect([field(seen, "duplexPair"), field(seen, "_isArrayBufferView")]).toEqual([undefined, undefined]);
  });
  it("carries writes, empty writes and the end across the pair in Node's order", async () => {
    await withStream(async stream => {
      const [a, b] = pair(call(field(stream, "duplexPair")));
      const log: string[] = [];
      b.on("data", chunk => log.push(`b:${String(chunk)}`)); b.on("end", () => log.push("b end"));
      a.on("data", chunk => log.push(`a:${String(chunk)}`)); a.on("end", () => log.push("a end"));
      a.on("close", () => log.push("a close")); b.on("close", () => log.push("b close"));
      const done = Promise.all([closed(a), closed(b)]);
      a.write("hello", () => log.push("a write cb")); a.write(Buffer.alloc(0), () => log.push("a empty cb")); b.write("world");
      a.end(() => { log.push("a end cb"); b.end(); });
      await done;
      expect(log).toEqual(["a write cb", "b:hello", "a:world", "a empty cb", "b end", "a end cb", "a end", "a close", "b close"]);
    });
  });
  it("passes objects in object mode and closes the other side when one is destroyed", async () => {
    await withStream(async stream => {
      const duplexPair = field(stream, "duplexPair");
      const [g, h] = pair(call(duplexPair, { objectMode: true }));
      const got: unknown[] = [];
      const two = new Promise<void>(resolve => { h.on("data", item => { got.push(item); if (got.length === 2) resolve(); }); });
      g.write({ a: 1 }); g.write(5);
      await two;
      expect(got).toEqual([{ a: 1 }, 5]);

      const [c, d] = pair(call(duplexPair));
      const log: string[] = [];
      d.on("error", () => log.push("d err")); d.on("end", () => log.push("d end")); d.on("close", () => log.push(`d close ${String(d.destroyed)}`));
      c.on("error", error => log.push(`c err ${String(field(error, "message"))}`));
      d.resume();
      const gone = closed(d);
      c.destroy(new Error("x"));
      await gone;
      expect(log).toEqual(["c err x", "d close true"]);

      const [e, f] = pair(call(duplexPair));
      const ended = new Promise<void>(resolve => { f.on("end", () => { resolve(); }); });
      f.resume(); e.destroy();
      await ended;
      expect(f.destroyed).toBe(false);
    });
  });
});
