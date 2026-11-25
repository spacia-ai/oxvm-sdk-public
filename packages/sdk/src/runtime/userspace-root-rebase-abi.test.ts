import { expect, it } from "vitest";
import { decodeRootRebaseStep, encodeRootRebaseSource } from "./userspace-root-rebase-abi.js";

const header = [0x4f, 0x58, 0x52, 0x47, 1, 0, 0, 0];

it("encodes the verified source identity and signed image metadata", () => {
  const metadata = Uint8Array.from([0x4f, 0x58, 0x52, 0x46, 5, 0, 0, 0, 0, 0, 0, 0]);
  const source = encodeRootRebaseSource({ rootTreeSha256: "07".repeat(32), metadata });
  expect(source.slice(0, 8)).toEqual(Uint8Array.of(0x4f, 0x58, 0x52, 0x4d, 1, 0, 0, 0));
  expect(source.slice(8, 40)).toEqual(new Uint8Array(32).fill(7));
  expect(source.slice(40)).toEqual(metadata);
});

it("validates migration requests before admitting source reads or completion", () => {
  const ready = Uint8Array.of(...header, 0, 3, 0, 0, 0);
  expect(decodeRootRebaseStep(ready)).toEqual({ kind: "ready", conflicts: 3 });
  const path = new TextEncoder().encode("/usr/local/bin/ls");
  expect(decodeRootRebaseStep(Uint8Array.of(...header, 2, ...path))).toEqual({ kind: "shadowed", path: "/usr/local/bin/ls" });
  expect(decodeRootRebaseStep(Uint8Array.of(...header, 3, ...new TextEncoder().encode("/etc/user-"), 255)))
    .toEqual({ kind: "conflict", path: "/etc/user-\\xff" });
  const file = Uint8Array.of(...header, 1, 255, 255, 0, 0, 0, 0, 0, 0, ...new Uint8Array(32).fill(4), ...path);
  expect(decodeRootRebaseStep(file)).toEqual({ kind: "file", bytes: 65_535, sha256: "04".repeat(32), path: "/usr/local/bin/ls" });
  for (const invalid of [ready.subarray(0, 12), Uint8Array.of(...ready, 1), Uint8Array.of(...header, 2, 47, 255),
    Uint8Array.of(...header, 2, ...new TextEncoder().encode("/etc/../bin"))]) {
    expect(() => decodeRootRebaseStep(invalid)).toThrow(/Invalid persistent-root/u);
  }
});
