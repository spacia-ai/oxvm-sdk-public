import { expect, it, vi } from "vitest";
import { SpaceReserve } from "./managed-disk-reserve.js";
import { MemoryDirectory, MemoryFile, MemoryQuota } from "./opfs-double.test-support.js";
import { opfsWorkspaceStoreBackend, reserveWorkspaceWrites } from "./workspace-backend.js";
import { SnapshotObjects } from "./snapshot-objects.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { WorkspaceStore } from "./workspace-store.js";
import { workspaceBytesInput } from "./workspace-stream.js";

it("leaves space for guest writes when the reserve could exhaust the quota", async () => {
  const bytes = 1024 * 1024;
  const directory = new MemoryDirectory();
  const estimate = vi.fn().mockResolvedValue({ quota: 4 * bytes, usage: 2.5 * bytes });
  vi.stubGlobal("navigator", { storage: { estimate } });
  const reserve = await SpaceReserve.open(directory, bytes, false);
  if (reserve === undefined) throw new Error("missing reserve");
  try {
    expect(await reserve.hold()).toBe(false);
    const file = directory.find("space.reserve");
    if (!(file instanceof MemoryFile)) throw new Error("missing reserve file");
    expect(file.size).toBe(0);
    expect(file.locked).toBe(false);
    estimate.mockResolvedValue({ quota: 4 * bytes, usage: 2 * bytes });
    expect(await reserve.hold()).toBe(true);
    expect(file.size).toBe(bytes);
  } finally { reserve.close(); vi.unstubAllGlobals(); }
});
it("closes a reserve handle that opens after the generation closes", async () => {
  const directory = new MemoryDirectory();
  const reserve = await SpaceReserve.open(directory, 1024, false);
  const file = directory.find("space.reserve");
  if (reserve === undefined || !(file instanceof MemoryFile)) throw new Error("missing reserve");
  const openHandle = file.createSyncAccessHandle.bind(file);
  const opening = Promise.withResolvers<undefined>();
  const permit = Promise.withResolvers<undefined>();
  const open = vi.spyOn(file, "createSyncAccessHandle").mockImplementationOnce(async () => {
    opening.resolve(undefined);
    await permit.promise;
    return openHandle();
  });
  try {
    const holding = reserve.hold();
    await opening.promise;
    reserve.close();
    permit.resolve(undefined);
    expect(await holding).toBe(false);
    expect(file.locked).toBe(false);
    expect(file.size).toBe(0);
  } finally {
    permit.resolve(undefined);
    reserve.close();
    open.mockRestore();
  }
});

it("retains a workspace quota failure when the browser already closed the stream", async () => {
  const refused = new DOMException("Requested space above quota", "QuotaExceededError");
  const abort = vi.fn(() => Promise.reject(new DOMException("already closed", "InvalidStateError")));
  const stream = Object.assign(await new MemoryFile("refused").createWritable(), {
    abort, write: () => Promise.reject(refused),
  });
  const opened = vi.spyOn(MemoryFile.prototype, "createWritable").mockResolvedValueOnce(stream);
  try {
    await expect(opfsWorkspaceStoreBackend(new MemoryDirectory()).write("blobs/file", Uint8Array.of(1)))
      .rejects.toBe(refused);
    expect(abort).toHaveBeenCalledWith(refused);
  } finally {
    opened.mockRestore();
  }
});

it("keeps the reserve for durable file writes, retries once, and refuses writes when exhausted", async () => {
  const quota = new MemoryQuota(2 * 1024 * 1024);
  const directory = new MemoryDirectory("workspace", undefined, quota);
  const reserve = await SpaceReserve.open(directory, 1024 * 1024);
  const backend = reserveWorkspaceWrites(opfsWorkspaceStoreBackend(directory), reserve);
  try {
    const snapshots = await SnapshotObjects.open(directory);
    quota.limit = quota.used + 64 * 1024;
    await expect(snapshots.put(new Uint8Array(128 * 1024).fill(3))).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(quota.used).toBe(1024 * 1024);
    const bytes = new Uint8Array(128 * 1024).fill(7);
    await backend.write("blobs/file", bytes);
    expect(await backend.read("blobs/file")).toEqual(bytes);
    expect(await reserve?.hold()).toBe(false);
    quota.limit = quota.used;
    await expect(backend.write("blobs/another", bytes)).rejects.toMatchObject({ name: "QuotaExceededError" });
    quota.limit = 4 * 1024 * 1024;
    expect(await reserve?.hold()).toBe(true);
  } finally { reserve?.close(); }
});

