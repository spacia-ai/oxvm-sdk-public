import { expect, it, vi } from "vitest";
import type { ManagedImageChunk } from "../managed-image.js";
import { ManagedBaseIntegrity } from "./managed-base-integrity.js";
import { installManagedBase } from "./managed-base-installation.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { sha256Hex } from "./snapshot-content.js";

it("completes partial base writes and verifies recorded ranges before resuming", async () => {
  const images = new MemoryDirectory();
  const file = images.file("base.pack", true);
  const journal = "base.installing";
  const data = [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6, 7, 8)];
  const chunks = await Promise.all(data.map(async (bytes, index): Promise<ManagedImageChunk> => ({
    index, url: new URL(`https://example.test/${String(index)}.gz`), bytes: bytes.length,
    sha256: await sha256Hex(bytes), encoding: "gzip", encodedBytes: 1, encodedSha256: "a".repeat(64),
  })));
  const acquire = vi.fn((chunk: ManagedImageChunk) => {
    const bytes = data[chunk.index];
    if (bytes === undefined) throw new Error("missing chunk");
    return Promise.resolve(bytes);
  });
  const handle = await file.createSyncAccessHandle();
  const write = handle.write.bind(handle);
  const read = handle.read.bind(handle);
  let blocked = true;
  vi.spyOn(handle, "write").mockImplementation((bytes, options) =>
    blocked && options?.at === 6 ? 0 : write(prefix(bytes), options));
  vi.spyOn(handle, "read").mockImplementation((bytes, options) => read(prefix(bytes), options));
  try {
    await expect(installManagedBase(file, images, journal, "image", chunks, acquire, { handle }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(JSON.parse(await (await images.file(journal, false).getFile()).text())).toEqual({
      version: 1, identity: "image", completed: [0],
    });
    blocked = false;
    await installManagedBase(file, images, journal, "image", chunks, acquire, { handle });
    expect(acquire.mock.calls.map(([chunk]) => chunk.index)).toEqual([0, 1, 1]);
    new ManagedBaseIntegrity(chunks, handle).verify(handle, 0, 8);
    expect(JSON.parse(await (await images.file(journal, false).getFile()).text())).toEqual({
      version: 1, identity: "image", completed: [0, 1],
    });
  } finally {
    handle.close();
  }
});

function prefix(bytes: AllowSharedBufferSource): Uint8Array {
  const length = Math.min(bytes.byteLength, 2);
  return ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, length)
    : new Uint8Array(bytes, 0, length);
}
