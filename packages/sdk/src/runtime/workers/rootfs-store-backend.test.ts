import { expect, it, vi } from "vitest";
import { SpaceReserve } from "./managed-disk-reserve.js";
import { MemoryDirectory, MemoryFile, MemoryQuota } from "./opfs-double.test-support.js";
import { names, openVerifiedReader, read, remove, sha256, verifiedBytes, write } from "./rootfs-store-backend.js";

it("stores a new large signed manifest compactly and keeps the prior raw cache readable", async () => {
  const root = new MemoryDirectory();
  const backend = { kind: "opfs", root } as const;
  const cache = root.directory("userspace-rootfs", true);
  const previous = Uint8Array.of(1, 2, 3);
  const old = `${await sha256(previous)}.json`;
  cache.directory("manifests", true).file(old, true).setBytes(previous);
  const bytes = new Uint8Array(1024 ** 2 + 1).fill(61);
  const digest = await sha256(bytes), current = `${digest}.json`;
  await write(backend, "manifests", current, bytes);

  const packed = root.find(`userspace-rootfs/manifests-gzip-v1/${current}`);
  if (!(packed instanceof MemoryFile)) throw new Error("missing compressed manifest");
  expect(packed.size).toBeLessThan(bytes.byteLength / 10);
  expect(root.find(`userspace-rootfs/manifests/${current}`)).toBeUndefined();
  expect(await verifiedBytes(backend, "manifests", current, bytes.length, digest)).toEqual(bytes);
  expect(await (await openVerifiedReader(backend, "manifests"))(current, bytes.length, digest)).toEqual(bytes);
  expect(await read(backend, "manifests", current, bytes.length - 1)).toBeUndefined();
  expect(await names(backend, "manifests")).toEqual([old, current]);
  const corrupt = new Uint8Array(await (await packed.getFile()).arrayBuffer());
  new DataView(corrupt.buffer).setUint32(0, bytes.length - 1, true);
  packed.setBytes(corrupt);
  expect(await read(backend, "manifests", current)).toBeUndefined();
  await remove(backend, "manifests", current);
  expect(await names(backend, "manifests")).toEqual([old]);
  expect(await read(backend, "manifests", old)).toEqual(previous);
});

it.each(["blobs", "packs"] as const)("writes verified %s in place and flushes the complete body", async scope => {
  const journal: string[] = [];
  const root = new MemoryDirectory("", journal), backend = { kind: "opfs", root } as const;
  const bytes = Uint8Array.of(1, 2, 3), digest = await sha256(bytes);
  const file = root.directory("userspace-rootfs", true).directory(scope, true).file(digest, true);
  file.setBytes(Uint8Array.of(9, 9, 9, 9));
  const stream = vi.spyOn(file, "createWritable");
  const open = file.createSyncAccessHandle.bind(file);
  const offsets: number[] = [];
  vi.spyOn(file, "createSyncAccessHandle").mockImplementation(async () => {
    const handle = await open(), put = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementation((buffer, options) => {
      if (!(buffer instanceof Uint8Array)) throw new Error("expected a byte buffer");
      offsets.push(options?.at ?? -1);
      return put(buffer.subarray(0, 1), options);
    });
    return handle;
  });

  await write(backend, scope, digest, bytes);

  expect(stream).not.toHaveBeenCalled();
  expect(offsets).toEqual([0, 1, 2]);
  expect(journal).toEqual(["write", "write", "write", "flush"].map(operation => digest + ":" + operation));
  expect(file.locked).toBe(false);
  expect(await verifiedBytes(backend, scope, digest, bytes.length, digest)).toEqual(bytes);
});

it.each(["quota", "zero progress", "flush"] as const)("retires a %s failure before retrying the body", async failure => {
  const journal: string[] = [];
  const root = new MemoryDirectory("", journal), backend = { kind: "opfs", root } as const;
  const bytes = Uint8Array.of(1, 2, 3), digest = await sha256(bytes);
  const file = root.directory("userspace-rootfs", true).directory("packs", true).file(digest, true);
  const open = file.createSyncAccessHandle.bind(file);
  const quota = new DOMException("the origin has no storage left", "QuotaExceededError");
  vi.spyOn(file, "createSyncAccessHandle").mockImplementationOnce(async () => {
    const handle = await open(), put = handle.write.bind(handle);
    if (failure === "flush") vi.spyOn(handle, "flush").mockImplementationOnce(() => { throw quota; });
    else {
      vi.spyOn(handle, "write").mockImplementation((buffer, options) => {
        if (!(buffer instanceof Uint8Array)) throw new Error("expected a byte buffer");
        if (options?.at === 0) return put(buffer.subarray(0, 1), options);
        if (failure === "quota") throw quota;
        return 0;
      });
    }
    return handle;
  });

  const failed = expect(write(backend, "packs", digest, bytes)).rejects;
  if (failure === "zero progress") {
    await failed.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "rootfs-write-progress", offset: 1 } });
  } else await failed.toBe(quota);
  expect(file.locked).toBe(false);
  expect(journal).toEqual([digest + ":write"]);
  expect(await verifiedBytes(backend, "packs", digest, bytes.length, digest)).toBeUndefined();

  await write(backend, "packs", digest, bytes);
  expect(await verifiedBytes(backend, "packs", digest, bytes.length, digest)).toEqual(bytes);
  expect(journal).toEqual([digest + ":write", digest + ":write", digest + ":flush"]);
});

