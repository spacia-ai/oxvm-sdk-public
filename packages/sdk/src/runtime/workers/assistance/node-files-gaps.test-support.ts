import { Buffer } from "buffer";
import type { AssistanceFileTime, AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult, AssistanceStat } from "../../protocol/assistance-reply.js";
import { createAsyncContext } from "./async-context.js";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";
import { inspectValue } from "./node-util-validators.ts";

/** A small Linux file tree in memory that answers the file service's operations, so that the tests of the `fs` additions
 * run against the runtime's real `createSyncFiles` and `createAsyncFiles` and not against a second model of them. */
interface Common { readonly ino: bigint; mode: number; atimeNs: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: number }
type Directory = Common & { readonly kind: "dir"; readonly entries: Map<string, Entry> };
type Regular = Common & { readonly kind: "file"; data: Uint8Array<ArrayBuffer> };
type Link = Common & { readonly kind: "link"; readonly target: string };
type Entry = Directory | Regular | Link;
interface Open { readonly node: Entry; position: number; readonly append: boolean; readonly writable: boolean }
type Failure = Extract<AssistanceResult, { kind: "error" }>;
const ERRNO: Readonly<Record<string, number>> = { ENOENT: 2, EBADF: 9, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ELOOP: 40, ENOTEMPTY: 39, EPERM: 1 };
const UMASK = 0o022;
const TYPE = { dir: 0o040000, file: 0o100000, link: 0o120000 } as const;

class Refusal extends Error { constructor(readonly code: string) { super(code); } }
const refuse = (code: string): never => { throw new Refusal(code); };

/** What a seeded path holds: text, a symbolic link's target, or a directory (`null`). */
export type Seed = string | { readonly link: string } | null;

