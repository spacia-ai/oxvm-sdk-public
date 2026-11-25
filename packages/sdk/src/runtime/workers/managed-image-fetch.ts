import { VMError } from "../errors.js";
import { Z_FINISH, Z_OK, Z_STREAM_END, ZStream, zlibInflate, zlibInflateEnd, zlibInflateInit2 } from "pako";
import type { ManagedImageManifest, ManagedImageArtifact } from "../managed-image.js";
import { sha256Hex } from "./snapshot-content.js";

export async function fetchVerifiedChunk(
  chunk: ManagedImageManifest["disk"]["chunks"][number],
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await managedFetch(chunk.url, signal);
  if (!response.ok) {
    throw new VMError(
      "STORAGE_ERROR",
      `managed artifact returned ${response.status}`,
    );
  }
  const encoded = await readManagedBody(response.body, chunk.encodedBytes, signal);
  if (
    encoded.byteLength !== chunk.encodedBytes ||
    (await sha256Hex(encoded)) !== chunk.encodedSha256
  ) {
    throw new VMError(
      "STORAGE_ERROR",
      "managed chunk failed its encoded length or SHA-256 check",
    );
  }
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    // Stream the verified bytes in small slices without the worker's Blob reader.
    const stream = managedBodyStream(encoded).pipeThrough(new DecompressionStream("gzip"));
    decoded = await readManagedBody(stream, chunk.bytes, signal);
  } catch (error) {
    assertManagedImageActive(signal);
    throw new VMError(
      "STORAGE_ERROR",
      "managed chunk could not be decompressed",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    decoded.byteLength !== chunk.bytes ||
    (await sha256Hex(decoded)) !== chunk.sha256
  ) {
    throw new VMError(
      "STORAGE_ERROR",
      "managed chunk failed its decoded length or SHA-256 check",
    );
  }
  return decoded;
}

export function managedBodyStream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const end = Math.min(offset + 16 * 1024, bytes.length);
      if (end > offset) controller.enqueue(bytes.subarray(offset, end));
      offset = end;
      if (offset === bytes.length) controller.close();
    },
  });
}

/** Decodes one cached gzip member into its declared, caller-bounded size. */
export function decodeManagedGzip(encoded: Uint8Array<ArrayBuffer>, length: number): Uint8Array<ArrayBuffer> | undefined {
  const output = new Uint8Array(length);
  const stream = new ZStream();
  if (zlibInflateInit2(stream, 15 + 16) !== Z_OK) return undefined;
  try {
    stream.input = encoded;
    stream.avail_in = encoded.length;
    stream.output = output;
    stream.avail_out = output.length;
    const status = zlibInflate(stream, Z_FINISH);
    return status === Z_STREAM_END && stream.avail_in === 0 && stream.next_out === length
      ? output : undefined;
  } finally {
    zlibInflateEnd(stream);
  }
}

export async function fetchVerified(
  artifact: ManagedImageArtifact,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (artifact.bytes > maximumBytes) {
    throw new VMError(
      "STORAGE_ERROR",
      `managed artifact exceeds ${maximumBytes} bytes`,
    );
  }
  const response = await managedFetch(artifact.url, signal);
  if (!response.ok) {
    throw new VMError(
      "STORAGE_ERROR",
      `managed artifact returned ${response.status}`,
    );
  }
  const bytes = await readManagedBody(response.body, artifact.bytes, signal);
  if (
    bytes.byteLength !== artifact.bytes ||
    (await sha256Hex(bytes)) !== artifact.sha256
  ) {
    throw new VMError(
      "STORAGE_ERROR",
      "managed artifact failed its length or SHA-256 check",
    );
  }
  return bytes;
}

async function managedFetch(url: URL, signal?: AbortSignal): Promise<Response> {
  assertManagedImageActive(signal);
  try { return await fetch(url, { cache: "no-store", credentials: "omit", ...(signal === undefined ? {} : { signal }) }); }
  catch { throw new VMError(signal?.aborted === true ? "ABORTED" : "STORAGE_ERROR", "Image download did not complete"); }
}

/** Encoded bodies, manifests and gzip output share exact bounded reads. */
export async function readManagedBody(body: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      assertManagedImageActive(signal);
      const frame = await reader.read(); if (frame.done) break;
      length += frame.value.byteLength;
      if (length > maximum) throw new VMError("STORAGE_ERROR", "Image data exceeds its declared bound");
      parts.push(frame.value);
    }
    assertManagedImageActive(signal);
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}


export function assertManagedImageActive(signal?: AbortSignal): void { if (signal?.aborted === true) throw new VMError("ABORTED", "Image installation cancelled"); }
