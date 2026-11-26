/*!
 * Argument handling shared by the `fs` additions (`node-files-*.ts`), as Node.js v24.18.1 words it in
 * lib/internal/fs/utils.js (`getValidatedPath`, `getOptions`, `assertEncoding`) and lib/internal/errors.js.
 * Copyright Node.js contributors. All rights reserved. MIT License: see node-util-validators.ts for the full text.
 */
import { Buffer } from "buffer";
import { fileURLToPath } from "./node-url.js";
import { SYSTEM_ERROR_NUMBERS, systemErrorMessage } from "./node-system-errors.ts";
import { inspectValue, invalidType, invalidValue } from "./node-util-validators.ts";

/** How an asynchronous form joins the process: `retain` keeps it alive until the returned release, `dispatch` runs a
 * callback as the process runs its own, and `nextTick` is the process's tick queue (the dispatch queue when absent). */
export interface FileScheduling {
  readonly retain: () => () => void;
  readonly dispatch: (callback: () => void) => void;
  readonly nextTick?: (callback: () => void) => void;
}

/** A Node error with a `code`: the class is the caller's, as Node's are `Error`, `TypeError` or `RangeError`. */
export function codeError(Kind: ErrorConstructor, code: string, message: string): Error {
  return Object.assign(new Kind(message), { code });
}
/** A libuv-style error: `CODE: description, syscall 'path' -> 'dest'`. */
export function systemError(code: string, syscall: string, path?: string, dest?: string): Error {
  return Object.assign(new Error(systemErrorMessage(code, syscall, path ?? null, dest ?? null)),
    { errno: SYSTEM_ERROR_NUMBERS[code] ?? -1, code, syscall, ...(path === undefined ? {} : { path }), ...(dest === undefined ? {} : { dest }) });
}
export function errorCode(error: unknown): string | undefined {
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}
/** A Linux failure of one call, reported as the failure of the Node call built on it; anything else passes through. */
export function reissued(error: unknown, syscall: string, path?: string, dest?: string): unknown {
  const code = errorCode(error);
  return code !== undefined && typeof Reflect.get(Object(error), "errno") === "number" && /^E[A-Z0-9]+$/u.test(code) ? systemError(code, syscall, path, dest) : error;
}

export interface ValidatedPath {
  /** What Node keeps: the string, the Buffer as passed, or a file URL's path. */
  readonly given: string | Uint8Array;
  /** The same path for the file service, which takes UTF-8 strings. */
  readonly text: string;
}
/** Node's `getValidatedPath`. */
export function validatedPath(value: unknown, name = "path"): ValidatedPath {
  const path = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof path === "string") {
    if (path.includes("\0")) throw invalidValue(name, value, "must be a string, Uint8Array, or URL without null bytes");
    return { given: path, text: path };
  }
  if (path instanceof Uint8Array) {
    if (path.includes(0)) throw invalidValue(name, value, "must be a string, Uint8Array, or URL without null bytes");
    return { given: path, text: Buffer.from(path).toString("utf8") };
  }
  throw invalidType(name, "string or an instance of Buffer or URL", value);
}

/** ERR_INVALID_ARG_TYPE for an argument that may be of several primitive types (`one of type string or object`). */
export function invalidOneOf(name: string, expected: string, value: unknown): Error {
  const base = invalidType(name, "x", value).message;
  return codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" ${name.includes(".") ? "property" : "argument"} must be one of type ${expected}.${base.slice(base.indexOf(" Received "))}`);
}

/** Node's `getOptions` with `{ encoding: "utf8" }` defaults: a string names the encoding, an object holds options, and
 * the encoding (lower-cased here) is checked unless it is `"buffer"`, which is answered as null. */
export type EncodingName = NonNullable<Parameters<Buffer["toString"]>[0]>;
function isEncoding(value: string | undefined): value is EncodingName { return value !== undefined && Buffer.isEncoding(value); }
export function encodingOptions(options: unknown): { readonly encoding: EncodingName | null; at(key: string): unknown } {
  if (options !== null && options !== undefined && typeof options !== "string" && typeof options !== "object") throw invalidOneOf("options", "string or object", options);
  const object = typeof options === "object" && options !== null ? options : undefined;
  const selected: unknown = typeof options === "string" ? options : object === undefined ? "utf8" : Reflect.get(object, "encoding") ?? "utf8";
  const at = (key: string): unknown => object === undefined ? undefined : Reflect.get(object, key);
  if (selected === "buffer") return { encoding: null, at };
  const lowered = typeof selected === "string" ? selected.toLowerCase() : undefined;
  if (!isEncoding(lowered)) throw Object.assign(new TypeError(`The argument 'encoding' is invalid encoding. Received ${inspectValue(selected)}`), { code: "ERR_INVALID_ARG_VALUE" });
  return { encoding: lowered, at };
}
/** A UTF-8 name as the encoding option asks for it. */
export function encodedName(name: string, encoding: EncodingName | null): string | Buffer {
  if (encoding === "utf8" || encoding === "utf-8") return name;
  return encoding === null ? Buffer.from(name) : Buffer.from(name).toString(encoding);
}

/** A rejection reason or callback error as an Error: Node's are, and anything else is kept as the cause. */
export function failureOf(error: unknown): Error {
  return error instanceof Error ? error : new Error("File operation failed", { cause: error });
}
/** Pins the `name` and `length` a program can read, which minification and unused parameters would change. */
export function shaped<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "name", { value: name, configurable: true });
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return target;
}
