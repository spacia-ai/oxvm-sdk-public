import type { createAsyncFiles, createSyncFiles } from "./node-files.js";
import type { FileScheduling } from "./node-files-args.ts";
import { createNodeCopySync, requiredStatus, type CopyStatus } from "./node-files-cp.ts";
import { createNodeCopy } from "./node-files-cp-async.ts";
import { createNodeDirectories } from "./node-files-dir.ts";
import { createNodeGlob } from "./node-files-glob.ts";
import { createNodeMiscellaneousFiles } from "./node-files-misc.ts";
import { createNodeFilePolling, type ChangeWatcher, type PollTimer } from "./node-files-poll.ts";
import { createNodeVectoredFiles, withVectoredHandle } from "./node-files-vectored.ts";
import { Stats } from "./node-stats.ts";
import { named } from "./node-util-validators.ts";

/** What the `fs` additions are built on: the runtime's own synchronous and asynchronous file operations and the
 * process's scheduling. Nothing here reaches Linux except through `files` and `asynchronous`. */
export interface NodeFilesGapsDependencies extends FileScheduling {
  /** `createSyncFiles(...)`: the synchronous API. */
  readonly files: ReturnType<typeof createSyncFiles>;
  /** `createAsyncFiles(...)`: the callback API and `promises`. */
  readonly asynchronous: ReturnType<typeof createAsyncFiles>;
  /** `fs.ReadStream` and `fs.WriteStream` (`createNodeReadStreams(...)`, `createNodeWriteStreams(...)`): Node exports the
   * same two constructors again as `FileReadStream` and `FileWriteStream`. */
  readonly ReadStream: unknown;
  readonly WriteStream: unknown;
  /** `fs.watch` (`createNodeWatchers(...).watch`), which `fs.promises.watch` iterates. */
  readonly watch: (path: string, options: { readonly persistent: boolean; readonly recursive: boolean; readonly encoding: string }) => ChangeWatcher;
  /** The process's interval timers (`timers.setInterval`, `timers.clear`): `watchFile` polls on one. */
  readonly timers: { readonly setInterval: (callback: () => void, milliseconds: number) => PollTimer; readonly clearInterval: (timer: PollTimer) => void };
  /** `process.emitWarning(message, type)`. */
  readonly warn?: (message: string, type: string) => void;
  /** The process's working directory (`directory.cwd`). */
  readonly cwd: () => string;
  /** The process's async context, so a callback runs in the context of the call that registered it. */
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
}

