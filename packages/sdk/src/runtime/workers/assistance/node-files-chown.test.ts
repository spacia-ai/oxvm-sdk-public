import { describe, expect, it } from "vitest";
import { LinuxError, type LinuxOperation, Reader } from "../../js-process/codec.js";
import { VMError } from "../../errors.js";
import { controls, list, rows } from "./node-controls.test-support.ts";
import { type ChownPorts, type ChownScheduling, createNodeChown } from "./node-files-chown.ts";

/** Every case ran in `node:24.18.1-alpine`, once as uid 1000 and once as root, and runs again here, unchanged. */
const recorded = controls("node-files-chown.controls.json");
const run = (name: string): { readonly uid: number; readonly cases: Record<string, unknown>[] } => {
  const section = rows([recorded[name]])[0] ?? {}, uid: unknown = Reflect.get(section, "uid");
  if (typeof uid !== "number") throw new TypeError("a recorded run names its uid");
  return { uid, cases: rows(Reflect.get(section, "cases")) };
};

const FILE = "/work/file", LINK = "/work/link", OPEN = 20, UNCHANGED = 0xffff_ffff, AT_FDCWD = 0xffff_ffff_ffff_ff9cn, AT_SYMLINK_NOFOLLOW = 0x100n;
interface Request { readonly number: number; readonly directory?: bigint; readonly fd?: bigint; readonly path?: Uint8Array; readonly uid: number; readonly gid: number; readonly flags?: bigint }
function decodeRequest(operation: LinuxOperation<void>): Request {
  const reader = new Reader(operation.payload);
  if (operation.number === 93) { const request = { number: 93, fd: reader.u64(), uid: reader.u32(), gid: reader.u32() }; reader.end(); return request; }
  if (operation.number !== 260) throw new Error(`unexpected operation ${String(operation.number)}`);
  const request = { number: 260, directory: reader.u64(), path: reader.blob(4095).slice(), uid: reader.u32(), gid: reader.u32(), flags: reader.u64() };
  reader.end();
  return request;
}
/**
 * The part of Linux these cases reach: `/work/file` and `/work/link -> file`, both the caller's, and descriptor 20 open
 * on the file. Root may set any owner; anyone else may only keep the owner and name their own group.
 */
function linux(caller: number, answer?: LinuxError) {
  const owners = new Map<string, readonly [number, number]>([[FILE, [caller, caller]], [LINK, [caller, caller]]]), requests: Request[] = [];
  function change(name: string, uid: number, gid: number): void {
    const owner = owners.get(name);
    if (owner === undefined) throw new LinuxError(2);
    const next: readonly [number, number] = [uid === UNCHANGED ? owner[0] : uid, gid === UNCHANGED ? owner[1] : gid];
    if (caller !== 0 && (next[0] !== owner[0] || next[1] !== caller)) throw new LinuxError(1);
    owners.set(name, next);
  }
  function perform(operation: LinuxOperation<void>): void {
    const request = decodeRequest(operation); requests.push(request);
    if (answer !== undefined) throw answer;
    if (request.number === 93) { if (request.fd !== BigInt(OPEN)) throw new LinuxError(9); change(FILE, request.uid, request.gid); }
    else {
      const path = new TextDecoder().decode(request.path);
      if (request.directory !== AT_FDCWD || (request.flags !== 0n && request.flags !== AT_SYMLINK_NOFOLLOW)) throw new LinuxError(22);
      if (path.startsWith(`${FILE}/`)) throw new LinuxError(20);
      change(path === LINK && request.flags === 0n ? FILE : path, request.uid, request.gid);
    }
    operation.decode({ value: 0n, bytes: new Uint8Array() });
  }
  const ports: ChownPorts = {
    callSync: perform,
    call: operation => { try { perform(operation); return Promise.resolve(); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("failed")); } },
  };
  return { ports, requests, owners: () => [owners.get(FILE), owners.get(LINK)] };
}

