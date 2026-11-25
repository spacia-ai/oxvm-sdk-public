import { expect, it } from "vitest";
import { LinuxError } from "../../js-process/codec.js";
import type { FileSystemStats, LinuxFileSystemStat } from "../../js-process/filesystem-stat.js";
import { createNodeStatfs } from "./node-statfs.js";

const TMPFS: LinuxFileSystemStat = { type: 0x0102_1994n, blockSize: 4096n, blocks: 1000n, freeBlocks: 600n, availableBlocks: 500n, files: 2n ** 40n, freeFiles: 2n ** 40n - 7n };
function port(answer: LinuxFileSystemStat | LinuxError = TMPFS) {
  const paths: string[] = [];
  const read = (path: string | Uint8Array): LinuxFileSystemStat => { paths.push(typeof path === "string" ? path : new TextDecoder().decode(path)); if (answer instanceof LinuxError) throw answer; return answer; };
  const stats: FileSystemStats = { statfs: read, statfsAsync: path => { try { return Promise.resolve(read(path)); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("failed")); } } };
  return { fs: createNodeStatfs(stats), paths };
}
/** The own fields of a StatFs, as a plain object. */
const fields = (value: unknown): object => typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const NUMBERS = { type: 0x0102_1994, bsize: 4096, blocks: 1000, bfree: 600, bavail: 500, files: 2 ** 40, ffree: 2 ** 40 - 7 };

it("returns Node's StatFs from statfsSync, as numbers or as bigints", () => {
  const { fs, paths } = port();
  const plain = fs.statfsSync("/workspace/.next/cache");
  expect(fields(plain)).toEqual(NUMBERS);
  expect(plain.constructor.name).toBe("StatFs");
  expect(fields(fs.statfsSync(new URL("file:///tmp/a%20b"), { bigint: true }))).toEqual({ type: 0x0102_1994n, bsize: 4096n, blocks: 1000n, bfree: 600n, bavail: 500n, files: 2n ** 40n, ffree: 2n ** 40n - 7n });
  expect(fields(fs.statfsSync("relative/dir", { bigint: false }))).toEqual(NUMBERS);
  expect(paths).toEqual(["/workspace/.next/cache", "/tmp/a b", "relative/dir"]);
});

it("serves the promise and callback forms from the same call", async () => {
  const { fs } = port();
  // Next.js sizes its image cache from these two fields.
  const { bavail, bsize } = await fs.promises.statfs("/workspace/.next/cache");
  expect(Math.floor(Number(bavail) * Number(bsize) / 2)).toBe(1_024_000);
  expect((await fs.promises.statfs("/", { bigint: true })).blocks).toBe(1000n);
  const viaCallback = await new Promise<unknown>((resolve, reject) => { fs.statfs("/", (error: unknown, stats: unknown) => { if (error === null) resolve(stats); else reject(error instanceof Error ? error : new Error("failed")); }); });
  expect(fields(viaCallback)).toEqual(NUMBERS);
  const withOptions = await new Promise<unknown>(resolve => { fs.statfs("/", { bigint: true }, (_error: unknown, stats: unknown) => { resolve(stats); }); });
  expect(withOptions).toMatchObject({ bsize: 4096n });
});

it("reports a Linux failure as Node's system error", async () => {
  const { fs } = port(new LinuxError(2));
  const expected = { code: "ENOENT", errno: -2, syscall: "statfs", path: "/absent", message: "ENOENT: no such file or directory, statfs '/absent'" };
  let thrown: unknown;
  try { fs.statfsSync("/absent"); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject(expected);
  await expect(fs.promises.statfs("/absent")).rejects.toMatchObject(expected);
  const viaCallback = await new Promise<unknown>(resolve => { fs.statfs("/absent", (error: unknown) => { resolve(error); }); });
  expect(viaCallback).toMatchObject(expected);
  expect(() => port(new LinuxError(13)).fs.statfsSync("/root")).toThrow(/^EACCES: permission denied, statfs '\/root'$/u);
});

it("checks its arguments before asking Linux", async () => {
  const { fs, paths } = port();
  expect(() => fs.statfsSync(7)).toThrow(TypeError);
  expect(() => fs.statfsSync("/a\0b")).toThrow(TypeError);
  expect(() => fs.statfsSync("/", { bigint: "yes" })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(() => fs.statfs("/")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  await expect(fs.promises.statfs(7)).rejects.toBeInstanceOf(TypeError);
  // An empty path is ENOENT without a call, as for the other path operations.
  expect(() => fs.statfsSync("")).toThrow(expect.objectContaining({ code: "ENOENT", syscall: "statfs" }));
  expect(paths).toEqual([]);
});

it("keeps the process alive while an asynchronous call is out, and calls back through the process's queue", async () => {
  let held = 0, released = 0; const queued: (() => void)[] = [], order: string[] = [];
  const pending = Promise.withResolvers<LinuxFileSystemStat>();
  const stats: FileSystemStats = { statfs: () => TMPFS, statfsAsync: () => pending.promise };
  const fs = createNodeStatfs(stats, {
    retain: () => { held += 1; return () => { released += 1; }; },
    dispatch: callback => { queued.push(callback); },
    context: { capture: () => run => { order.push("context"); return run(); } },
  });
  const promised = fs.promises.statfs("/"), called = new Promise<unknown>(resolve => { fs.statfs("/", (_error: unknown, value: unknown) => { order.push("callback"); resolve(value); }); });
  // Without a hold the process would end as idle before Linux answers.
  expect([held, released]).toEqual([3, 0]);
  pending.resolve(TMPFS);
  expect((await promised).bsize).toBe(4096);
  await Promise.resolve();
  // The callback waits in the process's queue; it does not run from the transport's own turn.
  expect([order, queued.length]).toEqual([[], 1]);
  queued[0]?.();
  expect(await called).toMatchObject({ bsize: 4096 });
  expect([order, held, released]).toEqual([["context", "callback"], 3, 3]);
  const failing = createNodeStatfs({ statfs: () => TMPFS, statfsAsync: () => Promise.reject(new LinuxError(2)) }, { retain: () => { held += 1; return () => { released += 1; }; } });
  await expect(failing.promises.statfs("/gone")).rejects.toMatchObject({ code: "ENOENT" });
  expect([held, released]).toEqual([4, 4]);
});
