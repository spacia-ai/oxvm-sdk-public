import { VMError } from "../errors.js";
import type { ManagedBoot } from "../protocol/storage.js";
import type { WorkspacePublicationResult } from "../protocol/workspace-publication.js";
import { stageNativeWorkspace } from "./native-workspace-stage.js";
import type { PreviousRootfs, RootfsCheckpointOwner, RootfsStore } from "./rootfs-store.js";
import type { RootRebaseSource } from "../userspace-root-rebase-abi.js";
import type { WorkspaceReadRequest } from "../protocol/workspace-read.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import type { WorkspaceReadLease } from "./workspace-read.js";
import { openWorkspaceStreams, workspaceBytesInput, type WorkspaceStreams } from "./workspace-stream.js";
import { receiveWorkspaceStream } from "./workspace-transfer.js";
import type { NativeSnapshotStorageRequest } from "./snapshot-native-channel.js";
import type { PreparedNativeFiles } from "./snapshot-userspace-files.js";
import type { WorkspaceSelections } from "./workspace-selections.js";
import { decodeWorkspaceOverlayManifest, WorkspaceStore } from "./workspace-store.js";

/** What a cold start needs: the workspace's file selections and the verified image. No restore-point storage. */
export interface NativeColdEnvironment {
  readonly workspaceId: string;
  readonly selections: WorkspaceSelections;
  readonly rootfs: Pick<RootfsStore, "pinImage" | "releaseCheckpoint" | "currentRootfs" | "beginCheckpointVerification" | "previousRootfs">;
}
export interface NativeColdSelection { readonly boot: ManagedBoot; readonly rootTreeSha256: string; readonly rootPersistence: "ephemeral" | "persistent" }
export type NativeColdRequest = Extract<NativeSnapshotStorageRequest, { readonly type:
  "inspect-native-cold-root" | "stage-native-cold-root" | "stage-native-cold-workspace" | "publish-native-cold" | "complete-native-cold" }>;
export type NativeRootRead = Extract<NonNullable<WorkspaceReadRequest["selection"]>, { readonly kind: "native-root" }>;

type ColdCandidate = PreparedNativeFiles & {
  stageRoot(identity: string, streams: WorkspaceStreams, signal: AbortSignal): Promise<number>;
};

interface ColdFiles {
  readonly sourceId: string;
  readonly files: ColdCandidate;
  readonly base: string;
  staged: boolean;
  preserve: boolean;
  published: boolean;
  readonly rootMigration?: { readonly target: string; readonly previous: PreviousRootfs };
  rootStaged: boolean;
  imageUpdate?: { readonly image: string; readonly previous: string | undefined; readonly rootTreeSha256: string };
}

/**
 * A Userspace cold start: it selects the boot's files, retains them and publishes the reconciled pair through the
 * existing atomic selection. It needs only the workspace selections and the verified image, so it works on every
 * workspace backend, the IndexedDB fallback included; restore points are a separate owner.
 */
