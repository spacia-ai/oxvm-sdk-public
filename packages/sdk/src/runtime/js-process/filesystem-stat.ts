import type { LinuxPath } from "../../js-process-types.js";
import { type LinuxOperation, type LinuxResult, operation, protocol, Writer } from "./codec.js";
import type { LinuxClient } from "./transport.js";

const DataView = globalThis.DataView;

/** What Linux reports about the filesystem a path is on: the leading words of `struct statfs`. */
export interface LinuxFileSystemStat {
  /** `f_type`, the filesystem's magic number. */
  readonly type: bigint;
  /** `f_bsize`, the optimal transfer block size in bytes. */
  readonly blockSize: bigint;
  /** `f_blocks`, `f_bfree` and `f_bavail`: total, free, and free-to-unprivileged blocks. */
  readonly blocks: bigint; readonly freeBlocks: bigint; readonly availableBlocks: bigint;
  /** `f_files` and `f_ffree`: total and free file nodes. */
  readonly files: bigint; readonly freeFiles: bigint;
}

/** Linux x86-64 `struct statfs`: 64-bit words in the order below, 120 bytes in all. */
const STATFS_BYTES = 120;
function decodeStatfs(result: LinuxResult): LinuxFileSystemStat {
  if (result.value !== 0n || result.bytes.byteLength !== STATFS_BYTES) protocol("Invalid Linux statfs result");
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength), word = (index: number): bigint => view.getBigUint64(index * 8, true);
  return { type: word(0), blockSize: word(1), blocks: word(2), freeBlocks: word(3), availableBlocks: word(4), files: word(5), freeFiles: word(6) };
}

/** OXJR 137 statfs: Rust resolves the path and answers with the record the native call writes (Userspace API 153). */
export function statfsOperation(path: LinuxPath): LinuxOperation<LinuxFileSystemStat> { return operation(137, new Writer().path(path), decodeStatfs); }

/** Filesystem statistics for a fast-path process, in both call styles. */
export interface FileSystemStats {
  statfs(path: LinuxPath): LinuxFileSystemStat;
  statfsAsync(path: LinuxPath, signal?: AbortSignal): Promise<LinuxFileSystemStat>;
}
export function fileSystemStats(client: Pick<LinuxClient, "sync" | "call">): FileSystemStats {
  return { statfs: path => client.sync(statfsOperation(path)), statfsAsync: (path, signal) => client.call(statfsOperation(path), signal) };
}