/** A recorded argument: `$fd`, `$bad` and `$me`, and `{ $: kind }` for what JSON cannot hold. */
function argument(value: unknown, me: number): unknown {
  if (value === "$fd") return OPEN;
  if (value === "$bad") return 9999;
  if (value === "$me") return me;
  if (typeof value !== "object" || value === null) return value;
  const kind: unknown = Reflect.get(value, "$");
  switch (kind) {
    case "undefined": return undefined;
    case "NaN": return NaN;
    case "Infinity": return Infinity;
    case "bigint": return BigInt(String(Reflect.get(value, "v")));
    case "symbol": return Symbol("s");
    case "buffer": return Buffer.from(String(Reflect.get(value, "hex")), "hex");
    case "url": return new URL(String(Reflect.get(value, "href")));
    default: return value;
  }
}
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const described: Record<string, unknown> = { name: error.name, ctor: error.constructor.name, message: error.message };
  for (const key of ["code", "errno", "syscall", "path", "dest"]) { const field: unknown = Reflect.get(error, key); if (field !== undefined) described[key] = field; }
  return described;
}
const plain = (value: unknown): unknown => value === undefined ? { $: "undefined" } : value instanceof Error ? describeError(value) : value;
type Callable = (...args: unknown[]) => unknown;
function callable(value: unknown): Callable {
  if (typeof value !== "function") throw new TypeError("not a function");
  return (...args) => { const result: unknown = Reflect.apply(value, undefined, args); return result; };
}

/** What the recorder keeps of one case. */
interface Outcome { returned?: unknown; threw?: unknown; resolved?: unknown; rejected?: unknown; callback?: unknown[]; during?: boolean; owners?: unknown }
/** One recorded case against the emulated functions, reported in the recorder's shape. */
async function replay(caller: number, api: string, recordedArguments: readonly unknown[]): Promise<Outcome> {
  const system = linux(caller), node = createNodeChown(system.ports), args = recordedArguments.map(value => argument(value, caller)), record: Outcome = {};
  if (api.endsWith("Sync")) {
    try { record.returned = plain(callable(Reflect.get(node.fs, api))(...args)); } catch (error) { record.threw = describeError(error); }
  } else if (api.startsWith("promises.") || api === "handle.chown") {
    let promise: unknown;
    try { promise = api === "handle.chown" ? callable(node.handleChown)(OPEN, ...args.slice(1)) : callable(Reflect.get(node.promises, api.slice(9)))(...args); }
    catch (error) { record.threw = describeError(error); }
    if (promise !== undefined) { try { record.resolved = plain(await Promise.resolve(promise)); } catch (error) { record.rejected = describeError(error); } }
  } else {
    // As the recorder: a case that names its callback argument keeps it, any other gets one.
    const own = recordedArguments.length === 4 || recordedArguments.length === 0;
    await new Promise<void>((resolve, reject) => {
      let during = true;
      const callback = (...got: unknown[]): void => { record.callback = got.map(plain); record.during = during; resolve(); };
      try { record.returned = plain(callable(Reflect.get(node.fs, api))(...(own ? args : [...args, callback]))); }
      catch (error) { record.threw = describeError(error); resolve(); }
      during = false;
      if (own && record.threw === undefined) reject(new Error("a case without a callback was accepted"));
    });
  }
  record.owners = system.owners();
  return record;
}

describe.each(["user", "root"])("chown, lchown and fchown as Node 24.18.1 answers them (%s)", name => {
  const { uid, cases } = run(name);
  it("has the recorded cases", () => { expect([uid, cases.length]).toEqual(name === "user" ? [1000, 443] : [0, 74]); });
  it.each(cases.map((entry, index) => ({ index, api: String(Reflect.get(entry, "api")), args: list(Reflect.get(entry, "args")), result: Reflect.get(entry, "result") })))("$index: $api $args", async ({ api, args, result }) => {
    expect(await replay(uid, api, args)).toEqual(result);
  });
});

