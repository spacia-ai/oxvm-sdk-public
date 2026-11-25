import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { HostAttention } from "../host-attention.js";
import { encodeFilesystemRecord, type RootfsMetadataEntry } from "../userspace-rootfs-record.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { readUserspaceOutput } from "./userspace-output.js";
import { admitInitialUserspaceProcess } from "./userspace-process-admission.js";
import { runUserspaceSlice, type UserspaceSlicePorts } from "./userspace-run-loop.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { stage, termination } from "./userspace-tier2.test-support.js";
import { newRuntimeState } from "./userspace-worker-state.js";

// The engine's toybox_reference --marker output keeps marker identity in the engine owner.
const markerPath = process.env["OXIDEVM_RUST_UTILITIES_MARKER"];
const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

it.skipIf(markerPath === undefined)("admits a Rust shell through the SDK and yields without JavaScript commands or JIT dispatch", async () => {
  if (markerPath === undefined) throw new Error("OXIDEVM_RUST_UTILITIES_MARKER is required");
  const runtime = await instantiateRuntime(
    await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")))),
    "rust-utilities-core-test", { kind: "disabled" }, "immediate",
  );
  try {
    const entry = (path: string, tag: number, mode: number, payload = new Uint8Array()): RootfsMetadataEntry => ({
      path: encode(path), pathText: path, tag, mode, payload, ownership: { uid: 0, gid: 0 },
    });
    const entries = ["/", "/usr", "/usr/libexec", "/usr/libexec/oxidevm", "/bin", "/tmp"].map(path => entry(path, 0, path === "/tmp" ? 0o1777 : 0o755));
    entries.push(entry("/usr/libexec/oxidevm/toybox", 1, 0o555, new Uint8Array(await readFile(markerPath))));
    for (const name of ["sh", "echo", "printf", "cat", "head", "test", "mkdir", "rmdir", "link", "unlink", "pwd", "tee", "wc", "base32", "base64", "true", "false", "date", "ts", "uname", "arch", "sleep", "sync", "fsync"]) {
      entries.push(entry(`/bin/${name}`, 2, 0o777, encode("/usr/libexec/oxidevm/toybox")));
    }
    const metadata = encodeFilesystemRecord(entries, "rootfs");
    stage(runtime, metadata);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", metadata.byteLength, 1, 128)).toBe(0);
    const pid = await admitInitialUserspaceProcess(runtime, { kind: "file", filename: "/bin/sh" }, {
      arguments: ["sh", "-c", "f() { export VALUE=kept; echo \"$VALUE\"; }; f >/tmp/out; if test -f /tmp/out; then cat /tmp/out | head -n 1; fi; echo \"$((7*4)):$(cat /tmp/out)\"; echo \"$((0x8000000000000000 / -1))\"; mkdir -p /tmp/tools/sub; link /tmp/out /tmp/tools/link; cat /tmp/tools/link | tee /tmp/tools/copy | wc -l; unlink /tmp/tools/link; rmdir /tmp/tools/sub; pwd -P; set -- first 'two words'; arg() { echo \"$#:$1:$2\"; }; arg one two; echo \"$#:$1:$2\"; wc /tmp/out 1>&-; echo \"write:$?\"; set -- 'one two' '' last; fields() { echo \"$#:$1:$2:$3\"; }; fields \"$@\"; for item in \"$@\"; do echo \"<$item>\"; done; if false; then echo wrong; elif true; then echo branch; fi; uname -snrvm; uname -op; arch; sleep 0; fsync /tmp/tools/copy; sync; echo \"${saved:=${missing:-default}}:${#saved}\"; echo 'Rust codecs' | base64 | base64 -d; echo 'Rust codecs' | base32 | base32 -d; date -u -d @-1.123456789 '+%F %T.%N'; date -u -D '%F' -d 1970-01-01 '+%s'; date -u -s @0 >/tmp/date-out 2>/tmp/date-error; echo set:$?; cat /tmp/date-error /tmp/date-out; printf 'one\\ntwo' | ts stamp; printf 'line\\n' | ts -s '%Y-%m-%d'; echo complete"],
      environment: ["PATH=/bin"], cwd: "/",
    }, () => {}, () => Promise.resolve(false));
    const active = newRuntimeState(runtime, "ready", undefined, undefined);
    const translated = vi.spyOn(runtime.jitRuntime, "runLinuxBlock");
    let now = 0, scheduled = 0;
    const ports: UserspaceSlicePorts = {
      now: () => now++, interactiveUntil: () => 0, attention: new HostAttention(),
      servicePendingWork: () => {},
      serviceHostRequests: () => {},
      finishResult: () => { expect(active.pendingResult?.kind).toBe("exit"); },
      scheduleRun: () => { scheduled += 1; },
    };
    for (let slice = 0; slice < 100 && termination(runtime, pid) === 0xffff_ffff; slice += 1) {
      runUserspaceSlice(active, ports);
    }
    expect(termination(runtime, pid)).toBe(0);
    expect(readUserspaceOutput(runtime, pid, "stderr")).toHaveLength(0);
    expect(new TextDecoder().decode(readUserspaceOutput(runtime, pid, "stdout"))).toBe("kept\n28:kept\n-9223372036854775808\n1\n/\n2:one:two\n2:first:two words\nwrite:1\n3:one two::last\n<one two>\n<>\n<last>\nbranch\nLinux oxidevm 6.18.40-oxidevm #1 x86_64\nToyboxunknown\nx86_64\ndefault:7\nRust codecs\nRust codecs\n1969-12-31 23:59:59.123456789\n0\nset:1\ndate: cannot set date: Function not implemented\nThu Jan  1 00:00:00 UTC 1970\nstamp one\nstamp two\n1970-01-01 line\ncomplete\n");
    expect(active.jsProcesses).toBeUndefined();
    expect(translated).not.toHaveBeenCalled();
    expect(scheduled).toBeGreaterThan(0);
  } finally { await runtime.jitRuntime.dispose(); }
});
