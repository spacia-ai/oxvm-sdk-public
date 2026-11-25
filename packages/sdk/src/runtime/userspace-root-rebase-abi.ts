import { exactKeys, record, string } from "./decode.js";
import { decodeBytes } from "./protocol/decoders.js";
import { VMError } from "./errors.js";

const MAX_ROOT_METADATA = 128 * 1024 ** 2;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface RootRebaseSource {
  readonly rootTreeSha256: string;
  readonly metadata: Uint8Array;
}

export type RootRebaseStep =
  | { readonly kind: "ready"; readonly conflicts: number }
  | { readonly kind: "file"; readonly path: string; readonly bytes: number; readonly sha256: string }
  | { readonly kind: "conflict"; readonly path: string }
  | { readonly kind: "shadowed"; readonly path: string };

export function decodeRootRebaseSource(value: unknown): RootRebaseSource | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "previous signed root");
  exactKeys(source, ["rootTreeSha256", "metadata"]);
  const rootTreeSha256 = string(source["rootTreeSha256"], "previous root identity");
  const metadata = decodeBytes(source["metadata"]);
  if (!/^[\da-f]{64}$/u.test(rootTreeSha256) || metadata.length < 12
    || metadata.length > MAX_ROOT_METADATA - 40) return invalid();
  return { rootTreeSha256, metadata };
}

export function encodeRootRebaseSource(source: RootRebaseSource): Uint8Array<ArrayBuffer> {
  if (!/^[\da-f]{64}$/u.test(source.rootTreeSha256) || source.metadata.length < 12
    || source.metadata.length > MAX_ROOT_METADATA - 40) return invalid();
  const input = new Uint8Array(40 + source.metadata.length);
  input.set([0x4f, 0x58, 0x52, 0x4d, 1, 0, 0, 0]);
  for (let byte = 0; byte < 32; byte += 1) {
    input[8 + byte] = Number.parseInt(source.rootTreeSha256.slice(byte * 2, byte * 2 + 2), 16);
  }
  input.set(source.metadata, 40);
  return input;
}

export function decodeRootRebaseStep(input: Uint8Array): RootRebaseStep {
  if (input.length < 9 || new TextDecoder().decode(input.subarray(0, 4)) !== "OXRG") return invalid();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(4, true) !== 1) return invalid();
  if (input[8] === 0) {
    if (input.length !== 13) return invalid();
    const conflicts = view.getUint32(9, true);
    if (conflicts > 131_072) return invalid();
    return { kind: "ready", conflicts };
  }
  if (input[8] === 2) return { kind: "shadowed", path: path(input.subarray(9)) };
  if (input[8] === 3) return { kind: "conflict", path: path(input.subarray(9), true) };
  if (input[8] !== 1 || input.length < 50) return invalid();
  const bytes = view.getBigUint64(9, true);
  if (bytes > 3n * 1024n ** 3n) return invalid();
  const sha256 = Array.from(input.subarray(17, 49), byte => byte.toString(16).padStart(2, "0")).join("");
  return { kind: "file", bytes: Number(bytes), sha256, path: path(input.subarray(49)) };
}

function path(input: Uint8Array, byteLabel = false): string {
  if (input.length < 2 || input.length > 4096 || input[0] !== 47 || input.includes(0)) return invalid();
  let path: string;
  try { path = decoder.decode(input); }
  catch {
    if (!byteLabel) return invalid();
    path = Array.from(input, byte => byte >= 32 && byte < 127 && byte !== 92
      ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  }
  if (path.slice(1).split("/").some(part => part === "" || part === "." || part === "..")) return invalid();
  return path;
}

function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid persistent-root rebase record"); }
