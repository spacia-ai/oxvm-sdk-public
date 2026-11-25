import { afterEach, expect, it, vi } from "vitest";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest, userspaceTreeIdentity } from "../userspace-rootfs.js";
import { packRootfsContents } from "../userspace-rootfs-packing.js";
import { MemoryDirectory, MemoryQuota } from "./opfs-double.test-support.js";
import { SpaceReserve } from "./managed-disk-reserve.js";
import { DISK_RESERVE_BYTES } from "./browser-quota.js";
import { ROOTFS_CHECKPOINT_URL } from "./rootfs-checkpoint.test-support.js";
import { RootfsNetworkClient, serveRootfsNetwork } from "./rootfs-network-channel.js";
import { RootfsStore } from "./rootfs-store.js";
import { names, read, verifiedBytes } from "./rootfs-store-backend.js";
import { sha256Hex } from "./snapshot-content.js";
import { signedCheckpointRootfsFixture } from "./rootfs-checkpoint.test-support.js";
import { record } from "../decode.js";
import type * as EnginePin from "../../engine.generated.js";

const nativeSuite = vi.hoisted(() => ({ identity: "oxidevm-rust-toybox", abi: 1, catalogSha256: "a".repeat(64) } as const));
vi.mock("../../engine.generated.js", async importOriginal => ({
  ...await importOriginal<typeof EnginePin>(),
  engineRelease: { schemaVersion: 5, nativeUtilities: nativeSuite },
}));

const EVIDENCE = ["sbom", "notices", "correspondingSources", "reproducibility"] as const;
const ports: MessagePort[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const port of ports.splice(0)) port.close(); });

function store(root = new MemoryDirectory(), reserve?: SpaceReserve): RootfsStore {
  const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
  serveRootfsNetwork(channel.port2);
  return RootfsStore.opfs(root, new RootfsNetworkClient(channel.port1), reserve);
}

it("uses the same signed manifest for activation and a cold selection pin", async () => {
  const root = new MemoryDirectory(), rootfs = store(root), image = await evidenceImage();
  const backend = { kind: "opfs", root } as const;
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest);
  await rootfs.pinImage({ workspaceId: "cold-selection", snapshotId: "01234567-89ab-4def-8765-0123456789ab" });
  expect(await names(backend, "manifests")).toEqual([`${image.digest}.json`]);
  expect(await read(backend, "manifests", `${image.digest}.json`)).toEqual(image.manifest);
});

it("retains a previously activated manifest across a later activation and collection", async () => {
  const root = new MemoryDirectory(), rootfs = store(root), first = await evidenceImage();
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, first.trusted, first.digest);
  const second = await evidenceImage(undefined, { version: "replacement" });
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, second.trusted, second.digest);
  await rootfs.collect();
  const backend = { kind: "opfs", root } as const;
  expect((await names(backend, "manifests")).sort()).toEqual([first.digest, second.digest].sort().map(hash => `${hash}.json`));
  expect(await read(backend, "manifests", `${first.digest}.json`)).toEqual(first.manifest);
});

it("rejects a signed native suite mismatch before fetching evidence or activating the image", async () => {
  const image = await signedCheckpointRootfsFixture("native", 9);
  const rootfs = store();
  await expect(rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted)).rejects.toMatchObject({ code: "NATIVE_UTILITY_MISMATCH" });
  expect(image.fetcher.mock.calls.map(call => call[0])).toEqual([ROOTFS_CHECKPOINT_URL]);
  expect(() => rootfs.currentRootfs()).toThrow("No verified rootfs is active");
});

