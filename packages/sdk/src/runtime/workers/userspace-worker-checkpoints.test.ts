import { afterEach, expect, it } from "vitest";
import { VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import type { NativeCheckpointRequest } from "../protocol/userspace-checkpoints.js";
import type { NativeSnapshotRuntime } from "./userspace-snapshot-session.js";
import type {NativeColdRuntime} from "./userspace-cold-start.js";
import { UserspaceWorkerCheckpoints } from "./userspace-worker-checkpoints.js";
import { decodeSnapshotStorageRequest, snapshotStorageResponse } from "./snapshot-channel.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const configure: NativeCheckpointRequest = { id: 1, version: PROTOCOL_VERSION, type: "configure",
  mount: { rootTreeSha256: "a".repeat(64), workspaceBaseSha256: "b".repeat(64), cpuProfile: "x86-64-v2", rootfs: new Uint8Array() },
  destination: { manifestUrl: "https://example.invalid/rootfs.json", trusted: { keyId: "key", publicKey: new Uint8Array(32) } } };
function fixture(configure: ConstructorParameters<typeof UserspaceWorkerCheckpoints>[1], store?: (event: MessageEvent<unknown>, port: MessagePort) => void) {
  const channel = new MessageChannel();
  if (store !== undefined) channel.port2.onmessage = (event: MessageEvent<unknown>) => store(event, channel.port2);
  const owner = new UserspaceWorkerCheckpoints(channel.port1, configure, () => Promise.resolve(), () => {});
  cleanup.push(() => { owner.close(); channel.port2.close(); }); return owner;
}
it("installs the storage owner's selected image before the execution engine configures its mount", async () => {
  const requests: unknown[] = [];
  const owner = fixture(() => { throw new Error("configuration must wait"); }, (event, port) => {
    const { id, request } = decodeSnapshotStorageRequest(event.data);
    requests.push(request);
    port.postMessage(snapshotStorageResponse(id, undefined));
  });
  const signal = new AbortController().signal;
  await expect(owner.handle({ id: 2, version: PROTOCOL_VERSION, type: "prepare-image", reason: "repair" }, signal))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await owner.handle({ id: 3, version: PROTOCOL_VERSION, type: "prepare-image", reason: "first-install" }, signal);
  expect(requests).toEqual([expect.objectContaining({ type: "prepare-native-image", reason: "first-install" })]);
});
it("rejects checkpoint operations until configuration completes and never admits duplicate configuration", async () => {
  const pending = Promise.withResolvers<NativeSnapshotRuntime & NativeColdRuntime>();
  const owner = fixture(() => pending.promise), signal = new AbortController().signal;
  const configuring = owner.handle(configure, signal);
  const rejected = expect(configuring).rejects.toMatchObject({ code: "ABORTED" });
  await expect(owner.handle(configure, signal)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(owner.handle({ id: 2, version: PROTOCOL_VERSION, type: "dirty" }, signal)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  pending.reject(new VMError("ABORTED", "mount cancelled")); await rejected;
});
it("permits a new configuration after mount admission fails", async () => {
  let attempts = 0;
  const owner = fixture(() => { attempts++; return Promise.reject(new VMError("STORAGE_NOT_FOUND", "missing root")); });
  const signal = new AbortController().signal;
  await expect(owner.handle(configure, signal)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
  await expect(owner.handle(configure, signal)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
  expect(attempts).toBe(2);
});
