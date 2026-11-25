import { expect, it, vi } from "vitest";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import { NativeColdFiles, type NativeColdEnvironment } from "./native-cold-files.js";
import { AssistanceTraffic } from "./control/assistance-traffic.js";
import { transferWorkspaceStream } from "./workspace-transfer.js";
import { WorkspaceSelections } from "./workspace-selections.js";
import { WorkspaceStore } from "./workspace-store.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { workspaceBytesInput } from "./workspace-stream.js";
const BASE = "a".repeat(64), NEXT = "b".repeat(64);
const signal = () => new AbortController().signal;
const streams = (value: number) => ({ snapshot: workspaceBytesInput(new Uint8Array([value])), delta: workspaceBytesInput(new Uint8Array()) });

/** The verified image a cold start pins; the cold start has no restore-point storage at all. */
function verifiedImage(rootTreeSha256: string, workspaceBaseSha256: string) {
  const pins = new Set<string>(), rootfs = { origin: "managed", image: { id: "alpine", version: "v1" }, rootTreeSha256, manifest: { sha256: "c".repeat(64), bytes: 1 } } as const;
  const image: NativeColdEnvironment["rootfs"] = {
    pinImage: owner => { pins.add(owner.snapshotId); return Promise.resolve({ rootfs, manifest: new Uint8Array([1]) }); },
    releaseCheckpoint: owner => { pins.delete(owner.snapshotId); return Promise.resolve(); },
    currentRootfs: () => ({ id: "alpine", version: "v1", cpuProfile: "x86-64-v2", rootTreeSha256, workspaceBaseSha256, fileCount: 0, totalBytes: 0, metadata: new Uint8Array(), runtimes: { supportingFiles: [] } }),
    beginCheckpointVerification: () => Promise.resolve(() => undefined),
    previousRootfs: () => Promise.resolve({ rootTreeSha256: BASE, metadata: new Uint8Array(12),
      openFile: () => Promise.reject(new Error("Unexpected need for a prior immutable blob")) }),
  };
  return { image, pins };
}

async function fixture() {
  const backend = opfsWorkspaceStoreBackend(new MemoryDirectory()), selections = new WorkspaceSelections(backend);
  await new WorkspaceStore(selections.backend).commitStreams(BASE, streams(1), signal());
  const { image, pins } = verifiedImage(NEXT, NEXT);
  return { backend, selections, pins, image, cold: new NativeColdFiles({ workspaceId: "test", selections, rootfs: image }) };
}

it("cold-starts from the workspace selections and the verified image alone, with no restore-point storage", async () => {
  const f = await fixture();
  const { sourceId } = await f.cold.select({ boot: "live", rootTreeSha256: NEXT, rootPersistence: "ephemeral" }, signal());
  const session = await f.selections.session();
  expect(f.cold.priorWorkspaceImage).toBeUndefined();
  expect(session?.image).toMatch(/^[0-9a-f-]{36}$/u);
  expect([...f.pins]).toEqual([session?.image]);
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(4), signal());
  f.cold.staged(sourceId, false);
  await f.cold.handle({ type: "publish-native-cold", sourceId }, signal());
  await f.cold.handle({ type: "complete-native-cold", sourceId }, signal());
  expect(await new WorkspaceStore(new WorkspaceSelections(f.backend).backend).read(NEXT)).toEqual(new Uint8Array([4]));
  expect(f.cold.busy).toBe(false);
});

it("refuses a cold start whose verified image differs and leaves no image pin", async () => {
  const f = await fixture();
  await expect(f.cold.select({ boot: "live", rootTreeSha256: BASE, rootPersistence: "ephemeral" }, signal())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(f.pins.size).toBe(0);
  expect(f.cold.busy).toBe(false);
});

it("keeps the last usable image and files pinned when a managed update aborts before publication", async () => {
  const f = await fixture(), image = crypto.randomUUID(), resume = crypto.randomUUID();
  const previous = { image, resume };
  f.pins.add(image);
  await f.selections.setSession(previous);
  const { sourceId } = await f.cold.select({ boot: "update-image", rootTreeSha256: NEXT, rootPersistence: "persistent" }, signal());
  expect(await new WorkspaceSelections(f.backend).session()).toEqual(previous);
  expect(f.cold.priorWorkspaceImage).toEqual({ workspaceId: "test", snapshotId: image });
  expect(f.pins.has(image)).toBe(true);
  expect([...f.pins]).toEqual([image]);

  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(6), signal());
  f.cold.staged(sourceId, false);
  expect(f.cold.priorWorkspaceImage).toBeUndefined();
  await f.cold.abort(sourceId);
  expect(f.cold.priorWorkspaceImage).toBeUndefined();
  const reopened = new WorkspaceSelections(f.backend);
  expect(await reopened.session()).toEqual(previous);
  expect([...f.pins]).toEqual([image]);
  expect(await new WorkspaceStore(reopened.backend).read(BASE)).toEqual(new Uint8Array([1]));
  expect(f.cold.busy).toBe(false);
});

