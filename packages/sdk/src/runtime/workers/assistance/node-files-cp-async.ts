/*!
 * `fs.cp` and `fs.promises.cp`, adapted from Node.js v24.18.1 lib/internal/fs/cp/cp.js. Node's `cpSync` is a separate
 * implementation, partly in C++, with other checks, errors and modes (see node-files-cp.ts), so the two share only
 * their options and the shape of their errors, as in Node.
 * Copyright Node.js contributors. All rights reserved. MIT License: see node-files-dir.ts for the full text.
 */
import { Dirent } from "./node-file-operations.js";
import { errorCode, shaped, validatedPath, type FileScheduling } from "./node-files-args.ts";
import { contextError, copyOptions, type CopyOptions, type CopyStatus } from "./node-files-cp.ts";
import { createNodePath } from "./node-path.js";
import { invalidType, validateFunction } from "./node-util-validators.ts";

/** The asynchronous operations a copy is made of: each is the runtime's own `fs.promises.*`. */
export interface AsyncCopyPorts extends FileScheduling {
  readonly stat: (path: string) => Promise<CopyStatus>;
  readonly lstat: (path: string) => Promise<CopyStatus>;
  readonly readdir: (path: string, options: { readonly withFileTypes: true }) => Promise<unknown>;
  readonly readlink: (path: string) => Promise<string>;
  readonly symlink: (target: string, path: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly mkdir: (path: string, options?: { readonly recursive: true }) => Promise<unknown>;
  readonly copyFile: (source: string, destination: string, mode: number) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly utimes: (path: string, atime: Date, mtime: Date) => Promise<void>;
  readonly cwd: () => string;
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
}
export interface NodeAsyncCopy {
  readonly cp: (src: unknown, dest: unknown, options: unknown, callback: unknown) => void;
  readonly promises: { readonly cp: (src: unknown, dest: unknown, options: unknown) => Promise<void> };
}

export function createNodeCopy(ports: AsyncCopyPorts): NodeAsyncCopy {
  const path = createNodePath(ports.cwd);
  const absent = async (read: Promise<CopyStatus>): Promise<CopyStatus | undefined> => { try { return await read; } catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; } };
  const identical = (source: CopyStatus, destination: CopyStatus): boolean => destination.ino !== 0 && destination.dev !== 0 && destination.ino === source.ino && destination.dev === source.dev;
  const subdirectory = (source: string, destination: string): boolean => {
    const parts = (value: string): string[] => path.resolve(value).split("/").filter(Boolean), inner = parts(destination);
    return parts(source).every((part, index) => inner[index] === part);
  };
  const inside = (source: string, destination: string): Error => contextError("ERR_FS_CP_EINVAL", "EINVAL", 22, `cannot copy ${source} to a subdirectory of self ${destination}`, destination);

