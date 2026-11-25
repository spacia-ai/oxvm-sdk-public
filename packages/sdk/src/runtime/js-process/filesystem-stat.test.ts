import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import type { LinuxOperation, LinuxResult } from "./codec.js";
import { fileSystemStats, statfsOperation } from "./filesystem-stat.js";

/** A Linux x86-64 `struct statfs`: eleven 64-bit words, then spare bytes, 120 in all. */
function record(words: readonly bigint[]): Uint8Array {
  const bytes = new Uint8Array(120), view = new DataView(bytes.buffer);
  words.forEach((word, index) => { view.setBigUint64(index * 8, word, true); });
  return bytes;
}
const TMPFS = [0x0102_1994n, 4096n, 1000n, 600n, 500n, 2n ** 40n, 2n ** 40n - 7n, 0n, 255n, 4096n, 0x20n];

it("asks Linux for statfs by its syscall number and reads the record it writes", () => {
  const request = statfsOperation("/workspace/.next/cache");
  expect(request.number).toBe(137);
  expect(new TextDecoder().decode(request.payload.subarray(4))).toBe("/workspace/.next/cache");
  expect(request.decode({ value: 0n, bytes: record(TMPFS) })).toEqual({ type: 0x0102_1994n, blockSize: 4096n, blocks: 1000n, freeBlocks: 600n, availableBlocks: 500n, files: 2n ** 40n, freeFiles: 2n ** 40n - 7n });
});

it("refuses a statfs answer that is not the 120-byte record", () => {
  const request = statfsOperation("/");
  for (const bad of [{ value: 0n, bytes: new Uint8Array(119) }, { value: 0n, bytes: new Uint8Array(121) }, { value: 1n, bytes: record(TMPFS) }, { value: 0n, bytes: new Uint8Array() }]) {
    expect(() => request.decode(bad)).toThrow(VMError);
  }
});

it("serves both call styles from the same operation", async () => {
  const seen: number[] = [], answer: LinuxResult = { value: 0n, bytes: record(TMPFS) };
  const stats = fileSystemStats({
    sync<T>(operation: LinuxOperation<T>): T { seen.push(operation.number); return operation.decode(answer); },
    call<T>(operation: LinuxOperation<T>): Promise<T> { seen.push(operation.number); return Promise.resolve(operation.decode(answer)); },
  });
  expect(stats.statfs("/").blocks).toBe(1000n);
  expect((await stats.statfsAsync("/")).availableBlocks).toBe(500n);
  expect(seen).toEqual([137, 137]);
});