it("holds the cold-selection slot while authenticating the previous image", async () => {
  const f = await fixture(), image = crypto.randomUUID();
  f.pins.add(image);
  await f.selections.setSession({ image, resume: null });
  const reading = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>();
  const previousRootfs = f.image.previousRootfs;
  vi.spyOn(f.image, "previousRootfs").mockImplementationOnce(async owner => {
    reading.resolve(undefined);
    await resume.promise;
    return previousRootfs(owner);
  });
  const pending = f.cold.select({ boot: "update-image", rootTreeSha256: NEXT, rootPersistence: "persistent" }, signal());
  await reading.promise;
  const busy = f.cold.busy;
  resume.resolve(undefined);
  await f.cold.abort((await pending).sourceId);
  expect(busy).toBe(true);
  expect([...f.pins]).toEqual([image]);
});

it("commits an updated image and its reconciled workspace at the same selection write", async () => {
  const f = await fixture(), image = crypto.randomUUID();
  f.pins.add(image);
  await f.selections.setSession({ resume: null, image });
  const { sourceId } = await f.cold.select({ boot: "update-image", rootTreeSha256: NEXT, rootPersistence: "ephemeral" }, signal());
  expect([...f.pins]).toEqual([image]);
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(7), signal());
  f.cold.staged(sourceId, false);
  await f.cold.publish(sourceId, signal());
  const reopened = new WorkspaceSelections(f.backend);
  const next = [...f.pins].find(pin => pin !== image);
  expect(next).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await reopened.session()).toEqual({ resume: null, image: next });
  expect(await new WorkspaceStore(reopened.backend).read(NEXT)).toEqual(new Uint8Array([7]));
  expect([...f.pins]).toEqual([next]);
  await f.cold.complete(sourceId);
});

it("checks an update before it needs storage for a new image pin", async () => {
  const f = await fixture(), image = crypto.randomUUID();
  f.pins.add(image);
  await f.selections.setSession({ resume: null, image });
  const pin = vi.spyOn(f.image, "pinImage").mockRejectedValue(new DOMException("Image pin exceeds quota", "QuotaExceededError"));
  const { sourceId } = await f.cold.select({ boot: "update-image", rootTreeSha256: NEXT, rootPersistence: "ephemeral" }, signal());
  expect(pin).not.toHaveBeenCalled();
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(7), signal());
  f.cold.staged(sourceId, false);
  await expect(f.cold.publish(sourceId, signal())).rejects.toMatchObject({ name: "QuotaExceededError" });
  await f.cold.abort(sourceId);
  expect(await f.selections.session()).toEqual({ resume: null, image });
  expect([...f.pins]).toEqual([image]);
});

it("keeps the previous selection after a managed update cannot write its new head", async () => {
  const f = await fixture(), image = crypto.randomUUID();
  f.pins.add(image);
  await f.selections.setSession({ resume: null, image });
  const { sourceId } = await f.cold.select({ boot: "update-image", rootTreeSha256: NEXT, rootPersistence: "ephemeral" }, signal());
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(9), signal());
  f.cold.staged(sourceId, false);
  const write = f.backend.write.bind(f.backend);
  const failure = vi.spyOn(f.backend, "write").mockImplementation((path, bytes) => {
    if (path === "selections/head.json") return Promise.reject(new Error("Cannot commit selected files"));
    return write(path, bytes);
  });
  await expect(f.cold.publish(sourceId, signal())).rejects.toThrow("Cannot commit selected files");
  failure.mockRestore();
  await f.cold.abort(sourceId);
  const reopened = new WorkspaceSelections(f.backend);
  expect(await reopened.session()).toEqual({ resume: null, image });
  expect(await new WorkspaceStore(reopened.backend).read(BASE)).toEqual(new Uint8Array([1]));
  expect([...f.pins]).toEqual([image]);
});
it("retains a foreign cold source and publishes its reconciled stream only at the selected commit", async () => {
  const f = await fixture(), sourceId = await f.cold.begin(undefined, NEXT, signal());
  expect(f.cold.busy).toBe(true);
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(2), signal());
  f.cold.staged(sourceId, true);
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
  await f.cold.publish(sourceId, signal());
  const reopened = new WorkspaceSelections(f.backend);
  expect(await new WorkspaceStore(reopened.backend).read(NEXT)).toEqual(new Uint8Array([2]));
  await f.cold.complete(sourceId);
  expect(await reopened.isPreserved(sourceId)).toBe(true);
  const lease = await reopened.retainedWorkspace(sourceId, signal(), BASE);
  expect(lease?.snapshot?.bytes).toBe(1); await lease?.retire();
  expect(f.cold.busy).toBe(false);
});
it("refuses stale cold tokens and discards only the unpublished candidate on failure", async () => {
  const f = await fixture(), sourceId = await f.cold.begin(undefined, NEXT, signal());
  expect(() => f.cold.files(crypto.randomUUID(), NEXT)).toThrow();
  await expect(f.cold.publish(sourceId, signal())).rejects.toThrow();
  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(2), signal());
  await f.cold.abort();
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
  expect(await f.selections.has(sourceId)).toBe(false);
  expect(f.cold.busy).toBe(false);
});