export function createMemoryLinux(cwd = "/work") {
  let inodes = 1n, clock = 1_700_000_000_000_000_000n, descriptors = 2;
  const tick = (): bigint => { clock += 1_000_000_000n; return clock; };
  const common = (mode: number): Common => { const now = tick(); return { ino: ++inodes, mode, atimeNs: now, mtimeNs: now, ctimeNs: now, nlink: 1 }; };
  const directory = (mode = 0o755): Directory => ({ ...common(mode), kind: "dir", entries: new Map() });
  const root = directory();
  const open = new Map<number, Open>();
  const operations: AssistanceOperation[] = [];

  function parts(path: string): string[] { return (path.startsWith("/") ? path : `${cwd}/${path}`).split("/").filter(part => part !== "" && part !== "."); }
  /** The directory holding the last name of `path` and the entry there, following links on the way and, when asked, at the end. */
  function locate(path: string, follow: boolean, depth = 0): { readonly parent: Directory; readonly name: string; readonly node: Entry | undefined; readonly trail: readonly string[] } {
    if (depth > 20) refuse("ELOOP");
    const names = parts(path);
    let current: Directory = root; const trail: string[] = [], stack: Directory[] = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] ?? "", last = index === names.length - 1;
      if (name === "..") { current = stack.pop() ?? root; trail.pop(); if (last) return { parent: current, name: ".", node: current, trail }; continue; }
      const node = current.entries.get(name);
      if (last && (node === undefined || node.kind !== "link" || !follow)) {
        if (node !== undefined && node.kind !== "dir" && path.endsWith("/")) refuse("ENOTDIR");
        return { parent: current, name, node, trail: [...trail, name] };
      }
      if (node === undefined) return refuse("ENOENT");
      if (node.kind === "link") {
        const rest = names.slice(index + 1).join("/");
        const target = node.target.startsWith("/") ? node.target : `/${[...trail, node.target].join("/")}`;
        return locate(rest === "" ? target : `${target}/${rest}`, follow, depth + 1);
      }
      if (node.kind !== "dir") return refuse("ENOTDIR");
      stack.push(current); trail.push(name); current = node;
    }
    return { parent: current, name: ".", node: current, trail };
  }
  function existing(path: string, follow = true): Entry { return locate(path, follow).node ?? refuse("ENOENT"); }
  function directoryAt(path: string): Directory { const node = existing(path); return node.kind === "dir" ? node : refuse("ENOTDIR"); }
  function stat(node: Entry): AssistanceStat {
    const size = node.kind === "file" ? node.data.length : node.kind === "link" ? node.target.length : 4096;
    return { details: { rdev: 0n, birthtimeNs: node.ctimeNs }, dev: 64n, ino: node.ino, nlink: BigInt(node.nlink), size: BigInt(size), blocks: BigInt(Math.ceil(size / 512)),
      mode: TYPE[node.kind] | node.mode, uid: 0, gid: 0, blksize: 4096, atimeNs: node.atimeNs, mtimeNs: node.mtimeNs, ctimeNs: node.ctimeNs };
  }
  function descriptor(fd: number): Open { return open.get(fd) ?? refuse("EBADF"); }
  function regular(fd: number): Regular { const { node } = descriptor(fd); return node.kind === "file" ? node : refuse(node.kind === "dir" ? "EISDIR" : "EINVAL"); }
  function touch(node: Entry, atime: AssistanceFileTime, mtime: AssistanceFileTime): void {
    const now = tick();
    if (atime !== "omit") node.atimeNs = atime === "now" ? now : atime;
    if (mtime !== "omit") node.mtimeNs = mtime === "now" ? now : mtime;
    node.ctimeNs = now;
  }
  function resize(node: Regular, length: number): void { const next = new Uint8Array(length); next.set(node.data.subarray(0, length)); node.data = next; node.mtimeNs = node.ctimeNs = tick(); }
  const unit: AssistanceResult = { kind: "unit" };

  function answer(operation: AssistanceOperation): AssistanceResult {
    switch (operation.kind) {
      case "access": existing(operation.path); return unit;
      case "open": {
        const { flags } = operation, creates = flags >= 2, exclusive = [4, 5, 8, 9].includes(flags), truncates = flags >= 2 && flags <= 5;
        const found = locate(operation.path, true);
        let node = found.node;
        if (node === undefined) {
          if (!creates) refuse("ENOENT");
          node = { ...common(operation.mode & 0o777 & ~UMASK), kind: "file", data: new Uint8Array(0) };
          found.parent.entries.set(found.name, node); found.parent.mtimeNs = found.parent.ctimeNs = tick();
        } else if (exclusive) refuse("EEXIST");
        else if (node.kind === "dir" && flags !== 0) refuse("EISDIR");
        else if (node.kind === "file" && truncates) resize(node, 0);
        open.set(++descriptors, { node, position: 0, append: flags >= 6 && flags <= 9, writable: flags !== 0 });
        return { kind: "opened", fd: descriptors };
      }
      case "close": descriptor(operation.fd); open.delete(operation.fd); return unit;
      case "read": {
        const file = descriptor(operation.fd), node = regular(operation.fd);
        const start = operation.offset === null ? file.position : Number(operation.offset);
        const bytes = new Uint8Array(node.data.subarray(start, start + operation.length));
        if (operation.offset === null) file.position += bytes.length;
        return { kind: "data", bytes };
      }
      case "write": {
        const file = descriptor(operation.fd), node = regular(operation.fd);
        if (!file.writable) refuse("EBADF");
        const start = file.append ? node.data.length : operation.offset === null ? file.position : Number(operation.offset);
        if (start + operation.bytes.length > node.data.length) resize(node, start + operation.bytes.length);
        node.data.set(operation.bytes, start); node.mtimeNs = node.ctimeNs = tick();
        if (operation.offset === null) file.position = start + operation.bytes.length;
        return { kind: "written", count: operation.bytes.length };
      }
      case "fstat": return { kind: "stat", stat: stat(descriptor(operation.fd).node) };
      case "fsync": case "fdatasync": descriptor(operation.fd); return unit;
      case "stat": return { kind: "stat", stat: stat(existing(operation.path)) };
      case "lstat": return { kind: "stat", stat: stat(existing(operation.path, false)) };
      case "readdir": return { kind: "names", names: [...directoryAt(operation.path).entries.keys()] };
      case "readdir-entries": return { kind: "entries", entries: [...directoryAt(operation.path).entries].map(([name, node]) => ({ name, mode: TYPE[node.kind] | node.mode })) };
      case "readlink": { const node = existing(operation.path, false); return node.kind === "link" ? { kind: "path", path: node.target } : refuse("EINVAL"); }
      case "realpath": { const found = locate(operation.path, true); if (found.node === undefined) refuse("ENOENT"); return { kind: "path", path: `/${found.trail.join("/")}` }; }
      case "unlink": case "rmdir": {
        const found = locate(operation.path, false), node = found.node ?? refuse("ENOENT");
        if (operation.kind === "unlink" && node.kind === "dir") refuse("EISDIR");
        if (operation.kind === "rmdir" && node.kind !== "dir") refuse("ENOTDIR");
        if (node.kind === "dir" && node.entries.size !== 0) refuse("ENOTEMPTY");
        found.parent.entries.delete(found.name); node.nlink -= 1; found.parent.mtimeNs = found.parent.ctimeNs = tick();
        return unit;
      }
      case "mkdir": {
        const found = locate(operation.path, false);
        if (found.node !== undefined) refuse("EEXIST");
        found.parent.entries.set(found.name, directory(operation.mode & 0o777 & ~UMASK)); found.parent.mtimeNs = found.parent.ctimeNs = tick();
        return unit;
      }
      case "chmod": { const node = existing(operation.path); node.mode = operation.mode & 0o7777; node.ctimeNs = tick(); return unit; }
      case "fchmod": { const { node } = descriptor(operation.fd); node.mode = operation.mode & 0o7777; node.ctimeNs = tick(); return unit; }
      case "utime": touch(existing(operation.path), operation.atime, operation.mtime); return unit;
      case "lutime": touch(existing(operation.path, false), operation.atime, operation.mtime); return unit;
      case "futime": touch(descriptor(operation.fd).node, operation.atime, operation.mtime); return unit;
      case "truncate": { const node = existing(operation.path); if (node.kind !== "file") return refuse("EISDIR"); resize(node, Number(operation.length)); return unit; }
      case "ftruncate": resize(regular(operation.fd), Number(operation.length)); return unit;
      case "rename": case "link": {
        const from = locate(operation.path, false), node = from.node ?? refuse("ENOENT"), to = locate(operation.destination, false);
        if (operation.kind === "link") { if (to.node !== undefined) refuse("EEXIST"); node.nlink += 1; }
        else from.parent.entries.delete(from.name);
        to.parent.entries.set(to.name, node);
        return unit;
      }
      case "symlink": {
        const found = locate(operation.path, false);
        if (found.node !== undefined) refuse("EEXIST");
        found.parent.entries.set(found.name, { ...common(0o777), kind: "link", target: operation.target });
        return unit;
      }
      case "fork": case "watch-add": case "watch-remove": case "watch-read": case "socket-listen": case "socket-connect-local": case "socket-accept": case "socket-close":
      case "socket-address": case "socket-read": case "socket-write": case "socket-shutdown": case "socket-nodelay": case "socket-keepalive": case "start": case "stop": case "getcwd":
      case "chdir": case "check-dependencies": case "terminal-ack": case "spawn": case "stdin": case "close-stdin": case "signal": case "ack":
        throw new TypeError(`The memory Linux does not serve ${operation.kind}`);
    }
  }
  function call(operation: AssistanceOperation): AssistanceResult {
    operations.push(operation);
    try { return answer(operation); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      // Node names a failed symlink by its target and then the link.
      const failure: Failure = operation.kind === "symlink" ? { kind: "error", code: error.code, errno: ERRNO[error.code] ?? 5, syscall: "symlink", path: operation.target, destination: operation.path }
        : { kind: "error", code: error.code, errno: ERRNO[error.code] ?? 5, syscall: operation.kind, path: "path" in operation ? operation.path : null, destination: "destination" in operation ? operation.destination : null };
      return failure;
    }
  }
  /** Creates each path in the given order, with its missing parent directories. */
  function seed(tree: Readonly<Record<string, Seed>>): void {
    for (const [path, content] of Object.entries(tree)) {
      const names = parts(path); let current = root;
      for (const name of names.slice(0, -1)) {
        let next = current.entries.get(name);
        if (next === undefined) { next = directory(); current.entries.set(name, next); }
        if (next.kind !== "dir") throw new TypeError(`${path} passes through a file`);
        current = next;
      }
      const name = names.at(-1);
      if (name === undefined) continue;
      if (content === null) { if (!current.entries.has(name)) current.entries.set(name, directory()); }
      else if (typeof content === "string") current.entries.set(name, { ...common(0o644), kind: "file", data: new TextEncoder().encode(content) });
      else current.entries.set(name, { ...common(0o777), kind: "link", target: content.link });
    }
  }
  /** Every path below `path`, as `dir`, `link -> target` or `file:` and its text. */
  function listing(path: string): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (node: Entry, at: string): void => {
      if (node.kind === "file") result[at] = `file:${new TextDecoder().decode(node.data)}`;
      else if (node.kind === "link") result[at] = `link -> ${node.target}`;
      else { result[at] = "dir"; for (const [name, child] of [...node.entries].sort(([left], [right]) => left < right ? -1 : 1)) visit(child, at === "" ? name : `${at}/${name}`); }
    };
    const start = locate(path, false).node;
    if (start !== undefined) visit(start, "");
    return result;
  }
  return { call, seed, listing, operations, openDescriptors: () => open.size, node: (path: string) => locate(path, false).node, tick, cwd };
}

