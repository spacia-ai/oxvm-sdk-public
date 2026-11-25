import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integer, record, string } from "./decode.js";
import { serializeUnknownError, VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { createUserspaceRuntimeVM } from "./userspace-vm.js";
import { createManagedUserspaceRuntimeVM } from "./index.js";

/** The Userspace worker behind the control worker's `attach-userspace` port: the request types it received, in order. */
const userspace = { received: new Array<string>(), ports: new Array<MessagePort>() };

/** The control worker attaches the Userspace execution; `initialize` answers with `initialized` and `dispose` succeeds. */
function scriptUserspaceWorker(initialized: () => unknown = () => undefined): void {
  ScriptedWorker.answers.set("attach-userspace", input => {
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new Error("attach-userspace carries no Userspace port");
    userspace.ports.push(port);
    port.onmessage = async (event: MessageEvent<unknown>) => {
      const request = record(event.data, "Userspace request"), type = string(request["type"], "Userspace request type");
      const id = integer(request["id"], "Userspace request id", 1);
      userspace.received.push(type);
      try {
        if (type !== "initialize" && type !== "dispose") throw new Error(`unexpected Userspace request ${type}`);
        port.postMessage({ id, version: PROTOCOL_VERSION, ok: true, value: type === "initialize" ? await initialized() : undefined });
      } catch (error) { port.postMessage({ id, version: PROTOCOL_VERSION, ok: false, error: serializeUnknownError(error) }); }
    };
    return undefined;
  });
}

/** Lets messages between channels arrive. */
async function arrive(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

const WORKERS = ["oxidevm-storage", "oxidevm-network", "oxidevm-control"] as const;
const runtime = { mode: "userspace", workspaceId: "start", memoryMiB: 256, network: "local" } as const;
const start = () => createUserspaceRuntimeVM(runtime);
const bootOptions = { trustedKeyId: "test", trustedPublicKey: new Uint8Array(32), imagePreparation: "before-ready" } as const;
function scriptManagedImage(): void {
  ScriptedWorker.answers.set("prepare-userspace-rootfs", () => ({
    id: "alpine", version: "1", rootTreeSha256: "a".repeat(64), cpuProfile: "x86-64-v2", fileCount: 1,
    totalBytes: 1, metadata: new Uint8Array(4), runtimes: { node: "usr/bin/node", bun: "usr/bin/bun", supportingFiles: [] },
  }));
  ScriptedWorker.answers.set("configure-userspace-checkpoints", () => undefined);
  ScriptedWorker.answers.set("select-userspace-files", () => ({ sourceId: "123e4567-e89b-42d3-a456-426614174001" }));
  ScriptedWorker.answers.set("start-userspace-cold", () => ({ state: "in-sync", conflicts: [], omittedConflicts: 0 }));
}

describe("a Userspace VM start", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://app.example.test/"));
  });
  afterEach(() => {
    for (const port of userspace.ports.splice(0)) port.close();
    userspace.received.length = 0;
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("starts the control worker, which starts the Userspace worker, while storage initializes", async () => {
    const storage = Promise.withResolvers<undefined>();
    ScriptedWorker.answers.set("initialize", () => storage.promise);
    scriptUserspaceWorker();
    const starting = start();
    await arrive();
    // Their scripts load alongside storage's initialize instead of after it.
    expect(ScriptedWorker.named("oxidevm-storage").operations).toEqual(["initialize"]);
    expect(ScriptedWorker.named("oxidevm-control").operations).toEqual(["attach-userspace"]);
    // The Userspace worker receives its storage and network ports only once storage has initialized.
    expect(userspace.received).toEqual([]);
    storage.resolve(undefined);
    const vm = await starting;
    expect(userspace.received).toEqual(["initialize"]);
    await vm.dispose();
    expect(userspace.received).toEqual(["initialize", "dispose"]);
  });

  it("releases the workspace reserve before the final Userspace publication", async () => {
    scriptUserspaceWorker();
    const vm = await start();
    const reserve = Promise.withResolvers<undefined>();
    ScriptedWorker.answers.set("release-workspace-reserve", () => reserve.promise);
    const disposed = vm.dispose();
    try {
      await arrive();
      expect(ScriptedWorker.named("oxidevm-storage").operations).toEqual(["initialize", "release-workspace-reserve"]);
      expect(userspace.received).toEqual(["initialize"]);
    } finally { reserve.resolve(undefined); await disposed; }
    expect(userspace.received).toEqual(["initialize", "dispose"]);
    expect(ScriptedWorker.named("oxidevm-storage").operations).toEqual(["initialize", "release-workspace-reserve", "dispose"]);
  });

  it("identifies a failed reserve release while still disposing the execution and storage workers", async () => {
    scriptUserspaceWorker();
    const vm = await start();
    ScriptedWorker.answers.set("release-workspace-reserve", () => {
      throw new VMError("STORAGE_ERROR", "could not release the reserve", { name: "UnknownError" });
    });
    await expect(vm.dispose()).rejects.toMatchObject({
      code: "STORAGE_ERROR", message: "could not release the reserve",
      detail: { name: "UnknownError", disposalStage: "workspace-reserve" },
    });
    expect(userspace.received).toEqual(["initialize", "dispose"]);
    expect(ScriptedWorker.named("oxidevm-storage").operations).toEqual(["initialize", "release-workspace-reserve", "dispose"]);
  });

  it("reports a failed storage initialize, not the earlier failure it caused, and ends every worker it started", async () => {
    const storage = Promise.withResolvers<undefined>();
    ScriptedWorker.answers.set("initialize", () => storage.promise);
    ScriptedWorker.answers.set("attach-userspace", () => { throw new VMError("PROTOCOL_ERROR", "the control worker failed"); });
    const failed = expect(start()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await arrive();
    storage.reject(new VMError("STORAGE_ERROR", "the workspace cannot be opened"));
    await failed;
    for (const name of WORKERS) expect(ScriptedWorker.named(name).terminated, name).toBe(true);
    expect(userspace.received).toEqual([]);
  });

  it("ends every worker it started when the Userspace worker cannot initialize", async () => {
    scriptUserspaceWorker(() => { throw new VMError("CORE_LOAD_FAILED", "Userspace Wasm fetch failed"); });
    await expect(start()).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    for (const name of WORKERS) expect(ScriptedWorker.named(name).terminated, name).toBe(true);
    expect(userspace.received).toEqual(["initialize"]);
  });

  it("starts durable installation during engine initialization and waits for both before admitting the guest", async () => {
    const engine = Promise.withResolvers<undefined>();
    const installation = Promise.withResolvers<undefined>();
    scriptUserspaceWorker(() => engine.promise);
    scriptManagedImage();
    ScriptedWorker.answers.set("prepare-image", () => installation.promise);
    const created = vi.fn();
    const booting = createManagedUserspaceRuntimeVM(runtime, "/rootfs.json", bootOptions, created);
    await arrive();
    const control = ScriptedWorker.named("oxidevm-control"), storage = ScriptedWorker.named("oxidevm-storage");
    expect(userspace.received).toEqual(["initialize"]);
    expect(control.inputs).toContainEqual(expect.objectContaining({ type: "prepare-image", reason: "first-install" }));
    expect(control.operations).not.toContain("configure-userspace-checkpoints");
    expect(created).not.toHaveBeenCalled();
    engine.resolve(undefined);
    await arrive();
    expect(created).toHaveBeenCalledTimes(1);
    expect(control.operations).toContain("configure-userspace-checkpoints");
    expect(storage.operations).not.toContain("select-userspace-files");
    expect(control.operations).not.toContain("start-userspace-cold");
    installation.resolve(undefined);
    const { vm, image } = await booting;
    expect(created).toHaveBeenCalledWith(vm);
    expect(image.start.kind).toBe("booted");
    await vm.dispose();
  });
});
