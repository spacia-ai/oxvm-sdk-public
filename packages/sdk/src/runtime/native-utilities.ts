import { decodeSHA256, type SHA256 } from "../values.js";
import { exactKeys, integer, protocolError, record } from "./decode.js";
import { VMError } from "./errors.js";
import { engineRelease } from "../engine.generated.js";

export const NATIVE_UTILITY_MARKER_PATH = "/usr/libexec/oxidevm/toybox";

/** Build-time Rust commands compiled into one engine, separate from application modules. */
export interface NativeUtilityRequirement {
  readonly identity: "oxidevm-rust-toybox";
  readonly abi: number;
  readonly catalogSha256: string;
}

export interface NativeUtilitySuite extends NativeUtilityRequirement {
  readonly catalogSha256: SHA256;
}

export function decodeNativeUtilitySuite(value: unknown): NativeUtilitySuite {
  const suite = record(value, "native utility suite");
  exactKeys(suite, ["identity", "abi", "catalogSha256"]);
  if (suite["identity"] !== "oxidevm-rust-toybox") throw protocolError("Unknown native utility suite");
  return { identity: "oxidevm-rust-toybox", abi: integer(suite["abi"], "native utility ABI", 1, 0xffff),
    catalogSha256: decodeSHA256(suite["catalogSha256"], "native utility catalog") };
}

/** Read the closed suite contract from a pinned engine release. */
export function nativeUtilitiesOf(value: unknown): NativeUtilitySuite | undefined {
  const release = record(value, "engine release");
  if (release["schemaVersion"] === 4 && release["nativeUtilities"] === undefined) return undefined;
  if (release["schemaVersion"] !== 5) throw protocolError("Unsupported native utility release schema");
  return decodeNativeUtilitySuite(release["nativeUtilities"]);
}

export function assertImageNativeUtilities(required: NativeUtilitySuite | undefined): void {
  if (required !== undefined) assertNativeUtilities(required, nativeUtilitiesOf(engineRelease));
}

/** Refuse an incompatible image before any native utility can run. */
export function assertNativeUtilities(required: NativeUtilitySuite | undefined, provided: NativeUtilitySuite | undefined): void {
  if (required === undefined) return;
  const reason = provided === undefined ? "engine-support-missing"
    : required.abi !== provided.abi ? "abi-mismatch"
    : required.catalogSha256 !== provided.catalogSha256 ? "catalog-mismatch" : undefined;
  if (reason !== undefined) throw new VMError("NATIVE_UTILITY_MISMATCH",
    "The Userspace image requires a different Rust utility suite", { reason, required, provided: provided ?? null });
}