it("reserves source reachability before asynchronous preparation and rejects another begin",async()=>{
 const f=await fixture(),pending=f.cold.begin(undefined,NEXT,signal());
 expect(f.cold.busy).toBe(true);expect(f.cold.retainedIds).toHaveLength(1);
 await expect(f.cold.begin(undefined,NEXT,signal())).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
 const id=await pending;await f.selections.collect(new Set(f.cold.retainedIds));
 expect(await f.selections.has(id)).toBe(true);await f.cold.abort(id);
});
it("keeps a committed cold selection and preserved source after later native publication failure",async()=>{
 const f=await fixture(),id=await f.cold.begin(undefined,NEXT,signal());
 await f.cold.files(id,NEXT).stageWorkspace(NEXT,streams(9),signal());f.cold.staged(id,true);await f.cold.publish(id,signal());
 await f.cold.abort(id);await f.selections.collect(new Set());
 const reopened=new WorkspaceSelections(f.backend);
 expect(await new WorkspaceStore(reopened.backend).read(NEXT)).toEqual(new Uint8Array([9]));
 expect(await reopened.isPreserved(id)).toBe(true);
});
it("rejects a staged export whose base differs from the verified selected image",async()=>{
 const f=await fixture(),id=await f.cold.begin(undefined,NEXT,signal());
 expect(()=>f.cold.files(id,BASE)).toThrow();await f.cold.abort(id);
});

it("keeps saved generations through same-base cold publication, later writes and collection",async()=>{
 const f=await fixture(),saved=crypto.randomUUID();await f.selections.retain(saved);
 await new WorkspaceStore(f.selections.backend).commitStreams(BASE,streams(2),signal());
 const id=await f.cold.begin(undefined,BASE,signal());
 await f.cold.files(id,BASE).stageWorkspace(BASE,streams(2),signal());f.cold.staged(id,false);
 await f.cold.publish(id,signal());await f.cold.complete(id);await f.selections.collect(new Set([saved]));
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([2]));
 await f.selections.publish(saved,signal());
 expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
 await new WorkspaceStore(f.selections.backend).commitStreams(BASE,streams(2),signal());
 await f.selections.collect(new Set([saved]));await f.selections.validate(saved,signal());
});


it.each(["workspace", "root"] as const)("does not reclaim an in-flight %s flush while collecting retired cold generations",async scope=>{
 const f=await fixture(),root=scope==="root"?NEXT:undefined;
 if(root!==undefined)await (await openUserspaceRootStore(f.selections.backend,root)).commitStreams(root,streams(1),signal());
 const id=await f.cold.begin(root,BASE,signal());
 await f.cold.files(id,BASE).stageWorkspace(BASE,streams(1),signal());f.cold.staged(id,false);
 await f.cold.publish(id,signal());await f.cold.complete(id);
 const saved=crypto.randomUUID();await f.selections.retain(saved,root);
 const writing=Promise.withResolvers<undefined>(),resume=Promise.withResolvers<undefined>();
 const original=f.backend.write.bind(f.backend);
 vi.spyOn(f.backend,"write").mockImplementation(async(path,bytes)=>{
  await original(path,bytes);
  if(path.includes("chunks/")&&bytes.length===1&&bytes[0]===3){writing.resolve(undefined);await resume.promise;}
 });
 const writer=root===undefined?new WorkspaceStore(f.selections.backend):await openUserspaceRootStore(f.selections.backend,root);
 const commit=writer.commitStreams(root??BASE,streams(3),signal());
 const outcome=commit.then(()=>undefined,(error:unknown)=>error);
 await writing.promise;
 const reading=f.selections.retainedWorkspace(saved,signal(),BASE);
 const collection=f.selections.collect(new Set([saved]));
 // Let the independently admitted collector reach its existing staging scan.
 await Promise.race([collection, new Promise<void>(resolve=>setTimeout(resolve,25))]);
 resume.resolve(undefined);await collection;
 expect(await outcome).toBeUndefined();
 const lease=await reading;if(lease?.snapshot===undefined)throw new Error("Missing retained workspace");
 const producer=lease.snapshot.source(signal());
 const chunks:Uint8Array[]=[];for await(const bytes of producer.frames)chunks.push(bytes);
 expect(chunks).toEqual([new Uint8Array([1])]);
 await producer.retire();await lease.retire();
 const reader=root===undefined?new WorkspaceStore(f.selections.backend):await openUserspaceRootStore(f.selections.backend,root);
 expect(await reader.read(root??BASE)).toEqual(new Uint8Array([3]));
});