it("preserves the matching signed requirement in the prepared image", async () => {
  const fixture = await signedCheckpointRootfsFixture("native", 9);
  const source = record(JSON.parse(new TextDecoder().decode(fixture.bytes)), "signed image");
  const input = { ...source, nativeUtilities: nativeSuite };
  const decoded = decodeUserspaceRootfsManifest(input, new URL(ROOTFS_CHECKPOINT_URL));
  const signature = await crypto.subtle.sign("Ed25519", fixture.keys.privateKey, canonicalUserspaceRootfsBytes(decoded));
  const manifest = new TextEncoder().encode(JSON.stringify({ ...input,
    provenance: { ...record(source["provenance"], "provenance"), signature: Buffer.from(signature).toString("base64url") } }));
  const prepared = await store().prepare(ROOTFS_CHECKPOINT_URL, fixture.trusted,
    await sha256Hex(manifest), false, undefined, "on-demand", manifest);
  expect(prepared.nativeUtilities).toEqual(nativeSuite);
});

it("keeps the active image when a signed replacement requires another native suite", async () => {
  const rootfs = store(), previous = await evidenceImage();
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, previous.trusted);
  const image = await signedCheckpointRootfsFixture("native", 9);
  await expect(rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted)).rejects.toMatchObject({ code: "NATIVE_UTILITY_MISMATCH" });
  expect(rootfs.currentRootfs().version).toBe("evidence");
});

/** A signed image with four different evidence files, served by a fetch double that records every request it gets. */
async function evidenceImage(answer: (url: string, body: Uint8Array<ArrayBuffer>) => Response | Promise<Response> = (_url, body) => new Response(body),
  { version = "evidence", packed = false } = {}) {
  const content = new Uint8Array([1, 2, 3]), blob = await sha256Hex(content), files = new Map<string, Uint8Array<ArrayBuffer>>();
  const blobURL = new URL("./unread", ROOTFS_CHECKPOINT_URL).href;
  const objects = new Map([[blob, content]]);
  const provenance: Record<string, unknown> = { keyId: "test", signature: "A".repeat(86) };
  for (const name of EVIDENCE) {
    const bytes = new TextEncoder().encode(`${name} of the image`);
    const digest = await sha256Hex(bytes);
    files.set(new URL(`./evidence/${name}`, ROOTFS_CHECKPOINT_URL).href, bytes);
    objects.set(digest, bytes);
    provenance[name] = { url: `./evidence/${name}`, bytes: bytes.length, sha256: digest };
  }
  const evidence = [...files.keys()], packUrls: string[] = [];
  const artifacts: { sha256: string; encoding: "gzip"; url: string; encodedBytes: number; encodedSha256: string }[] = [];
  const index = packed ? await packRootfsContents([...objects.entries()].map(([sha256, bytes]) => ({ sha256, bytes: bytes.length })),
    async function* (object) {
      const bytes = objects.get(object.sha256);
      if (bytes === undefined) throw new Error("missing evidence object");
      yield await Promise.resolve(bytes);
    }, async (chunk, content) => {
      const bytes = new Uint8Array(await new Response(new Blob([content]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      const url = `./packs/${chunk.sha256}`, href = new URL(url, ROOTFS_CHECKPOINT_URL).href;
      packUrls.push(href); files.set(href, bytes);
      artifacts.push({ sha256: chunk.sha256, encoding: "gzip", url, encodedBytes: bytes.length, encodedSha256: await sha256Hex(bytes) });
    }) : undefined;
  if (packed && packUrls.length !== 1) {
    throw new Error("fixture must place all four evidence files in one pack");
  }
  const times = { accessNs: "0", modificationNs: "0" }, ownership = { uid: 1000, gid: 1000 };
  const input = {
    schemaVersion: index === undefined ? 6 : 8, ...(index === undefined ? {} : { packs: { index, artifacts } }),
    kind: "linux-user-rootfs", id: "test-rootfs", version, architecture: "x86_64", cpuProfile: "x86-64-v2",
    sourceDateEpoch: 1_786_060_800, rootTreeSha256: "0".repeat(64), workspaceBaseSha256: "0".repeat(64), fileCount: 2, totalBytes: content.length,
    blobs: [{ sha256: blob, bytes: content.length, url: "./unread" }],
    entries: [{ type: "directory", path: "bin", mode: 0o755, ownership, times }, { type: "file", path: "bin/app", mode: 0o755, blob, ownership, times }],
    runtimes: { supportingFiles: [] }, provenance,
  };
  const url = new URL(ROOTFS_CHECKPOINT_URL), draft = decodeUserspaceRootfsManifest(input, url);
  Object.assign(input, await userspaceTreeIdentity(draft.entries, draft.blobs, draft.schemaVersion));
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(input, url)));
  provenance["signature"] = Buffer.from(signature).toString("base64url");
  const manifest = new TextEncoder().encode(JSON.stringify(input)), requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn((target: string) => {
    requests.push(target);
    const body = target === ROOTFS_CHECKPOINT_URL ? manifest : target === blobURL ? content : files.get(target);
    return Promise.resolve(body === undefined ? new Response(null, { status: 404 }) : target === ROOTFS_CHECKPOINT_URL ? new Response(body) : answer(target, body));
  }));
  return { manifest, digest: await sha256Hex(manifest), requests, evidence, packUrls, content, blob, blobURL,
    trusted: { keyId: "test", publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)) } };
}

