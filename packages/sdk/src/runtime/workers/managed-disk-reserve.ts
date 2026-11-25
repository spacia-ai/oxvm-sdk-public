import { normalizeStorageError } from "../errors.js";
import { availableStorageBytes, refusedForSpace } from "./browser-quota.js";
export { DISK_RESERVE_BYTES, refusedForSpace } from "./browser-quota.js";
const FILE = "space.reserve";

/**
 * A file that holds storage for a disk generation while the origin has room for it, so restore
 * points cannot take the last of the space the guest's disk writes need. The first disk write the
 * browser refuses for lack of space releases it and runs again, while saves, refused too, pause
 * as "Storage full"; the reserve is taken back once space returns. Chromium keeps an open sync
 * access handle's storage counted until the handle closes, so the reserve holds its storage
 * through an open handle and releases it by emptying and closing the file.
 */
export class SpaceReserve {
  readonly #file: FileSystemFileHandle;
  readonly #bytes: number;
  /** Open while the reserve holds its storage. */
  #handle: FileSystemSyncAccessHandle | undefined;
  #closed = false;

  private constructor(file: FileSystemFileHandle, bytes: number) {
    this.#file = file;
    this.#bytes = bytes;
  }

  /** Opens the reserve in `directory` and holds it if there is room; none when `bytes` is 0. */
  static async open(directory: FileSystemDirectoryHandle, bytes: number, holdImmediately = true): Promise<SpaceReserve | undefined> {
    if (bytes === 0) return undefined;
    const reserve = new SpaceReserve(await directory.getFileHandle(FILE, { create: true }), bytes);
    if (holdImmediately) await reserve.hold();
    return reserve;
  }

  /** Holds the reserve again when the origin has room for it; whether it holds it now. */
  async hold(): Promise<boolean> {
    if (this.#isClosed()) return false;
    if (this.#handle !== undefined) return true;
    // A sync handle can reserve more capacity than the file's logical length.
    if ((await availableStorageBytes() ?? Infinity) < 2 * this.#bytes) return false;
    const handle = await this.#file.createSyncAccessHandle();
    // A disk closed meanwhile holds no reserve.
    if (this.#isClosed()) {
      handle.close();
      return false;
    }
    try {
      handle.truncate(this.#bytes);
      handle.flush();
    } catch (error) {
      handle.close();
      if (refusedForSpace(error)) return false;
      throw normalizeStorageError(error);
    }
    this.#handle = handle;
    return true;
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  /** Gives the reserve's storage back to the origin; false when it held none. */
  release(): boolean {
    const handle = this.#handle;
    if (handle === undefined) return false;
    this.#handle = undefined;
    try {
      handle.truncate(0);
      handle.flush();
    } finally {
      handle.close();
    }
    return true;
  }

  /** Releases the reserve, so a closed generation holds none. */
  close(): void {
    this.#closed = true;
    this.release();
  }
}
