import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { VMError } from "../../errors.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createSyncFiles } from "./node-files.js";
import { BigIntStats } from "./node-stats.js";

const STAT = { dev: 2049n, ino: 9007199254740993n, mode: 0o040755, nlink: 3n, uid: 1000, gid: 1000, size: 4096n, blocks: 8n, blksize: 4096,
  atimeNs: 1_700_000_000_123_456_789n, mtimeNs: 1_700_000_001_000_000_001n, ctimeNs: -1n, details: { rdev: 5n, birthtimeNs: 1_600_000_000_000_000_000n } } as const;
function files(reply: (operation: AssistanceOperation) => AssistanceResult) {
  const operations: AssistanceOperation[] = [];
  return { operations, fs: createSyncFiles(operation => { operations.push(operation); return reply(operation); }, () => "/workspace") };
}
const stat = (mode: number): AssistanceResult => ({ kind: "stat", stat: { ...STAT, mode } });

describe("bigint stats", () => {
  it("keeps every 64-bit field exact and carries nanosecond times, as Node's BigIntStats does", () => {
    const { fs } = files(() => stat(0o040755));
    const stats: unknown = Reflect.apply(fs.statSync, fs, ["dir", { bigint: true }]);
    if (!(stats instanceof BigIntStats)) throw new TypeError("not BigIntStats");
    expect(Object.fromEntries(Object.entries(stats))).toEqual({ dev: 2049n, mode: 0o040755n, nlink: 3n, uid: 1000n, gid: 1000n, rdev: 5n, blksize: 4096n, ino: 9007199254740993n, size: 4096n, blocks: 8n,
      atimeMs: 1_700_000_000_123n, mtimeMs: 1_700_000_001_000n, ctimeMs: 0n, birthtimeMs: 1_600_000_000_000n,
      atimeNs: 1_700_000_000_123_456_789n, mtimeNs: 1_700_000_001_000_000_001n, ctimeNs: -1n, birthtimeNs: 1_600_000_000_000_000_000n });
    expect([stats.isDirectory(), stats.isFile(), stats.isSymbolicLink()]).toEqual([true, false, false]);
    expect(stats.atime).toEqual(new Date(1_700_000_000_123));
    expect(Object.keys(stats)).toContain("atime");
  });
  it("answers lstat and fstat alike and still honors throwIfNoEntry", () => {
    const { fs, operations } = files(operation => operation.kind === "stat" && operation.path === "gone" ? { kind: "error", code: "ENOENT", errno: 2, syscall: "stat", path: "gone", destination: null } : stat(0o100644));
    expect(Reflect.apply(fs.lstatSync, fs, ["file", { bigint: true }])).toBeInstanceOf(BigIntStats);
    expect(Reflect.apply(fs.fstatSync, fs, [7, { bigint: true }])).toBeInstanceOf(BigIntStats);
    expect(Reflect.apply(fs.statSync, fs, ["gone", { bigint: true, throwIfNoEntry: false }])).toBeUndefined();
    expect(Reflect.apply(fs.statSync, fs, ["file", { bigint: false }])).not.toBeInstanceOf(BigIntStats);
    expect(operations.map(operation => operation.kind)).toEqual(["lstat", "fstat", "stat", "stat"]);
    expect(() => Reflect.apply(fs.statSync, fs, ["file", { bigint: 1 }])).toThrow(/bigint/);
  });
});

