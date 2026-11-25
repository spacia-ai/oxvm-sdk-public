import {startNativeCold, type NativeColdRuntime} from "./userspace-cold-start.js";
import type { SnapshotEventRecord } from "../protocol/snapshots.js";
import { VMError, serializeUnknownError } from "../errors.js";
import type { NativeCheckpointRequest, NativeCheckpointConfiguration } from "../protocol/userspace-checkpoints.js";
import { UserspaceSnapshotSession, type NativeSnapshotRuntime } from "./userspace-snapshot-session.js";
import { SnapshotStorageClient } from "./snapshot-channel.js";
import type { ImageAcquisitionReason } from "../protocol/image-preparation.js";

/** Lifecycle requests share one transaction owner; execution supplies the concrete host cut. */
export class UserspaceWorkerCheckpoints {
  readonly #storage: SnapshotStorageClient;
  readonly #configure: (configuration: NativeCheckpointConfiguration, signal: AbortSignal) => Promise<NativeSnapshotRuntime & NativeColdRuntime>;
  readonly #notify: (event: SnapshotEventRecord) => void;
  readonly #flush: () => Promise<void>;
  #state: { readonly kind: "new" | "configuring" } | { readonly kind: "ready"; readonly session: UserspaceSnapshotSession; readonly runtime: NativeColdRuntime } = { kind: "new" };
  constructor(storagePort: MessagePort, configure: (configuration: NativeCheckpointConfiguration, signal: AbortSignal) => Promise<NativeSnapshotRuntime & NativeColdRuntime>, flush: () => Promise<void>, notify: (event: SnapshotEventRecord) => void) {
    this.#storage = new SnapshotStorageClient(storagePort); this.#configure = configure; this.#flush = flush; this.#notify = notify;
  }
  async handle(request: NativeCheckpointRequest, signal: AbortSignal): Promise<unknown> {
    active(signal);
    if (request.type === "configure") {
      if (this.#state.kind !== "new") throw new VMError("PROTOCOL_ERROR", "Native checkpoint session already configured");
      this.#state = { kind: "configuring" };
      try {
        const runtime = await this.#configure(request, signal);
        active(signal);
        this.#state = { kind: "ready", runtime, session: new UserspaceSnapshotSession(runtime, this.#storage, this.#notify) };
        return undefined;
      } catch (error) { this.#state = { kind: "new" }; throw error; }
    }
    // A fresh install acts on the storage owner's authenticated selection. It can finish before the Rust mount exists.
    if (request.type === "prepare-image" && request.reason === "first-install") return this.#prepareImage(request.reason, signal);
    if (this.#state.kind !== "ready") throw new VMError("PROTOCOL_ERROR", "Native checkpoint session is not configured");
    const session = this.#state.session;
    switch (request.type) {
      case "cold-start": return startNativeCold(this.#state.runtime,this.#storage,request.sourceId,signal);
      case "capture": return session.capture({ kind: request.kind, ...(request.label === undefined ? {} : { label: request.label }), signal });
      case "restore": return session.restore(request.snapshot, { signal, ...(request.startup===undefined?{}:{startup:request.startup}), ...(request.replacedId === undefined ? {} : { replacedId: request.replacedId }),...(request.initialStart===undefined?{}:{initialStart:request.initialStart}) });
      case "dirty": return session.dirty();
      case "app-data": session.setAppData(request.data); return undefined;
      case "prepare-image": return this.#prepareImage(request.reason ?? "automatic", signal);
      case "collect": await this.#storage.request({type:"reclaim-native-cache"},[],signal);await this.#storage.request({ type: "collect" }, [], signal); return undefined;
      case "flush": await this.#flush(); return undefined;
    }
  }
  async #prepareImage(reason: ImageAcquisitionReason, signal: AbortSignal): Promise<void> {
    let last = 0;
    try {
      await this.#storage.request({ type: "prepare-native-image", reason }, [], signal, progress => {
        const now = performance.now();
        if (last === 0 || now - last >= 100 || progress.completedBytes === progress.totalBytes) {
          last = now;
          this.#notify({ type: "image-preparation-progress", ...progress });
        }
      });
      active(signal);
      this.#notify({ type: "image-prepared" });
    } catch (error) {
      if (!signal.aborted) this.#notify({ type: "image-preparation-failed", error: serializeUnknownError(error) });
      throw error;
    }
  }
  close(): void { this.#storage.close(); }
}

function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Native checkpoint request cancelled"); }
