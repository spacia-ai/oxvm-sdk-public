import { VMError } from "../errors.js";
import { normalizeWorkspacePath } from "../workspace-path.js";
import type { WorkspaceStoreBackend } from "./workspace-store.js";
import { indexedDbWorkspacePaths, opfsWorkspacePaths } from "./workspace-enumeration.js";
import { availableStorageBytes, refusedForSpace } from "./browser-quota.js";
import type { SpaceReserve } from "./managed-disk-reserve.js";
import { decodeManagedGzip } from "./managed-image-fetch.js";
import { tryWriteImmutableOpfsBody } from "./opfs-body.js";
import { CHUNK_BYTES } from "./workspace-stream.js";

/** Only durable file publications may spend the guest reserve; snapshot object
 * writes keep using their own backend and report storage pressure. */
export function reserveWorkspaceWrites(backend: WorkspaceStoreBackend, reserve: SpaceReserve | undefined): WorkspaceStoreBackend {
  return { ...backend, write: async (path, bytes, operation) => {
    if (reserve !== undefined && (await availableStorageBytes() ?? Infinity) <= bytes.byteLength) reserve.release();
    try { await backend.write(path, bytes, operation); }
    catch (error) {
      if (!refusedForSpace(error) || reserve?.release() !== true) throw error;
      await backend.write(path, bytes, operation);
    }
  } };
}

export async function parentDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  const name = segments.at(-1);
  if (name === undefined) {
    throw new VMError("INVALID_ARGUMENT", "path has no filename");
  }
  return {
    directory: await descend(root, segments.slice(0, -1), create),
    name,
  };
}

export async function descend(
  start: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let directory = start;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
}

export function indexedDbWorkspaceStoreBackend(database: Promise<IDBDatabase>): WorkspaceStoreBackend {
  return {
    list: async function* (prefix) { yield* indexedDbWorkspacePaths(await database, prefix); },
    read: async (path, maximumBytes, signal) => indexedDbRead(await database, path, maximumBytes, signal),
    write: async (path, bytes) => indexedDbWrite(await database, path, bytes),
    remove: async (path) => indexedDbRemove(await database, path),
  };
}

