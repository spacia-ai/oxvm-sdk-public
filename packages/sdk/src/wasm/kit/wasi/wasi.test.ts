import { describe, expect, it, vi } from "vitest";
import { WASI } from "./errno.js";
import { GuestMemory } from "./memory.js";
import { encodeDirent } from "./directories.js";
import { timesOf } from "./fd.js";
import { openFlags } from "./paths.js";
import { encodeLaunch, preview1, type Preopen } from "./preview1.js";
import { RIGHT } from "./rights.js";
import { FakeFiles } from "./files.test-support.js";
import { descriptor, FakeLinuxError, streams } from "./streams.test-support.js";
import { WasiError } from "./context.js";

const ROOT = 3, PATHS = 1024, OUT = 2048, BUFFER = 4096;
const ALL = (1n << 29n) - 1n;

function setup(preopens?: readonly Preopen[], files = new FakeFiles({ "/workspace/a.txt": "hello" }, ["/workspace", "/srv", "/srv/data"]), pages = 1) {
  const memory = new GuestMemory(new WebAssembly.Memory({ initial: pages }));
  const fake = streams({ files });
  const { imports, table } = preview1(fake.host, () => memory, { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2) }, encodeLaunch(["t"], {}), { stdin: false, stdout: false, stderr: false }, preopens);
  const call = (name: string, ...args: readonly (number | bigint)[]): number => {
    const fn = imports[name];
    if (fn === undefined) throw new Error(`no import ${name}`);
    const result: unknown = Reflect.apply(fn, undefined, args);
    if (typeof result !== "number") throw new Error(`${name} returned ${String(result)}`);
    return result;
  };
  const path = (text: string, at = PATHS): [number, number] => { const bytes = new TextEncoder().encode(text); memory.write(at, bytes); return [at, bytes.byteLength]; };
  const open = (dir: number, text: string, oflags = 0, base = ALL, inheriting = ALL): number => {
    const errno = call("path_open", dir, 0, ...path(text), oflags, base, inheriting, 0, OUT);
    if (errno !== 0) throw new Error(`path_open ${text} failed with WASI errno ${String(errno)}`);
    return memory.u32(OUT);
  };
  return { memory, files, call, path, open, table };
}

describe("descriptor lifetime (OBL-FD-LIFETIME)", () => {
  it("renumbering onto an open slot closes its Linux descriptor once; the old number is then BADF", () => {
    const { call, open, files } = setup();
    const a = open(ROOT, "workspace/a.txt"), b = open(ROOT, "workspace/a.txt");
    const [hostB] = [...files.open.keys()].slice(-1);
    expect(call("fd_renumber", a, b)).toBe(0);
    expect(files.calls.filter(entry => entry.op === "close").map(entry => entry.args[0])).toEqual([hostB]);
    expect(call("fd_close", a)).toBe(WASI.badf);
    expect(call("fd_close", b)).toBe(0);
    expect(call("fd_close", b)).toBe(WASI.badf);
  });

  it("answers a guessed number (a Linux descriptor's own number) with BADF", () => {
    const { call, files } = setup();
    const [rootHost] = [...files.open.keys()];
    expect(call("fd_fdstat_get", rootHost ?? 10, OUT)).toBe(WASI.badf);
    expect(call("fd_close", 200)).toBe(WASI.badf);
  });
});

describe("rights (OBL-FD-RIGHTS)", () => {
  it("only ever shrink, and a missing right is NOTCAPABLE before any host call", () => {
    const { call, open, files, memory } = setup();
    const fd = open(ROOT, "workspace/a.txt", 0, RIGHT.fdRead | RIGHT.fdSeek | RIGHT.fdTell | RIGHT.fdFilestatGet, 0n);
    expect(call("fd_fdstat_set_rights", fd, RIGHT.fdRead | RIGHT.fdWrite, 0n)).toBe(WASI.notcapable);
    expect(call("fd_fdstat_set_rights", fd, RIGHT.fdRead, 0n)).toBe(0);
    const before = files.calls.length;
    memory.setU32(OUT, BUFFER); memory.setU32(OUT + 4, 4);
    expect(call("fd_write", fd, OUT, 1, OUT + 64)).toBe(WASI.notcapable);
    expect(call("fd_seek", fd, 0n, 0, OUT + 64)).toBe(WASI.notcapable);
    expect(files.calls.length).toBe(before);
  });

  it("refuses a child that asks for more than its directory may hand down", () => {
    const { call, path } = setup([{ guest: "/srv", host: "/srv", readOnly: true }]);
    expect(call("path_open", ROOT, 0, ...path("data"), 2, RIGHT.fdReaddir, RIGHT.fdWrite, 0, OUT)).toBe(WASI.notcapable);
  });
});

