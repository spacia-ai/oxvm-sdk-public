import { VMError } from "../runtime/errors.js";
import { copyKey, COPY_MISSING_REASON, decodeMissingKeys, type CopyKey, type ModulePin } from "../runtime/protocol/userspace-module-files.js";
import type { PinnedFile } from "./handle.js";
import type { LaunchDescriptor } from "./runner/descriptor.js";
import { ADAPTER_FILE, readPinned, type Fetcher } from "./runner/pinned.js";

/**
 * The page's half of verify-once (engine ADR 0028): the VM's verified-copy store says which pinned files it lacks, the
 * page reads only those from its own origin, within each pin's size, and sends them with the start or the enable. The
 * store hashes them before any of the module's code runs; the page hashes nothing. A file that cannot be read is
 * CORE_LOAD_FAILED `wasm-module-artifact`, naming it in `detail.file`, before anything reaches the VM.
 */

/** What the supply needs of a VM: which pins its store lacks. */
export interface ModuleFileOwner {
  readonly missing: (pins: readonly ModulePin[], signal: AbortSignal | undefined) => Promise<readonly CopyKey[]>;
}

/** The page's own `fetch`, bound late so a page that replaces it (or a test) is used. */
const pageFetch: Fetcher = (url, init) => fetch(url, { signal: init.signal });

function files(descriptor: LaunchDescriptor): readonly { readonly file: string; readonly pin: PinnedFile }[] {
  return [{ file: ADAPTER_FILE, pin: descriptor.adapter }, ...Object.entries(descriptor.artifacts).map(([file, pin]) => ({ file, pin }))];
}

/** Reads the files whose keys are `missing`, each once and in turn, so at most one is in flight. */
export async function readMissingFiles(descriptor: LaunchDescriptor, missing: readonly CopyKey[], signal: AbortSignal | undefined, fetcher: Fetcher = pageFetch): Promise<Readonly<Record<CopyKey, Blob>>> {
  const wanted = new Set<string>(missing), supplied: Record<CopyKey, Blob> = {}, live = signal ?? new AbortController().signal;
  for (const { file, pin } of files(descriptor)) {
    const key = copyKey(pin);
    if (!wanted.has(key) || Object.hasOwn(supplied, key)) continue;
    const label = file === ADAPTER_FILE ? "The adapter bundle" : `Artifact ${file}`;
    supplied[key] = new Blob([await readPinned(pin, label, file, fetcher, live)]);
  }
  if (Object.keys(supplied).length !== wanted.size) throw new VMError("PROTOCOL_ERROR", "The VM asked for a file this module does not pin");
  return supplied;
}

/**
 * First calls `send` without files so the VM checks availability, options and bounds before any download.
 * Reads the pinned files the VM reports as missing and retries once if the store drops another copy in the meantime.
 */
export async function withModuleFiles<T>(descriptor: LaunchDescriptor, owner: ModuleFileOwner, send: (files: Readonly<Record<CopyKey, Blob>>) => Promise<T>, signal: AbortSignal | undefined, fetcher: Fetcher = pageFetch): Promise<T> {
  let supplied: Readonly<Record<CopyKey, Blob>> = {};
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(supplied);
    } catch (error: unknown) {
      if (attempt >= 2 || !(error instanceof VMError) || error.detail?.["reason"] !== COPY_MISSING_REASON) throw error;
      const pins = files(descriptor).map(({ pin }) => ({ sha256: pin.sha256, bytes: pin.bytes }));
      const missing = error.detail["missing"];
      const hinted = missing === undefined ? undefined : decodeMissingKeys({ missing }).missing;
      const keys = new Set(pins.map(copyKey));
      // Older runtimes omit the list. The VM adapter separately supplies engine files such as TLS.
      const wanted = hinted !== undefined && hinted.every(key => keys.has(key)) ? hinted : await owner.missing(pins, signal);
      supplied = await readMissingFiles(descriptor, wanted, signal, fetcher);
    }
  }
}
