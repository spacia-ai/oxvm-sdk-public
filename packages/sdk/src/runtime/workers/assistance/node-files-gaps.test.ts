import { expect, it } from "vitest";
import { createMemoryFs } from "./node-files-gaps.test-support.ts";

it("returns the members Node 24.18.1 has and the runtime lacked, for one spread into fs and one into fs.promises", () => {
  const { gaps } = createMemoryFs();
  expect(Object.keys(gaps.fs).sort()).toEqual(["Dir", "FileReadStream", "FileWriteStream", "_toUnixTimestamp", "cp", "cpSync", "exists", "glob", "globSync", "mkdtempDisposableSync", "openAsBlob", "opendir",
    "opendirSync", "readv", "readvSync", "unwatchFile", "watchFile", "writev", "writevSync"]);
  expect(Object.keys(gaps.promises).sort()).toEqual(["cp", "glob", "lchmod", "mkdtempDisposable", "open", "opendir", "watch"]);
  // Names and lengths recorded from Node (`fs.<name>.name`, `.length`); `_toUnixTimestamp` and `promises.watch` carry their internal names.
  const shape = (value: unknown): unknown => typeof value === "function" ? [value.name, value.length] : typeof value;
  expect(Object.fromEntries(Object.entries(gaps.fs).map(([name, value]) => [name, shape(value)]))).toEqual({
    Dir: ["Dir", 3], opendir: ["opendir", 3], opendirSync: ["opendirSync", 2], readv: ["readv", 4], readvSync: ["readvSync", 3], writev: ["writev", 4], writevSync: ["writevSync", 3],
    cpSync: ["cpSync", 3], cp: ["cp", 4], glob: ["glob", 3], globSync: ["globSync", 2], watchFile: ["watchFile", 3], unwatchFile: ["unwatchFile", 2], exists: ["exists", 2], openAsBlob: ["openAsBlob", 1],
    mkdtempDisposableSync: ["mkdtempDisposableSync", 2], _toUnixTimestamp: ["toUnixTimestamp", 1], FileReadStream: ["ReadStream", 2], FileWriteStream: ["WriteStream", 2],
  });
  expect(Object.fromEntries(Object.entries(gaps.promises).map(([name, value]) => [name, shape(value)]))).toEqual({
    opendir: ["opendir", 3], open: ["open", 3], cp: ["cp", 3], glob: ["glob", 2], watch: ["_watch", 1], mkdtempDisposable: ["mkdtempDisposable", 2], lchmod: ["lchmod", 2],
  });
});
