import { atFileOperations, CWD } from "../../js-process/at-operations.js";
import { LinuxError, type LinuxOperation } from "../../js-process/codec.js";
import { linuxErrnoCode } from "../../linux-errno.js";
import { validatedPath } from "./node-files-args.ts";
import { systemErrorMessage } from "./node-system-errors.ts";
import { invalidType, named, outOfRange, validateFunction, validateInteger } from "./node-util-validators.ts";

/** The process's own Linux channel, in both call styles (`LinuxClient.sync` and `LinuxClient.call`). */
export interface ChownPorts {
  callSync(operation: LinuxOperation<void>): void;
  call(operation: LinuxOperation<void>): Promise<void>;
  /** Told of every errno Linux answers for a path, before the program sees it: a launch remembers a write its
   * read-only dependency folders refused (`EROFS`). */
  readonly failed?: (code: string, path: string) => void;
}
/** How an asynchronous call joins the process: a hold on its event loop, its callback queue and its async context. */
export interface ChownScheduling {
  readonly retain?: () => () => void;
  readonly dispatch?: (callback: () => void) => void;
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
}

const AT_SYMLINK_NOFOLLOW = 0x100, MAX_ID = 0xffff_ffff, MAX_FD = 0x7fff_ffff, PATH_BYTES = 4095;
type Syscall = "chown" | "lchown" | "fchown";

function systemError(code: string, errno: number, syscall: Syscall, path?: string): Error {
  return Object.assign(new Error(systemErrorMessage(code, syscall, path ?? null, null)), { errno: -errno, code, syscall, ...(path === undefined ? {} : { path }) });
}
/** Node's `validateInteger(id, name, -1, kMaxUserId)`: -1 leaves the ID as it is. */
function id(value: unknown, name: "uid" | "gid"): number {
  validateInteger(value, name, -1, MAX_ID);
  return value;
}
/** A descriptor as Node's binding checks it; it words a bigint without the `n` its JavaScript checks print. */
function descriptor(value: unknown): number {
  if (typeof value === "bigint") throw Object.assign(new TypeError(`The "fd" argument must be of type number. Received type bigint (${String(value)})`), { code: "ERR_INVALID_ARG_TYPE" });
  if (typeof value !== "number") throw invalidType("fd", "number", value);
  if (!Number.isInteger(value)) throw outOfRange("fd", "an integer", value);
  if (value < 0 || value > MAX_FD) throw outOfRange("fd", `>= 0 && <= ${String(MAX_FD)}`, value);
  return value;
}
interface Request { readonly syscall: Syscall; readonly operation: LinuxOperation<void>; readonly path?: string }
/** `chown` follows a symbolic link and `lchown` names the link itself: both are fchownat under the working directory. */
function pathRequest(syscall: "chown" | "lchown", path: unknown, uid: unknown, gid: unknown): Request {
  const target = validatedPath(path), owner = id(uid, "uid"), group = id(gid, "gid");
  const bytes = typeof target.given === "string" ? new TextEncoder().encode(target.given) : target.given;
  // The record holds a path below 4096 bytes, which is also the longest Linux resolves: its answer is this one.
  if (bytes.byteLength > PATH_BYTES) throw systemError("ENAMETOOLONG", 36, syscall, target.text);
  return { syscall, path: target.text, operation: atFileOperations.chownAt(CWD, bytes, owner, group, syscall === "lchown" ? AT_SYMLINK_NOFOLLOW : 0) };
}
/** Node checks the IDs before the descriptor, so the caller passes them checked. */
function descriptorRequest(fd: unknown, owner: number, group: number): Request {
  return { syscall: "fchown", operation: atFileOperations.fchown(descriptor(fd), owner, group) };
}

/**
 * Node's `fs.chown`, `fs.lchown` and `fs.fchown` in their synchronous, callback and promise forms, and the call behind
 * `FileHandle.prototype.chown`. Linux decides who may give a file to whom (OXJR 260 and 93, Userspace API 154); here
 * the arguments are checked as Node checks them and Linux's errno is reported as Node reports it.
 */