export class NativeColdFiles {
  readonly #environment: NativeColdEnvironment;
  #active: ColdFiles | undefined;
  #preparing: string | undefined;
  #selecting = false;
  constructor(environment: NativeColdEnvironment) { this.#environment = environment; }
  get busy(): boolean { return this.#active !== undefined || this.#preparing !== undefined || this.#selecting; }
  get retainedIds(): readonly string[] { return this.#active === undefined ? (this.#preparing===undefined?[]:[this.#preparing]) : [this.#active.sourceId, this.#active.files.id]; }

  get priorWorkspaceImage(): RootfsCheckpointOwner | undefined {
    const current = this.#active;
    if (current === undefined || current.staged || current.published) return undefined;
    const prior = current.imageUpdate?.previous;
    return prior === undefined ? undefined : this.#owner(prior);
  }

  /** Retains the boot files. An image update pins the candidate when it publishes the selection. */
  async select(request: NativeColdSelection, signal: AbortSignal): Promise<{ readonly sourceId: string; readonly replaced?: string }> {
    if (this.busy) invalid(); active(signal); this.#selecting = true;
    const { selections, rootfs } = this.#environment, image = crypto.randomUUID();
    const update = request.boot === "update-image";
    let retainPin = false;
    try {
      const previous = await selections.session();
      const candidate = rootfs.currentRootfs();
      if (candidate.rootTreeSha256 !== request.rootTreeSha256) throw new VMError("STORAGE_ERROR", "Cold-start image differs from its verified source");
      let result: { readonly replaced?: string } = {};
      if (!update) {
        await this.#pinImage(image, request.rootTreeSha256, signal);
        result = await selections.selectBoot(request.boot, request.rootTreeSha256, image, signal);
        retainPin = true;
        if (previous?.image !== undefined) await rootfs.releaseCheckpoint(this.#owner(previous.image)).catch(() => {});
      }
      const root = request.rootPersistence === "persistent" ? request.rootTreeSha256 : undefined;
      const oldRoot = update && root !== undefined && previous?.image !== undefined
        ? await rootfs.previousRootfs(this.#owner(previous.image)) : undefined;
      active(signal);
      this.#selecting = false;
      const sourceId = await this.begin(root, candidate.workspaceBaseSha256 ?? request.rootTreeSha256, signal, oldRoot);
      if (update) this.#require(sourceId).imageUpdate = { image, previous: previous?.image, rootTreeSha256: candidate.rootTreeSha256 };
      return { ...result, sourceId };
    } finally {
      this.#selecting = false;
      if (!update && !retainPin) await rootfs.releaseCheckpoint(this.#owner(image));
    }
  }

  async #pinImage(image: string, rootTreeSha256: string, signal: AbortSignal): Promise<void> {
    const rootfs = this.#environment.rootfs;
    const retire = await rootfs.beginCheckpointVerification(signal);
    try {
      const saved = await rootfs.pinImage(this.#owner(image));
      active(signal);
      if (saved.rootfs.rootTreeSha256 !== rootTreeSha256) throw new VMError("STORAGE_ERROR", "Cold-start image differs from its verified source");
    } finally { retire(); }
  }

  async begin(root: string | undefined, base: string, signal: AbortSignal, previous?: PreviousRootfs): Promise<string> {
    if (this.busy) invalid();
    const sourceId = crypto.randomUUID();
    this.#preparing=sourceId;
    try {
      const oldRoot = previous !== undefined && root !== undefined && previous.rootTreeSha256 !== root ? previous.rootTreeSha256 : undefined;
      const selections = this.#environment.selections;
      await selections.retain(sourceId, root, oldRoot);
      let rootMigration: ColdFiles["rootMigration"];
      if (oldRoot !== undefined && root !== undefined && previous !== undefined) {
        const saved = await selections.retainedRoot(sourceId, oldRoot, signal);
        if (saved !== undefined) {
          try {
            if (saved.snapshot === undefined || saved.snapshot.bytes === 0 || (saved.delta?.bytes ?? 0) !== 0 || saved.dependencies !== undefined) {
              throw new VMError("STORAGE_ERROR", "Prior system-file generation is invalid");
            }
            rootMigration = { target: root, previous };
          } finally { await saved.retire(); }
        }
      }
      const files = await this.#prepare(sourceId, root, signal);
      this.#active = { sourceId, files, base, staged: false, preserve: false, published: false, rootStaged: false,
        ...(rootMigration === undefined ? {} : { rootMigration }) };
      return sourceId;
    } catch (error) { await this.#environment.selections.release(sourceId); throw error; }
    finally {this.#preparing=undefined;}
  }

  async rootRead(selection: NativeRootRead, base: string, signal: AbortSignal): Promise<WorkspaceReadLease | undefined> {
    const current = this.#require(selection.id), previous = current.rootMigration?.previous;
    if (current.published || current.rootStaged || previous?.rootTreeSha256 !== base) return invalid();
    const file = selection.file;
    return file === undefined ? this.#environment.selections.retainedRoot(selection.id, base, signal)
      : previous.openFile(file.path, file.sha256, file.bytes, signal);
  }

  handle(request: NativeColdRequest, signal: AbortSignal): Promise<WorkspacePublicationResult | RootRebaseSource | number | undefined> {
    switch (request.type) {
      case "inspect-native-cold-root": {
        const current = this.#require(request.sourceId), previous = current.rootMigration?.previous;
        if (current.published || current.rootStaged) return invalid();
        return Promise.resolve(previous === undefined ? undefined : {
          rootTreeSha256: previous.rootTreeSha256, metadata: previous.metadata,
        });
      }
      case "stage-native-cold-root": return this.#stageRoot(request, signal);
      case "stage-native-cold-workspace": return this.#stage(request, signal);
      case "publish-native-cold": return this.publish(request.sourceId, signal).then(() => undefined);
      case "complete-native-cold": return this.complete(request.sourceId).then(() => undefined);
    }
  }

  files(sourceId: string, base: string): PreparedNativeFiles {
    const current = this.#require(sourceId); if(current.base!==base)invalid(); if (current.published || current.staged) invalid(); return current.files;
  }
  staged(sourceId: string, preserve: boolean): void {
    const current = this.#require(sourceId); if (current.published || current.staged) invalid(); current.staged = true; current.preserve = preserve;
  }
  async publish(sourceId: string, signal: AbortSignal): Promise<void> {
    const current = this.#require(sourceId); if (!current.staged || current.published) invalid();
    if (current.rootMigration !== undefined && !current.rootStaged) return invalid();
    const image = current.imageUpdate;
    if (image !== undefined) await this.#pinImage(image.image, image.rootTreeSha256, signal);
    const session = image === undefined ? undefined : { image: image.image, resume: null };
    await current.files.commit(signal, session, current.preserve ? sourceId : undefined);
    current.published = true;
    if (image?.previous !== undefined) {
      await this.#environment.rootfs.releaseCheckpoint(this.#owner(image.previous)).catch(() => {});
    }
  }
  async complete(sourceId: string): Promise<void> {
    const current = this.#require(sourceId); if (!current.published) invalid();
    this.#active = undefined;
    await this.#environment.selections.release(current.sourceId);
  }
  async abort(sourceId?:string): Promise<void> {
    const current = this.#active; if (current === undefined) return;
    if(sourceId!==undefined&&sourceId!==current.sourceId)invalid();
    // Once the pair committed, a later native publication error cannot uncommit durable files.
    if (!current.published) {
      await current.files.abort();
      const image = current.imageUpdate?.image;
      if (image !== undefined && (await this.#environment.selections.session())?.image !== image) {
        await this.#environment.rootfs.releaseCheckpoint(this.#owner(image));
      }
    }
    await this.#environment.selections.release(current.sourceId);
    this.#active = undefined;
  }

  async #stageRoot(request: Extract<NativeColdRequest, { readonly type: "stage-native-cold-root" }>, signal: AbortSignal): Promise<number> {
    const input = request.input;
    const snapshot = receiveWorkspaceStream(input, input.binding, input.transfer);
    const opened = await openWorkspaceStreams({ snapshot, delta: workspaceBytesInput(new Uint8Array()) }, signal);
    try {
      const current = this.#require(request.sourceId), target = current.rootMigration?.target;
      if (target === undefined || current.published || current.rootStaged || input.bytes === 0
        || input.binding.session !== request.sourceId || input.binding.generation !== 1 || input.transfer !== 1) return invalid();
      const generation = await current.files.stageRoot(target, opened.streams, signal);
      current.rootStaged = true;
      return generation;
    } finally { await opened.retire(); }
  }

  async #stage(request: Extract<NativeColdRequest, { readonly type: "stage-native-cold-workspace" }>, signal: AbortSignal): Promise<WorkspacePublicationResult> {
    const result = await stageNativeWorkspace(() => this.files(request.sourceId, request.publication.workspaceBaseSha256), request.publication, signal);
    if (result.retired && result.outcome.kind === "committed") this.staged(request.sourceId, request.preserve);
    return result;
  }

  /** Uses the retained cold selection; no checkpoint catalogue or image closure is synthesized. */
  async #prepare(id: string, root: string | undefined, signal: AbortSignal): Promise<ColdCandidate> {
    active(signal); await this.#environment.selections.validate(id, signal);
    const candidate = crypto.randomUUID(), stage = await this.#environment.selections.stage(candidate, root, id);
    return { ...stage, id: candidate,
      stageRoot: async (identity, streams, signal) => {
        if (root !== identity) return invalid();
        return (await openUserspaceRootStore(stage.backend, identity)).commitStreams(identity, streams, signal);
      },
      stageWorkspace: async (base, streams, signal) => {
      // The original foreign generation remains pinned by id. Only the private
      // candidate's workspace scope changes base; its selected root stays intact.
      const encoded = await stage.backend.read("active.json", 128 * 1024, signal);
      if (encoded !== undefined && coldWorkspaceBase(encoded) !== base) {
        await stage.backend.remove("active.json");
      }
      return new WorkspaceStore(stage.backend).commitStreams(base, streams, signal);
    } };
  }
  #owner(snapshotId: string) { return { workspaceId: this.#environment.workspaceId, snapshotId }; }
  #require(sourceId: string): ColdFiles { if (this.#active?.sourceId !== sourceId) invalid(); return this.#active; }
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Cold file selection is not in the requested phase"); }
function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Native file selection cancelled"); }

function coldWorkspaceBase(bytes:Uint8Array):string {
  try {return decodeWorkspaceOverlayManifest(JSON.parse(new TextDecoder().decode(bytes))).workspaceBaseSha256;}
  catch {throw new VMError("STORAGE_ERROR","Cold workspace metadata is damaged");}
}
