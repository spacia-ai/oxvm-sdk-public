import { describe, expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { FakeFiles } from "../../../wasm/kit/wasi/files.test-support.js";
import { streams } from "../../../wasm/kit/wasi/streams.test-support.js";
import { createNodeWasi } from "./node-wasi.js";

const RESOLVE_BENEATH = 8, BADF = 8, ALL_RIGHTS = (1n << 29n) - 1n;

/** A process whose Linux has /workspace/a.txt, and whose standard streams are captured. */
function process(files = new FakeFiles({ "/workspace/a.txt": "from the guest\n", "/etc/passwd": "root" }, ["/workspace", "/etc"]), stdin?: Uint8Array) {
  const fake = streams({ files, ...(stdin === undefined ? {} : { stdin }) }), exits: number[] = [];
  const { WASI } = createNodeWasi({ host: fake.host, exit: code => { exits.push(code); throw new Error(`process exited ${String(code)}`); } });
  return { WASI, files, exits, stdout: () => new TextDecoder().decode(fake.stdout()), stderr: () => fake.stderr() };
}
/** An instance-shaped object over one memory, with the imports of `wasi` callable by name. */
function bound(wasi: { readonly wasiImport: object; finalizeBindings(instance: unknown, options?: unknown): void }, shared = false) {
  const memory = new WebAssembly.Memory(shared ? { initial: 1, maximum: 1, shared: true } : { initial: 1 });
  wasi.finalizeBindings({ exports: {} }, { memory });
  const bytes = (): Uint8Array => new Uint8Array(memory.buffer), view = (): DataView => new DataView(memory.buffer);
  const call = (name: string, ...args: readonly (number | bigint)[]): unknown => {
    const target: unknown = Reflect.get(wasi.wasiImport, name);
    if (typeof target !== "function") throw new TypeError(`no ${name}`);
    const result: unknown = Reflect.apply(target, undefined, args); return result;
  };
  const put = (at: number, text: string): number => { const encoded = new TextEncoder().encode(text); bytes().set(encoded, at); return encoded.length; };
  /** path_open(dirfd 3, "…") with every right; the errno, and the descriptor on success. */
  const open = (path: string, oflags = 0): readonly [unknown, number] => {
    const length = put(256, path);
    return [call("path_open", 3, 0, 256, length, oflags, ALL_RIGHTS, ALL_RIGHTS, 0, 512), view().getUint32(512, true)];
  };
  return { memory, bytes, view, call, put, open };
}
/** Calls one import of a WASI object that is not bound to an instance-shaped helper. */
function invoke(wasi: { readonly wasiImport: object }, name: string, ...args: readonly number[]): unknown {
  const target: unknown = Reflect.get(wasi.wasiImport, name);
  if (typeof target !== "function") throw new TypeError(`no ${name}`);
  const result: unknown = Reflect.apply(target, undefined, args); return result;
}
const codeOf = (work: () => unknown): unknown => { try { work(); return "accepted"; } catch (error) { return error instanceof Error && "code" in error ? error.code : error; } };

describe("node:wasi", () => {
  it("validates its options as Node does", () => {
    const { WASI } = process();
    const codes = (options: unknown): unknown => codeOf(() => new WASI(options));
    expect(codes({})).toBe("ERR_INVALID_ARG_TYPE");
    expect(codes({ version: "preview2" })).toBe("ERR_INVALID_ARG_VALUE");
    expect(codes({ version: "preview1", args: "x" })).toBe("ERR_INVALID_ARG_TYPE");
    expect(codes({ version: "preview1", env: 1 })).toBe("ERR_INVALID_ARG_TYPE");
    expect(codes({ version: "preview1", preopens: [] })).toBe("ERR_INVALID_ARG_TYPE");
    expect(codes({ version: "preview1", returnOnExit: 1 })).toBe("ERR_INVALID_ARG_TYPE");
    expect(codes({ version: "preview1", stdout: "1" })).toBe("ERR_INVALID_ARG_TYPE");
    expect(codes({ version: "preview1", args: ["a\0b"] })).toBe("ERR_INVALID_ARG_VALUE");
    expect(codes({ version: "preview1", args: ["a"], env: { A: "1" }, stdin: 0, stdout: 1, stderr: 2 })).toBe("accepted");
  });

  it("refuses the older snapshot as a remembered limitation", () => {
    const { WASI } = process();
    let failure: unknown;
    try { new WASI({ version: "unstable" }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(VMError);
    expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject: "node:wasi version 'unstable'" } });
  });

  it("names its import module and serves all 46 functions", () => {
    const wasi = new (process().WASI)({ version: "preview1" });
    expect(Object.keys(wasi.getImportObject())).toEqual(["wasi_snapshot_preview1"]);
    expect(wasi.getImportObject()["wasi_snapshot_preview1"]).toBe(wasi.wasiImport);
    expect(Object.keys(wasi.wasiImport)).toHaveLength(46);
    expect(Object.values(wasi.wasiImport).every(value => typeof value === "function")).toBe(true);
  });

  it("reads a preopened file through Linux and writes standard output byte for byte", () => {
    const fake = process(), wasi = new fake.WASI({ version: "preview1", preopens: { "/sandbox": "/workspace" } });
    const { call, view, bytes, open, put } = bound(wasi);
    const [errno, fd] = open("a.txt");
    expect(errno).toBe(0);
    view().setUint32(600, 1024, true); view().setUint32(604, 64, true);
    expect(call("fd_read", fd, 600, 1, 608)).toBe(0);
    const count = view().getUint32(608, true);
    expect(new TextDecoder().decode(bytes().subarray(1024, 1024 + count))).toBe("from the guest\n");
    // No newline, then bytes that are not text: both arrive exactly.
    view().setUint32(604, put(1024, "hello"), true);
    expect(call("fd_write", 1, 600, 1, 608)).toBe(0);
    bytes().set([0xff, 0x0a, 0x00, 0x80], 1024); view().setUint32(604, 4, true);
    expect(call("fd_write", 2, 600, 1, 608)).toBe(0);
    expect(fake.stdout()).toBe("hello");
    expect(Array.from(new TextEncoder().encode(fake.stderr()))).not.toHaveLength(0);
    expect(call("fd_close", fd)).toBe(0);
    expect(call("fd_close", fd)).toBe(BADF);
  });

  it("asks Linux to resolve every path beneath the preopened directory", () => {
    const fake = process(), wasi = new fake.WASI({ version: "preview1", preopens: { "/sandbox": "/workspace" } });
    const { open, call, put } = bound(wasi);
    open("a.txt"); open("../etc/passwd"); open("/etc/passwd");
    call("path_unlink_file", 3, 256, put(256, "sub/victim"));
    const opens = fake.files.calls.filter(entry => entry.op === "openat" && entry.args[1] !== "/workspace");
    expect(opens.length).toBeGreaterThan(0);
    // Whatever the program names, the request carries RESOLVE_BENEATH and the program's own path, relative to the preopen.
    for (const entry of opens) expect(Number(entry.args[4]) & RESOLVE_BENEATH, JSON.stringify(entry.args)).toBe(RESOLVE_BENEATH);
    // An absolute path is handed to Linux as it is, with the flag: Linux refuses it, not a check here.
    expect(opens.map(entry => entry.args[1])).toEqual(expect.arrayContaining(["a.txt", "../etc/passwd", "/etc/passwd"]));
  });

  it("works on a shared memory, as a threaded binding's does", () => {
    const fake = process(), wasi = new fake.WASI({ version: "preview1", preopens: { "/sandbox": "/workspace" } });
    const { open, call, view, put } = bound(wasi, true);
    expect(open("a.txt")[0]).toBe(0);
    view().setUint32(600, 1024, true); view().setUint32(604, put(1024, "threads"), true);
    expect(call("fd_write", 1, 600, 1, 608)).toBe(0);
    expect(fake.stdout()).toBe("threads");
  });

  it("uses the descriptors the program names as its standard streams", () => {
    const files = new FakeFiles({ "/workspace/out.log": "" }, ["/workspace"]), fake = process(files);
    const target = files.at.openat(files.at.cwd, "out.log", 1, 0);
    const wasi = new fake.WASI({ version: "preview1", stdout: target });
    const { call, view, put } = bound(wasi);
    view().setUint32(600, 1024, true); view().setUint32(604, put(1024, "to a file"), true);
    expect(call("fd_write", 1, 600, 1, 608)).toBe(0);
    expect(new TextDecoder().decode(files.tree.get("/workspace/out.log")?.data)).toBe("to a file");
    expect(fake.stdout()).toBe("");
  });

  it("starts a command: returns its exit status, or ends the process when asked to", () => {
    const fake = process(), memory = new WebAssembly.Memory({ initial: 1 });
    const command = (wasi: { readonly wasiImport: object }, code: number | undefined) => ({ exports: { memory, _start: () => {
      if (code !== undefined) invoke(wasi, "proc_exit", code);
    } } });
    const returning = new fake.WASI({ version: "preview1" });
    expect(returning.start(command(returning, 7))).toBe(7);
    expect(codeOf(() => returning.start(command(returning, 0)))).toBe("ERR_WASI_ALREADY_STARTED");
    const quiet = new fake.WASI({ version: "preview1" });
    expect(quiet.start(command(quiet, undefined))).toBe(0);
    const exiting = new fake.WASI({ version: "preview1", returnOnExit: false });
    expect(() => exiting.start(command(exiting, 3))).toThrow("process exited 3");
    expect(fake.exits).toEqual([3]);
  });

  it("checks the instance it is given, as Node does", () => {
    const { WASI } = process(), memory = new WebAssembly.Memory({ initial: 1 });
    const fresh = () => new WASI({ version: "preview1" });
    expect(codeOf(() => fresh().start({}))).toBe("ERR_INVALID_ARG_TYPE");
    expect(codeOf(() => fresh().start({ exports: { memory } }))).toBe("ERR_INVALID_ARG_TYPE");
    expect(codeOf(() => fresh().start({ exports: { memory, _start: () => undefined, _initialize: () => undefined } }))).toBe("ERR_INVALID_ARG_TYPE");
    expect(codeOf(() => fresh().start({ exports: { _start: () => undefined } }))).toBe("ERR_INVALID_ARG_TYPE");
    expect(codeOf(() => fresh().initialize({ exports: { memory, _start: () => undefined } }))).toBe("ERR_INVALID_ARG_TYPE");
    let initialized = 0;
    fresh().initialize({ exports: { memory, _initialize: () => { initialized++; } } });
    fresh().initialize({ exports: { memory } });
    expect(initialized).toBe(1);
    // An import called before any instance is bound fails loudly instead of touching no memory.
    expect(() => invoke(fresh(), "fd_write", 1, 0, 0, 0)).toThrow(/before its instance was bound/u);
  });
});