it("has Node's function names and lengths", () => {
  const node = createNodeChown(linux(1000).ports), shape = rows([Reflect.get(rows([recorded["user"]])[0] ?? {}, "shape")])[0] ?? {};
  const actual = (value: unknown): unknown => typeof value === "function" ? [value.name, value.length] : undefined;
  for (const name of ["chown", "chownSync", "lchown", "lchownSync", "fchown", "fchownSync"]) expect([name, actual(Reflect.get(node.fs, name))]).toEqual([name, shape[name]]);
  for (const name of ["chown", "lchown"]) expect([name, actual(Reflect.get(node.promises, name))]).toEqual([name, shape[`promises.${name}`]]);
  // A FileHandle's own `chown(uid, gid)` is the wiring's; the helper it calls takes the descriptor first.
  expect([shape["handle.chown"], actual(node.handleChown)]).toEqual([["chown", 2], ["chown", 3]]);
});

it("asks Linux for fchownat under AT_FDCWD, with AT_SYMLINK_NOFOLLOW for lchown, and for fchown on a descriptor", async () => {
  const requests: Request[] = [], note = (operation: LinuxOperation<void>): void => { requests.push(decodeRequest(operation)); };
  const system = { requests }, node = createNodeChown({ callSync: note, call: operation => { note(operation); return Promise.resolve(); } });
  node.fs.chownSync("relative/name", 1, 2); node.fs.lchownSync(LINK, -1, 4_294_967_295); node.fs.fchownSync(OPEN, 3, -1);
  await node.promises.chown(new URL("file:///work/file"), 5, 6); await node.promises.lchown(Buffer.from(LINK), 7, 8); await node.handleChown(OPEN, 9, 10);
  const text = (request: Request): unknown => ({ ...request, ...(request.path === undefined ? {} : { path: new TextDecoder().decode(request.path) }) });
  expect(system.requests.map(text)).toEqual([
    // The caller's spelling travels as it is: Linux resolves a relative path against the process's own directory.
    { number: 260, directory: AT_FDCWD, path: "relative/name", uid: 1, gid: 2, flags: 0n },
    { number: 260, directory: AT_FDCWD, path: LINK, uid: UNCHANGED, gid: UNCHANGED, flags: AT_SYMLINK_NOFOLLOW },
    { number: 93, fd: 20n, uid: 3, gid: UNCHANGED },
    { number: 260, directory: AT_FDCWD, path: FILE, uid: 5, gid: 6, flags: 0n },
    { number: 260, directory: AT_FDCWD, path: LINK, uid: 7, gid: 8, flags: AT_SYMLINK_NOFOLLOW },
    { number: 93, fd: 20n, uid: 9, gid: 10 },
  ]);
  // A Buffer's bytes are the name, also where they are not UTF-8.
  const raw = linux(0, new LinuxError(2));
  expect(() => createNodeChown(raw.ports).fs.chownSync(Buffer.from([0x2f, 0xff, 0xfe]), 1, 1)).toThrow(/^ENOENT: /u);
  expect(Array.from(raw.requests[0]?.path ?? [])).toEqual([0x2f, 0xff, 0xfe]);
});

