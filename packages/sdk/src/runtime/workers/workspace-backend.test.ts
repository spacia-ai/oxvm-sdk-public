import { expect, it } from "vitest";
import { MemoryDirectory, MemoryQuota } from "./opfs-double.test-support.js";
import { opfsWorkspaceStoreBackend, readWorkspaceBlob } from "./workspace-backend.js";
import { WorkspaceStore } from "./workspace-store.js";
import { workspaceBytesInput } from "./workspace-stream.js";

it("cancels a pending OPFS blob read and awaits underlying retirement", async () => {
  const reading = Promise.withResolvers<undefined>();
  const cancelling = Promise.withResolvers<undefined>();
  const retired = Promise.withResolvers<undefined>();
  class PendingBlob extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({
        pull: () => { reading.resolve(undefined); return new Promise<void>(() => { /* Wait for cancellation. */ }); },
        cancel: () => { cancelling.resolve(undefined); return retired.promise; },
      });
    }
  }
  const controller = new AbortController();
  let settled = false;
  const read = readWorkspaceBlob(new PendingBlob([new Uint8Array(1)]), 1, controller.signal);
  void read.then(() => { settled = true; }, () => { settled = true; });
  const cancelled = expect(read).rejects.toMatchObject({ code: "ABORTED" });
  await reading.promise;
  controller.abort();
  await cancelling.promise;
  expect(settled).toBe(false);
  retired.resolve(undefined);
  await cancelled;
});

it("bounds OPFS blob allocation and verifies complete reads", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  await expect(readWorkspaceBlob(blob, 3)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  await expect(readWorkspaceBlob(blob, 2)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const controller = new AbortController(); controller.abort();
  await expect(readWorkspaceBlob(blob, 3, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
});

it.each([1, 3])("rejects OPFS data whose size %i differs from the pinned size", async bytes => {
  class ChangedBlob extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({ start: controller => { controller.enqueue(new Uint8Array(bytes)); controller.close(); } });
    }
  }
  await expect(readWorkspaceBlob(new ChangedBlob([new Uint8Array(2)]), 2)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it("does not hide failed blob retirement behind cancellation", async () => {
  const reading = Promise.withResolvers<undefined>();
  class FailedBlob extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({
        pull: () => { reading.resolve(undefined); return new Promise<void>(() => { /* Cancel the read. */ }); },
        cancel: () => Promise.reject(new Error("retirement failed")),
      });
    }
  }
  const controller = new AbortController();
  const read = readWorkspaceBlob(new FailedBlob([new Uint8Array(1)]), 1, controller.signal);
  const failed = expect(read).rejects.toMatchObject({
    code: "STORAGE_ERROR", detail: { cleanupFailed: true, reason: "workspace-producer-retirement-failed" },
  });
  await reading.promise;
  controller.abort();
  await failed;
});

it("commits a compressible workspace larger than the origin quota and reopens every byte", async () => {
  const chunk = 1024 ** 2;
  const quota = new MemoryQuota(2 * chunk);
  const directory = new MemoryDirectory("workspace", undefined, quota);
  const base = "a".repeat(64);
  const signal = new AbortController().signal;
  const snapshot = new Uint8Array(3 * chunk);
  for (let i = 0; i < 3; i++) snapshot.fill(i + 1, i * chunk, (i + 1) * chunk);
  const streams = { snapshot: workspaceBytesInput(snapshot), delta: workspaceBytesInput(Uint8Array.of(9)) };

  await expect(new WorkspaceStore(opfsWorkspaceStoreBackend(directory)).commitStreams(base, streams, signal))
    .rejects.toMatchObject({ name: "QuotaExceededError" });
  const writer = new WorkspaceStore(opfsWorkspaceStoreBackend(directory, true));
  await expect(writer.commitStreams(base, streams, signal)).resolves.toBe(1);
  expect(quota.used).toBeLessThan(chunk);

  const reader = new WorkspaceStore(opfsWorkspaceStoreBackend(directory));
  const restored = await reader.read(base);
  expect(restored?.length).toBe(snapshot.length);
  expect(restored?.every((byte, offset) => byte === snapshot[offset])).toBe(true);
  await expect(reader.readDelta(base)).resolves.toEqual(Uint8Array.of(9));
});

it("reads existing raw chunks and rejects invalid compressed lengths before allocation", async () => {
  const directory = new MemoryDirectory();
  const raw = opfsWorkspaceStoreBackend(directory);
  const compact = opfsWorkspaceStoreBackend(directory, true);
  const path = `chunks/${"b".repeat(64)}`;
  const bytes = new Uint8Array(128 * 1024).fill(17);

  await raw.write(path, bytes, "immutable-chunk");
  expect((await compact.read(path))?.every(byte => byte === 17)).toBe(true);
  await compact.remove(path);
  await compact.write(path, bytes, "immutable-chunk");
  await expect(raw.read(path, bytes.length - 1)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const packed = await directory.getDirectoryHandle("chunks");
  const file = await packed.getFileHandle(`${"b".repeat(64)}.gzip-v1`);
  const writable = await file.createWritable({ keepExistingData: true });
  await writable.write({ type: "write", position: 0, data: Uint8Array.of(0xff, 0xff, 0xff, 0xff) });
  await writable.close();
  await expect(raw.read(path)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  await raw.remove(path);
  await expect(compact.read(path)).resolves.toBeUndefined();
});