export function createNodeChown(ports: ChownPorts, scheduling: ChownScheduling = {}) {
  const retain = scheduling.retain ?? (() => () => undefined), dispatch = scheduling.dispatch ?? ((callback: () => void): void => { callback(); });
  /** A Linux errno becomes Node's system error; anything else is not Linux's answer and passes through. */
  const failure = (error: unknown, request: Request): unknown => {
    if (!(error instanceof LinuxError)) return error;
    const code = linuxErrnoCode(error.errno);
    if (request.path !== undefined) ports.failed?.(code, request.path);
    return systemError(code, error.errno, request.syscall, request.path);
  };
  const runSync = (request: Request): void => {
    try { ports.callSync(request.operation); }
    catch (error) { throw failure(error, request); }
  };
  const ask = async (request: Request): Promise<void> => {
    try { await ports.call(request.operation); }
    catch (error) { throw failure(error, request); }
  };
  /** The process stays alive until Linux has answered. */
  const run = async (request: Request): Promise<void> => {
    const release = retain();
    try { await ask(request); }
    finally { release(); }
  };
  /** One hold spans the call and the callback, which runs from the process's queue in the context of the call. */
  const callBack = (request: Request, done: (...args: unknown[]) => unknown): void => {
    const within = scheduling.context?.capture() ?? (<Result>(inner: () => Result): Result => inner());
    const release = retain();
    const finish = (error: unknown): void => { dispatch(() => { try { within(() => { done(error); }); } finally { release(); } }); };
    void ask(request).then(() => { finish(null); }, finish);
  };

  const chownSync = named(function (path: unknown, uid: unknown, gid: unknown): void { runSync(pathRequest("chown", path, uid, gid)); }, "chownSync");
  const lchownSync = named(function (path: unknown, uid: unknown, gid: unknown): void { runSync(pathRequest("lchown", path, uid, gid)); }, "lchownSync");
  const fchownSync = named(function (fd: unknown, uid: unknown, gid: unknown): void { runSync(descriptorRequest(fd, id(uid, "uid"), id(gid, "gid"))); }, "fchownSync");
  // The path forms check the callback first; fchown checks it after the IDs and before the descriptor.
  const chown = named(function (path: unknown, uid: unknown, gid: unknown, callback: unknown): void {
    validateFunction(callback, "cb");
    callBack(pathRequest("chown", path, uid, gid), callback);
  }, "chown");
  const lchown = named(function (path: unknown, uid: unknown, gid: unknown, callback: unknown): void {
    validateFunction(callback, "cb");
    callBack(pathRequest("lchown", path, uid, gid), callback);
  }, "lchown");
  const fchown = named(function (fd: unknown, uid: unknown, gid: unknown, callback: unknown): void {
    const owner = id(uid, "uid"), group = id(gid, "gid");
    validateFunction(callback, "cb");
    callBack(descriptorRequest(fd, owner, group), callback);
  }, "fchown");
  const promises = {
    chown: named(async function (path: unknown, uid: unknown, gid: unknown): Promise<void> { await run(pathRequest("chown", path, uid, gid)); }, "chown"),
    lchown: named(async function (path: unknown, uid: unknown, gid: unknown): Promise<void> { await run(pathRequest("lchown", path, uid, gid)); }, "lchown"),
  };
  /** `FileHandle.prototype.chown(uid, gid)` on the handle's descriptor: every failure, a refused argument too, rejects. */
  const handleChown = named(async function (fd: number, uid: unknown, gid: unknown): Promise<void> { await run(descriptorRequest(fd, id(uid, "uid"), id(gid, "gid"))); }, "chown");
  return { fs: { chown, chownSync, fchown, fchownSync, lchown, lchownSync }, promises, handleChown };
}
