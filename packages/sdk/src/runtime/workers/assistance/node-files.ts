import type { Buffer } from "buffer";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { Dirent, fileAccessConstants, createFileOperations, type FileOperation } from "./node-file-operations.js";
import { mkdtemp } from "./node-file-mkdtemp.js";
import type { Inspect } from "./node-arg-type.js";
import { unavailableNodeApi } from "./node-capability.js";
import type { BigIntStats, Stats } from "./node-stats.js";

export { createAsyncFiles } from "./node-files-async.js";

/** `inspect` words argument errors as Node's util.inspect does; it is the caller's, so that a worker without Node's
 * util (esbuild's Go host) does not bundle it, and there mkdtemp is a typed refusal. */
export function createSyncFiles(call: (operation: AssistanceOperation) => AssistanceResult, cwd: () => string, copyOpenMode?: 10, inspect?: Inspect) {
  const operations = createFileOperations(cwd, false, copyOpenMode);
  function run<Result>(program: FileOperation<Result>): Result {
    let step = program.next();
    while (step.done !== true) {
      let result: AssistanceResult;
      try { result = call(step.value); }
      catch (error) { step = program.throw(error); continue; }
      step = program.next(result);
    }
    return step.value;
  }
  // Without options these answer Node's default forms; the options select the bigint and byte forms.
  type Status = (target: unknown, options?: unknown) => FileOperation<Stats | BigIntStats | undefined>;
  function status(operation: Status) {
    function sync(target: unknown): Stats | undefined;
    function sync(target: unknown, options: unknown): Stats | BigIntStats | undefined;
    function sync(...args: [target: unknown, options?: unknown]): Stats | BigIntStats | undefined { return run(operation(...args)); }
    return sync;
  }
  function located(operation: (target: unknown, options?: unknown) => FileOperation<string | Buffer>) {
    function sync(target: unknown): string;
    function sync(target: unknown, options: unknown): string | Buffer;
    function sync(...args: [target: unknown, options?: unknown]): string | Buffer { return run(operation(...args)); }
    return sync;
  }
  return {
    Dirent, constants: fileAccessConstants,
    accessSync: (...args: Parameters<typeof operations.access>) => run(operations.access(...args)),
    openSync: (...args: Parameters<typeof operations.open>) => run(operations.open(...args)),
    closeSync: (...args: Parameters<typeof operations.close>) => run(operations.close(...args)),
    readSync: (...args: Parameters<typeof operations.read>) => run(operations.read(...args)),
    writeSync: (...args: Parameters<typeof operations.write>) => run(operations.write(...args)),
    readFileSync: (...args: Parameters<typeof operations.readFile>) => run(operations.sync.readFile(...args)),
    statSync: status(operations.stat),
    // Node's existsSync answers false for every failure, including invalid arguments.
    existsSync: (path: unknown): boolean => { try { run(operations.access(path)); return true; } catch { return false; } },
    lstatSync: status(operations.lstat),
    fstatSync: status(operations.fstat),
    writeFileSync: (...args: Parameters<typeof operations.writeFile>) => run(operations.sync.writeFile(...args)),
    appendFileSync: (...args: Parameters<typeof operations.appendFile>) => run(operations.sync.appendFile(...args)),
    fsyncSync: (...args: Parameters<typeof operations.fsync>) => run(operations.fsync(...args)),
    fdatasyncSync: (...args: Parameters<typeof operations.fdatasync>) => run(operations.fdatasync(...args)),
    unlinkSync: (...args: Parameters<typeof operations.unlink>) => run(operations.unlink(...args)),
    copyFileSync: (...args: Parameters<typeof operations.copyFile>) => run(operations.copyFile(...args)),
    rmSync: (...args: Parameters<typeof operations.rm>) => run(operations.rm(...args)),
    rmdirSync: (...args: Parameters<typeof operations.rmdir>) => run(operations.rmdir(...args)),
    mkdirSync: (...args: Parameters<typeof operations.mkdir>) => run(operations.mkdir(...args)).path,
    mkdtempSync: (prefix: unknown, options?: unknown) => inspect === undefined ? unavailableNodeApi("fs.mkdtempSync") : run(mkdtemp(prefix, options, inspect)),
    chmodSync: (...args: Parameters<typeof operations.chmod>) => run(operations.chmod(...args)),
    fchmodSync: (...args: Parameters<typeof operations.fchmod>) => run(operations.fchmod(...args)),
    utimesSync: (...args: Parameters<typeof operations.utimes>) => run(operations.utimes(...args)),
    lutimesSync: (...args: Parameters<typeof operations.lutimes>) => run(operations.lutimes(...args)),
    futimesSync: (...args: Parameters<typeof operations.futimes>) => run(operations.futimes(...args)),
    truncateSync: (...args: Parameters<typeof operations.truncate>) => run(operations.truncate(...args)),
    ftruncateSync: (...args: Parameters<typeof operations.ftruncate>) => run(operations.ftruncate(...args)),
    renameSync: (...args: Parameters<typeof operations.rename>) => run(operations.rename(...args)),
    linkSync: (...args: Parameters<typeof operations.link>) => run(operations.link(...args)),
    symlinkSync: (...args: Parameters<typeof operations.symlink>) => run(operations.symlink(...args)),
    readlinkSync: located(operations.readlink),
    realpathSync: located(operations.realpath),
    readdirSync: (...args: Parameters<typeof operations.readdir>) => run(operations.readdir(...args)),
  };
}