  async function checkPaths(source: string, destination: string, options: CopyOptions): Promise<{ readonly from: CopyStatus; readonly to: CopyStatus | undefined } | undefined> {
    if (options.filter !== undefined) {
      const keep = Boolean(await options.filter(source, destination));
      if (!keep) return undefined;
    }
    const read = options.dereference ? ports.stat : ports.lstat;
    const [from, to] = await Promise.all([read(source), absent(read(destination))]);
    if (to !== undefined) {
      if (identical(from, to)) throw contextError("ERR_FS_CP_EINVAL", "EINVAL", 22, "src and dest cannot be the same", destination);
      if (from.isDirectory() && !to.isDirectory()) throw contextError("ERR_FS_CP_DIR_TO_NON_DIR", "EISDIR", 21, `cannot overwrite non-directory ${destination} with directory ${source}`, destination);
      if (!from.isDirectory() && to.isDirectory()) throw contextError("ERR_FS_CP_NON_DIR_TO_DIR", "ENOTDIR", 20, `cannot overwrite directory ${destination} with non-directory ${source}`, destination);
    }
    if (from.isDirectory() && subdirectory(source, destination)) throw inside(source, destination);
    return { from, to };
  }
  /** No directory above the destination may be the source itself, by whatever name. */
  async function checkParents(source: string, from: CopyStatus, destination: string): Promise<void> {
    for (let above = path.resolve(path.dirname(destination)), below = destination; above !== path.resolve(path.dirname(source)) && above !== "/"; below = above, above = path.resolve(path.dirname(above))) {
      const holder = await absent(ports.stat(above));
      if (holder === undefined) return;
      if (identical(from, holder)) throw inside(source, below);
    }
  }
  async function copyEntry(to: CopyStatus | undefined, source: string, destination: string, options: CopyOptions): Promise<void> {
    const from = await (options.dereference ? ports.stat : ports.lstat)(source);
    if (from.isDirectory() && options.recursive) { await copyDirectory(from, to, source, destination, options); return; }
    if (from.isDirectory()) throw contextError("ERR_FS_EISDIR", "EISDIR", 21, `${source} is a directory (not copied)`, source);
    if (from.isFile() || from.isCharacterDevice() || from.isBlockDevice()) { await copyFile(from, to, source, destination, options); return; }
    if (from.isSymbolicLink()) { await copyLink(to, source, destination, options); return; }
    if (from.isSocket()) throw contextError("ERR_FS_CP_SOCKET", "EINVAL", 22, `cannot copy a socket file: ${destination}`, destination);
    if (from.isFIFO()) throw contextError("ERR_FS_CP_FIFO_PIPE", "EINVAL", 22, `cannot copy a FIFO pipe: ${destination}`, destination);
    throw contextError("ERR_FS_CP_UNKNOWN", "EINVAL", 22, `cannot copy an unknown file type: ${destination}`, destination);
  }
  async function copyFile(from: CopyStatus, to: CopyStatus | undefined, source: string, destination: string, options: CopyOptions): Promise<void> {
    if (to !== undefined) {
      if (!options.force) {
        if (options.errorOnExist) throw contextError("ERR_FS_CP_EEXIST", "EEXIST", 17, `${destination} already exists`, destination);
        return;
      }
      await ports.unlink(destination);
    }
    await ports.copyFile(source, destination, options.mode);
    if (options.preserveTimestamps) {
      if ((from.mode & 0o200) === 0) await ports.chmod(destination, from.mode | 0o200);
      const current = await ports.stat(source);
      await ports.utimes(destination, current.atime, current.mtime);
    }
    await ports.chmod(destination, from.mode);
  }
  async function copyDirectory(from: CopyStatus, to: CopyStatus | undefined, source: string, destination: string, options: CopyOptions): Promise<void> {
    if (to !== undefined && options.errorOnExist && !options.force) throw contextError("ERR_FS_CP_EEXIST", "EEXIST", 17, `${destination} already exists`, destination);
    if (to === undefined) await ports.mkdir(destination);
    const listed = await ports.readdir(source, { withFileTypes: true });
    for (const entry of Array.isArray(listed) ? listed : []) {
      if (!(entry instanceof Dirent)) continue;
      const inner = path.join(source, entry.name), target = path.join(destination, entry.name);
      const checked = await checkPaths(inner, target, options);
      if (checked !== undefined) await copyEntry(checked.to, inner, target, options);
    }
    if (to === undefined) await ports.chmod(destination, from.mode);
  }
  async function copyLink(to: CopyStatus | undefined, source: string, destination: string, options: CopyOptions): Promise<void> {
    let target = await ports.readlink(source);
    if (!options.verbatimSymlinks && !path.isAbsolute(target)) target = path.resolve(path.dirname(source), target);
    if (to === undefined) { await ports.symlink(target, destination); return; }
    let current: string;
    try { current = await ports.readlink(destination); }
    catch (error) {
      if (errorCode(error) === "EINVAL" || errorCode(error) === "UNKNOWN") { await ports.symlink(target, destination); return; }
      throw error;
    }
    if (!path.isAbsolute(current)) current = path.resolve(path.dirname(destination), current);
    const followed = await absent(ports.stat(source));
    if (followed?.isDirectory() === true && subdirectory(target, current)) throw contextError("ERR_FS_CP_EINVAL", "EINVAL", 22, `cannot copy ${target} to a subdirectory of self ${current}`, destination);
    if ((await ports.stat(source)).isDirectory() && subdirectory(current, target)) throw contextError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", "EINVAL", 22, `cannot overwrite ${current} with ${target}`, destination);
    await ports.unlink(destination);
    await ports.symlink(target, destination);
  }
  async function copy(src: ReturnType<typeof validatedPath>, dest: ReturnType<typeof validatedPath>, options: CopyOptions): Promise<void> {
    const source = src.text, destination = dest.text;
    const checked = await checkPaths(source, destination, options);
    if (checked === undefined) return;
    // Node's path functions take the validated paths next, and refuse a Buffer.
    for (const given of [src.given, dest.given]) if (typeof given !== "string") throw invalidType("path", "string", given);
    await checkParents(source, checked.from, destination);
    const holder = path.dirname(destination);
    if (await absent(ports.stat(holder)) === undefined) await ports.mkdir(holder, { recursive: true });
    await copyEntry(checked.to, source, destination, options);
  }

  const promised = shaped(async function (src: unknown, dest: unknown, options: unknown): Promise<void> {
    const selected = copyOptions(options);
    await copy(validatedPath(src, "src"), validatedPath(dest, "dest"), selected);
  }, "cp", 3);
  const cp = shaped(function (src: unknown, dest: unknown, options: unknown, callback: unknown): void {
    const done = typeof options === "function" ? options : callback;
    validateFunction(done, "cb");
    const selected = copyOptions(typeof options === "function" ? undefined : options), source = validatedPath(src, "src"), destination = validatedPath(dest, "dest");
    const release = ports.retain(), run = ports.context?.capture() ?? (<Result>(inner: () => Result): Result => inner());
    const finish = (args: unknown[]): void => { ports.dispatch(() => { release(); run(() => { Reflect.apply(done, undefined, args); }); }); };
    copy(source, destination, selected).then(() => { finish([null, undefined]); }, (error: unknown) => { finish([error]); });
  }, "cp", 4);
  return { cp, promises: { cp: promised } };
}
