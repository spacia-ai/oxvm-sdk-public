import { VMError } from "../errors.js";
import { availableStorageBytes, DISK_RESERVE_BYTES, refusedWrite } from "./browser-quota.js";
import { decodeManagedGzip, managedBodyStream, readManagedBody } from "./managed-image-fetch.js";
import { tryWriteImmutableOpfsBody } from "./opfs-body.js";

const PACKED_MANIFESTS = "manifests-gzip-v1";
const MIN_PACKED_MANIFEST = 1024 ** 2;
export const MAX_ROOTFS_MANIFEST_BYTES = 128 * 1024 ** 2;

/** The origin's disk reserve, which gives its space back once when an image write is refused. */
export interface RootfsSpaceReserve { release(): boolean }
export type Scope = "root" | "blobs" | "manifests" | "workspace-bases" | "pins" | "packs" | "pack-layouts" | "transports" | "installations";
type OpfsScope = Scope | typeof PACKED_MANIFESTS;
export type Backend =
  | { readonly kind: "opfs"; readonly root: FileSystemDirectoryHandle; readonly reserve?: RootfsSpaceReserve }
  | { readonly kind: "indexeddb"; readonly database: Promise<IDBDatabase> };
/** An activated workspace base and its checkpoint pins share the fetched signed bytes. */
export async function activate(backend: Backend, url: URL, digest: string, rootTreeSha256: string, encoded: Uint8Array<ArrayBuffer>): Promise<void> {
  const file = `${digest}.json`;
  const encoder = new TextEncoder();
  const marker = encoder.encode(JSON.stringify({ file, manifestUrl: url.href }));
  const base = encoder.encode(url.href);
  const saved = await read(backend, "manifests", file, encoded.length);
  const reusable = saved !== undefined && saved.length === encoded.length && encoded.every((byte, i) => byte === saved[i]);
  if (backend.kind === "indexeddb") {
    const database = await backend.database;
    await idbWrite(database, (store) => {
      if (!reusable) store.put(encoded, key("manifests", file));
      store.put(base, key("workspace-bases", file));
      store.put(marker, key("root", "active.json"));
    });
    return;
  }
  await write(backend, "root", "intent.json", encoder.encode(JSON.stringify({ file, rootTreeSha256 })));
  if (!reusable) await write(backend, "manifests", file, encoded);
  await write(backend, "workspace-bases", file, base);
  await write(backend, "root", "active.json", marker);
  await remove(backend, "root", "intent.json");
}

export async function verifiedFile(backend: Backend, scope: Scope, name: string, bytes: number, digest: string): Promise<boolean> {
  return await verifiedBytes(backend, scope, name, bytes, digest) !== undefined;
}

export async function verifiedBytes(
  backend: Backend,
  scope: Scope,
  name: string,
  bytes: number,
  digest: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return verifiedContent(await read(backend, scope, name, bytes), bytes, digest);
}

/** Retains only a directory capability; every read still verifies fresh bytes. */
export async function openVerifiedReader(backend: Backend, scope: Scope): Promise<(name: string, bytes: number, digest: string) => Promise<Uint8Array<ArrayBuffer> | undefined>> {
  if (backend.kind === "indexeddb" || scope === "manifests") {
    return (name, bytes, digest) => verifiedBytes(backend, scope, name, bytes, digest);
  }
  let directory: FileSystemDirectoryHandle | undefined;
  try { directory = await opfsDirectory(backend.root, scope, false); } catch { /* A missing cache is not created by verification. */ }
  return async (name, bytes, digest) => {
    if (directory === undefined) return undefined;
    let content: Uint8Array<ArrayBuffer>;
    try {
      const file = await (await directory.getFileHandle(name)).getFile();
      if (file.size !== bytes) return undefined;
      content = new Uint8Array(await file.arrayBuffer());
    }
    catch { return undefined; }
    return verifiedContent(content, bytes, digest);
  };
}

async function verifiedContent(content: Uint8Array<ArrayBuffer> | undefined, bytes: number, digest: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return content !== undefined && content.byteLength === bytes && await sha256(content) === digest
    ? content
    : undefined;
}

export async function read(backend: Backend, scope: Scope, name: string, maximum = Infinity): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (backend.kind === "opfs") {
    const raw = await readOpfs(backend.root, scope, name, maximum);
    if (raw !== undefined || scope !== "manifests") return raw;
    const packed = await readOpfs(backend.root, PACKED_MANIFESTS, name, Math.min(maximum, MAX_ROOTFS_MANIFEST_BYTES));
    if (packed === undefined || packed.length < 4) return undefined;
    const length = new DataView(packed.buffer, packed.byteOffset, 4).getUint32(0, true);
    if (length > maximum || length > MAX_ROOTFS_MANIFEST_BYTES || length <= packed.length) return undefined;
    // WebKit can stall a fresh storage worker while it reads a compressed retained manifest.
    return decodeManagedGzip(packed.subarray(4), length);
  }
  const database = await backend.database;
  const content = await idbRead(database, key(scope, name));
  return content !== undefined && content.length <= maximum ? content : undefined;
}

async function readOpfs(root: FileSystemDirectoryHandle, scope: OpfsScope, name: string, maximum: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    const directory = await opfsDirectory(root, scope, false);
    const file = await (await directory.getFileHandle(name)).getFile();
    return file.size <= maximum ? new Uint8Array(await file.arrayBuffer()) : undefined;
  } catch {
    return undefined;
  }
}

