import type { FileDescriptor } from "../../../js-process-types.js";
import type { WasiHost } from "../../../wasm/kit/wasi/host.js";
import { GuestMemory } from "../../../wasm/kit/wasi/memory.js";
import { encodeLaunch, LaunchError, preview1, ProcExit, type Preopen } from "../../../wasm/kit/wasi/preview1.js";
import { lateFailureError } from "../../js-process/late-failure.ts";

/**
 * What `node:wasi` uses of its process: the Linux ports the SDK's WASI Preview 1 serves from (the same ones a module's
 * `kit.wasi` uses), and the process's exit. A WASI program has the process's own Linux authority and no other.
 */
export interface NodeWasiProcess {
  readonly host: WasiHost;
  /** Ends the process, as `process.exit` does. Called for `proc_exit` when `returnOnExit` is false. */
  readonly exit: (code: number) => unknown;
}

interface Options {
  readonly args: string[]; readonly env: Record<string, string>; readonly preopens: Record<string, string>;
  readonly returnOnExit: boolean; readonly stdio: readonly [FileDescriptor, FileDescriptor, FileDescriptor];
}
const IMPORT_MODULE = "wasi_snapshot_preview1";

function invalid(name: string, expected: string): TypeError {
  return Object.assign(new TypeError(`The "${name}" ${name.includes(".") ? "property" : "argument"} must be ${expected}.`), { code: "ERR_INVALID_ARG_TYPE" });
}
function plainObject(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(name, "of type object");
  return value;
}
function isDescriptor(value: unknown): value is FileDescriptor {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fff_ffff;
}
/** Node's validation of the constructor options, in Node's order. */
function decode(input: unknown): Options {
  const options = plainObject(input, "options"), at = (name: string): unknown => Reflect.get(options, name);
  const version = at("version");
  if (version !== "unstable" && version !== "preview1") {
    if (typeof version !== "string") throw invalid("options.version", "of type string");
    throw Object.assign(new TypeError(`The property 'options.version' must be one of: 'unstable', 'preview1'. Received '${version}'`), { code: "ERR_INVALID_ARG_VALUE" });
  }
  const args = at("args") ?? [];
  if (!Array.isArray(args)) throw invalid("options.args", "an instance of Array");
  const env = at("env") === undefined ? {} : plainObject(at("env"), "options.env");
  const preopens = at("preopens") === undefined ? {} : plainObject(at("preopens"), "options.preopens");
  const returnOnExit = at("returnOnExit") ?? true;
  if (typeof returnOnExit !== "boolean") throw invalid("options.returnOnExit", "of type boolean");
  const stream = (name: string, standard: number): FileDescriptor => {
    const descriptor = at(name) ?? standard;
    if (!isDescriptor(descriptor)) throw invalid(`options.${name}`, "of type number");
    return descriptor;
  };
  const stdio = [stream("stdin", 0), stream("stdout", 1), stream("stderr", 2)] as const;
  // The older snapshot has other record layouts; the SDK serves the current one only.
  if (version === "unstable") throw lateFailureError("unavailable-builtin", "node:wasi serves version 'preview1' only", "node:wasi version 'unstable'");
  const text = (source: object): Record<string, string> => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
  return { args: args.map(String), env: text(env), preopens: text(preopens), returnOnExit, stdio };
}

/** Node's `WASI` instance surface. */
export interface NodeWasi {
  readonly wasiImport: object;
  getImportObject(): Record<string, object>;
  start(instance: unknown): unknown;
  initialize(instance: unknown): void;
  finalizeBindings(instance: unknown, options?: unknown): void;
}

function exportsOf(instance: unknown): object {
  const exports: unknown = Reflect.get(plainObject(instance, "instance"), "exports");
  return plainObject(exports, "instance.exports");
}

/**
 * Node's `node:wasi`: WASI Preview 1 for a WebAssembly instance the program made itself.
 *
 * The system interface is the SDK's own (`wasm/kit/wasi`), the one application-pinned modules run on. Preopened
 * directories are held as Linux directory descriptors and every path resolves beneath them in Linux, so confinement is
 * Linux's, not a check made here. Standard streams are the process's descriptors, written byte for byte.
 */
export function createNodeWasi(process: NodeWasiProcess): { readonly WASI: new (options?: unknown) => NodeWasi } {
  class WASI implements NodeWasi {
    readonly wasiImport: object;
    readonly #returnOnExit: boolean;
    #memory: GuestMemory | undefined;
    #bound = false;

    constructor(options: unknown = {}) {
      const decoded = decode(options);
      this.#returnOnExit = decoded.returnOnExit;
      let launch;
      try { launch = encodeLaunch(decoded.args, decoded.env); }
      catch (error) {
        if (error instanceof LaunchError) throw Object.assign(new TypeError(`The WASI arguments or environment are invalid: ${error.message}`), { code: "ERR_INVALID_ARG_VALUE" });
        throw error;
      }
      const preopens: Preopen[] = Object.entries(decoded.preopens).map(([guest, host]) => ({ guest, host, readOnly: false }));
      const memory = (): GuestMemory => {
        if (this.#memory === undefined) throw new TypeError("WASI was called before its instance was bound: call start(), initialize() or finalizeBindings() first");
        return this.#memory;
      };
      const [stdin, stdout, stderr] = decoded.stdio;
      this.wasiImport = preview1(process.host, memory, { stdin, stdout, stderr }, launch, { stdin: false, stdout: false, stderr: false }, preopens).imports;
    }

    getImportObject(): Record<string, object> { return { [IMPORT_MODULE]: this.wasiImport }; }

    finalizeBindings(instance: unknown, options?: unknown): void {
      if (this.#bound) throw Object.assign(new Error("WASI instance has already started"), { code: "ERR_WASI_ALREADY_STARTED" });
      const named: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "memory") : undefined;
      const memory: unknown = named ?? Reflect.get(exportsOf(instance), "memory");
      if (!(memory instanceof WebAssembly.Memory)) throw invalid("instance.exports.memory", "an instance of WebAssembly.Memory");
      this.#memory = new GuestMemory(memory); this.#bound = true;
    }

    start(instance: unknown): unknown {
      const exports = exportsOf(instance), start: unknown = Reflect.get(exports, "_start");
      if (typeof start !== "function") throw invalid("instance.exports._start", "of type function");
      if (Reflect.get(exports, "_initialize") !== undefined) throw invalid("instance.exports._initialize", "undefined");
      this.finalizeBindings(instance);
      try { Reflect.apply(start, undefined, []); }
      catch (error) {
        if (!(error instanceof ProcExit)) throw error;
        if (this.#returnOnExit) return error.code;
        process.exit(error.code);
      }
      return 0;
    }

    initialize(instance: unknown): void {
      const exports = exportsOf(instance), initialize: unknown = Reflect.get(exports, "_initialize");
      if (Reflect.get(exports, "_start") !== undefined) throw invalid("instance.exports._start", "undefined");
      if (initialize !== undefined && typeof initialize !== "function") throw invalid("instance.exports._initialize", "of type function");
      this.finalizeBindings(instance);
      if (typeof initialize === "function") Reflect.apply(initialize, undefined, []);
    }
  }
  return { WASI };
}
