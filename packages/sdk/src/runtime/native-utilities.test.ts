import { describe, expect, it } from "vitest";
import { decodeSerializedError, serializeUnknownError, VMError } from "./errors.js";
import { assertNativeUtilities, decodeNativeUtilitySuite, nativeUtilitiesOf } from "./native-utilities.js";
import { decodePreparedUserspaceRootfs } from "./protocol/storage.js";

const suite = { identity: "oxidevm-rust-toybox", abi: 1, catalogSha256: "a".repeat(64) } as const;

it("extracts engine requirements only from a supported release schema", () => {
  expect(nativeUtilitiesOf({ schemaVersion: 4 })).toBeUndefined();
  expect(nativeUtilitiesOf({ schemaVersion: 5, nativeUtilities: suite })).toEqual(suite);
  for (const release of [{ schemaVersion: 5 }, { schemaVersion: 6, nativeUtilities: suite },
    { schemaVersion: 4, nativeUtilities: suite }]) expect(() => nativeUtilitiesOf(release)).toThrow();
});

it("prepared rootfs records preserve the native requirement across worker and restore boundaries", () => {
  const record = { id: "native", version: "1", cpuProfile: "x86-64-v3", rootTreeSha256: "a".repeat(64),
    fileCount: 0, totalBytes: 0, metadata: new Uint8Array(), runtimes: { supportingFiles: [] }, nativeUtilities: suite };
  expect(decodePreparedUserspaceRootfs(record).nativeUtilities).toEqual(suite);
  expect(() => decodePreparedUserspaceRootfs({ ...record, nativeUtilities: { ...suite, abi: 0 } })).toThrow();
});

describe("native utility engine/image identity", () => {
  it("accepts matching identities and preserves images without native requirements", () => {
    const expected = decodeNativeUtilitySuite(suite);
    expect(expected).toEqual(suite);
    expect(() => assertNativeUtilities(undefined, undefined)).not.toThrow();
    expect(() => assertNativeUtilities(undefined, expected)).not.toThrow();
    expect(() => assertNativeUtilities(expected, expected)).not.toThrow();
  });

  it.each([
    null, [], {}, { ...suite, identity: "plugin" }, { ...suite, abi: 0 },
    { ...suite, abi: 65536 }, { ...suite, abi: "1" },
    { ...suite, catalogSha256: "A".repeat(64) }, { ...suite, catalogSha256: "short" },
    { ...suite, extra: true },
  ])("rejects malformed requirements: %j", input => {
    expect(() => decodeNativeUtilitySuite(input)).toThrow();
  });

  it.each([
    [undefined, "engine-support-missing"],
    [{ ...suite, abi: 2 }, "abi-mismatch"],
    [{ ...suite, catalogSha256: "b".repeat(64) }, "catalog-mismatch"],
  ] as const)("reports a typed compatibility error for %j", (provided, reason) => {
    let failure: unknown;
    try {
      assertNativeUtilities(decodeNativeUtilitySuite(suite),
        provided === undefined ? undefined : decodeNativeUtilitySuite(provided));
    } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(VMError);
    const transported = decodeSerializedError(serializeUnknownError(failure));
    expect(transported.code).toBe("NATIVE_UTILITY_MISMATCH");
    expect(transported.detail?.["reason"]).toBe(reason);
  });
});
