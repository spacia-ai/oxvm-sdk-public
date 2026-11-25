import { equalBytes } from "../equal-bytes.js";
import { VMError } from "../errors.js";

interface SyncBodyHandle {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array<ArrayBuffer>, options: { readonly at: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array<ArrayBuffer>, options: { readonly at: number }): number;
}

function supportsSyncBody(file: FileSystemFileHandle): file is FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncBodyHandle>;
} {
  return "createSyncAccessHandle" in file && typeof file.createSyncAccessHandle === "function";
}

/** The caller verifies a body by size and digest. Flush it before publishing references. */
export async function tryWriteImmutableOpfsBody(
  file: FileSystemFileHandle,
  bytes: Uint8Array<ArrayBuffer>,
  owner: "rootfs" | "workspace",
): Promise<boolean> {
  if (!supportsSyncBody(file)) return false;
  let handle: SyncBodyHandle;
  try { handle = await file.createSyncAccessHandle(); }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") return false;
    throw error;
  }
  let replacing = false;
  try {
    // Another cache writer can finish the same digest while this writer waits for its turn.
    if (!matchesBody(handle, bytes)) {
      replacing = true;
      handle.truncate(0);
      for (let offset = 0; offset < bytes.byteLength;) {
        const expected = bytes.byteLength - offset;
        const actual = handle.write(bytes.subarray(offset), { at: offset });
        if (!Number.isSafeInteger(actual) || actual <= 0 || actual > expected) {
          throw new VMError("STORAGE_ERROR", `a ${owner} body write made invalid progress`, {
            reason: `${owner}-write-progress`, offset, actual, expected,
          });
        }
        offset += actual;
      }
    }
    handle.flush();
  } catch (error) {
    if (replacing) {
      try { handle.truncate(0); } catch { /* Recovery verifies the remaining body. */ }
    }
    try { handle.close(); } catch { /* Keep the original write failure. */ }
    throw error;
  }
  handle.close();
  return true;
}

function matchesBody(handle: SyncBodyHandle, bytes: Uint8Array<ArrayBuffer>): boolean {
  if (handle.getSize() !== bytes.byteLength) return false;
  const buffer = new Uint8Array(Math.min(bytes.byteLength, 64 * 1024));
  for (let offset = 0; offset < bytes.byteLength;) {
    const target = buffer.subarray(0, Math.min(buffer.byteLength, bytes.byteLength - offset));
    const count = handle.read(target, { at: offset });
    if (!Number.isSafeInteger(count) || count <= 0 || count > target.byteLength
      || !equalBytes(target.subarray(0, count), bytes.subarray(offset, offset + count))) return false;
    offset += count;
  }
  return true;
}