it("does not mistake another view's active legacy replacement for interrupted publication",async()=>{
 const f=await fixture(),writing=Promise.withResolvers<undefined>(),resume=Promise.withResolvers<undefined>();
 const original=f.backend.write.bind(f.backend);
 vi.spyOn(f.backend,"write").mockImplementation(async(path,bytes)=>{
  await original(path,bytes);if(path.startsWith("blobs/")&&bytes[0]===3){writing.resolve(undefined);await resume.promise;}
 });
 const replacement=new WorkspaceStore(f.selections.backend).replace(BASE,new Uint8Array([3]),true,signal());
 await writing.promise;
 const collection=new WorkspaceStore(f.selections.backend).collect().then(()=>undefined,(error:unknown)=>error);
 await Promise.race([collection,new Promise<void>(resolve=>setTimeout(resolve,25))]);resume.resolve(undefined);
 await replacement;expect(await collection).toBeUndefined();
 expect(await new WorkspaceStore(f.selections.backend).readDelta(BASE)).toEqual(new Uint8Array([3]));
});

it("publishes migrated system files with the new workspace and image in one selected generation", async () => {
  const f = await fixture(), oldImage = crypto.randomUUID();
  f.pins.add(oldImage);
  await f.selections.setSession({ image: oldImage, resume: null });
  const previous = await openUserspaceRootStore(f.selections.backend, BASE);
  await previous.commitStreams(BASE, streams(8), signal());
  const target = await openUserspaceRootStore(f.selections.backend, NEXT);
  await target.commitStreams(NEXT, streams(9), signal());

  const { sourceId } = await f.cold.select({ boot: "update-image", rootTreeSha256: NEXT, rootPersistence: "persistent" }, signal());
  const update = { kind: "native-root", id: sourceId } as const;
  await expect(f.cold.handle({ type: "inspect-native-cold-root", sourceId }, signal()))
    .resolves.toMatchObject({ rootTreeSha256: BASE });
  const lease = await f.cold.rootRead(update, BASE, signal());
  expect(lease?.workspaceBaseSha256).toBe(BASE);
  expect(lease?.snapshot?.bytes).toBe(1);
  await lease?.retire();
  await expect(f.cold.rootRead(update, NEXT, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });

  await f.cold.files(sourceId, NEXT).stageWorkspace(NEXT, streams(4), signal());
  f.cold.staged(sourceId, false);
  await expect(f.cold.publish(sourceId, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  const input = transferWorkspaceStream(streams(5).snapshot, { session: sourceId, generation: 1 }, 1, new AssistanceTraffic());
  await expect(f.cold.handle({ type: "stage-native-cold-root", sourceId, input: input.descriptor }, signal())).resolves.toBeTypeOf("number");
  await input.finished;

  expect(await target.read(NEXT)).toEqual(new Uint8Array([9]));
  expect(await new WorkspaceStore(f.selections.backend).read(BASE)).toEqual(new Uint8Array([1]));
  expect(await f.selections.session()).toMatchObject({ image: oldImage });
  await f.cold.publish(sourceId, signal());

  const reopened = new WorkspaceSelections(f.backend);
  expect(await reopened.session()).toMatchObject({ image: [...f.pins][0] });
  expect(f.pins.has(oldImage)).toBe(false);
  expect(await new WorkspaceStore(reopened.backend).read(NEXT)).toEqual(new Uint8Array([4]));
  expect(await (await openUserspaceRootStore(reopened.backend, NEXT)).read(NEXT)).toEqual(new Uint8Array([5]));
  expect(await previous.read(BASE)).toEqual(new Uint8Array([8]));
  await f.cold.complete(sourceId);
});
