/// <reference lib="esnext.disposable" />
import { codeError, shaped, validatedPath } from "./node-files-args.ts";
import { createNodePath } from "./node-path.js";
import { invalidType, named, validateFunction, validateObject, validateString } from "./node-util-validators.ts";

/** The runtime operations the small `fs` additions are made of. */
export interface MiscellaneousFilePorts {
  /** `fs.access(path, mode, callback)`. */
  readonly access: (path: string, mode: number, callback: (error: unknown) => void) => void;
  readonly readFileSync: (path: string) => unknown;
  readonly mkdtempSync: (prefix: unknown, options: unknown) => unknown;
  readonly rmSync: (path: string, options: { readonly recursive: true; readonly force: true }) => void;
  readonly mkdtemp: (prefix: unknown, options: unknown) => Promise<unknown>;
  readonly rm: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void>;
  readonly cwd: () => string;
}

/** The intrinsic itself: it answers for a Date of any realm and throws for every other value, as Node's `isDate` does. */
const dateTime: unknown = Object.getOwnPropertyDescriptor(Date.prototype, "getTime")?.value;
/** Node's `fs._toUnixTimestamp`: seconds from a number, a numeric string or a Date; a negative number means now. */
export const toUnixTimestamp = named(function (time: unknown, name: unknown = "time"): number {
  if (typeof time === "string" && !Number.isNaN(Number(time))) return Number(time);
  if (typeof time === "number" && Number.isFinite(time)) return time < 0 ? Date.now() / 1000 : time;
  let milliseconds: unknown;
  try { if (typeof dateTime === "function") milliseconds = Reflect.apply(dateTime, time, []); } catch { /* Not a Date: refused below. */ }
  if (typeof milliseconds === "number") return milliseconds / 1000;
  const base = invalidType(String(name), "x", time).message;
  throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${String(name)}" argument must be an instance of Date or an Time in seconds.${base.slice(base.indexOf(" Received "))}`);
}, "toUnixTimestamp");

/** Node rejects `fs.promises.lchmod` on Linux, where a symbolic link has no mode of its own to change. */
export const lchmod = shaped(async function (): Promise<never> {
  await Promise.resolve();
  throw codeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", "The lchmod() method is not implemented");
}, "lchmod", 2);

export interface NodeMiscellaneousFiles {
  readonly exists: (path: unknown, callback: unknown) => void;
  readonly openAsBlob: (path: unknown, options?: unknown) => Promise<Blob>;
  readonly mkdtempDisposableSync: (prefix: unknown, options: unknown) => { path: string; remove: () => void; [Symbol.dispose](): void };
  readonly _toUnixTimestamp: typeof toUnixTimestamp;
  readonly lchmod: undefined;
  readonly lchmodSync: undefined;
  readonly promises: {
    readonly mkdtempDisposable: (prefix: unknown, options: unknown) => Promise<{ path: string; remove: () => Promise<void>; [Symbol.asyncDispose](): Promise<void> }>;
    readonly lchmod: typeof lchmod;
  };
}

export function createNodeMiscellaneousFiles(ports: MiscellaneousFilePorts): NodeMiscellaneousFiles {
  const resolve = createNodePath(ports.cwd).resolve;
  const exists = named(function (path: unknown, callback: unknown): void {
    validateFunction(callback, "cb");
    // An argument `access` refuses is answered at once; Linux's answer arrives as its callbacks do.
    try { ports.access(validatedPath(path).text, 0, error => { callback(error === null || error === undefined); }); }
    catch { callback(false); }
  }, "exists");
  // `util.promisify(fs.exists)` resolves with the boolean: the callback has no error argument.
  Object.defineProperty(exists, Symbol.for("nodejs.util.promisify.custom"), { value: named(function (path: unknown): Promise<unknown> {
    return new Promise(done => { exists(path, done); });
  }, "exists") });

  /** The file's bytes as a Blob. Node's Blob is backed by the file and reads it when asked; this one holds a copy read
   * here, so a later change to the file does not reach it (in Node such a Blob then fails to read). */
  const openAsBlob = named(function (path: unknown, options: unknown = {}): Promise<Blob> {
    validateObject(options, "options");
    const requested: unknown = Reflect.get(options, "type"), type = requested === undefined || requested === null || requested === false || requested === 0 ? "" : requested;
    validateString(type, "options.type");
    const target = validatedPath(path);
    let content: unknown;
    try { content = ports.readFileSync(target.text); }
    catch { throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Unable to open file as blob"); }
    if (!(content instanceof Uint8Array)) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Unable to open file as blob");
    const blob = new Blob([new Uint8Array(content)], { type });
    // The browser lower-cases a Blob's type; Node keeps the caller's spelling here.
    if (blob.type !== type) Object.defineProperty(blob, "type", { value: type, enumerable: true, configurable: true });
    return Promise.resolve(blob);
  }, "openAsBlob");

  /** The created path as a string: Node resolves it against the working directory, which refuses a Buffer (after the
   * directory exists, as in Node). */
  const made = (path: unknown): { readonly path: string; readonly full: string } => {
    if (typeof path !== "string") throw invalidType("paths[1]", "string", path);
    return { path, full: resolve(ports.cwd(), path) };
  };
  const mkdtempDisposableSync = named(function (prefix: unknown, options: unknown) {
    const { path, full } = made(ports.mkdtempSync(prefix, options));
    const remove = named((): void => { ports.rmSync(full, { recursive: true, force: true }); }, "remove");
    return { path, remove, [Symbol.dispose](): void { remove(); } };
  }, "mkdtempDisposableSync");
  const mkdtempDisposable = named(async function (prefix: unknown, options: unknown) {
    const { path, full } = made(await ports.mkdtemp(prefix, options));
    const remove = named(async (): Promise<void> => { await ports.rm(full, { recursive: true, force: true }); }, "remove");
    const result = { path, remove, async [Symbol.asyncDispose](): Promise<void> { await remove(); } };
    Object.setPrototypeOf(result, null);
    return result;
  }, "mkdtempDisposable");
  // Node on Linux exports `lchmod` and `lchmodSync` with the value undefined; libraries test for them.
  return { exists, openAsBlob, mkdtempDisposableSync, _toUnixTimestamp: toUnixTimestamp, lchmod: undefined, lchmodSync: undefined, promises: { mkdtempDisposable, lchmod } };
}
