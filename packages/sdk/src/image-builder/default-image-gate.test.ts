import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildImage } from "./build.js";
import { generateImageKey } from "./keys.js";
import { defaultHistoryKey, requireReadableDefaultImage } from "./default-image-gate.js";

const suite = vi.hoisted(() => ({
  identity: "oxidevm-rust-toybox" as const, abi: 1, catalogSha256: "a".repeat(64),
}));
vi.mock("../engine.generated.js", () => ({ engineRelease: { schemaVersion: 5, nativeUtilities: suite } }));

const DIGEST = "ab".repeat(32);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(made => rm(made, { recursive: true, force: true })));
});

async function defaultDirectory(lock: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-default-gate-"));
  directories.push(dir);
  await writeFile(join(dir, "image.lock.json"), `${JSON.stringify(lock)}\n`);
  return dir;
}

const STALE_LOCK = {
  schemaVersion: 1,
  mode: "userspace",
  id: "sdk-alpine-smoke",
  version: "2026.10.14-rc.4",
  manifestSHA256: DIGEST,
};

it("refuses a default bundle this SDK cannot read, naming the directory and the reason", async () => {
  const dir = await defaultDirectory(STALE_LOCK);

  const failure = await requireReadableDefaultImage(dir).then(() => undefined, (error: unknown) => error);

  expect(failure).toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "image-lock-version", directory: dir },
  });
  expect(failure).toHaveProperty("message", expect.stringContaining(dir));
});

it("keeps a stale default in history under the manifest digest its lock records", async () => {
  const dir = await defaultDirectory(STALE_LOCK);

  await expect(defaultHistoryKey(dir)).resolves.toBe(DIGEST);
});

it("names a retired default by its recorded digest without verifying the bundle it retires", async () => {
  // A lock that no reader would accept, but which records a digest: retirement needs only the digest.
  const dir = await defaultDirectory({ schemaVersion: 2, manifestSHA256: DIGEST });

  await expect(defaultHistoryKey(dir)).resolves.toBe(DIGEST);
  await expect(requireReadableDefaultImage(dir)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

it("refuses a retired default whose lock records no digest", async () => {
  const dir = await defaultDirectory({ schemaVersion: 2 });

  await expect(defaultHistoryKey(dir)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

it("rejects a signed default that requires a different native utility catalog before staging its pin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oxidevm-default-native-gate-"));
  directories.push(dir);
  await mkdir(join(dir, "root"));
  await writeFile(join(dir, "root", "payload"), "owned test bytes");
  const key = await generateImageKey(join(dir, "author.pem"));
  const recipe = { id: "native-default", version: "1", mode: "userspace" as const,
    source: { kind: "directory" as const, path: "root" },
    smokeTest: { command: "/bin/true", expectedExitCode: 0 as const },
  };
  const mismatch = await buildImage({ ...recipe, nativeUtilities: { ...suite, catalogSha256: DIGEST } },
    { recipeDir: dir, signingKeyFile: key.privateKeyPath, outDir: "mismatch" });
  await expect(requireReadableDefaultImage(mismatch.bundleDir, key.trust)).rejects.toMatchObject({
    code: "NATIVE_UTILITY_MISMATCH", detail: { reason: "catalog-mismatch", directory: mismatch.bundleDir },
  });
  const matching = await buildImage({ ...recipe, nativeUtilities: suite },
    { recipeDir: dir, signingKeyFile: key.privateKeyPath, outDir: "matching" });
  await expect(requireReadableDefaultImage(matching.bundleDir, key.trust)).resolves.toMatchObject({
    image: { manifestSHA256: matching.image.manifestSHA256 },
  });
});