it("uses the workspace reserve before the browser has to refuse a durable write", async () => {
  const quota = new MemoryQuota(4 * 1024 ** 2);
  const directory = new MemoryDirectory("workspace", undefined, quota);
  vi.stubGlobal("navigator", { storage: { estimate: () => Promise.resolve({ quota: quota.limit, usage: quota.used }) } });
  const reserve = await SpaceReserve.open(directory, 1024 ** 2);
  if (reserve === undefined) throw new Error("missing reserve");
  const opened = vi.spyOn(MemoryFile.prototype, "createWritable");
  try {
    const bytes = new Uint8Array(131072).fill(8);
    quota.limit = quota.used + bytes.byteLength;
    const backend = reserveWorkspaceWrites(opfsWorkspaceStoreBackend(directory), reserve);
    await backend.write("blobs/file", bytes);
    expect(opened).toHaveBeenCalledOnce();
    expect(quota.used).toBe(bytes.byteLength);
    expect(await backend.read("blobs/file")).toEqual(bytes);
  } finally { opened.mockRestore(); reserve.close(); vi.unstubAllGlobals(); }
});

it("flushes verified workspace stream bodies in place and retries on quota before selecting them", async () => {
  const chunkBytes = 1024 ** 2;
  const quota = new MemoryQuota(4 * chunkBytes);
  const journal: string[] = [];
  const directory = new MemoryDirectory("workspace", journal, quota);
  const reserve = await SpaceReserve.open(directory, chunkBytes);
  if (reserve === undefined) throw new Error("missing reserve");
  const release = vi.spyOn(reserve, "release");
  try {
    const raw = opfsWorkspaceStoreBackend(directory);
    const store = new WorkspaceStore(reserveWorkspaceWrites(new WorkspaceSelections(raw).backend, reserve));
    const signal = new AbortController().signal;
    const base = "a".repeat(64);
    const snapshot = new Uint8Array(chunkBytes).fill(41);
    quota.limit = quota.used + 64 * 1024;
    await expect(store.commitStreams(base, {
      snapshot: workspaceBytesInput(snapshot),
      delta: workspaceBytesInput(new Uint8Array()),
    }, signal)).resolves.toBe(1);
    expect(release).toHaveBeenCalledOnce();
    const chunks = directory.find("chunks");
    if (!(chunks instanceof MemoryDirectory)) throw new Error("missing chunks");
    expect(chunks.names()).toHaveLength(2);
    for (const name of chunks.names()) {
      const file = chunks.file(name, false);
      expect(file.commits).toBe(0);
      expect(file.syncWrites).toBe(1);
      expect(file.locked).toBe(false);
      expect(journal.filter((entry) => entry.startsWith(name))).toEqual([`${name}:write`, `${name}:flush`]);
    }
    const head = directory.find("selections/head.json");
    if (!(head instanceof MemoryFile)) throw new Error("missing selected generation");
    expect(head.commits).toBe(1);
    expect(head.syncWrites).toBe(0);
    const restored = await new WorkspaceStore(new WorkspaceSelections(raw).backend).read(base);
    expect(restored?.length).toBe(chunkBytes);
    expect(restored?.every((byte) => byte === 41)).toBe(true);
  } finally { release.mockRestore(); reserve.close(); }
});

it("keeps ordinary writes atomic even under a digest-shaped chunk path", async () => {
  const directory = new MemoryDirectory();
  const path = `chunks/${"a".repeat(64)}`;
  await opfsWorkspaceStoreBackend(directory).write(path, Uint8Array.of(7));
  const file = directory.find(path);
  if (!(file instanceof MemoryFile)) throw new Error("missing chunk-shaped file");
  expect(file.commits).toBe(1);
  expect(file.syncWrites).toBe(0);
});

it("commits a chunk that fits when the sync handle requests more than its size", async () => {
  const chunkBytes = 1024 ** 2;
  const quota = new MemoryQuota(chunkBytes + 900 * 1024);
  const directory = new MemoryDirectory("workspace", undefined, quota);
  await directory.getDirectoryHandle("chunks", { create: true });
  const chunks = directory.find("chunks");
  if (!(chunks instanceof MemoryDirectory)) throw new Error("missing chunks");
  const file = chunks.file("body", true);
  const open = file.createSyncAccessHandle.bind(file);
  const sync = vi.spyOn(file, "createSyncAccessHandle").mockImplementationOnce(async () => {
    const handle = await open();
    vi.spyOn(handle, "write").mockImplementation(() => {
      throw new DOMException("Rounded capacity exceeds quota", "QuotaExceededError");
    });
    return handle;
  });
  const backend = opfsWorkspaceStoreBackend(directory);
  const content = new Uint8Array(chunkBytes).fill(31);
  await backend.write("chunks/body", content, "immutable-chunk");
  expect(sync).toHaveBeenCalledOnce();
  expect(file.locked).toBe(false);
  expect(file.commits).toBe(1);
  expect(await backend.read("chunks/body")).toEqual(content);
});
