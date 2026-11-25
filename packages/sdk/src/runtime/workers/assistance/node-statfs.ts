import { fileURLToPath } from "./node-url.js";
import { LinuxError } from "../../js-process/codec.js";
import type { FileSystemStats, LinuxFileSystemStat } from "../../js-process/filesystem-stat.js";
import { linuxErrnoCode } from "../../linux-errno.js";
import { systemErrorMessage } from "./node-system-errors.ts";

/** Node's `fs.StatFs`. Every field is a number, or a bigint when `bigint: true` was asked for. */
class StatFs<Word extends number | bigint> {
  constructor(readonly type: Word, readonly bsize: Word, readonly blocks: Word, readonly bfree: Word, readonly bavail: Word, readonly files: Word, readonly ffree: Word) {}
}
// The bundle renames classes; programs read this one's name.
Object.defineProperty(StatFs, "name", { value: "StatFs" });
function statFs(stat: LinuxFileSystemStat, big: boolean): StatFs<number> | StatFs<bigint> {
  const words = [stat.type, stat.blockSize, stat.blocks, stat.freeBlocks, stat.availableBlocks, stat.files, stat.freeFiles] as const;
  if (big) return new StatFs(...words);
  // Node converts the same way: a count above 2^53 loses its low bits.
  const [type, bsize, blocks, bfree, bavail, files, ffree] = words.map(Number);
  return new StatFs(type ?? 0, bsize ?? 0, blocks ?? 0, bfree ?? 0, bavail ?? 0, files ?? 0, ffree ?? 0);
}

function systemError(code: string, errno: number, path: string): Error {
  return Object.assign(new Error(systemErrorMessage(code, "statfs", path, null)), { errno: -errno, code, syscall: "statfs", path });
}
function pathOf(value: unknown): string {
  const decoded = value instanceof URL ? fileURLToPath(value) : value;
  // The same paths the other fs operations take.
  if (typeof decoded !== "string" || decoded.includes("\0")) throw new TypeError("Only UTF-8 string and file URL paths are supported");
  if (decoded === "") throw systemError("ENOENT", 2, decoded);
  return decoded;
}
function wantsBigint(options: unknown): boolean {
  if (options === undefined || options === null) return false;
  const bigint: unknown = typeof options === "object" ? Reflect.get(options, "bigint") : options;
  if (typeof options !== "object" || (bigint !== undefined && typeof bigint !== "boolean")) throw Object.assign(new TypeError('The "options.bigint" property must be of type boolean.'), { code: "ERR_INVALID_ARG_TYPE" });
  return bigint === true;
}
/** A Linux errno becomes Node's system error; anything else is not a filesystem answer and passes through. */
function failure(error: unknown, path: string): unknown {
  return error instanceof LinuxError ? systemError(linuxErrnoCode(error.errno), error.errno, path) : error;
}

/** How an asynchronous call joins the process: a hold on its event loop, its callback queue and its async context. */
export interface StatfsScheduling {
  readonly retain?: () => () => void;
  readonly dispatch?: (callback: () => void) => void;
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
}

/**
 * Node's `fs.statfsSync`, `fs.statfs` and `fs.promises.statfs`. Linux answers through the process's own channel
 * (OXJR 137); nothing about the filesystem is decided here.
 */
export function createNodeStatfs(stats: FileSystemStats, scheduling: StatfsScheduling = {}) {
  const retain = scheduling.retain ?? (() => () => undefined), dispatch = scheduling.dispatch ?? ((callback: () => void): void => { callback(); });
  const statfsSync = (path: unknown, options?: unknown): StatFs<number> | StatFs<bigint> => {
    const target = pathOf(path), big = wantsBigint(options);
    try { return statFs(stats.statfs(target), big); }
    catch (error) { throw failure(error, target); }
  };
  /** The process stays alive until Linux has answered. */
  const ask = async (target: string, big: boolean): Promise<StatFs<number> | StatFs<bigint>> => {
    const release = retain();
    try { return statFs(await stats.statfsAsync(target), big); }
    catch (error) { throw failure(error, target); }
    finally { release(); }
  };
  const promised = async (path: unknown, options?: unknown): Promise<StatFs<number> | StatFs<bigint>> => ask(pathOf(path), wantsBigint(options));
  const statfs = (path: unknown, optionsOrCallback?: unknown, callback?: unknown): void => {
    const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (typeof done !== "function") throw Object.assign(new TypeError('The "cb" argument must be of type function.'), { code: "ERR_INVALID_ARG_TYPE" });
    const target = pathOf(path), big = wantsBigint(typeof optionsOrCallback === "function" ? undefined : optionsOrCallback);
    const run = scheduling.context?.capture() ?? (<Result>(inner: () => Result): Result => inner());
    // The hold of the call would end before the callback ran; this one spans both.
    const release = retain();
    const finish = (args: unknown[]): void => { dispatch(() => { try { run(() => { Reflect.apply(done, undefined, args); }); } finally { release(); } }); };
    void ask(target, big).then(result => { finish([null, result]); }, (error: unknown) => { finish([error]); });
  };
  return { statfsSync, statfs, promises: { statfs: promised } };
}