export async function names(backend: Backend, scope: Scope): Promise<string[]> {
  if (backend.kind === "opfs") {
    const found = await opfsNames(backend.root, scope);
    return scope === "manifests"
      ? [...new Set([...found, ...await opfsNames(backend.root, PACKED_MANIFESTS)])] : found;
  }
  const database = await backend.database;
  const prefix = key(scope, "");
  return new Promise((resolve, reject) => {
    const tx = database.transaction("files", "readonly");
    const request = tx.objectStore("files").getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => resolve(request.result.flatMap(name => typeof name === "string" ? [name.slice(prefix.length)] : []));
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB listing failed"));
  });
}

async function opfsNames(root: FileSystemDirectoryHandle, scope: OpfsScope): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const [name, handle] of (await opfsDirectory(root, scope, false)).entries()) {
      if (handle.kind === "file") names.push(name);
    }
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
  return names;
}

function idbRead(database: IDBDatabase, name: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("files", "readonly");
    const request = tx.objectStore("files").get(name);
    request.onsuccess = () => resolve(
      request.result instanceof Uint8Array
        ? new Uint8Array(request.result)
        : request.result instanceof ArrayBuffer
          ? new Uint8Array(request.result)
          : undefined,
    );
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB read failed"));
    tx.onabort = () => reject(tx.error ?? new VMError("ABORTED", "rootfs IndexedDB read aborted"));
  });
}

export async function write(backend: Backend, scope: Scope, name: string, bytes: Uint8Array<ArrayBuffer>, mayBorrowReserve?: () => boolean): Promise<void> {
  const reserve = backend.kind === "opfs" ? backend.reserve : undefined;
  const packed = backend.kind === "opfs" && scope === "manifests"
    ? await packManifest(backend.root, name, bytes) : undefined;
  const body = packed ?? bytes;
  const available = reserve === undefined && mayBorrowReserve === undefined ? undefined : await availableStorageBytes();
  if (available !== undefined) {
    // A pack's allocation can exceed the logical file that triggered a demand read.
    if (available < body.byteLength + DISK_RESERVE_BYTES && mayBorrowReserve?.() === false) {
      throw new VMError("QUOTA_EXCEEDED", "Insufficient space for optional image cache");
    }
    if (available <= body.byteLength) reserve?.release();
  }
  if (backend.kind === "indexeddb") {
    const database = await backend.database;
    await idbWrite(database, (store) => { store.put(bytes, key(scope, name)); });
    return;
  }
  const directory = await opfsDirectory(backend.root, packed === undefined ? scope : PACKED_MANIFESTS, true);
  const immutable = scope === "blobs" || scope === "packs";
  const persist = () => writeFile(directory, name, body, immutable);
  const commit = async () => {
    try { await persist(); }
    catch (error) {
      // Required image installations may borrow the reserve. On-demand reads can use verified transient bytes.
      if (!refusedWrite(error) || mayBorrowReserve?.() === false || reserve?.release() !== true) throw error;
      await persist();
    }
  };
  const locks = immutable && typeof navigator === "object" ? navigator.locks : undefined;
  if (locks === undefined) await commit();
  else await locks.request(`oxidevm-rootfs-body:${scope}:${name}`, { mode: "exclusive" }, commit);
}

async function packManifest(root: FileSystemDirectoryHandle, name: string,
  bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (bytes.length < MIN_PACKED_MANIFEST || bytes.length > MAX_ROOTFS_MANIFEST_BYTES
    || !/^[a-f0-9]{64}\.json$/u.test(name)
    || typeof CompressionStream !== "function") return undefined;
  try {
    await (await opfsDirectory(root, "manifests", false)).getFileHandle(name);
    // Keep the original cache path for a previously installed raw manifest.
    return undefined;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
  let encoded: Uint8Array<ArrayBuffer>;
  try {
    encoded = await readManagedBody(
      managedBodyStream(bytes).pipeThrough(new CompressionStream("gzip")), bytes.length - 5,
    );
  } catch {
    return undefined;
  }
  const body = new Uint8Array(4 + encoded.length);
  new DataView(body.buffer).setUint32(0, bytes.length, true);
  body.set(encoded, 4);
  return body;
}

async function writeFile(
  directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array<ArrayBuffer>, immutable: boolean,
): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  if (immutable && await tryWriteImmutableOpfsBody(file, bytes, "rootfs")) return;
  const writable = await file.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export async function remove(backend: Backend, scope: Scope, name: string): Promise<void> {
  if (backend.kind === "indexeddb") {
    const database = await backend.database;
    await idbWrite(database, (store) => { store.delete(key(scope, name)); });
    return;
  }
  const directory = await opfsDirectory(backend.root, scope, true);
  await directory.removeEntry(name).catch(() => undefined);
  if (scope === "manifests") {
    const packed = await opfsDirectory(backend.root, PACKED_MANIFESTS, true);
    await packed.removeEntry(name).catch(() => undefined);
  }
}

export async function opfsDirectory(root: FileSystemDirectoryHandle, scope: OpfsScope, create: boolean): Promise<FileSystemDirectoryHandle> {
  const base = await root.getDirectoryHandle("userspace-rootfs", { create });
  return scope === "root" ? base : base.getDirectoryHandle(scope, { create });
}

function key(scope: Scope, name: string): string {
  return `${scope}/${name}`;
}

/** `name` is the storage scope's `userspace-rootfs` database (storage-scope.ts). */
export function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB open failed"));
  });
}

function idbWrite(database: IDBDatabase, start: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("files", "readwrite");
    start(tx.objectStore("files"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new VMError("STORAGE_ERROR", "rootfs IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new VMError("ABORTED", "rootfs storage transaction aborted"));
  });
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
