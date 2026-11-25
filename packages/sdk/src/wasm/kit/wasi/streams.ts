import { moduleFileOperations } from "../../../runtime/js-process/at-operations.js";
import { WASI } from "./errno.js";
import { LIMITS } from "./limits.js";
import type { IoVector } from "./memory.js";
import type { WasiContext } from "./context.js";
import { RIGHT } from "./rights.js";

type ImportFunction = (...args: never[]) => number;
type Move = (vector: IoVector, offset: number, length: number, done: number) => number;
type ReadVectors = (lengths: readonly number[]) => Uint8Array | undefined;

/**
 * Moves bytes through checked vectors in bounded pieces and stops at the first short transfer. A failure after
 * some bytes moved reports the partial count (as readv/writev do); the next call sees the error.
 */
function transfer(context: WasiContext, list: number, count: number, out: number, move: Move, readVectors?: ReadVectors, chunk = LIMITS.ioChunk): number {
  const memory = context.memory();
  let vectors: readonly IoVector[];
  try { vectors = memory.ioVectors(list, count); memory.check(out, 4); } catch (error) { return context.errnoOf(error); }
  let total = 0;
  try {
    if (readVectors !== undefined && vectors.length > 1) {
      const lengths = vectors.map(vector => vector.length).filter(length => length !== 0);
      if (lengths.length > 1 && lengths.every(length => length <= LIMITS.ioChunk)) {
        const bytes = readVectors(lengths);
        if (bytes !== undefined) {
          for (const vector of vectors) {
            const length = Math.min(vector.length, bytes.byteLength - total);
            if (length === 0) continue;
            memory.write(vector.pointer, bytes.subarray(total, total + length));
            total += length;
          }
          memory.setU32(out, total);
          return WASI.success;
        }
      }
    }
    outer: for (const vector of vectors) {
      for (let offset = 0; offset < vector.length; ) {
        const length = Math.min(chunk, vector.length - offset), moved = move(vector, offset, length, total);
        if (!Number.isInteger(moved) || moved < 0 || moved > length) throw new RangeError(`host moved ${String(moved)} of ${String(length)} bytes`);
        total += moved; offset += moved;
        if (moved < length) break outer;
      }
    }
  } catch (error) { const errno = context.errnoOf(error); if (total === 0) return errno; }
  context.memory().setU32(out, total);
  return WASI.success;
}

/** fd_read, fd_write, fd_pread and fd_pwrite over the descriptor table. */
export function streams(context: WasiContext): Readonly<Record<string, ImportFunction>> {
  const { host } = context;
  const compound = host.at === undefined ? undefined : moduleFileOperations(host.at);
  const target = (fd: number, right: bigint) => context.table.require(fd, right).host;
  const read = (fd: number, list: number, count: number, out: number): number => {
    let hostFd;
    try { hostFd = target(fd, RIGHT.fdRead); } catch (error) { return context.errnoOf(error); }
    return transfer(context, list, count, out, (vector, offset, length) => {
      const bytes = host.fs.read(hostFd, length);
      if (bytes.byteLength > length) throw new RangeError(`host returned ${String(bytes.byteLength)} bytes for a ${String(length)}-byte read`);
      context.memory().write(vector.pointer + offset, bytes);
      return bytes.byteLength;
    }, compound === undefined ? undefined : lengths => compound.readVectors(hostFd, lengths));
  };
  const write = (fd: number, list: number, count: number, out: number): number => {
    let hostFd;
    try { hostFd = target(fd, RIGHT.fdWrite); } catch (error) { return context.errnoOf(error); }
    return transfer(context, list, count, out, (vector, offset, length) => host.fs.write(hostFd, context.memory().read(vector.pointer + offset, length)));
  };
  const pread = (fd: number, list: number, count: number, offset: bigint, out: number): number => {
    let hostFd;
    try { hostFd = target(fd, RIGHT.fdRead | RIGHT.fdSeek); context.requireAt(); } catch (error) { return context.errnoOf(error); }
    if (offset > 0x7fff_ffff_ffff_ffffn) return WASI.inval;
    return transfer(context, list, count, out, (vector, at, length, done) => {
      const bytes = context.at.pread(hostFd, length, offset + BigInt(done));
      if (bytes.byteLength > length) throw new RangeError(`host returned ${String(bytes.byteLength)} bytes for a ${String(length)}-byte pread`);
      context.memory().write(vector.pointer + at, bytes);
      return bytes.byteLength;
    }, compound === undefined ? undefined : lengths => compound.readVectors(hostFd, lengths, offset));
  };
  const pwrite = (fd: number, list: number, count: number, offset: bigint, out: number): number => {
    let entry;
    try { entry = context.table.require(fd, RIGHT.fdWrite | RIGHT.fdSeek); context.requireAt(); } catch (error) { return context.errnoOf(error); }
    if (offset > 0x7fff_ffff_ffff_ffffn) return WASI.inval;
    const chunk = entry.kind === "regularFile" ? LIMITS.regularFileWriteChunk : LIMITS.ioChunk;
    return transfer(context, list, count, out, (vector, at, length, done) => {
      return context.at.pwrite(entry.host, context.memory().read(vector.pointer + at, length), offset + BigInt(done));
    }, undefined, chunk);
  };
  return { fd_read: read, fd_write: write, fd_pread: pread, fd_pwrite: pwrite };
}