it("serializes concurrent rootfs body writes and leaves the first verified bytes in place", async () => {
  const root = new MemoryDirectory();
  const bytes = Uint8Array.of(1, 2, 3), digest = await sha256(bytes);
  const file = root.directory("userspace-rootfs", true).directory("blobs", true).file(digest, true);
  const opened = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>();
  const queued = Promise.withResolvers<undefined>();
  const open = file.createSyncAccessHandle.bind(file);
  const handles = vi.spyOn(file, "createSyncAccessHandle").mockImplementationOnce(async () => {
    const handle = await open();
    opened.resolve(undefined);
    await release.promise;
    return handle;
  });
  let tail = Promise.resolve(), count = 0;
  vi.stubGlobal("navigator", { locks: {
    request: (name: string, options: LockOptions, commit: () => Promise<void>) => {
      expect(name).toBe("oxidevm-rootfs-body:blobs:" + digest);
      expect(options.mode).toBe("exclusive");
      if (++count === 2) queued.resolve(undefined);
      const turn = tail.then(commit);
      tail = turn.catch(() => {});
      return turn;
    },
  } });
  try {
    const first = write({ kind: "opfs", root }, "blobs", digest, bytes);
    await opened.promise;
    const second = write({ kind: "opfs", root }, "blobs", digest, bytes);
    await queued.promise;
    expect(handles).toHaveBeenCalledOnce();
    release.resolve(undefined);
    await Promise.all([first, second]);
    expect(file.syncWrites).toBe(1);
    expect(file.locked).toBe(false);
    expect(file.bytes).toEqual(bytes);
  } finally {
    release.resolve(undefined);
    vi.unstubAllGlobals();
  }
});

it("publishes mutable cache metadata through an atomic writable stream", async () => {
  const root = new MemoryDirectory(), backend = { kind: "opfs", root } as const;
  const bytes = Uint8Array.of(1, 2, 3);
  for (const scope of ["root", "manifests", "pins", "workspace-bases", "pack-layouts", "transports", "installations"] as const) {
    await write(backend, scope, "index.json", bytes);
    const path = scope === "root" ? "userspace-rootfs/index.json" : "userspace-rootfs/" + scope + "/index.json";
    const file = root.find(path);
    if (!(file instanceof MemoryFile)) throw new Error("missing metadata");
    expect(file.commits).toBe(1);
    expect(file.syncWrites).toBe(0);
  }
});

it("resolves a verification directory once while checking every fresh file body", async () => {
  const root = new MemoryDirectory(), backend = { kind: "opfs", root } as const;
  const bytes = new Uint8Array([1, 2, 3]), digest = await sha256(bytes);
  await write(backend, "blobs", "first", bytes); await write(backend, "blobs", "second", bytes);
  const directories = vi.spyOn(root, "getDirectoryHandle");
  const read = await openVerifiedReader(backend, "blobs");
  expect(await read("first", 3, digest)).toEqual(bytes);
  expect(await read("second", 3, digest)).toEqual(bytes);
  expect(directories).toHaveBeenCalledOnce();
  const file = root.find("userspace-rootfs/blobs/first");
  if (!(file instanceof MemoryFile)) throw new Error("missing fixture body");
  file.setBytes(new Uint8Array([9, 9, 9]));
  expect(await read("first", 3, digest)).toBeUndefined();
  expect(await read("second", 4, digest)).toBeUndefined();
  expect(await read("missing", 3, digest)).toBeUndefined();
});

it("does not create a missing verification directory", async () => {
  const root = new MemoryDirectory();
  const read = await openVerifiedReader({ kind: "opfs", root }, "blobs");
  expect(await read("missing", 1, "a".repeat(64))).toBeUndefined();
  expect(root.find("userspace-rootfs")).toBeUndefined();
});