describe("read-only and confined preopens (OBL-PATH-RO, OBL-PATH-DENIED)", () => {
  it("refuses every mutation through a read-only preopen with ROFS before the host sees it", () => {
    const { call, path, files } = setup([{ guest: "/srv", host: "/srv", readOnly: true }]);
    const before = files.calls.length;
    expect(call("path_create_directory", ROOT, ...path("new"))).toBe(WASI.rofs);
    expect(call("path_unlink_file", ROOT, ...path("data"))).toBe(WASI.rofs);
    expect(call("path_open", ROOT, 0, ...path("f"), 1, RIGHT.fdWrite, 0n, 0, OUT)).toBe(WASI.rofs);
    expect(call("path_rename", ROOT, ...path("a"), ROOT, ...path("b", PATHS + 64))).toBe(WASI.rofs);
    expect(files.calls.length).toBe(before);
  });

  it("resolves beneath a restricted preopen with RESOLVE_BENEATH on a held parent", () => {
    const { call, path, files } = setup([{ guest: "/srv", host: "/srv", readOnly: false }]);
    expect(call("path_create_directory", ROOT, ...path("data/inner"))).toBe(0);
    const parentOpen = files.calls.find(entry => entry.op === "openat" && entry.args[1] === "data");
    expect(parentOpen?.args[4]).toBe(8 | 2);
    expect(files.calls.find(entry => entry.op === "mkdirAt")?.args[1]).toBe("inner");
    // The held parent was closed again.
    expect(files.calls.some(entry => entry.op === "close")).toBe(true);
    expect(files.tree.has("/srv/data/inner")).toBe(true);
  });

  it("refuses . and .. as the leaf beneath a restricted preopen", () => {
    const { call, path } = setup([{ guest: "/srv", host: "/srv", readOnly: false }]);
    expect(call("path_remove_directory", ROOT, ...path("data/.."))).toBe(WASI.inval);
    expect(call("path_create_directory", ROOT, ...path("."))).toBe(WASI.exist);
  });

  it("passes the whole path to the engine beneath the root preopen, unconfined", () => {
    const { call, path, files } = setup();
    expect(call("path_create_directory", ROOT, ...path("workspace/new"))).toBe(0);
    expect(files.calls.find(entry => entry.op === "mkdirAt")?.args.slice(1)).toEqual(["workspace/new", 0o777]);
  });
});

describe("directories (OBL-DIRECTORIES)", () => {
  it("resumes from a cookie and cuts a record that does not fit, as WASI requires", () => {
    const { call, open, memory, files } = setup(undefined, new FakeFiles({ "/workspace/b": "", "/workspace/zażółć": "" }, ["/workspace"]));
    const dir = open(ROOT, "workspace", 2, RIGHT.fdReaddir | RIGHT.fdSeek, 0n);
    expect(call("fd_readdir", dir, BUFFER, 1024, 0n, OUT)).toBe(0);
    const used = memory.u32(OUT), names: string[] = [];
    for (let at = 0; at < used; ) {
      const length = memory.u32(BUFFER + at + 16);
      names.push(new TextDecoder().decode(memory.read(BUFFER + at + 24, length)));
      at += 24 + length;
    }
    expect(names).toEqual([".", "..", "b", "zażółć"]);
    // From cookie 3 (after "b") with room for 30 bytes: the 36-byte record for "zażółć" is cut; used == capacity.
    expect(call("fd_readdir", dir, BUFFER, 30, 3n, OUT)).toBe(0);
    expect(memory.u32(OUT)).toBe(30);
    expect(files.calls.filter(entry => entry.op === "seek").map(entry => entry.args[1])).toEqual([0n, 3n]);
    expect(encodeDirent({ name: Uint8Array.of(0xff), inode: 2n ** 63n, type: 10, next: 7n }).subarray(0, 21)).toEqual(Uint8Array.of(7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 1, 0, 0, 0, 7));
  });
});