/** The runtime's own synchronous and asynchronous `fs` over one memory Linux, with the process ports counted. */
export function createMemoryFiles(tree: Readonly<Record<string, Seed>> = {}, cwd = "/work") {
  const linux = createMemoryLinux(cwd);
  linux.seed({ [cwd]: null, ...tree });
  const held = { now: 0, total: 0 };
  const retain = (): (() => void) => { held.now += 1; held.total += 1; let released = false; return () => { if (!released) { released = true; held.now -= 1; } }; };
  const queue: (() => void)[] = [];
  const dispatch = (callback: () => void): void => { queue.push(callback); queueMicrotask(() => { queue.shift()?.(); }); };
  const context = createAsyncContext();
  const files = createSyncFiles(operation => linux.call(operation), () => cwd, 10, inspectValue);
  const asynchronous = createAsyncFiles(operation => Promise.resolve().then(() => linux.call(operation)), () => cwd, context, retain, dispatch, { copyOpenMode: 10, inspect: inspectValue });
  return { linux, files, asynchronous, retain, dispatch, held, context };
}

// ---- scenarios recorded from Node -------------------------------------------------------------------------------------------------

export interface Scenario { readonly name: string; readonly source: string; readonly result: unknown }
/** The scenarios of a controls file: each is the body of an async function of `(fs, h)` that ran in Node 24.18.1. */
export function readScenarios(text: string): Scenario[] {
  const controls: unknown = JSON.parse(text);
  const scenarios: unknown = typeof controls === "object" && controls !== null ? Reflect.get(controls, "scenarios") : undefined;
  if (typeof scenarios !== "object" || scenarios === null) throw new TypeError("controls have no scenarios");
  return Object.entries(scenarios).map(([name, value]: [string, unknown]) => {
    const source: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "source") : undefined;
    if (typeof source !== "string") throw new TypeError(`scenario ${name} has no source`);
    const result: unknown = Reflect.get(Object(value), "result");
    return { name, source, result };
  });
}
function describe(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const description: Record<string, unknown> = { name: error.name, ctor: error.constructor.name, message: error.message };
  for (const key of ["code", "errno", "syscall", "path", "dest"]) { const value: unknown = Reflect.get(error, key); if (value !== undefined) description[key] = value; }
  return description;
}
const bytes = (value: unknown): unknown => Buffer.isBuffer(value) ? { hex: value.toString("hex") } : value;
/** The recorder's `h`, with this layer's Buffer. */
export function scenarioHelpers(warnings: unknown[], fire: () => void = () => undefined) {
  const probe = (entry: unknown, name: string): boolean => { const test: unknown = Reflect.get(Object(entry), name); return typeof test === "function" && Reflect.apply(test, entry, []) === true; };
  return {
    Buffer, custom: Symbol.for("nodejs.util.promisify.custom"), warnings, err: describe,
    attempt(run: () => unknown): unknown { try { return { ok: run() }; } catch (error) { return { error: describe(error) }; } },
    async attemptAsync(run: () => unknown): Promise<unknown> { try { return { ok: await run() }; } catch (error) { return { error: describe(error) }; } },
    turn: (): Promise<void> => new Promise(resolve => { setImmediate(resolve); }),
    /** The recorder sleeps through several polls here; the replay fires the poll timers and lets their answers land. */
    async wait(): Promise<void> { for (let round = 0; round < 3; round += 1) { fire(); await new Promise(resolve => { setImmediate(resolve); }); } },
    dirent: (entry: unknown): unknown => entry === null ? null : [bytes(Reflect.get(Object(entry), "name")), bytes(Reflect.get(Object(entry), "parentPath")),
      probe(entry, "isDirectory") ? "dir" : probe(entry, "isSymbolicLink") ? "link" : probe(entry, "isFile") ? "file" : "other"],
    fn: (value: unknown): unknown => typeof value === "function" ? [value.name, value.length] : typeof value,
  };
}
/** Runs a recorded scenario against `fs` and answers what it returned, as JSON holds it. */
export async function runScenario(source: string, fs: object, helpers: object): Promise<unknown> {
  // The scenario is the very text Node ran; evaluating it is the point of the replay.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the replay runs the recorded scenario text itself
  const body = new Function("fs", "h", `return (async () => {${source}\n})()`);
  const result: unknown = await Reflect.apply(body, undefined, [fs, helpers]);
  const text = JSON.stringify(result);
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

import { createNodeFilesGaps } from "./node-files-gaps.ts";
import type { PollTimer } from "./node-files-poll.ts";
import { EventEmitter } from "./node-streams.js";
import { createNodeReadStreams } from "./node-read-stream.js";
import { createNodeWriteStreams } from "./node-write-stream.js";
/** `fs` as the process runtime assembles it, over a memory Linux. */
export function createMemoryFs(tree: Readonly<Record<string, Seed>> = {}) {
  const memory = createMemoryFiles(tree);
  const streams = { ...createNodeReadStreams((path, flags) => memory.asynchronous.promises.open(path, flags), memory.context),
    ...createNodeWriteStreams((path, flags, mode) => memory.asynchronous.promises.open(path, flags, mode), memory.context) };
  // Timers and watchers the test drives: nothing here waits on the clock or on Linux.
  const intervals = new Set<{ readonly callback: () => void; readonly milliseconds: number; referenced: boolean; ref(): unknown; unref(): unknown }>();
  const timers = {
    setInterval(callback: () => void, milliseconds: number) {
      const timer = { callback, milliseconds, referenced: true, ref() { timer.referenced = true; return timer; }, unref() { timer.referenced = false; return timer; } };
      intervals.add(timer); return timer;
    },
    clearInterval(timer: PollTimer): void { for (const known of intervals) if (known === timer) intervals.delete(known); },
  };
  const watched: { readonly path: string; readonly options: object; readonly emitter: EventEmitter; closed: boolean }[] = [];
  const watch = (path: string, options: object) => {
    try { memory.files.statSync(path); } catch { throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${path}'`), { errno: -2, code: "ENOENT", syscall: "watch", path }); }
    const emitter = new EventEmitter(), entry = { path, options, emitter, closed: false };
    watched.push(entry);
    return { on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener), close: (): void => { entry.closed = true; } };
  };
  const warnings: [string, string][] = [];
  const gaps = createNodeFilesGaps({ timers, watch, warn: (message, type) => { warnings.push([type, message]); }, ReadStream: streams.ReadStream, WriteStream: streams.WriteStream, files: memory.files, asynchronous: memory.asynchronous, retain: memory.retain, dispatch: memory.dispatch, cwd: () => memory.linux.cwd, context: memory.context });
  const promises = { ...memory.asynchronous.promises, ...gaps.promises };
  return { ...memory, gaps, intervals, watched, warnings, fs: { ...memory.files, ...memory.asynchronous, ...streams, ...gaps.fs, promises } };
}

/** Replaces the value at `path` of a recorded result: a place where this layer knowingly differs from Node. */
export function withDeviation(result: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy: unknown = structuredClone(result);
  let target: unknown = copy;
  for (const key of path.slice(0, -1)) target = Reflect.get(Object(target), key);
  const last = path.at(-1);
  if (last === undefined || typeof target !== "object" || target === null || !Reflect.has(target, last)) throw new TypeError(`no recorded value at ${path.join(".")}`);
  Reflect.set(target, last, value);
  return copy;
}
