import { decodeProcessId } from "../../values.js";
import { integer } from "../decode.js";
import { JS_MAILBOX_BYTES, Reader, protocol, decodeJSIdentity, writeBytes, type JSProcessIdentity } from "./codec.js";
export type { JSProcessIdentity } from "./codec.js";

const REQUEST_MAGIC = new TextEncoder().encode("OXJR");
const REQUEST_HEADER_BYTES = 36;

export interface JSCompletion extends JSProcessIdentity { readonly sequence: number; readonly pid: number; readonly errno: number; readonly value: bigint; readonly payload: Uint8Array }
export function encodeJSRequest(identity: JSProcessIdentity, sequence: number, operation: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = REQUEST_HEADER_BYTES + payload.byteLength;
  if (length > JS_MAILBOX_BYTES - 64) protocol("Linux request exceeds its byte limit");
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  writeBytes(bytes, REQUEST_MAGIC);
  view.setUint32(4, 4, true);
  view.setBigUint64(8, identity.generation, true);
  view.setBigUint64(16, identity.id, true);
  view.setBigUint64(24, BigInt(integer(sequence, "u64", 0)), true);
  view.setUint32(32, integer(operation, "u32", 0, 0xffff_ffff), true);
  writeBytes(bytes, payload, REQUEST_HEADER_BYTES);
  return bytes;
}
export function decodeJSCompletion(bytes: Uint8Array): JSCompletion {
  const r = new Reader(bytes);
  if (new TextDecoder().decode(r.raw(4)) !== "OXJP" || r.u32() !== 1) protocol("Linux completion version mismatch");
  const { generation, id } = decodeJSIdentity(r.u64(), r.u64());
  const bigSequence = r.u64(), pid = decodeProcessId(r.u32()), errno = r.u32(), value = r.u64(), payload = r.blob(); r.end();
  if (generation === 0n || id === 0n || bigSequence === 0n || bigSequence > BigInt(Number.MAX_SAFE_INTEGER) || errno > 4095 || (errno !== 0 && (value !== 0n || payload.byteLength !== 0))) protocol("Invalid Linux completion identity or result");
  return { generation, id, sequence: Number(bigSequence), pid, errno, value, payload };
}