// A small origin quota (Chromium's in-memory profiles get a fraction of RAM) used to leave the
// 256 MiB disk reserve holding the space the last image packs needed, and a guest read failed with EIO.
it("releases the disk reserve once for an image write the origin refuses for space", async () => {
  const quota = new MemoryQuota(2 * 1024 * 1024), root = new MemoryDirectory("", undefined, quota);
  const reserve = await SpaceReserve.open(root, 1024 * 1024);
  if (reserve === undefined) throw new Error("missing reserve");
  try {
    quota.limit = quota.used + 64 * 1024;
    const bytes = new Uint8Array(128 * 1024).fill(5), digest = await sha256(bytes);
    await expect(write({ kind: "opfs", root }, "packs", "unreserved", bytes)).rejects.toMatchObject({ name: "QuotaExceededError" });
    await write({ kind: "opfs", root, reserve }, "packs", "chunk", bytes);
    expect(await (await openVerifiedReader({ kind: "opfs", root }, "packs"))("chunk", bytes.length, digest)).toEqual(bytes);
    expect(quota.used).toBeLessThan(1024 * 1024);
    // Once released, the reserve is not released again: a second refusal is the origin's real limit.
    quota.limit = quota.used;
    await expect(write({ kind: "opfs", root, reserve }, "packs", "another", bytes)).rejects.toMatchObject({ name: "QuotaExceededError" });
  } finally { reserve.close(); }
});

// Chromium also ends a writable stream's write with AbortError ("Failed to write data to data pipe") at the
// origin's limit; hosted captures saw it at the same usage as QuotaExceededError.
it("treats a write the browser aborts as refused, releasing the reserve once and writing again", async () => {
  const quota = new MemoryQuota(4 * 1024 * 1024), root = new MemoryDirectory("", undefined, quota);
  const reserve = await SpaceReserve.open(root, 1024 * 1024);
  if (reserve === undefined) throw new Error("missing reserve");
  const aborted = Object.assign(await new MemoryFile("aborted").createWritable(), { write: () => Promise.reject(new DOMException("Failed to write data to data pipe", "AbortError")) });
  const opened = vi.spyOn(MemoryFile.prototype, "createWritable").mockResolvedValueOnce(aborted);
  const openSync = vi.spyOn(MemoryFile.prototype, "createSyncAccessHandle")
    .mockRejectedValue(new DOMException("Sync access unavailable", "NotSupportedError"));
  try {
    const bytes = new Uint8Array(4096).fill(9), digest = await sha256(bytes), releasing = vi.spyOn(reserve, "release");
    await write({ kind: "opfs", root, reserve }, "packs", "chunk", bytes);
    expect(releasing).toHaveReturnedWith(true);
    expect(await (await openVerifiedReader({ kind: "opfs", root }, "packs"))("chunk", bytes.length, digest)).toEqual(bytes);
    opened.mockImplementationOnce(() => Promise.reject(new DOMException("Invalid state", "InvalidStateError")));
    await expect(write({ kind: "opfs", root, reserve }, "packs", "other", bytes)).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(releasing).toHaveBeenCalledOnce();
  } finally { opened.mockRestore(); openSync.mockRestore(); reserve.close(); }
});

it("keeps the write refusal when the browser has already closed the failed stream", async () => {
  const root = new MemoryDirectory();
  const refused = new DOMException("requested space above quota", "QuotaExceededError");
  const abort = vi.fn(() => Promise.reject(new DOMException("already closed", "InvalidStateError")));
  const stream = Object.assign(await new MemoryFile("refused").createWritable(), {
    write: () => Promise.reject(refused), abort,
  });
  const opened = vi.spyOn(MemoryFile.prototype, "createWritable").mockResolvedValueOnce(stream);
  try {
    await expect(write({ kind: "opfs", root }, "root", "active.json", Uint8Array.of(3))).rejects.toBe(refused);
    expect(abort).toHaveBeenCalledWith(refused);
  } finally { opened.mockRestore(); }
});

it("checks the physical pack size before caching an optional demand read", async () => {
  const root = new MemoryDirectory();
  const bytes = new Uint8Array(4 * 1024 ** 2);
  const quota = 1_048_576_000;
  vi.stubGlobal("navigator", { storage: { estimate: () => Promise.resolve({ quota, usage: quota - 258 * 1024 ** 2 }) } });
  try {
    const backend = { kind: "opfs", root } as const;
    await expect(write(backend, "packs", "optional", bytes, () => false)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(root.find("userspace-rootfs/packs/optional")).toBeUndefined();
    await write(backend, "packs", "required", bytes, () => true);
    expect(root.find("userspace-rootfs/packs/required")).toBeInstanceOf(MemoryFile);
  } finally { vi.unstubAllGlobals(); }
});