it("prepares the pinned manifest the runtime page verified without fetching it again", async () => {
  const image = await evidenceImage();
  const prepared = await store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "on-demand", image.manifest.slice());
  expect(prepared).toMatchObject({ id: "test-rootfs", version: "evidence", identity: { manifestSHA256: image.digest, signatureVerified: true } });
  expect(image.requests).not.toContain(ROOTFS_CHECKPOINT_URL);
  expect([...image.requests].sort()).toEqual([...image.evidence].sort());
});

it("leaves the cache and delivery idle when an immutable file read is cancelled", async () => {
  const image = await evidenceImage(), rootfs = store();
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted);
  image.requests.length = 0;
  await expect(rootfs.read("/bin/app", AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
  expect(image.requests).toEqual([]);
});

it.each([0, 54])("uses the verified delivery in a small origin with %d MiB already used", async (usage) => {
  const image = await signedCheckpointRootfsFixture("limited", 8);
  const root = new MemoryDirectory(), rootfs = store(root);
  const backend = { kind: "opfs", root } as const;
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted);
  vi.stubGlobal("navigator", { storage: {
    estimate: () => Promise.resolve({ quota: 100 * 1024 ** 2, usage: usage * 1024 ** 2 }),
  } });
  expect((await rootfs.read("/bin/app")).bytes).toEqual(Uint8Array.of(1, 2, 3));
  expect(await names(backend, "packs")).toEqual([]);
  await rootfs.prepareImage({ workspaceId: "limited", snapshotId: "01234567-89ab-4def-8765-0123456789ab" },
    new AbortController().signal, () => undefined, "repair");
  expect(await names(backend, "packs")).toHaveLength(1);
});

it.each(["estimate", "write refusal"] as const)("keeps the guest reserve when an unpacked demand read encounters %s", async (pressure) => {
  const image = await evidenceImage();
  const quota = new MemoryQuota(1024 ** 2), root = new MemoryDirectory("", undefined, quota);
  const reserve = await SpaceReserve.open(root, 32);
  if (reserve === undefined) throw new Error("missing reserve");
  try {
    const rootfs = store(root, reserve);
    await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest);
    const release = vi.spyOn(reserve, "release");
    if (pressure === "write refusal") quota.limit = quota.used + image.content.length - 1;
    vi.stubGlobal("navigator", { storage: { estimate: () => Promise.resolve({
      quota: DISK_RESERVE_BYTES * 2,
      usage: pressure === "estimate" ? DISK_RESERVE_BYTES + 1 : 0,
    }) } });
    expect((await rootfs.read("/bin/app")).bytes).toEqual(image.content);
    expect(image.requests).toContain(image.blobURL);
    expect(release).not.toHaveBeenCalled();
    expect(await verifiedBytes({ kind: "opfs", root }, "blobs", image.blob, image.content.length, image.blob)).toBeUndefined();
  } finally { reserve.close(); }
});

