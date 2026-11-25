import { sha256 as hash } from "@noble/hashes/sha2.js";
import { decodeManagedGzip } from "./managed-image-fetch.js";
import { decodeUserspaceRootfsManifest, rootfsClosure, type UserspaceRootfsBlob, type UserspaceRootfsManifest } from "../userspace-rootfs.js";
import { RootfsInstallations } from "./rootfs-installations.js";
import { retainRootfsRead, type RootfsReadLock } from "./rootfs-read-lock.js";
import { RootfsImagePreparation, type ImagePreparationProgress } from "./rootfs-image-preparation.js";
import { decodeRootfsPackIndex, ROOTFS_PACK_BYTES, type UserspaceRootfsPacks, type RootfsBlobIdentity, type RootfsPackExtent, type RootfsPackIndex } from "../userspace-rootfs-packs.js";
import { decodeRootfsTransport, rootfsTransportURL } from "../userspace-rootfs-transport.js";
import { inDigestOrder, packRootfsContents } from "../userspace-rootfs-packing.js";
import { exactKeys, record, protocolError, string } from "../decode.js";
import { equalBytes } from "../equal-bytes.js";
import { VMError } from "../errors.js";
import type { ImagePreparation } from "../../values.js";
import { read, remove, names, opfsDirectory, sha256, type Backend, type Scope } from "./rootfs-store-backend.js";
import type { RootfsNetworkClient, RootfsNetworkProgress } from "./rootfs-network-channel.js";
import { readStorageObjects } from "./storage-read-batch.js";
import { retainWorkspaceRead, type WorkspaceReadLease } from "./workspace-read.js";
import { packAcquisitionFailure, packMiss, type RootfsPackMiss, type RootfsPackStage } from "./rootfs-pack-failures.js";

interface Reads { readonly files: Map<string,File>; readonly checked:Set<string>; readonly verifiedBlobs:Set<string>; readonly buffers:Map<string,Uint8Array<ArrayBuffer>>; readonly lock?:RootfsReadLock }
function reads(): Reads {return {files:new Map(),checked:new Set(),verifiedBlobs:new Set(),buffers:new Map()};}
/** Writes the supplied bytes durably without mutating the caller's view. */
type Writer=(scope:Scope,name:string,bytes:Uint8Array<ArrayBuffer>,mayBorrowReserve?:()=>boolean)=>Promise<void>;
type Artifact = UserspaceRootfsPacks["artifacts"][number];
interface BlobReadOptions {
  readonly signal?: AbortSignal;
  readonly missed?: (miss: RootfsPackMiss) => void;
  readonly transient?: true;
}
type SingleExtent = RootfsBlobIdentity & { readonly extent: RootfsPackExtent };
type PackedBlob = RootfsPackIndex["blobs"][number];
interface SpanningFile {
  readonly blob: PackedBlob;
  readonly bytes: number;
  pending: number;
}
interface PackInstallTask extends RootfsBlobIdentity {
  readonly singleExtents: SingleExtent[];
  readonly spanningFiles: SpanningFile[];
}
/**
 * Packs an install checks or downloads at once. Each is at most 4 MiB and a request's wait for its
 * first byte dominates its time, so an image is bound by bandwidth only with several in flight.
 */
const PACK_DOWNLOADS = 6;
// WebCrypto needs a contiguous input. Larger files retain bounded streaming verification.
const MAX_BUFFERED_HASH_BYTES = 64 * 1024 ** 2;