describe("numeric open flags", () => {
  const C = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 0o100, EXCL: 0o200, NOCTTY: 0o400, TRUNC: 0o1000, APPEND: 0o2000, NONBLOCK: 0o4000, LARGEFILE: 0o100000, DIRECTORY: 0o200000, NOFOLLOW: 0o400000, CLOEXEC: 0o2000000 };
  it("exposes the Linux values Node exposes", () => {
    const { fs } = files(() => ({ kind: "unit" }));
    expect(fs.constants).toMatchObject({ O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024, O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_NONBLOCK: 2048, O_SYNC: 1052672, O_DSYNC: 4096, O_DIRECT: 16384, O_NOATIME: 262144, F_OK: 0 });
  });
  it("opens each combination the ten Node flag strings name with exactly that string's operation", () => {
    const table: [number, string][] = [[C.RDONLY, "r"], [C.RDWR, "r+"], [C.WRONLY | C.CREAT | C.TRUNC, "w"], [C.RDWR | C.CREAT | C.TRUNC, "w+"],
      [C.WRONLY | C.CREAT | C.TRUNC | C.EXCL, "wx"], [C.RDWR | C.CREAT | C.TRUNC | C.EXCL, "wx+"], [C.WRONLY | C.CREAT | C.APPEND, "a"], [C.RDWR | C.CREAT | C.APPEND, "a+"],
      [C.WRONLY | C.CREAT | C.APPEND | C.EXCL, "ax"], [C.RDWR | C.CREAT | C.APPEND | C.EXCL, "ax+"]];
    for (const [numeric, text] of table) {
      const byNumber = files(() => ({ kind: "opened", fd: 5 })), byText = files(() => ({ kind: "opened", fd: 5 }));
      expect(byNumber.fs.openSync("file", numeric | C.CLOEXEC | C.NOCTTY | C.LARGEFILE, 0o640)).toBe(5);
      byText.fs.openSync("file", text, 0o640);
      expect(byNumber.operations).toEqual(byText.operations);
    }
  });
  it("opens only a directory for O_DIRECTORY, examining the target first, and answers as open(2) does for anything else", () => {
    for (const extra of [0, C.NONBLOCK, C.NONBLOCK | C.CLOEXEC]) {
      const directory = files(operation => operation.kind === "open" ? { kind: "opened", fd: 9 } : stat(0o040755));
      expect(directory.fs.openSync("dir", C.RDONLY | C.DIRECTORY | extra)).toBe(9);
      expect(directory.operations).toEqual([{ kind: "stat", path: "dir" }, { kind: "open", path: "dir", flags: 0, mode: 0o666 }]);
    }
    const attempt = (reply: AssistanceResult): { failure: unknown; operations: AssistanceOperation[] } => {
      const target = files(() => reply); let failure: unknown;
      try { target.fs.openSync("file", C.RDONLY | C.DIRECTORY); } catch (error) { failure = error; }
      return { failure, operations: target.operations };
    };
    for (const mode of [0o100644, 0o010644]) {
      const other = attempt(stat(mode));
      expect(other.failure).toMatchObject({ code: "ENOTDIR", errno: -20, syscall: "open", path: "file" });
      expect(other.operations).toEqual([{ kind: "stat", path: "file" }]);
    }
    const gone = attempt({ kind: "error", code: "ENOENT", errno: 2, syscall: "stat", path: "file", destination: null });
    expect(gone.failure).toMatchObject({ code: "ENOENT", errno: -2, syscall: "open", path: "file" });
    expect(gone.operations).toEqual([{ kind: "stat", path: "file" }]);
  });
  it("refuses a combination no flag string names, before any guest I/O, as a remembered limitation", () => {
    for (const numeric of [C.WRONLY, C.WRONLY | C.CREAT, C.RDWR | C.CREAT, C.RDONLY | C.NOFOLLOW, C.RDONLY | C.NONBLOCK, C.WRONLY | C.DIRECTORY, C.RDONLY | C.TRUNC, 3, -1, 1.5, 2 ** 32]) {
      const { fs, operations } = files(() => ({ kind: "opened", fd: 5 }));
      let failure: unknown;
      try { fs.openSync("file", numeric); } catch (error) { failure = error; }
      expect(operations).toEqual([]);
      if (Number.isInteger(numeric) && numeric >= 0 && numeric < 2 ** 32) {
        expect(failure).toBeInstanceOf(VMError);
        expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin", subject: "node:fs open flags" } });
      } else expect(failure).toBeInstanceOf(RangeError);
    }
  });
});

describe("realpath and readlink encodings", () => {
  it("accepts Node's encoding option in both spellings", () => {
    const { fs } = files(() => ({ kind: "path", path: "/workspace/café" }));
    for (const call of [fs.realpathSync, fs.readlinkSync]) {
      expect(Reflect.apply(call, fs, ["x"])).toBe("/workspace/café");
      expect(Reflect.apply(call, fs, ["x", "utf8"])).toBe("/workspace/café");
      expect(Reflect.apply(call, fs, ["x", { encoding: "utf-8" }])).toBe("/workspace/café");
      expect(Reflect.apply(call, fs, ["x", { encoding: null }])).toBe("/workspace/café");
      expect(Reflect.apply(call, fs, ["x", "buffer"])).toEqual(Buffer.from("/workspace/café"));
      expect(Reflect.apply(call, fs, ["x", { encoding: "hex" }])).toBe(Buffer.from("/workspace/café").toString("hex"));
    }
  });
  it("refuses an unknown encoding and unknown options before guest I/O", () => {
    const { fs, operations } = files(() => ({ kind: "path", path: "/x" }));
    expect(() => Reflect.apply(fs.realpathSync, fs, ["x", "klingon"])).toThrow(/Unknown encoding/);
    expect(() => Reflect.apply(fs.realpathSync, fs, ["x", { cache: {} }])).toThrow(/Unsupported filesystem options/);
    expect(() => Reflect.apply(fs.readlinkSync, fs, ["x", 5])).toThrow(/Unsupported filesystem options/);
    expect(operations).toEqual([]);
  });
});
