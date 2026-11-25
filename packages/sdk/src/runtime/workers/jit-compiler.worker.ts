/// <reference lib="webworker" />

// Compiles translated JIT modules off the guest's execution thread. The execution worker bounds
// how many compiles are in flight; responses may arrive in any order and each follows a bump of
// the shared ready counter, so the execution worker can end its slice and install the module.

import { serializeUnknownError } from "../errors.js";
import { postCounted, type AttentionCounter } from "../host-attention.js";
import { decodeJitModuleExit, JIT_CONTEXT_LENGTH } from "../core-abi.js";
import { JIT_DISPATCH_TABLE_ENTRIES, MAX_LINKED_JIT_MEMBERS } from "../jit-cache.js";
import {
  JIT_COMPILER_PROTOCOL_VERSION,
  type JitCompilerRequest,
  type JitCompilerResponse,
  decodeJitCompilerRequest,
} from "./control/jit-compiler-protocol.js";

let ready: AttentionCounter | null = null;
let warmEntries = false;
let scratch: WebAssembly.ModuleImports | undefined;

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  let request: JitCompilerRequest;
  try {
    request = decodeJitCompilerRequest(event.data);
  } catch (error) {
    fail(error);
    return;
  }
  if (request.type === "attach") {
    ready = request.ready;
    warmEntries = request.warmEntries;
    return;
  }
  compile(request).catch(fail);
});

function fail(error: unknown): void {
  self.postMessage({
    version: JIT_COMPILER_PROTOCOL_VERSION,
    type: "protocol-failure",
    error: serializeUnknownError(error),
  });
  self.close();
}

async function compile(request: Extract<JitCompilerRequest, { readonly type: "compile" }>): Promise<void> {
  const started = performance.now();
  let response: JitCompilerResponse;
  try {
    const module = await WebAssembly.compile(request.bytes);
    if (warmEntries) warmModuleEntries(module);
    response = {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "compiled",
      id: request.id,
      epoch: request.epoch,
      module,
      compileMilliseconds: performance.now() - started,
    };
  } catch (error) {
    response = {
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: request.id,
      epoch: request.epoch,
      errorName: error instanceof Error ? error.name.slice(0, 64) : "non-Error",
      reason: error instanceof Error ? error.message : "non-Error JIT compiler failure",
    };
  }
  postCounted(ready, () => { self.postMessage(response); });
}

function warmModuleEntries(module: WebAssembly.Module): void {
  if (scratch === undefined) {
    const pages = Math.ceil(JIT_CONTEXT_LENGTH / 65_536);
    const table = new WebAssembly.Table({ element: "anyfunc", initial: JIT_DISPATCH_TABLE_ENTRIES });
    scratch = {
      memory: new WebAssembly.Memory({ initial: pages, maximum: pages }),
      dispatch_table: table,
      record_dispatch_table: table,
    };
  }
  const functions = WebAssembly.Module.imports(module).filter(entry => entry.kind === "function");
  const imports = Object.fromEntries(functions.map(entry => [entry.name, warmupImport]));
  const instance = new WebAssembly.Instance(module, { oxidevm: { ...imports, ...scratch } });
  const members = instance.exports["member_table"];
  if (members === undefined) {
    warmEntry(instance.exports["trace"]);
    return;
  }
  if (!(members instanceof WebAssembly.Table) || members.length === 0 || members.length > MAX_LINKED_JIT_MEMBERS) {
    throw new Error("Invalid JIT warm-up member table");
  }
  for (let index = 0; index < members.length; index++) warmEntry(members.get(index));
}

function warmupImport(): never {
  throw new Error("JIT warm-up reached an engine helper");
}

function warmEntry(entry: unknown): void {
  if (typeof entry !== "function") throw new Error("Invalid JIT warm-up entry");
  // A zero budget stops the translated entry before it executes a guest instruction.
  const exit: unknown = Reflect.apply(entry, undefined, [0, 0n, 0]);
  if (decodeJitModuleExit(exit) !== "guard") throw new Error("JIT warm-up did not return the entry guard exit");
}
