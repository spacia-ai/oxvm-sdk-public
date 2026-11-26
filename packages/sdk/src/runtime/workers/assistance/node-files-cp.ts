/*!
 * `fs.cpSync`, adapted from Node.js v24.18.1 lib/internal/fs/cp/cp-sync.js; the parts Node does in C++
 * (`cpSyncCheckPaths`, `cpSyncCopyDir`, `cpSyncOverrideFile` in src/node_file.cc) are written from recorded behaviour.
 * Copyright Node.js contributors. All rights reserved. MIT License: see node-files-dir.ts for the full text.
 */
import { Dirent } from "./node-file-operations.js";
import { codeError, errorCode, reissued, systemError, validatedPath } from "./node-files-args.ts";
import { createNodePath } from "./node-path.js";
import { named, validateBoolean, validateFunction, validateInteger, validateObject } from "./node-util-validators.ts";

/** What `cpSync` reads of a `Stats`. */
export interface CopyStatus {
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean; isSocket(): boolean; isFIFO(): boolean;
  readonly mode: number; readonly dev: number; readonly ino: number; readonly atime: Date; readonly mtime: Date;
}
/** The synchronous operations a copy is made of: each is the runtime's own `fs.*Sync`. */
export interface CopyPorts {
  readonly statSync: (path: string) => CopyStatus;
  readonly lstatSync: (path: string) => CopyStatus;
  readonly readdirSync: (path: string, options: { readonly withFileTypes: true }) => unknown;
  readonly readlinkSync: (path: string) => string;
  readonly realpathSync: (path: string) => string;
  readonly symlinkSync: (target: string, path: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly rmdirSync: (path: string) => void;
  readonly mkdirSync: (path: string, options?: { readonly recursive: true }) => void;
  readonly copyFileSync: (source: string, destination: string, mode: number) => void;
  readonly chmodSync: (path: string, mode: number) => void;
  readonly utimesSync: (path: string, atime: Date, mtime: Date) => void;
  readonly cwd: () => string;
}

export interface CopyOptions {
  readonly dereference: boolean; readonly errorOnExist: boolean; readonly force: boolean; readonly preserveTimestamps: boolean; readonly recursive: boolean;
  readonly verbatimSymlinks: boolean; readonly mode: number; readonly filter: ((source: string, destination: string) => unknown) | undefined;
}
/** Node's `validateCpOptions`. */
export function copyOptions(options: unknown): CopyOptions {
  if (options !== undefined) validateObject(options, "options");
  const flag = (name: string, fallback: boolean): boolean => {
    const value: unknown = options === undefined ? undefined : Reflect.get(options, name), selected = value === undefined ? fallback : value;
    validateBoolean(selected, `options.${name}`);
    return selected;
  };
  const dereference = flag("dereference", false), errorOnExist = flag("errorOnExist", false), force = flag("force", true), preserveTimestamps = flag("preserveTimestamps", false);
  const recursive = flag("recursive", false), verbatimSymlinks = flag("verbatimSymlinks", false);
  const requested: unknown = options === undefined ? undefined : Reflect.get(options, "mode"), mode = requested ?? 0;
  validateInteger(mode, "mode", 0, 7);
  if (dereference && verbatimSymlinks) throw codeError(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", 'Option "dereference" cannot be used in combination with option "verbatimSymlinks"');
  const filter: unknown = options === undefined ? undefined : Reflect.get(options, "filter");
  if (filter !== undefined) validateFunction(filter, "options.filter");
  return { dereference, errorOnExist, force, preserveTimestamps, recursive, verbatimSymlinks, mode, filter };
}

/** Node's `SystemError` as its JavaScript `cp` code throws it: a context in the message and in `info`. */
class NodeError extends Error {}
named(NodeError, "NodeError");
const SYSTEM_PREFIX: Readonly<Record<string, string>> = { ERR_FS_CP_EEXIST: "Target already exists", ERR_FS_CP_EINVAL: "Invalid src or dest", ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: "Cannot overwrite symlink in subdirectory of self",
  ERR_FS_CP_DIR_TO_NON_DIR: "Cannot overwrite non-directory with directory", ERR_FS_CP_NON_DIR_TO_DIR: "Cannot overwrite directory with non-directory", ERR_FS_EISDIR: "Path is a directory",
  ERR_FS_CP_SOCKET: "Cannot copy a socket file", ERR_FS_CP_FIFO_PIPE: "Cannot copy a FIFO pipe", ERR_FS_CP_UNKNOWN: "Cannot copy an unknown file type" };
export function contextError(key: string, code: string, errno: number, message: string, path: string): Error {
  const info = { message, path, syscall: "cp", errno, code };
  const error = new NodeError(`${SYSTEM_PREFIX[key] ?? key}: cp returned ${code} (${message}) ${path}`);
  Object.defineProperty(error, "name", { value: "SystemError", enumerable: false, writable: true, configurable: true });
  return Object.assign(error, { code: key, info, errno, syscall: "cp", path });
}
/** A failure of Node's C++ copy, which reports the C library's words about the whole copy's destination. */
function nativeError(code: "EEXIST" | "EINVAL" | "ENOTDIR", errno: number, text: string, destination: string): Error {
  return Object.assign(new Error(`${code}, ${text} '${destination}'`), { code, errno, syscall: "cp", path: destination });
}

export function createNodeCopySync(ports: CopyPorts): (src: unknown, dest: unknown, options: unknown) => void {
  const path = createNodePath(ports.cwd);
  const missing = <Result>(read: () => Result): Result | undefined => { try { return read(); } catch { return undefined; } };
  /** `lstat` or `stat` of a destination: only ENOENT means "not there", as Node's `throwIfNoEntry: false` has it here. */
  const present = (read: () => CopyStatus): CopyStatus | undefined => { try { return read(); } catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; } };
  /** `std::filesystem::path::parent_path`. */
  const parent = (value: string): string => { const slash = value.lastIndexOf("/"); return slash < 0 ? "" : slash === 0 ? "/" : value.slice(0, slash); };
  const same = (left: CopyStatus, right: CopyStatus): boolean => left.dev === right.dev && left.ino === right.ino;
  const allowed = (options: CopyOptions, source: string, destination: string): boolean => {
    if (options.filter === undefined) return true;
    const answer = options.filter(source, destination);
    if (answer instanceof Promise) throw codeError(TypeError, "ERR_INVALID_RETURN_VALUE", 'Expected boolean to be returned from the "filter" function but got an instance of Promise.');
    return Boolean(answer);
  };

  /** Node's `cpSyncCheckPaths`. With `dereference` it examines the source link itself and the destination's target,
   * and without it the other way round: that is what Node 24.18.1 does, and what its errors show. */
  function checkPaths(source: string, destination: string, options: CopyOptions): void {
    let from: CopyStatus;
    try { from = options.dereference ? ports.lstatSync(source) : ports.statSync(source); }
    catch (error) { throw reissued(error, options.dereference ? "stat" : "lstat", source); }
    const to = missing(() => options.dereference ? ports.statSync(destination) : ports.lstatSync(destination));
    const sourceIsDirectory = from.isDirectory() || (options.dereference && from.isSymbolicLink());
    if (to !== undefined) {
      // Node compares the two files behind any links; a dangling link here aborts Node itself, and fails as stat fails here.
      if (same(ports.statSync(source), ports.statSync(destination))) throw codeError(Error, "ERR_FS_CP_EINVAL", `src and dest cannot be the same ${destination}`);
      if (sourceIsDirectory && !to.isDirectory()) throw codeError(Error, "ERR_FS_CP_DIR_TO_NON_DIR", `Cannot overwrite non-directory ${destination} with directory ${source}`);
      if (!sourceIsDirectory && to.isDirectory()) throw codeError(Error, "ERR_FS_CP_NON_DIR_TO_DIR", `Cannot overwrite directory ${destination} with non-directory ${source}`);
    }
    const prefix = source.endsWith("/") ? source : `${source}/`;
    const inside = (): Error => codeError(Error, "ERR_FS_CP_EINVAL", `Cannot copy ${prefix} to a subdirectory of self ${destination}`);
    if (sourceIsDirectory && destination.startsWith(prefix)) throw inside();
    for (let above = parent(destination); parent(source) !== above && parent(above) !== "" && parent(above) !== above; above = parent(above)) {
      const holder = missing(() => ports.statSync(parent(destination))), origin = missing(() => ports.statSync(source));
      if (holder === undefined || origin === undefined) break;
      if (same(origin, holder)) throw inside();
    }
    if (sourceIsDirectory && !options.recursive) throw codeError(Error, "ERR_FS_EISDIR", `Recursive option not enabled, cannot copy a directory: ${prefix}`);
    const holder = parent(destination);
    if (holder !== "" && missing(() => ports.statSync(holder)) === undefined) ports.mkdirSync(holder, { recursive: true });
  }

  function copyEntry(source: string, destination: string, options: CopyOptions): void {
    const read = options.dereference ? ports.statSync : ports.lstatSync;
    const from = read(source), to = present(() => read(destination));
    if (from.isDirectory() && options.recursive) { copyDirectory(source, destination, options, to === undefined ? from.mode : undefined); return; }
    if (from.isFile() || from.isCharacterDevice() || from.isBlockDevice()) { copyFile(from, to, source, destination, options); return; }
    if (from.isSymbolicLink()) { copyLink(to, source, destination, options.verbatimSymlinks); return; }
    throw new Error("Unreachable code");
  }
  function timestamps(from: CopyStatus, source: string, destination: string): void {
    if ((from.mode & 0o200) === 0) ports.chmodSync(destination, from.mode | 0o200);
    const current = ports.statSync(source);
    ports.utimesSync(destination, current.atime, current.mtime);
  }
  function copyFile(from: CopyStatus, to: CopyStatus | undefined, source: string, destination: string, options: CopyOptions): void {
    if (to === undefined) {
      ports.copyFileSync(source, destination, options.mode);
      if (options.preserveTimestamps) timestamps(from, source, destination);
      ports.chmodSync(destination, from.mode);
      return;
    }
    if (options.force) {
      // Node removes what is there (an empty directory too) and copies; the exclusive mode therefore never refuses.
      if (ports.lstatSync(destination).isDirectory()) ports.rmdirSync(destination); else ports.unlinkSync(destination);
      ports.copyFileSync(source, destination, options.mode);
      if (options.preserveTimestamps) { const current = ports.statSync(source); ports.utimesSync(destination, current.atime, current.mtime); }
      return;
    }
    if (options.errorOnExist) throw contextError("ERR_FS_CP_EEXIST", "EEXIST", 17, `${destination} already exists`, destination);
  }
  function entriesOf(directory: string): Dirent[] {
    const listed = ports.readdirSync(directory, { withFileTypes: true });
    if (!Array.isArray(listed)) throw new TypeError("Invalid directory listing");
    return listed.filter((entry: unknown): entry is Dirent => entry instanceof Dirent);
  }
  function copyDirectory(source: string, destination: string, options: CopyOptions, createdMode: number | undefined): void {
    if (options.filter === undefined) { copyTree(source, destination, destination, options); return; }
    if (createdMode !== undefined) ports.mkdirSync(destination);
    let entries: Dirent[];
    try { entries = entriesOf(source); } catch (error) { throw reissued(error, "opendir"); }
    try {
      for (const { name } of entries) {
        const from = path.join(source, name), to = path.join(destination, name);
        if (allowed(options, from, to)) copyEntry(from, to, options);
      }
    } finally { if (createdMode !== undefined) ports.chmodSync(destination, createdMode); }
  }
  /** Node's `cpSyncCopyDir`, the C++ walk it uses when there is no filter: directories are made with the default
   * mode, files keep theirs, and `dereference` changes nothing below the top. */
  function copyTree(source: string, destination: string, top: string, options: CopyOptions): void {
    const there = missing(() => ports.statSync(destination));
    if (there === undefined) ports.mkdirSync(destination, { recursive: true });
    // Not recorded: what Node's C++ reports for a directory copied over a file.
    else if (!there.isDirectory()) throw nativeError("ENOTDIR", 20, "Not a directory", top);
    for (const entry of entriesOf(source)) {
      const from = `${source.replace(/\/$/u, "")}/${entry.name}`, to = `${destination.replace(/\/$/u, "")}/${entry.name}`;
      if (entry.isSymbolicLink()) { copyTreeLink(from, to, top, options); continue; }
      if (entry.isDirectory()) { copyTree(from, to, top, options); continue; }
      const existing = missing(() => ports.lstatSync(to));
      if (existing?.isDirectory() === true) throw nativeError("EINVAL", 22, "Invalid argument", top);
      if (existing !== undefined && !options.force) {
        if (options.errorOnExist) throw codeError(Error, "ERR_FS_CP_EEXIST", `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${to} already exists)`);
        continue;
      }
      ports.copyFileSync(from, to, 0);
      if (options.preserveTimestamps) { const current = ports.statSync(from); ports.utimesSync(to, current.atime, current.mtime); }
    }
  }
  /** `std::filesystem::weakly_canonical`: the links of the part that exists are resolved, the rest is kept as text. */
  function canonical(absolute: string): string {
    const rest: string[] = [];
    for (let current = absolute; ; current = path.dirname(current)) {
      const real = missing(() => ports.realpathSync(current));
      if (real !== undefined) return rest.length === 0 ? real : path.join(real, ...rest);
      if (current === "/") return absolute;
      rest.unshift(path.basename(current));
    }
  }
  function copyTreeLink(from: string, to: string, top: string, options: CopyOptions): void {
    const target = ports.readlinkSync(from);
    // shortcut: Node also refuses a link whose target holds, or is held by, the directory an existing destination link
    // points to (ERR_FS_CP_EINVAL, ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY); those two checks of the C++ walk are not ported.
    if (!options.verbatimSymlinks && missing(() => ports.statSync(to)) !== undefined) {
      if (!ports.lstatSync(to).isSymbolicLink()) throw nativeError("EEXIST", 17, "File exists", top);
      ports.unlinkSync(to);
    }
    try { ports.symlinkSync(options.verbatimSymlinks || path.isAbsolute(target) ? target : canonical(path.resolve(path.dirname(from), target)), to); }
    catch (error) { throw errorCode(error) === "EEXIST" ? nativeError("EEXIST", 17, "File exists", top) : error; }
  }
  const subdirectory = (source: string, destination: string): boolean => {
    const parts = (value: string): string[] => path.resolve(value).split("/").filter(Boolean), inner = parts(destination);
    return parts(source).every((part, index) => inner[index] === part);
  };
  function copyLink(to: CopyStatus | undefined, source: string, destination: string, verbatim: boolean): void {
    let target = ports.readlinkSync(source);
    if (!verbatim && !path.isAbsolute(target)) target = path.resolve(path.dirname(source), target);
    if (to === undefined) { ports.symlinkSync(target, destination); return; }
    let current: string;
    try { current = ports.readlinkSync(destination); }
    catch (error) {
      if (errorCode(error) === "EINVAL" || errorCode(error) === "UNKNOWN") { ports.symlinkSync(target, destination); return; }
      throw error;
    }
    if (!path.isAbsolute(current)) current = path.resolve(path.dirname(destination), current);
    if (missing(() => ports.statSync(source))?.isDirectory() === true && subdirectory(target, current)) {
      throw contextError("ERR_FS_CP_EINVAL", "EINVAL", 22, `cannot copy ${target} to a subdirectory of self ${current}`, destination);
    }
    if (ports.statSync(destination).isDirectory() && subdirectory(current, target)) {
      throw contextError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", "EINVAL", 22, `cannot overwrite ${current} with ${target}`, destination);
    }
    ports.unlinkSync(destination);
    ports.symlinkSync(target, destination);
  }

  return named(function (src: unknown, dest: unknown, options: unknown): void {
    const selected = copyOptions(options), source = validatedPath(src, "src").text, destination = validatedPath(dest, "dest").text;
    if (!allowed(selected, source, destination)) return;
    checkPaths(source, destination, selected);
    copyEntry(source, destination, selected);
  }, "cpSync");
}
/** A status the runtime answered, or Node's ENOENT when it answered none (`throwIfNoEntry: false` is never asked here). */
export function requiredStatus<Status>(status: Status | undefined, path: string, syscall: string): Status {
  if (status === undefined) throw systemError("ENOENT", syscall, path);
  return status;
}