/** Packed bodies are immutable; a restore retains verified File snapshots only for its transaction. */
export class RootfsPackCache {
  readonly #backend: Backend;
  readonly #network: Pick<RootfsNetworkClient,"fetchBlob" | "fetchTransport"> | undefined;
  readonly #write: Writer | undefined;
  readonly #indexes = new Map<string,RootfsPackIndex>();
  // Parsed metadata is not a body proof. Exact source identity guards reuse; publication/reclamation invalidates it.
  readonly #layouts = new Map<string,{readonly manifest:UserspaceRootfsManifest;readonly index:RootfsPackIndex}>();
  readonly #transports = new Map<string, UserspaceRootfsPacks>();
  readonly #manifests = new Map<string, UserspaceRootfsManifest>();
  readonly #transient = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly #preparation: RootfsImagePreparation;
  #reads: Reads | undefined;
  #borrowed = 0;
  #retiring: Promise<void> = Promise.resolve();
  constructor(backend:Backend,network?:Pick<RootfsNetworkClient,"fetchBlob" | "fetchTransport">,write?:Writer,preparation=new RootfsImagePreparation()) {
    this.#backend=backend;this.#network=network;this.#write=write;
    this.#preparation=preparation;
  }
  async discover(manifest: UserspaceRootfsManifest, digest: string, base: URL, signal?: AbortSignal, progress?: (value: RootfsNetworkProgress) => void): Promise<boolean> {
    active(signal);
    if (manifest.packs !== undefined || await this.verify(manifest, digest, signal)) return true;
    if (this.#transports.has(digest)) return true;
    const cached = await read(this.#backend, "transports", `${digest}.json`, 128 * 1024 ** 2);
    const bytes = cached ?? await this.#network?.fetchTransport(rootfsTransportURL(base, digest), signal, progress);
    if (bytes === undefined) return false;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw protocolError("Rootfs transport is not valid UTF-8 JSON"); }
    const packs = decodeRootfsTransport(value, manifest, digest, base);
    active(signal);
    // The transport is an installation intent, not an admitted local layout.
    if (cached === undefined) await this.#write?.("transports", `${digest}.json`, bytes);
    this.#transports.set(digest, packs);
    return true;
  }
  beginVerification(lock?: RootfsReadLock):()=>void {
    if(this.#reads!==undefined)throw protocolError("Packed rootfs verification is already active");
    const scoped={...reads(),...(lock===undefined?{}:{lock})};this.#reads=scoped;
    return ()=>{
      if(this.#reads===scoped)this.#reads=undefined;
      // Admitted streams retain this scope's immutable File capabilities.
      scoped.buffers.clear();
    };
  }
  async index(manifest:UserspaceRootfsManifest,digest:string):Promise<RootfsPackIndex|undefined> {
    this.#manifests.set(digest, manifest);
    if(manifest.packs!==undefined)return manifest.packs.index;
    const cached=this.#layouts.get(digest);
    if(cached?.manifest===manifest){this.#layouts.delete(digest);this.#layouts.set(digest,cached);return cached.index;}
    const bytes=await read(this.#backend,"pack-layouts",`${digest}.json`,128*1024**2);
    if(bytes===undefined)return undefined;
    try {
      if(bytes.length>128*1024**2)throw protocolError("Packed layout exceeds metadata bounds");
      const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),source=record(value,"cached rootfs pack layout");
      exactKeys(source,["version","manifestSHA256","index"]);
      if(source["version"]!==1||string(source["manifestSHA256"],"pack manifest")!==digest)throw protocolError("Packed layout names another manifest");
      const index=decodeRootfsPackIndex(source["index"],rootfsClosure(manifest));
      this.#layouts.set(digest,{manifest,index});
      while(this.#layouts.size>2){const oldest=this.#layouts.keys().next().value;if(oldest!==undefined)this.#layouts.delete(oldest);}
      return index;
    } catch {return undefined;}
  }
  /** A complete pin can reuse owned immutable content without rehashing it on each save. */
  async available(manifest: UserspaceRootfsManifest, digest: string, signal?: AbortSignal): Promise<boolean> {
    active(signal);
    const index = await this.index(manifest, digest);
    const present = async (scope: "packs" | "blobs", objects: readonly RootfsBlobIdentity[]) => {
      const missing = new Set<string>();
      await readStorageObjects(objects, async object => {
        try {
          const bytes = this.#backend.kind === "opfs"
            ? (await (await (await opfsDirectory(this.#backend.root, scope, false)).getFileHandle(object.sha256)).getFile()).size
            : (await read(this.#backend, scope, object.sha256))?.length;
          if (bytes !== object.bytes) missing.add(object.sha256);
        } catch { missing.add(object.sha256); }
      },signal);
      active(signal);
      return missing.size === 0;
    };
    return index !== undefined && await present("packs", index.chunks) || await present("blobs", rootfsClosure(manifest));
  }
  async ensure(manifest:UserspaceRootfsManifest,digest:string,signal?:AbortSignal,progress?:(bytes:number,total:number,stage?:"download"|"verify"|"commit",network?:RootfsNetworkProgress)=>void,foreground:()=>boolean=()=>true):Promise<boolean> {
    active(signal);const delivery=manifest.packs ?? this.#transports.get(digest),index=delivery?.index ?? await this.index(manifest,digest);
    if(index===undefined)return false;
    if(delivery===undefined)return this.verify(manifest,digest,signal);
    // Repair can replace files. Its mutable proofs must never replace capabilities lent to admitted streams.
    const scoped=reads(),artifacts=new Map(delivery.artifacts.map(pack=>[pack.sha256,pack]));
    const expected = rootfsClosure(manifest);
    let complete=0;const total=expected.reduce((sum,blob)=>sum+blob.bytes,0);
    const downloads = new Map<string, RootfsNetworkProgress>();
    const totals = () => ({ downloadedBytes: [...downloads.values()].reduce((sum, item) => sum + item.downloadedBytes, 0),
      requestCount: [...downloads.values()].reduce((sum, item) => sum + item.requestCount, 0) });
    const network = (digest: string, value: RootfsNetworkProgress) => {
      downloads.set(digest, value);
      progress?.(Math.min(complete,total), total, "download", totals());
    };
    try {
      await this.#verifyIndex(index,expected,scoped,signal);
      if (manifest.packs === undefined && await this.index(manifest, digest) === undefined) {
        const finish = this.#write === undefined ? undefined : await new RootfsInstallations(this.#backend, this.#write).begin(digest, index);
        active(signal); await this.#publish(index, digest); await finish?.();
      }
      this.#indexes.set(digest,index);progress?.(total,total,"verify",totals());return true;
    } catch {active(signal);}
    const journal = this.#write === undefined ? undefined : await new RootfsInstallations(this.#backend, this.#write).begin(digest, index);
    const sizes = new Map(expected.map(blob => [blob.sha256, blob.bytes]));
    const { chunks, byChunk, empty } = packInstallTasks(index, sizes);
    const stop = new AbortController(), installing = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    let verifiedSpans = Promise.resolve();
    let spanFailure: { readonly cause: unknown } | undefined;
    try {
      await readStorageObjects(chunks, async chunk => {
        active(installing);
        let body: Uint8Array<ArrayBuffer>;
        try { body = await this.#chunk(chunk, scoped, installing); }
        catch (error) {
          active(installing);
          if (this.#network === undefined || this.#write === undefined) throw error;
          const artifact = artifacts.get(chunk.sha256);
          if (artifact === undefined) throw protocolError("Pack download identity is missing");
          forgetChunk(chunk.sha256, scoped);
          await this.#acquire(chunk, artifact, installing, {
            background: !foreground(), progress: value => network(chunk.sha256, value), proofs: scoped,
          });
          body = await this.#chunk(chunk, scoped, installing);
        }
        // Verify the exact logical slices while this job still holds its authenticated readback.
        for (const blob of chunk.singleExtents) await verifySingleExtent(blob, body, installing);
        for (const span of chunk.spanningFiles) {
          span.pending -= 1;
          if (span.pending !== 0) continue;
          // The same bounded logical verifier runs one file at a time as its persisted packs become available.
          verifiedSpans = verifiedSpans.then(() => this.#verifyLogicalBlob(span.blob, span.bytes, byChunk, scoped, installing));
          void verifiedSpans.catch((cause: unknown) => {
            if (installing.aborted) return;
            spanFailure = { cause };
            stop.abort();
          });
        }
        active(installing);
        complete += chunk.bytes;
        progress?.(Math.min(complete, total), total, "verify", totals());
      }, installing, PACK_DOWNLOADS, PACK_DOWNLOADS * ROOTFS_PACK_BYTES);
      await verifiedSpans;
    } catch (error) {
      stop.abort();
      await verifiedSpans.catch(() => undefined);
      throw spanFailure?.cause ?? error;
    }
    for (const blob of empty) await this.#verifyLogicalBlob(blob, 0, byChunk, scoped, signal);
    active(signal); await this.#publish(index,digest); await journal?.();this.#indexes.set(digest,index);progress?.(total,total,"commit",totals());return true;
  }
  async #download(chunk: RootfsBlobIdentity, artifact: Artifact, signal?: AbortSignal,
    priority: "high" | "low" = "high", progress?: (value: RootfsNetworkProgress) => void): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#network === undefined) throw damaged();
    let stage: RootfsPackStage = "fetch";
    try {
      const encoded = await this.#network.fetchBlob(artifact.url, artifact.encodedBytes, artifact.encodedSha256, signal, priority, progress);
      stage = "decode";
      return await decodePack(encoded, chunk, signal);
    } catch (error: unknown) {
      active(signal);
      throw packAcquisitionFailure(error, chunk.sha256, stage);
    }
  }
  async #acquire(chunk: RootfsBlobIdentity, artifact: Artifact, signal?: AbortSignal,
    { background = false, progress, proofs, preparation = "before-ready", guard }: {
      readonly background?: boolean;
      readonly progress?: (value: RootfsNetworkProgress) => void;
      readonly proofs?: Reads;
      readonly preparation?: ImagePreparation;
      readonly guard?: RootfsReadLock;
    } = {}): Promise<void> {
    await this.#preparation.prepare(`pack:${chunk.sha256}:${String(chunk.bytes)}`, { background, preparation, ...(signal === undefined ? {} : { signal }),
      ...(progress === undefined ? {} : { progress: (value: ImagePreparationProgress) => progress({ downloadedBytes: value.downloadedBytes ?? 0, requestCount: value.requestCount ?? 0 }) }) }, async (workSignal, foreground, report, mayBorrowReserve) => {
      const acquire = async () => {
        const scoped = proofs??reads();
        try { await this.#chunk(chunk, scoped, workSignal); return; } catch { active(workSignal); }
        const write = this.#write;
        if (write === undefined) throw damaged();
        const body = await this.#download(chunk, artifact, workSignal, foreground() ? "high" : "low",
          value => report({ completedObjects: 0, completedBytes: 0, totalBytes: 0, stage: "download", ...value }));
        let stage: RootfsPackStage = "write";
        try {
          active(workSignal); await write("packs", chunk.sha256, body, mayBorrowReserve);
          forgetChunk(chunk.sha256,scoped);
          // The decoded buffer already matches the signed hash. Authenticate the actual readback by equality.
          stage = "verify"; await this.#chunk(chunk, scoped, workSignal, body);
        } catch (error: unknown) {
          active(workSignal);
          const failure = packAcquisitionFailure(error, chunk.sha256, stage);
          if (stage === "write" && failure.code === "QUOTA_EXCEEDED") rememberChunk(this.#transient, chunk.sha256, body);
          throw failure;
        }
      };
      const locks = typeof navigator === "object" ? navigator.locks : undefined;
      // A cancelled consumer can detach while an admitted durable write finishes.
      const release = guard?.borrow();
      try {
        if (locks === undefined) await acquire();
        else await locks.request(`oxidevm-rootfs-chunk:${chunk.sha256}`, { signal: workSignal }, acquire);
      } finally { await release?.(); }
    });
  }

  async acquireBlob(manifest: UserspaceRootfsManifest, digest: string, blob: UserspaceRootfsBlob, signal?: AbortSignal,
    preparation: ImagePreparation = "before-ready", guard?: RootfsReadLock): Promise<boolean> {
    const delivery = manifest.packs ?? this.#transports.get(digest);
    if (delivery === undefined) return false;
    const descriptor = delivery.index.blobs.find(entry => entry.sha256 === blob.sha256);
    if (descriptor === undefined) throw protocolError("pack has no requested logical file");
    const used = new Set(descriptor.extents.map(extent => extent.chunk));
    const artifacts = new Map(delivery.artifacts.map(artifact => [artifact.sha256, artifact]));
    await readStorageObjects(delivery.index.chunks.filter(chunk => used.has(chunk.sha256)), async chunk => {
      const artifact = artifacts.get(chunk.sha256);
      if (artifact === undefined) throw protocolError("requested file has no acquisition artifact");
      await this.#acquire(chunk, artifact, signal, { preparation, ...(guard === undefined ? {} : { guard }) });
    }, signal, 2);
    return true;
  }
  async verify(manifest:UserspaceRootfsManifest,digest:string,signal?:AbortSignal):Promise<boolean> {
    active(signal);const index=await this.index(manifest,digest);if(index===undefined)return false;
    try {await this.#verifyIndex(index,rootfsClosure(manifest),this.#reads??reads(),signal);this.#indexes.set(digest,index);return true;}
    catch {active(signal);this.#indexes.delete(digest);return false;}
  }
  verifiedLayout(digest:string):boolean {return this.#indexes.has(digest);}
  /** The checkpoint owner supplies a committed proof of this exact signed layout, never a legacy index. */
  async verifyPinnedPacks(manifest:UserspaceRootfsManifest,digest:string,signal?:AbortSignal):Promise<boolean> {
    const index=manifest.packs?.index;if(index===undefined)return false;
    const scoped=this.#reads??reads();
    try {
      await readStorageObjects(index.chunks,chunk=>this.#chunk(chunk,scoped,signal).then(()=>{}),signal,2);
      active(signal);const chunks=new Map(index.chunks.map(chunk=>[chunk.sha256,chunk])),sizes=new Map(rootfsClosure(manifest).map(blob=>[blob.sha256,blob.bytes]));
      for(const blob of index.blobs){const bytes=sizes.get(blob.sha256);if(bytes===undefined)throw damaged();scoped.verifiedBlobs.add(verificationKey(blob,bytes,chunks));}
      this.#indexes.set(digest,index);return true;
    }catch{active(signal);this.#indexes.delete(digest);return false;}
  }
  async #verifyIndex(index:RootfsPackIndex,expected:readonly RootfsBlobIdentity[],scoped:Reads,signal?:AbortSignal):Promise<void> {
    const chunks=new Map(index.chunks.map(chunk=>[chunk.sha256,chunk])),sizes=new Map(expected.map(blob=>[blob.sha256,blob.bytes]));
    for(const blob of index.blobs) {
      active(signal);const bytes=sizes.get(blob.sha256);if(bytes===undefined)throw damaged();
      await this.#verifyLogicalBlob(blob, bytes, chunks, scoped, signal);
    }
  }
  async #verifyLogicalBlob(blob: PackedBlob, bytes: number, chunks: ReadonlyMap<string, RootfsBlobIdentity>, scoped: Reads, signal?: AbortSignal): Promise<void> {
    active(signal);
    const key=verificationKey(blob,bytes,chunks);
    if(this.#backend.kind==="opfs"&&scoped.verifiedBlobs.has(key)){
      // A demand-read proof authenticates the file, not its containing packs.
      for(const extent of blob.extents){
        const chunk=chunks.get(extent.chunk);if(chunk===undefined)throw damaged();
        if(!scoped.checked.has(chunk.sha256))await this.#chunk(chunk,scoped,signal);
      }
      return;
    }
    const only=blob.extents.length===1?blob.extents[0]:undefined;
    if(only!==undefined){
      const chunk=chunks.get(only.chunk);if(chunk===undefined)throw damaged();
      await verifySingleExtent({ sha256: blob.sha256, bytes, extent: only }, await this.#chunk(chunk,scoped,signal), signal);
      scoped.verifiedBlobs.add(key);return;
    }
    const input = bytes <= MAX_BUFFERED_HASH_BYTES
      ? { kind: "buffered" as const, body: new Uint8Array(bytes) }
      : { kind: "streaming" as const, hash: hash.create() };
    let size = 0;
    for (const extent of blob.extents) {
      const chunk = chunks.get(extent.chunk);
      if (chunk === undefined) throw protocolError("Unknown pack chunk");
      const body = await this.#chunk(chunk, scoped, signal);
      const slice = body.subarray(extent.offset, extent.offset + extent.bytes);
      if (input.kind === "buffered") input.body.set(slice, size);
      else input.hash.update(slice);
      size += slice.byteLength;
    }
    if (size !== bytes) throw damaged();
    const sha256Hex = input.kind === "buffered" ? await sha256(input.body) : hex(input.hash.digest());
    if (sha256Hex !== blob.sha256) throw damaged();
    active(signal);
    scoped.verifiedBlobs.add(key);
  }
  async #chunk(chunk:RootfsBlobIdentity,scoped:Reads,signal?:AbortSignal,decodedProof?:Uint8Array<ArrayBuffer>):Promise<Uint8Array<ArrayBuffer>> {
    active(signal);const cached=scoped.buffers.get(chunk.sha256);if(cached!==undefined){if(cached.length!==chunk.bytes)throw damaged();return cached;}
    let file=scoped.files.get(chunk.sha256),body:Uint8Array<ArrayBuffer>;
    if(this.#backend.kind==="opfs") {
      file??=await this.#file(chunk,scoped);
      if(file.size!==chunk.bytes)throw damaged();body=new Uint8Array(await file.arrayBuffer());
      scoped.files.set(chunk.sha256,file);
    } else {const stored=await read(this.#backend,"packs",chunk.sha256);if(stored===undefined)throw damaged();body=stored;}
    if(body.length!==chunk.bytes)throw damaged();
    if (decodedProof !== undefined) {
      if (!equalBytes(body, decodedProof)) throw damaged();
    } else if ((this.#backend.kind !== "opfs" || !scoped.checked.has(chunk.sha256)) && await sha256(body) !== chunk.sha256) {
      throw damaged();
    }
    active(signal);scoped.checked.add(chunk.sha256);rememberChunk(scoped.buffers,chunk.sha256,body);
    return body;
  }
  async #file(chunk:RootfsBlobIdentity,scoped:Reads):Promise<File> {
    const backend=this.#backend;if(backend.kind!=="opfs")throw damaged();
    const file=scoped.files.get(chunk.sha256)??await (await (await opfsDirectory(backend.root,"packs",false)).getFileHandle(chunk.sha256)).getFile();
    if(file.size!==chunk.bytes)throw damaged();scoped.files.set(chunk.sha256,file);return file;
  }
  /** Demand reads authenticate the complete logical file, without reading unrelated pack bytes. */
  async #extent(chunk:RootfsBlobIdentity,extent:{readonly offset:number;readonly bytes:number},scoped:Reads,signal?:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
    active(signal);const end=extent.offset+extent.bytes;
    if(!Number.isSafeInteger(end)||extent.offset<0||extent.bytes<0||end>chunk.bytes)throw damaged();
    const cached=scoped.buffers.get(chunk.sha256);
    const bytes=cached!==undefined?cached.slice(extent.offset,end):this.#backend.kind==="opfs"
      ?new Uint8Array(await (await this.#file(chunk,scoped)).slice(extent.offset,end).arrayBuffer())
      :(await this.#chunk(chunk,scoped,signal)).slice(extent.offset,end);
    if(bytes.length!==extent.bytes)throw damaged();active(signal);return bytes;
  }
  /** A demand read may use verified delivery bytes after storage has refused a pack write. */
  async readBlob(manifest: UserspaceRootfsManifest, digest: string, blob: UserspaceRootfsBlob,
    { signal, missed, transient }: BlobReadOptions = {}): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const delivery = manifest.packs ?? this.#transports.get(digest);
    if (transient && (delivery === undefined || this.#network === undefined)) return undefined;
    const index = transient ? delivery?.index : this.#indexes.get(digest) ?? await this.index(manifest, digest) ?? delivery?.index;
    if (index === undefined) return undefined;
    const artifacts = transient ? new Map(delivery?.artifacts.map(artifact => [artifact.sha256, artifact])) : undefined;
    const descriptor=index.blobs.find(entry=>entry.sha256===blob.sha256);if(descriptor===undefined)return undefined;
    const scoped = transient ? reads() : this.#reads ?? reads();
    const chunks=new Map(index.chunks.map(chunk=>[chunk.sha256,chunk])),output=new Uint8Array(blob.bytes);
    let current="";
    try {
      for(const extent of descriptor.extents) {
        current=extent.chunk;const chunk=chunks.get(extent.chunk);if(chunk===undefined)throw damaged();
        const bytes = await this.#extent(chunk, extent, scoped, signal).catch(async (error: unknown) => {
          const artifact = artifacts?.get(chunk.sha256);
          if (artifact === undefined) throw error;
          active(signal);
          const retained = this.#transient.get(chunk.sha256);
          const body = retained?.length === chunk.bytes ? retained : await this.#download(chunk, artifact, signal);
          rememberChunk(this.#transient, chunk.sha256, body);
          rememberChunk(scoped.buffers, chunk.sha256, body);
          return body.subarray(extent.offset, extent.offset + extent.bytes);
        });
        output.set(bytes, extent.fileOffset);
      }
      const key=verificationKey(descriptor,blob.bytes,chunks);
      if(!scoped.verifiedBlobs.has(key)){if(await sha256(output)!==blob.sha256)throw damaged();active(signal);scoped.verifiedBlobs.add(key);}active(signal);return output;
    } catch(error:unknown) {
      active(signal);
      if (transient) throw error;
      missed?.(packMiss(error,current));
      return undefined;
    }
  }
  async openFile(manifest:UserspaceRootfsManifest,digest:string,blob:UserspaceRootfsBlob,signal:AbortSignal,release:()=>void,guarded=false):Promise<WorkspaceReadLease|undefined> {
    const releaseLock = guarded ? undefined : this.#reads?.lock?.borrow() ?? await retainRootfsRead(signal);
    this.#borrowed++;
    let retired=false,lent=false;
    const retire=()=>{if(retired)return;retired=true;this.#borrowed--;if(releaseLock!==undefined){const retiring=releaseLock();this.#retiring=Promise.all([this.#retiring,retiring]).then(()=>{});}};
    try {
    const index=this.#indexes.get(digest)??await this.index(manifest,digest)??this.#transports.get(digest)?.index;if(index===undefined)return undefined;
    const descriptor=index.blobs.find(entry=>entry.sha256===blob.sha256);if(descriptor===undefined)return undefined;
    const scoped=this.#reads??reads(),chunks=new Map(index.chunks.map(chunk=>[chunk.sha256,chunk]));
    const readExtent=(chunk:RootfsBlobIdentity,offset:number,bytes:number,signal:AbortSignal)=>this.#extent(chunk,{offset,bytes},scoped,signal);
    const produce=async function*(signal:AbortSignal){for(const extent of descriptor.extents){const chunk=chunks.get(extent.chunk);if(chunk===undefined)throw damaged();
      for(let offset=extent.offset;offset<extent.offset+extent.bytes;offset+=65536){active(signal);yield await readExtent(chunk,offset,Math.min(65536,extent.offset+extent.bytes-offset),signal);}}};
    // A derived legacy layout is checked against the signed file hash before lending its frames.
    const key=verificationKey(descriptor,blob.bytes,chunks);
    if(!scoped.verifiedBlobs.has(key)){
      const digestHash=hash.create();for await(const frame of produce(signal))digestHash.update(frame);
      if(hex(digestHash.digest())!==blob.sha256)throw damaged();active(signal);scoped.verifiedBlobs.add(key);
    }
    const lease=retainWorkspaceRead({generation:1,snapshot:{bytes:blob.bytes,read:produce}},signal,()=>{retire();release();},()=>{});
    lent=true;return lease;
    } catch(error){retire();throw error;}
    finally { if(!lent)retire(); }
  }
  settleReads(): Promise<void> { return this.#retiring; }
  async compact(manifest:UserspaceRootfsManifest,digest:string,signal:AbortSignal):Promise<boolean> {
    active(signal);if(manifest.packs!==undefined||this.#write===undefined)return false;
    if(await this.verify(manifest,digest,signal))return true;
    const backend=this.#backend,write=this.#write;
    // Digest order matches the packs of a transport sidecar, which this cache can then serve without downloading.
    const index=await packRootfsContents(inDigestOrder(rootfsClosure(manifest)),async function*(blob){
      active(signal);
      if(backend.kind==="opfs"){
        const file=await (await (await opfsDirectory(backend.root,"blobs",false)).getFileHandle(blob.sha256)).getFile();
        if(file.size!==blob.bytes)throw damaged();
        for(let offset=0;offset<file.size;offset+=65536){active(signal);yield new Uint8Array(await file.slice(offset,offset+65536).arrayBuffer());}
      }else{const bytes=await read(backend,"blobs",blob.sha256);if(bytes===undefined)throw damaged();yield bytes;}
    },(chunk,bytes)=>write("packs",chunk.sha256,bytes),signal);
    await this.#verifyIndex(index,rootfsClosure(manifest),reads(),signal);active(signal);
    await this.#publish(index,digest);this.#indexes.set(digest,index);return true;
  }
  async #publish(index:RootfsPackIndex,digest:string):Promise<void> {
    if(this.#write===undefined)return;
    this.#layouts.delete(digest);this.#indexes.delete(digest);
    await this.#write("pack-layouts",`${digest}.json`,new TextEncoder().encode(JSON.stringify({version:1,manifestSHA256:digest,index})));
  }
  async reclaim():Promise<void> {
    if(this.#reads!==undefined||this.#borrowed!==0)return;
    for(const name of await names(this.#backend,"pack-layouts")) {
      const digest = name.slice(0, -5);
      let manifest = this.#manifests.get(digest);
      if (manifest === undefined) {
        const encoded = await read(this.#backend, "manifests", `${digest}.json`, 128 * 1024 ** 2);
        if (encoded === undefined || await sha256(encoded) !== digest) continue;
        try { manifest = decodeUserspaceRootfsManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown, new URL("https://oxidevm-rootfs-cache.invalid/manifest.json")); }
        catch { continue; }
      }
      const missing = new Set<string>();
      await readStorageObjects(rootfsClosure(manifest), async blob => {
        const bytes = await read(this.#backend, "blobs", blob.sha256);
        if (bytes === undefined || bytes.length !== blob.bytes || await sha256(bytes) !== blob.sha256) missing.add(blob.sha256);
      });
      if (missing.size !== 0) continue;
      await remove(this.#backend,"pack-layouts",name); await remove(this.#backend,"installations",name);
      this.#indexes.delete(digest);this.#layouts.delete(digest);
    }
  }
}

async function decodePack(
  encoded: Uint8Array<ArrayBuffer>,
  chunk: RootfsBlobIdentity,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  active(signal);
  if (chunk.bytes > ROOTFS_PACK_BYTES) throw damaged();
  const output = decodeManagedGzip(encoded, chunk.bytes);
  if (output === undefined || await sha256(output) !== chunk.sha256) throw damaged();
  active(signal);
  return output;
}

function packInstallTasks(index: RootfsPackIndex, sizes: ReadonlyMap<string, number>) {
  const chunks: PackInstallTask[] = index.chunks.map(chunk => ({ ...chunk, singleExtents: [], spanningFiles: [] }));
  const byChunk = new Map(chunks.map(chunk => [chunk.sha256, chunk]));
  const empty: PackedBlob[] = [];
  for (const blob of index.blobs) {
    const bytes = sizes.get(blob.sha256);
    if (bytes === undefined) throw damaged();
    if (blob.extents.length === 0) {
      if (bytes !== 0) throw damaged();
      empty.push(blob);
    } else if (blob.extents.length === 1) {
      const extent = blob.extents[0], group = extent === undefined ? undefined : byChunk.get(extent.chunk);
      if (extent === undefined || group === undefined) throw damaged();
      group.singleExtents.push({ sha256: blob.sha256, bytes, extent });
    } else {
      const uses = new Set(blob.extents.map(extent => extent.chunk));
      const span = { blob, bytes, pending: uses.size };
      for (const digest of uses) {
        const group = byChunk.get(digest);
        if (group === undefined) throw damaged();
        group.spanningFiles.push(span);
      }
    }
  }
  return { chunks, byChunk, empty };
}

async function verifySingleExtent({ sha256: digest, bytes, extent }: SingleExtent, body: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
  active(signal);
  if (extent.bytes !== bytes || extent.fileOffset !== 0 || extent.offset < 0 || extent.offset + bytes > body.length
    || await sha256(body.subarray(extent.offset, extent.offset + bytes)) !== digest) throw damaged();
  active(signal);
}
function active(signal?:AbortSignal):void {if(signal?.aborted===true)throw new VMError("ABORTED","Rootfs pack operation cancelled");}
function rememberChunk(buffers: Map<string, Uint8Array<ArrayBuffer>>, digest: string, body: Uint8Array<ArrayBuffer>): void {
  buffers.set(digest, body);
  if (buffers.size <= 2) return;
  const oldest = buffers.keys().next().value;
  if (oldest !== undefined) buffers.delete(oldest);
}
function forgetChunk(digest:string,scoped:Reads):void {
  scoped.files.delete(digest);scoped.checked.delete(digest);scoped.buffers.delete(digest);scoped.verifiedBlobs.clear();
}
function damaged():VMError{return new VMError("STORAGE_ERROR","Rootfs pack is missing or damaged",{reason:"image-not-cached"});}
function hex(bytes:Uint8Array):string{return [...bytes].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function verificationKey(blob:RootfsPackIndex["blobs"][number],bytes:number,chunks:ReadonlyMap<string,RootfsBlobIdentity>):string {
  return JSON.stringify([blob.sha256,bytes,blob.extents.map(extent=>[extent.chunk,chunks.get(extent.chunk)?.bytes,extent.offset,extent.bytes,extent.fileOffset])]);
}