export function opfsWorkspaceStoreBackend(root: FileSystemDirectoryHandle, compactChunks = false): WorkspaceStoreBackend {
  return {
    list: (prefix) => opfsWorkspacePaths(root, prefix),
    read: async (path, maximumBytes, signal) => {
      requireActive(signal);
      const segments = normalizeWorkspacePath(path);
      const raw = await findWorkspaceBlob(root, segments);
      if (raw !== undefined) return readWorkspaceBlob(raw, maximumBytes, signal);
      const packedPath = packedChunkPath(segments);
      const packed = packedPath === undefined ? undefined : await findWorkspaceBlob(root, packedPath);
      requireActive(signal);
      return packed === undefined ? undefined : readPackedChunk(packed, maximumBytes, signal);
    },
    write: async (path, bytes, operation) => {
      let segments = normalizeWorkspacePath(path);
      let body = bytes;
      const compact = compactChunks && operation === "immutable-chunk" ? packedChunkPath(segments) : undefined;
      if (compact !== undefined) {
        const packed = await packChunk(bytes);
        if (packed !== undefined) { segments = compact; body = packed; }
      }
      const { directory, name } = await parentDirectory(root, segments, true);
      const file = await directory.getFileHandle(name, { create: true });
      if (operation === "immutable-chunk") {
        try { if (await tryWriteImmutableOpfsBody(file, body, "workspace")) return; }
        catch (error) {
          // A sync handle can reserve more space than the body needs.
          if (!refusedForSpace(error)) throw error;
        }
      }
      const writable = await file.createWritable({ keepExistingData: false });
      try {
        await writable.write(body.slice());
        await writable.close();
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
    },
    remove: async (path) => {
      const segments = normalizeWorkspacePath(path);
      await removeWorkspaceBlob(root, segments);
      const packed = packedChunkPath(segments);
      if (packed !== undefined) await removeWorkspaceBlob(root, packed);
    },
  };
}

async function findWorkspaceBlob(root: FileSystemDirectoryHandle, segments: string[]): Promise<File | undefined> {
  try {
    const { directory, name } = await parentDirectory(root, segments, false);
    return await (await directory.getFileHandle(name)).getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}

async function removeWorkspaceBlob(root: FileSystemDirectoryHandle, segments: string[]): Promise<void> {
  try {
    const { directory, name } = await parentDirectory(root, segments, false);
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
}

// The journal names the logical chunk. The versioned suffix selects its physical encoding.
function packedChunkPath(segments: string[]): string[] | undefined {
  const name = segments.at(-1);
  if (name === undefined || segments.at(-2) !== "chunks" || !/^[a-f0-9]{64}$/u.test(name)) return undefined;
  return [...segments.slice(0, -1), `${name}.gzip-v1`];
}

async function packChunk(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (bytes.length > CHUNK_BYTES || typeof CompressionStream !== "function") return undefined;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const encoded = new Uint8Array(await new Response(stream).arrayBuffer());
  if (encoded.length + 4 >= bytes.length) return undefined;
  const result = new Uint8Array(encoded.length + 4);
  new DataView(result.buffer).setUint32(0, bytes.length, true);
  result.set(encoded, 4);
  return result;
}

async function readPackedChunk(file: File, maximumBytes = CHUNK_BYTES, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const limit = Math.min(CHUNK_BYTES, maximumBytes);
  if (file.size <= 4 || file.size >= limit) {
    throw new VMError("STORAGE_ERROR", "Invalid compressed workspace chunk");
  }
  const packed = new Uint8Array(await file.arrayBuffer());
  requireActive(signal);
  const bytes = new DataView(packed.buffer).getUint32(0, true);
  if (bytes <= file.size || bytes > limit) throw new VMError("STORAGE_ERROR", "Invalid compressed workspace chunk length");
  const content = decodeManagedGzip(packed.subarray(4), bytes);
  if (content === undefined) throw new VMError("STORAGE_ERROR", "Workspace chunk did not decompress");
  return content;
}

export function indexedDbRead(database: IDBDatabase, path: string, maximumBytes?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return new Promise((resolve, reject) => {
    requireActive(signal);
    const transaction = database.transaction("files", "readonly");
    const request = transaction.objectStore("files").get(path);
    let abortError: VMError | undefined;
    const abort = () => {
      try { transaction.abort(); }
      catch (error) {
        // Completion may already be queued. Its handler still observes abort.
        if (!(error instanceof DOMException) || error.name !== "InvalidStateError") {
          abortError = new VMError("STORAGE_ERROR", "workspace IndexedDB cancellation failed");
        }
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    transaction.oncomplete = () => {
      signal?.removeEventListener("abort", abort);
      try {
        if (abortError !== undefined) throw abortError;
        requireActive(signal);
        const value: unknown = request.result;
        if (value === undefined) { resolve(undefined); return; }
        if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new VMError("STORAGE_ERROR", "workspace IndexedDB object is invalid");
        if (maximumBytes !== undefined && value.byteLength > maximumBytes) throw new VMError("STORAGE_ERROR", "workspace object exceeds its declared bound");
        resolve(new Uint8Array(value));
      } catch (error) { reject(error instanceof Error ? error : new VMError("STORAGE_ERROR", "workspace IndexedDB read failed")); }
    };
    transaction.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.aborted === true ? new VMError("ABORTED", "Workspace read cancelled")
        : transaction.error ?? new VMError("STORAGE_ERROR", "workspace IndexedDB read failed"));
    };
  });
}

/** Blob.arrayBuffer cannot interrupt a pending read. Retain the reader and its
 * cancellation outcome until the underlying byte producer confirms retirement. */
export async function readWorkspaceBlob(file: Blob, maximumBytes?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  requireActive(signal);
  if (maximumBytes !== undefined && file.size > maximumBytes) throw new VMError("STORAGE_ERROR", "workspace object exceeds its declared bound");
  return readWorkspaceBody(file.stream(), file.size, signal);
}

async function readWorkspaceBody(stream: ReadableStream<Uint8Array<ArrayBuffer>>, size: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(size);
  const reader = stream.getReader();
  let retirement: Promise<void> | undefined;
  const retire = () => retirement ??= reader.cancel();
  const abort = () => { void retire().catch(() => { /* Awaited below before returning ownership. */ }); };
  signal?.addEventListener("abort", abort, { once: true });
  let failure: { readonly error: unknown } | undefined;
  try {
    let offset = 0;
    for (;;) {
      requireActive(signal);
      const frame = await reader.read();
      requireActive(signal);
      if (frame.done) break;
      if (frame.value.length > bytes.length - offset) throw new VMError("STORAGE_ERROR", "Workspace blob exceeded its declared size");
      bytes.set(frame.value, offset); offset += frame.value.length;
    }
    if (offset !== bytes.length) throw new VMError("STORAGE_ERROR", "Workspace blob ended before its declared size");
  } catch (error) {
    failure = { error };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  try { await retire(); }
  catch { throw new VMError("STORAGE_ERROR", "Workspace read producer retirement failed", { reason: "workspace-producer-retirement-failed", cleanupFailed: true }); }
  finally { reader.releaseLock(); }
  if (failure !== undefined) throw failure.error;
  return bytes;
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new VMError("ABORTED", "Workspace read cancelled");
}

export function indexedDbKeys(database: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction("files", "readonly").objectStore("files").getAllKeys();
    request.onsuccess = () => resolve(request.result.filter((value): value is string => typeof value === "string"));
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "workspace IndexedDB listing failed"));
  });
}

export function indexedDbWrite(database: IDBDatabase, path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
  return indexedDbMutation(database, (store) => { store.put(data, path); });
}

export function indexedDbRemove(database: IDBDatabase, path: string): Promise<void> {
  return indexedDbMutation(database, (store) => { store.delete(path); });
}

function indexedDbMutation(database: IDBDatabase, mutate: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("files", "readwrite");
    mutate(transaction.objectStore("files"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new VMError("STORAGE_ERROR", "workspace IndexedDB mutation failed"));
    transaction.onabort = () => reject(transaction.error ?? new VMError("ABORTED", "workspace IndexedDB mutation aborted"));
  });
}