export function createNodeFilesGaps(dependencies: NodeFilesGapsDependencies) {
  const { files, asynchronous, retain, dispatch, nextTick } = dependencies;
  const scheduling: FileScheduling = { retain, dispatch, ...(nextTick === undefined ? {} : { nextTick }) };
  const directories = createNodeDirectories({ ...scheduling, readdirSync: (path, options) => files.readdirSync(path, options), readdir: (path, options) => asynchronous.promises.readdir(path, options) });
  const { context, cwd } = dependencies;
  const vectored = createNodeVectoredFiles({ ...scheduling, ...(context === undefined ? {} : { context }),
    readSync: (...args) => files.readSync(...args), writeSync: (...args) => files.writeSync(...args),
    read: (...args) => { asynchronous.read(...args); }, write: (...args) => { asynchronous.write(...args); } });
  const miscellaneous = createNodeMiscellaneousFiles({ cwd,
    access: (path, mode, callback) => { asynchronous.access(path, mode, callback); }, readFileSync: path => files.readFileSync(path),
    mkdtempSync: (prefix, options) => files.mkdtempSync(prefix, options), rmSync: (path, options) => { files.rmSync(path, options); },
    mkdtemp: (prefix, options) => asynchronous.promises.mkdtemp(prefix, options), rm: (path, options) => asynchronous.promises.rm(path, options) });
  const cpSync = createNodeCopySync({ cwd,
    statSync: path => requiredStatus(files.statSync(path), path, "stat"), lstatSync: path => requiredStatus(files.lstatSync(path), path, "lstat"),
    readdirSync: (path, options) => files.readdirSync(path, options), readlinkSync: path => files.readlinkSync(path), realpathSync: path => files.realpathSync(path),
    symlinkSync: (target, path) => { files.symlinkSync(target, path); }, unlinkSync: path => { files.unlinkSync(path); }, rmdirSync: path => { files.rmdirSync(path); },
    mkdirSync: (path, options) => { if (options === undefined) files.mkdirSync(path); else files.mkdirSync(path, options); },
    copyFileSync: (source, destination, mode) => { files.copyFileSync(source, destination, mode); }, chmodSync: (path, mode) => { files.chmodSync(path, mode); },
    utimesSync: (path, atime, mtime) => { files.utimesSync(path, atime, mtime); } });
  const globs = createNodeGlob({ ...scheduling, ...(context === undefined ? {} : { context }), cwd,
    lstatSync: path => requiredStatus(files.lstatSync(path), path, "lstat"), statSync: path => requiredStatus(files.statSync(path), path, "stat"),
    realpathSync: path => files.realpathSync(path), readdirSync: (path, options) => files.readdirSync(path, options),
    lstat: async path => requiredStatus(await asynchronous.promises.lstat(path), path, "lstat"), stat: async path => requiredStatus(await asynchronous.promises.stat(path), path, "stat"),
    realpath: async path => String(await asynchronous.promises.realpath(path)), readdir: (path, options) => asynchronous.promises.readdir(path, options) });
  const polling = createNodeFilePolling({ ...scheduling, cwd, timers: dependencies.timers, watch: dependencies.watch, ...(dependencies.warn === undefined ? {} : { warn: dependencies.warn }),
    stat: async (path, options) => requiredStatus(await asynchronous.promises.stat(path, options), path, "stat") });
  /** A status asked for without options is a plain `Stats`. */
  const plain = (status: unknown, path: string, syscall: string): CopyStatus => { if (status instanceof Stats) return status; throw new TypeError(`Invalid ${syscall} answer for ${path}`); };
  const copies = createNodeCopy({ ...scheduling, ...(context === undefined ? {} : { context }), cwd,
    stat: async path => plain(await asynchronous.promises.stat(path), path, "stat"), lstat: async path => plain(await asynchronous.promises.lstat(path), path, "lstat"),
    readdir: (path, options) => asynchronous.promises.readdir(path, options), readlink: async path => String(await asynchronous.promises.readlink(path)),
    symlink: (target, path) => asynchronous.promises.symlink(target, path), unlink: path => asynchronous.promises.unlink(path),
    mkdir: (path, options) => options === undefined ? asynchronous.promises.mkdir(path) : asynchronous.promises.mkdir(path, options),
    copyFile: (source, destination, mode) => asynchronous.promises.copyFile(source, destination, mode), chmod: (path, mode) => asynchronous.promises.chmod(path, mode),
    utimes: (path, atime, mtime) => asynchronous.promises.utimes(path, atime, mtime) });
  // A FileHandle gains Node's vectored forms and `[Symbol.asyncDispose]` where it is made.
  const open = named(async function (path: unknown, flags: unknown, mode: unknown) {
    return withVectoredHandle(await asynchronous.promises.open(path, flags, mode));
  }, "open");
  return {
    fs: { Dir: directories.Dir, opendir: directories.opendir, opendirSync: directories.opendirSync, ...vectored, cpSync, cp: copies.cp, glob: globs.glob, globSync: globs.globSync, watchFile: polling.watchFile, unwatchFile: polling.unwatchFile,
      exists: miscellaneous.exists, openAsBlob: miscellaneous.openAsBlob, mkdtempDisposableSync: miscellaneous.mkdtempDisposableSync, _toUnixTimestamp: miscellaneous._toUnixTimestamp, lchmod: miscellaneous.lchmod, lchmodSync: miscellaneous.lchmodSync,
      FileReadStream: dependencies.ReadStream, FileWriteStream: dependencies.WriteStream },
    promises: { opendir: directories.promises.opendir, open, cp: copies.promises.cp, glob: globs.promises.glob, watch: polling.promises.watch, ...miscellaneous.promises },
  };
}
