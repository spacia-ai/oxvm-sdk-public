import { invalidType, validateInteger, validateObject } from "./node-util-validators.ts";
import type { AeadMode } from "./node-crypto-cipher-aead.ts";
import type { PlainMode } from "./node-crypto-cipher-modes.ts";

/** The ciphers this runtime provides, with the names and numbers OpenSSL 3.5 gives them. */
export interface CipherSpec {
  readonly mode: PlainMode | AeadMode;
  /** OpenSSL's own name, as `getCipherInfo` reports it. */
  readonly name: string;
  readonly nid: number;
  readonly blockSize: number | undefined;
  readonly ivLength: number;
  readonly keyLength: number;
  readonly aead: boolean;
}
export interface CipherInfo { mode: string; name: string; nid: number; blockSize?: number; ivLength?: number; keyLength: number }

/** [mode, NIDs for 128/192/256-bit keys, block size, IV length]. */
const aesModes: readonly (readonly [mode: PlainMode | AeadMode, nids: readonly [number, number, number], blockSize: number, ivLength: number])[] = [
  ["cbc", [419, 423, 427], 16, 16], ["ecb", [418, 422, 426], 16, 0], ["cfb", [421, 425, 429], 1, 16], ["ofb", [420, 424, 428], 1, 16],
  ["cfb1", [650, 651, 652], 1, 16], ["cfb8", [653, 654, 655], 1, 16], ["ctr", [904, 905, 906], 1, 16],
  ["gcm", [895, 898, 901], 1, 12], ["ccm", [896, 899, 902], 1, 12], ["ocb", [958, 959, 960], 16, 12], ["wrap", [788, 789, 790], 8, 8],
];
const specs: CipherSpec[] = [];
/** Lower-cased lookup name to cipher: OpenSSL matches names without regard to case. */
const byName = new Map<string, CipherSpec>();
/** The names `getCiphers` lists, in Node's spelling. */
const listed: string[] = [];
function register(spec: CipherSpec, names: readonly string[]): void {
  specs.push(spec);
  for (const name of names) { listed.push(name); byName.set(name.toLowerCase(), spec); }
}
for (const [mode, nids, blockSize, ivLength] of aesModes) {
  [128, 192, 256].forEach((bits, index) => {
    const aead = mode === "gcm" || mode === "ccm" || mode === "ocb";
    const base = { mode, nid: nids[index] ?? 0, blockSize, ivLength, keyLength: bits / 8, aead };
    const size = String(bits);
    if (mode === "wrap") register({ ...base, name: `id-aes${size}-wrap` }, [`aes${size}-wrap`, `id-aes${size}-wrap`]);
    else if (mode === "gcm" || mode === "ccm") register({ ...base, name: `id-aes${size}-${mode}` }, [`aes-${size}-${mode}`, `id-aes${size}-${mode.toUpperCase()}`]);
    else register({ ...base, name: `aes-${size}-${mode}` }, mode === "cbc" ? [`aes-${size}-cbc`, `aes${size}`] : [`aes-${size}-${mode}`]);
  });
}
register({ mode: "chacha20", name: "chacha20", nid: 1019, blockSize: undefined, ivLength: 16, keyLength: 32, aead: false }, ["chacha20"]);
register({ mode: "chacha20-poly1305", name: "chacha20-poly1305", nid: 1018, blockSize: undefined, ivLength: 12, keyLength: 32, aead: true }, ["chacha20-poly1305"]);
listed.sort();

export function findCipher(name: string): CipherSpec | undefined { return byName.get(name.toLowerCase()); }
export function cipherNames(): string[] { return [...listed]; }

const INT32_MIN = -2_147_483_648, INT32_MAX = 2_147_483_647;
function lengthOption(options: object, key: "keyLength" | "ivLength"): number | undefined {
  const value: unknown = Reflect.get(options, key);
  if (value === undefined) return undefined;
  validateInteger(value, `options.${key}`, INT32_MIN, INT32_MAX);
  return value;
}
/** Whether OpenSSL lets a context of this cipher take an IV of `length` bytes (`EVP_CTRL_AEAD_SET_IVLEN`). */
function acceptsIvLength(spec: CipherSpec, length: number): boolean {
  if (spec.mode === "ccm") return length >= 7 && length <= 13;
  if (spec.mode === "gcm") return length >= 0;
  if (spec.mode === "ocb") return length >= 1 && length <= 15;
  return length === spec.ivLength;
}
/** `crypto.getCipherInfo`: undefined for an unknown cipher or a length the cipher cannot take. */
export function getCipherInfo(nameOrNid: unknown, options?: unknown): CipherInfo | undefined {
  if (typeof nameOrNid !== "string" && typeof nameOrNid !== "number") {
    const error = invalidType("nameOrNid", "string or number", nameOrNid);
    error.message = error.message.replace("must be of type", "must be one of type");
    throw error;
  }
  if (typeof nameOrNid === "number") validateInteger(nameOrNid, "nameOrNid", INT32_MIN, INT32_MAX);
  let keyLength: number | undefined, ivLength: number | undefined;
  if (options !== undefined) {
    validateObject(options, "options");
    keyLength = lengthOption(options, "keyLength");
    ivLength = lengthOption(options, "ivLength");
  }
  const spec = typeof nameOrNid === "string" ? findCipher(nameOrNid) : specs.find(candidate => candidate.nid === nameOrNid);
  if (spec === undefined) return undefined;
  if (keyLength !== undefined && keyLength !== spec.keyLength) return undefined;
  let reportedIv = spec.ivLength;
  if (ivLength !== undefined) {
    if (!acceptsIvLength(spec, ivLength)) return undefined;
    reportedIv = ivLength;
  }
  const mode = spec.mode === "chacha20" || spec.mode === "chacha20-poly1305" ? "stream" : spec.mode.replace(/[18]$/u, "");
  // Node adds the properties in this order; a zero IV length is left out.
  return {
    mode, name: spec.name, nid: spec.nid,
    ...(spec.blockSize === undefined ? {} : { blockSize: spec.blockSize }),
    ...(reportedIv === 0 ? {} : { ivLength: reportedIv }),
    keyLength: spec.keyLength,
  };
}