describe("positional IO and times (OBL-FD-POSITIONAL, OBL-FILE-TIMES)", () => {
  const largeWrite = 256 * 1024;

  it("uses bounded large requests for opened regular files and leaves their offset alone", () => {
    const { call, open, memory, files } = setup(undefined, undefined, 5);
    const fd = open(ROOT, "workspace/a.txt", 0, RIGHT.fdWrite | RIGHT.fdSeek | RIGHT.fdTell, 0n);
    const payload = new Uint8Array(largeWrite + 17).fill(37);
    memory.write(BUFFER, payload);
    memory.setU32(OUT, BUFFER); memory.setU32(OUT + 4, payload.byteLength);
    expect(call("fd_pwrite", fd, OUT, 1, 5n, OUT + 64)).toBe(WASI.success);
    expect(memory.u32(OUT + 64)).toBe(payload.byteLength);
    expect(files.calls.filter(entry => entry.op === "pwrite").map(entry => entry.args.slice(1))).toEqual([
      [largeWrite, 5n], [17, BigInt(largeWrite + 5)],
    ]);
    expect(files.tree.get("/workspace/a.txt")?.data.subarray(5)).toEqual(payload);
    expect(call("fd_tell", fd, OUT + 72)).toBe(WASI.success);
    expect(memory.u64(OUT + 72)).toBe(0n);
  });

  it("keeps small requests for a nonregular descriptor", () => {
    const files = new FakeFiles({}, ["/workspace"]);
    files.tree.set("/workspace/device", { mode: 0o020666, data: new Uint8Array(), atime: 0n, mtime: 0n });
    const { call, open, memory } = setup(undefined, files, 2);
    const fd = open(ROOT, "workspace/device", 0, RIGHT.fdWrite | RIGHT.fdSeek, 0n);
    const chunk = 64 * 1024;
    memory.setU32(OUT, BUFFER); memory.setU32(OUT + 4, chunk + 1);
    expect(call("fd_pwrite", fd, OUT, 1, 0n, OUT + 64)).toBe(WASI.success);
    expect(files.calls.filter(entry => entry.op === "pwrite").map(entry => entry.args.slice(1))).toEqual([
      [chunk, 0n], [1, BigInt(chunk)],
    ]);
  });

  it("stops on a short write and returns committed progress after a later error", () => {
    const { call, open, memory, files } = setup(undefined, undefined, 5);
    const fd = open(ROOT, "workspace/a.txt", 0, RIGHT.fdWrite | RIGHT.fdSeek, 0n);
    memory.setU32(OUT, BUFFER); memory.setU32(OUT + 4, largeWrite + 17);
    const pwrite = files.at.pwrite.bind(files.at);
    const requests = vi.spyOn(files.at, "pwrite");
    requests.mockImplementationOnce((host, bytes, offset) => pwrite(host, bytes.subarray(0, 13), offset));
    expect(call("fd_pwrite", fd, OUT, 1, 0n, OUT + 64)).toBe(WASI.success);
    expect(memory.u32(OUT + 64)).toBe(13);
    expect(requests).toHaveBeenCalledTimes(1);
    requests.mockImplementationOnce(pwrite).mockImplementationOnce(() => { throw new FakeLinuxError(28); });
    expect(call("fd_pwrite", fd, OUT, 1, 0n, OUT + 64)).toBe(WASI.success);
    expect(memory.u32(OUT + 64)).toBe(largeWrite);
    requests.mockImplementationOnce(() => { throw new FakeLinuxError(28); });
    expect(call("fd_pwrite", fd, OUT, 1, 0n, OUT + 64)).toBe(WASI.nospc);
    expect(memory.u32(OUT + 64)).toBe(largeWrite);
  });

  it("uses pread/pwrite and never moves the shared offset", () => {
    const { call, open, memory, files } = setup();
    const fd = open(ROOT, "workspace/a.txt", 0, RIGHT.fdRead | RIGHT.fdWrite | RIGHT.fdSeek | RIGHT.fdTell, 0n);
    memory.setU32(OUT, BUFFER); memory.setU32(OUT + 4, 3);
    expect(call("fd_pread", fd, OUT, 1, 1n, OUT + 64)).toBe(0);
    expect(new TextDecoder().decode(memory.read(BUFFER, memory.u32(OUT + 64)))).toBe("ell");
    expect(call("fd_tell", fd, OUT + 72)).toBe(0);
    expect(memory.u64(OUT + 72)).toBe(0n);
    expect(files.calls.some(entry => entry.op === "pread" && entry.args[2] === 1n)).toBe(true);
  });

  it("keeps nanosecond times exact and refuses contradictory flags", () => {
    expect(timesOf(2n ** 62n + 1n, 5n, 1 | 4)).toEqual([2n ** 62n + 1n, 5n]);
    expect(timesOf(0n, 0n, 2 | 8)).toEqual(["now", "now"]);
    expect(timesOf(0n, 0n, 0)).toEqual(["omit", "omit"]);
    expect(() => timesOf(0n, 0n, 1 | 2)).toThrow(WasiError);
    expect(() => timesOf(0n, 0n, 0x10)).toThrow(WasiError);
  });
});

describe("open flags", () => {
  it("derives the access mode from rights and always sets O_CLOEXEC", () => {
    expect(openFlags(0, RIGHT.fdRead, 0, true)).toBe(0o2000000);
    expect(openFlags(1 | 8, RIGHT.fdWrite, 1, false)).toBe(0o1 | 0o2000000 | 0o2000 | 0o400000 | 0o100 | 0o1000);
    expect(openFlags(0, RIGHT.fdRead | RIGHT.fdWrite, 0, true)).toBe(0o2 | 0o2000000);
    expect(() => openFlags(2, RIGHT.fdWrite, 0, true)).toThrow(WasiError);
    expect(() => openFlags(0x10, 0n, 0, true)).toThrow(WasiError);
  });
});
