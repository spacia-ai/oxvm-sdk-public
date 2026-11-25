import type { AssistanceBinding } from "../protocol/assistance.js";
import { VMError } from "../errors.js";
import { integer } from "../decode.js";
import { decodeRootRebaseSource, decodeRootRebaseStep, encodeRootRebaseSource } from "../userspace-root-rebase-abi.js";
import type { NativeRootRead } from "./native-cold-files.js";
import type { SnapshotStorageClient } from "./snapshot-channel.js";
import { decodeUserspaceRootExport } from "../userspace-persistence-abi.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "./userspace-exports.js";
import { readFileRecord } from "./userspace-files.js";
import type { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { createUserspaceWorkspaceCommit } from "./userspace-workspace-commit.js";
import { transferWorkspaceStream } from "./workspace-transfer.js";

interface Runtime { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }

/** Rust owns revisions, cursor retirement and execution admission. This adapter
 * only moves bounded frames to the storage worker and returns its actual outcome. */
export class UserspaceRootPersistence {
  readonly #runtime: Runtime;
  readonly #storage: UserspaceStorageClient;
  readonly #identity: string;
  readonly #wake: () => void;
  #publication: { binding: AssistanceBinding; bound: boolean; transfer: number; owner: UserspaceRootPersistence }
    = { binding: { session: crypto.randomUUID(), generation: 1 }, bound: false, transfer: 0, owner: this };
  #rebind = false;
  #configured = false;
  readonly #traffic = new AssistanceTraffic();
  readonly #queue;

  constructor(runtime: Runtime, storage: UserspaceStorageClient, identity: string,
    wake: () => void, failed: (error: unknown) => void) {
    this.#runtime = runtime; this.#storage = storage; this.#identity = identity; this.#wake = wake;
    this.#queue = createUserspaceWorkspaceCommit(() => this.#persist(), failed);
  }

  /** Keep the channel's acknowledged binding across consecutive unpublished replacements.
   * Selecting its next generation never replays files into the restored native tree. */
  restored(runtime: Runtime, identity: string, wake: () => void,
    failed: (error: unknown) => void): UserspaceRootPersistence {
    const next = new UserspaceRootPersistence(runtime, this.#storage, identity, wake, failed);
    next.#publication = this.#publication;
    next.#publication.owner = next;
    next.#rebind = true;
    next.#configured = true;
    return next;
  }

  configure(): void {
    this.#assertOwner();
    if(this.#configured)return;
    if (!/^[0-9a-f]{64}$/u.test(this.#identity)) throw new VMError("PROTOCOL_ERROR", "Root persistence requires an exact rootfs identity");
    const digest = Uint8Array.from(this.#identity.match(/../gu) ?? [], pair => Number.parseInt(pair, 16));
    this.#stage(digest);
    this.#ok("configure_root_persistence");this.#configured=true;
  }

  remounted(runtime:Runtime,identity:string,wake:()=>void,failed:(error:unknown)=>void):UserspaceRootPersistence {
    const next=this.restored(runtime,identity,wake,failed);next.#configured=false;return next;
  }

  async initialize(signal = new AbortController().signal): Promise<void> {
    this.#active(signal);this.configure();await this.#bindRestored();this.#active(signal);
    const selected = await this.#storage.openRootOverlay(this.#identity, this.#publication.binding, signal);
    this.#publication.bound=true;
    if (selected === undefined) { this.#active(signal); return; }
    let id = 0n, retired = false;
    try {
      this.#active(signal);
      id = call64(this.#runtime.instance, "oxidevm_userspace_root_import_begin");
      if (id === 0n) throw new VMError("STORAGE_ERROR", "Native root restore could not start");
      let received = 0;
      for (;;) {
        const bytes = await this.#storage.readRootFrame(selected.id, received, signal);
        this.#active(signal);
        if (bytes === undefined) break;
        if (bytes.length === 0 || bytes.length > 65536 || bytes.length > selected.bytes - received) throw new VMError("PROTOCOL_ERROR", "Invalid root restore frame");
        this.#stage(bytes);
        this.#ok("root_import_feed", id, bytes.length);
        received += bytes.length;
      }
      if (received !== selected.bytes) throw new VMError("STORAGE_ERROR", "Root restore ended before its committed length");
      // Release immutable read handles before activating the recovered tree.
      await this.#storage.closeRootOverlay(selected.id);
      retired = true;
      this.#active(signal);
      this.#ok("root_import_complete", id);
    } catch (error) {
      let cleanupFailed = id !== 0n && call(this.#runtime.instance, "oxidevm_userspace_root_transfer_abort", id) !== 0;
      if (!retired) {
        try { await this.#storage.closeRootOverlay(selected.id); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new VMError("STORAGE_ERROR", "Root restoration retirement is uncertain", { cleanupFailed: true });
      throw error;
    }
  }

  /** Runs before the cold candidate can spawn. Storage selects its new root only
   * when the surrounding workspace and image publication commits. */
  async rebase(sourceId: string, client: Pick<SnapshotStorageClient, "request">, signal: AbortSignal): Promise<void> {
    this.#active(signal);
    const source = decodeRootRebaseSource(await client.request({ type: "inspect-native-cold-root", sourceId }, [], signal));
    if (source === undefined) return;
    if (source.rootTreeSha256 === this.#identity) throw new VMError("PROTOCOL_ERROR", "System-file update selected its own prior image");
    this.#stage(encodeRootRebaseSource(source));
    const id = call64(this.#runtime.instance, "oxidevm_userspace_root_rebase_begin", 40 + source.metadata.length);
    if (id === 0n) throw new VMError("STORAGE_ERROR", "Native system-file update could not start");
    try {
      await this.#feedRebase({ kind: "native-root", id: sourceId }, source.rootTreeSha256, "root_import_feed", id, signal);
      this.#ok("root_rebase_prepare", id);
      for (;;) {
        this.#active(signal);
        this.#ok("root_rebase_next", id);
        const step = decodeRootRebaseStep(readFileRecord(this.#runtime));
        if (step.kind === "ready") break;
        if (step.kind === "shadowed") throw new VMError("NATIVE_UTILITY_MISMATCH", "A persistent file shadows a managed Rust utility", {
          reason: "path-shadowed", path: step.path,
        });
        if (step.kind === "conflict") throw new VMError("STORAGE_ERROR", "Both images have persistent edits at the same path", {
          reason: "system-file-conflict", path: step.path,
        });
        const file = { path: step.path, bytes: step.bytes, sha256: step.sha256 };
        await this.#feedRebase({ kind: "native-root", id: sourceId, file }, source.rootTreeSha256, "root_rebase_file", id, signal);
      }
      this.#ok("root_rebase_complete", id);
    } catch (error) { this.#ok("root_transfer_abort", id); throw error; }
    await this.#export({ session: sourceId, generation: 1 }, 1, async ({ descriptor, transfer }) => {
      integer(await client.request({ type: "stage-native-cold-root", sourceId, input: descriptor }, transfer, signal),
        "staged system-file generation", 1);
    });
  }

  async #feedRebase(selection: NativeRootRead, base: string, operation: "root_import_feed" | "root_rebase_file",
    id: bigint, signal: AbortSignal): Promise<void> {
    const read = await this.#storage.workspaceTransfers.read(base, signal, selection);
    try {
      const input = read.selection?.snapshot;
      if (input === undefined || (read.selection?.delta?.bytes ?? 0) !== 0 || read.selection?.dependencies !== undefined
        || (selection.file === undefined ? input.bytes === 0 || read.selection?.workspaceBaseSha256 !== base : input.bytes !== selection.file.bytes)) {
        throw new VMError("STORAGE_ERROR", "Verified system-file update stream differs from its requested source");
      }
      const producer = input.source(signal);
      try {
        if (input.bytes === 0) {
          this.#stage(new Uint8Array());
          this.#ok(operation, id, 0);
        } else {
          let received = 0;
          for await (const frame of producer.frames) {
            this.#active(signal);
            this.#stage(frame);
            this.#ok(operation, id, frame.length);
            received += frame.length;
          }
          if (received !== input.bytes) throw new VMError("STORAGE_ERROR", "Verified system-file update stream ended early");
        }
      } finally { await producer.retire(); }
    } finally { await read.retire(); }
  }

  schedule(): Promise<void> { return this.#queue.schedule(); }
  flush(): Promise<void> { return this.#queue.flush(); }

  async #persist(): Promise<void> {
    this.#assertOwner();
    await this.#bindRestored();
    const instance = this.#runtime.instance;
    const revision = call64(instance, "oxidevm_userspace_root_revision");
    if (revision === 0xffff_ffff_ffff_ffffn) throw new VMError("STORAGE_ERROR", "Root revision is exhausted or unavailable");
    if (revision === call64(instance, "oxidevm_userspace_root_published_revision")) return;
    if (this.#publication.transfer === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Root transfer sequence exhausted");
    await this.#export(this.#publication.binding, ++this.#publication.transfer, async ({ descriptor }) => {
      await this.#storage.commitRootOverlay(this.#identity, descriptor);
    });
  }

  async #export(binding: AssistanceBinding, sequence: number,
    publish: (transfer: ReturnType<typeof transferWorkspaceStream>) => Promise<void>): Promise<void> {
    this.#ok("root_export_begin");
    const exported = decodeUserspaceRootExport(readFileRecord(this.#runtime));
    let retired = false;
    const retire = async (): Promise<void> => {
      if (!retired) {
        this.#ok("root_export_retire", exported.id);
        retired = true;
        this.#wake();
      }
      await Promise.resolve();
    };
    let transferred: ReturnType<typeof transferWorkspaceStream> | undefined;
    try {
      transferred = transferWorkspaceStream({ bytes: exported.bytes, source: signal => ({
        frames: (async function* (owner: UserspaceRootPersistence) {
          while (!retired && !signal.aborted) {
            owner.#ok("root_export_next", exported.id);
            const bytes = readFileRecord(owner.#runtime);
            if (bytes.length === 0) return;
            if (bytes.length > 65536) throw new VMError("PROTOCOL_ERROR", "Native root export frame exceeds its bound");
            yield await Promise.resolve(bytes);
          }
        })(this), retire,
      }) }, binding, sequence, this.#traffic);
      await publish(transferred);
      await transferred.finished;
      this.#ok("root_export_complete", exported.id, 1);
    } catch (error) {
      await retire();
      this.#ok("root_export_complete", exported.id, 0);
      throw error;
    }
  }

  async #bindRestored(): Promise<void> {
    if (!this.#rebind) return;
    const previous = this.#publication.binding;
    if (this.#publication.bound && previous.generation === 0xffff_ffff) throw new VMError("QUOTA_EXCEEDED", "Root binding generation exhausted");
    const binding = this.#publication.bound ? { ...previous, generation: previous.generation + 1 } : previous;
    const selected = await this.#storage.openRootOverlay(this.#identity, binding, undefined, this.#publication.bound ? previous : undefined);
    // The settled storage response is the authority, even if closing its read fails.
    this.#publication.binding = binding;
    this.#publication.bound = true;
    this.#publication.transfer = 0;
    this.#rebind = false;
    if (selected !== undefined) await this.#storage.closeRootOverlay(selected.id);
  }

  #stage(bytes: Uint8Array): void {
    this.#ok("staging_resize", bytes.length);
    const pointer = call(this.#runtime.instance, "oxidevm_userspace_staging_ptr");
    if (pointer + bytes.length > this.#runtime.memory.buffer.byteLength) throw new VMError("PROTOCOL_ERROR", "Root staging lies outside Wasm memory");
    new Uint8Array(this.#runtime.memory.buffer, pointer, bytes.length).set(bytes);
  }

  #assertOwner(): void {
    if (this.#publication.owner !== this) throw new VMError("ABORTED", "Root producer was replaced");
  }

  #active(signal: AbortSignal): void {
    this.#assertOwner();
    if (signal.aborted) throw new VMError("ABORTED", "Root persistence cancelled");
  }

  #ok(name: string, ...args: readonly (number | bigint)[]): void {
    const status = call(this.#runtime.instance, `oxidevm_userspace_${name}`, ...args);
    if (status !== 0) throw new VMError(status === 3 ? "QUOTA_EXCEEDED" : "STORAGE_ERROR", `Native root persistence ${name} failed (${String(status)})`);
  }
}