it("reports any errno of Linux as Node's system error and passes everything else through", async () => {
  const refused: [string, string][] = [];
  const readOnly = createNodeChown({ ...linux(1000, new LinuxError(30)).ports, failed: (code, path) => { refused.push([code, path]); } });
  const expected = { name: "Error", code: "EROFS", errno: -30, syscall: "chown", path: "/workspace/node_modules/a", message: "EROFS: read-only file system, chown '/workspace/node_modules/a'" };
  expect(() => { readOnly.fs.chownSync("/workspace/node_modules/a", 1, 1); }).toThrow(expect.objectContaining(expected));
  await expect(readOnly.promises.lchown("/workspace/node_modules/b", 1, 1)).rejects.toMatchObject({ code: "EROFS", syscall: "lchown", path: "/workspace/node_modules/b" });
  const viaCallback = await new Promise<unknown>(resolve => { readOnly.fs.chown("/workspace/node_modules/c", 1, 1, resolve); });
  expect(viaCallback).toMatchObject({ code: "EROFS", syscall: "chown", path: "/workspace/node_modules/c" });
  // A descriptor names no path, so there is nothing to remember for it.
  expect(() => { readOnly.fs.fchownSync(OPEN, 1, 1); }).toThrow(expect.objectContaining({ code: "EROFS", syscall: "fchown" }));
  expect(refused).toEqual([["EROFS", "/workspace/node_modules/a"], ["EROFS", "/workspace/node_modules/b"], ["EROFS", "/workspace/node_modules/c"]]);

  // A name Linux cannot take is its ENAMETOOLONG; the record carries at most 4095 bytes.
  const long = linux(1000);
  expect(() => { createNodeChown(long.ports).fs.chownSync(`/${"a".repeat(4095)}`, 1, 1); }).toThrow(expect.objectContaining({ code: "ENAMETOOLONG", errno: -36, syscall: "chown" }));
  expect(long.requests).toEqual([]);

  const broken = new VMError("PROTOCOL_ERROR", "the channel closed");
  const closed = createNodeChown({ callSync: () => { throw broken; }, call: () => Promise.reject(broken) });
  expect(() => { closed.fs.fchownSync(OPEN, 1, 1); }).toThrow(broken);
  await expect(closed.promises.chown(FILE, 1, 1)).rejects.toBe(broken);
});

it("keeps the process alive until Linux answers and calls back through the process's queue, in the caller's context", async () => {
  let held = 0, released = 0; const queued: (() => void)[] = [], order: string[] = [];
  const pending = Promise.withResolvers<undefined>();
  const scheduling: ChownScheduling = {
    retain: () => { held += 1; return () => { released += 1; }; },
    dispatch: callback => { queued.push(callback); },
    context: { capture: () => inner => { order.push("context"); return inner(); } },
  };
  const node = createNodeChown({ callSync: () => undefined, call: () => pending.promise }, scheduling);
  const promised = node.promises.chown(FILE, 1, 1), handled = node.handleChown(OPEN, 1, 1);
  const called = new Promise<unknown[]>(resolve => { node.fs.fchown(OPEN, 1, 1, (...args: unknown[]) => { order.push("callback"); resolve(args); }); });
  // Without a hold the process would end as idle before Linux answers.
  expect([held, released]).toEqual([3, 0]);
  pending.resolve(undefined);
  await promised; await handled; await Promise.resolve();
  // The callback waits in the process's queue; it does not run from the transport's own turn, and its hold lasts until it ran.
  expect([order, queued.length, released]).toEqual([[], 1, 2]);
  queued[0]?.();
  expect(await called).toEqual([null]);
  expect([order, held, released]).toEqual([["context", "callback"], 3, 3]);

  // A refused argument holds nothing, and a failure releases its hold.
  expect(() => { node.fs.chown(FILE, "1", 1, () => undefined); }).toThrow(TypeError);
  await expect(node.promises.lchown(7, 1, 1)).rejects.toBeInstanceOf(TypeError);
  expect([held, released]).toEqual([3, 3]);
  const failing = createNodeChown({ callSync: () => undefined, call: () => Promise.reject(new LinuxError(1)) }, scheduling);
  await expect(failing.promises.chown(FILE, 0, 0)).rejects.toMatchObject({ code: "EPERM" });
  expect([held, released]).toEqual([4, 4]);
  // A callback that throws still releases the hold; the error is the queue's to report.
  failing.fs.chown(FILE, 0, 0, () => { throw new Error("from the callback"); });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(() => queued[1]?.()).toThrow("from the callback");
  expect([held, released]).toEqual([5, 5]);
});