it("keeps the guest reserve when a packed demand cache write fails", async () => {
  const image = await signedCheckpointRootfsFixture("limited-packs", 8);
  const quota = new MemoryQuota(1024 ** 2), root = new MemoryDirectory("", undefined, quota);
  const reserve = await SpaceReserve.open(root, 32);
  if (reserve === undefined) throw new Error("missing reserve");
  try {
    const rootfs = store(root, reserve);
    await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted);
    quota.limit = quota.used;
    const release = vi.spyOn(reserve, "release");
    expect((await rootfs.read("/bin/app")).bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(release).not.toHaveBeenCalled();
  } finally { reserve.close(); }
});

it("checks handed manifest bytes against their pin and the trusted key as it checks fetched ones", async () => {
  const image = await evidenceImage(), other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const untrusted = { keyId: "test", publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)) };
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, "f".repeat(64), false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR", message: "Userspace manifest digest differs from its pin" });
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, untrusted, image.digest, false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  // Without a pin, or on a start that may only read the cache, nothing ties handed bytes to the requested image.
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, undefined, false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(store().prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, true, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(image.requests).toEqual([]);
});

it("retains the four evidence files concurrently before it activates the image", async () => {
  const held: (() => void)[] = [];
  let holding = true;
  const image = await evidenceImage((_url, body) => holding ? new Promise(resolve => { held.push(() => { resolve(new Response(body)); }); }) : new Response(body));
  const rootfs = store();
  const outcome = rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "on-demand", image.manifest.slice())
    .then(prepared => ({ prepared }), (error: unknown) => ({ error }));
  try {
    await vi.waitFor(() => { expect(held).toHaveLength(EVIDENCE.length); });
    expect(() => rootfs.currentRootfs()).toThrow("No verified rootfs is active");
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
  }
  expect(await outcome).toMatchObject({ prepared: { id: "test-rootfs", version: "evidence" } });
  expect(rootfs.currentRootfs()).toMatchObject({ version: "evidence" });
});

it("reports the first evidence failure in manifest order and activates nothing", async () => {
  const image = await evidenceImage((url, body) => url.endsWith("/notices") ? new Response(null, { status: 404 })
    : url.endsWith("/correspondingSources") ? new Response(new Uint8Array(body.length)) : new Response(body));
  const rootfs = store();
  await expect(rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "on-demand", image.manifest.slice()))
    .rejects.toMatchObject({ code: "STORAGE_ERROR", message: "rootfs fetch returned 404" });
  expect(() => rootfs.currentRootfs()).toThrow("No verified rootfs is active");
});

it("uses one signed provenance pack and reuses it for the complete image installation", async () => {
  const image = await evidenceImage(undefined, { packed: true }), rootfs = store();
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "before-ready");
  expect(image.requests).toEqual([ROOTFS_CHECKPOINT_URL, ...image.packUrls]);
  await rootfs.prepareImage({ workspaceId: "packed-evidence", snapshotId: "123e4567-e89b-42d3-a456-426614174001" },
    new AbortController().signal, () => {}, "first-install");
  expect((await rootfs.read("bin/app")).bytes).toEqual(Uint8Array.of(1, 2, 3));
  expect(image.requests).toEqual([ROOTFS_CHECKPOINT_URL, ...image.packUrls]);
});

it("retains each signed loose evidence file when its shared pack fails validation", async () => {
  const image = await evidenceImage((url, body) => new Response(url.includes("/packs/") ? new Uint8Array(body.length) : body), { packed: true });
  const rootfs = store();
  await rootfs.prepare(ROOTFS_CHECKPOINT_URL, image.trusted, image.digest, false, undefined, "before-ready");
  expect(image.requests.slice(0, 2)).toEqual([ROOTFS_CHECKPOINT_URL, ...image.packUrls]);
  expect(image.requests.slice(2).sort()).toEqual([...image.evidence].sort());
  expect(rootfs.currentRootfs().identity?.manifestSHA256).toBe(image.digest);
});
