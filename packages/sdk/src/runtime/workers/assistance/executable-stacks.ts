import { fileURLToPath } from "./node-url.ts";
import { record } from "../../decode.ts";
import type { ExecutableSources } from "./executable-sources.ts";

type Formatter = (error: unknown, frames: unknown) => unknown;
function isFormatter(value: unknown): value is Formatter { return typeof value === "function"; }

export interface ExecutableStacks {
  /** The program's own `Error.prepareStackTrace`, wrapped so that its call sites name the program's files; none
   * while the program has installed no formatter. */
  readonly program: () => Formatter | undefined;
  readonly restore: () => void;
}

/**
 * Owns `Error.prepareStackTrace`. Program text runs lowered and evaluated, so an engine's call site for it has no
 * file name and the lowered text's line and column. The default formatting here names the program's own file and
 * position, and a formatter the program installs (as the `resolve`, `callsites` and `depd` packages do) receives
 * call sites that answer the same way.
 */
export function installExecutableStacks(sources: ExecutableSources, realmValue: unknown): ExecutableStacks {
  const realm = record(realmValue, "stack realm");
  const constructor = realm["Error"];
  if (typeof constructor !== "function") throw new TypeError("Realm has no Error constructor");
  const prototype: unknown = Reflect.get(constructor, "prototype");
  const toString = method(prototype, "toString");
  const previous = Object.getOwnPropertyDescriptor(constructor, "prepareStackTrace");
  const formatter: Formatter = (error, frames) => {
    if (!Array.isArray(frames)) throw new TypeError("Invalid V8 stack frames");
    const header: unknown = Reflect.apply(toString, error, []);
    if (typeof header !== "string") throw new TypeError("Invalid Error string");
    const values: readonly unknown[] = frames;
    return header + values.map(frame => `\n    at ${formatFrame(sources, frame)}`).join("");
  };
  // What the program assigned. A program that reads the property and later puts that value back (the usual way to
  // borrow the formatter for one call) gets its earlier state: the wrapper it read stands for the function it wraps.
  let assigned: Formatter | undefined;
  const wrappers = new WeakMap<Formatter, Formatter>(), wrapped = new WeakMap<Formatter, Formatter>();
  const wrapperOf = (program: Formatter): Formatter => {
    let wrapper = wrappers.get(program);
    if (wrapper === undefined) {
      wrapper = (error, frames) => {
        if (!Array.isArray(frames)) return program(error, frames);
        const values: readonly unknown[] = frames;
        return Reflect.apply(program, constructor, [error, values.map(frame => new ProgramCallSite(sources, frame))]);
      };
      wrappers.set(program, wrapper); wrapped.set(wrapper, program);
    }
    return wrapper;
  };
  Object.defineProperty(constructor, "prepareStackTrace", {
    configurable: true, enumerable: false,
    get: (): Formatter => assigned === undefined ? formatter : wrapperOf(assigned),
    set: (value: unknown): void => { assigned = !isFormatter(value) || value === formatter ? undefined : wrapped.get(value) ?? value; },
  });
  return {
    program: () => assigned === undefined ? undefined : wrapperOf(assigned),
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(constructor, "prepareStackTrace");
      else Object.defineProperty(constructor, "prepareStackTrace", previous);
    },
  };
}

interface Place { readonly file: string; readonly line: number; readonly column: number }

/** Where a frame's code stands in the program's own file, when the frame is program code. */
function placeOf(sources: ExecutableSources, frame: unknown): { readonly url: string; readonly line: number; readonly column: number; readonly place: Place | undefined } | undefined {
  const url: unknown = Reflect.apply(method(frame, "getScriptNameOrSourceURL"), frame, []);
  const line: unknown = Reflect.apply(method(frame, "getLineNumber"), frame, []);
  const column: unknown = Reflect.apply(method(frame, "getColumnNumber"), frame, []);
  if (typeof url !== "string" || typeof line !== "number" || typeof column !== "number") return undefined;
  const origin = sources.find(url, line, column)?.origin;
  if (origin === undefined || typeof origin.originalSource !== "string"
    || origin.originalLine === undefined || origin.originalColumn === undefined) return { url, line, column, place: undefined };
  let file = origin.originalSource;
  if (file.startsWith("file:")) {
    try { file = fileURLToPath(file); }
    catch { /* A nonlocal/invalid file URL remains a display URL, never a read. */ }
  }
  return { url, line, column, place: { file, line: origin.originalLine + 1, column: origin.originalColumn + 1 } };
}

function formatFrame(sources: ExecutableSources, frame: unknown): string {
  const text: unknown = Reflect.apply(method(frame, "toString"), frame, []);
  if (typeof text !== "string") throw new TypeError("Invalid V8 frame string");
  const found = placeOf(sources, frame);
  if (found?.place === undefined) return text;
  return text.replace(`${found.url}:${String(found.line)}:${String(found.column)}`, `${found.place.file}:${String(found.place.line)}:${String(found.place.column)}`);
}

/**
 * The call site a program's formatter receives: the engine's own, except that a frame of program code names the
 * program's file and position and is not an eval frame. Everything else is the engine's answer.
 */
export class ProgramCallSite {
  readonly #sources: ExecutableSources;
  readonly #frame: unknown;
  #place: Place | null | undefined;
  constructor(sources: ExecutableSources, frame: unknown) { this.#sources = sources; this.#frame = frame; }
  #own(): Place | undefined {
    if (this.#place === undefined) {
      try { this.#place = placeOf(this.#sources, this.#frame)?.place ?? null; }
      catch { this.#place = null; }
    }
    return this.#place ?? undefined;
  }
  #engine(name: string): unknown {
    const fn: unknown = typeof this.#frame === "object" && this.#frame !== null ? Reflect.get(this.#frame, name) : undefined;
    return typeof fn === "function" ? Reflect.apply(fn, this.#frame, []) : undefined;
  }
  getThis(): unknown { return this.#engine("getThis"); }
  getTypeName(): unknown { return this.#engine("getTypeName"); }
  getFunction(): unknown { return this.#engine("getFunction"); }
  getFunctionName(): unknown {
    const name = this.#engine("getFunctionName");
    // A module's own top-level code runs in an evaluated wrapper the engine calls "eval"; Node's has no name.
    return name === "eval" && this.#own() !== undefined && this.#engine("isEval") === true ? null : name;
  }
  getMethodName(): unknown { return this.#engine("getMethodName"); }
  getFileName(): unknown { return this.#own()?.file ?? this.#engine("getFileName"); }
  getLineNumber(): unknown { return this.#own()?.line ?? this.#engine("getLineNumber"); }
  getColumnNumber(): unknown { return this.#own()?.column ?? this.#engine("getColumnNumber"); }
  getEnclosingLineNumber(): unknown { return this.#own()?.line ?? this.#engine("getEnclosingLineNumber"); }
  getEnclosingColumnNumber(): unknown { return this.#own()?.column ?? this.#engine("getEnclosingColumnNumber"); }
  getScriptNameOrSourceURL(): unknown { return this.#own()?.file ?? this.#engine("getScriptNameOrSourceURL"); }
  getScriptHash(): unknown { return this.#engine("getScriptHash"); }
  getEvalOrigin(): unknown { return this.#own() === undefined ? this.#engine("getEvalOrigin") : undefined; }
  getPosition(): unknown { return this.#engine("getPosition"); }
  getPromiseIndex(): unknown { return this.#engine("getPromiseIndex"); }
  isToplevel(): unknown { return this.#engine("isToplevel"); }
  isEval(): unknown { return this.#own() === undefined ? this.#engine("isEval") : false; }
  isNative(): unknown { return this.#engine("isNative"); }
  isConstructor(): unknown { return this.#engine("isConstructor"); }
  isAsync(): unknown { return this.#engine("isAsync"); }
  isPromiseAll(): unknown { return this.#engine("isPromiseAll"); }
  toString(): string {
    try { return formatFrame(this.#sources, this.#frame); }
    catch { return String(this.#engine("toString")); }
  }
}
// The bundle renames classes; programs print a call site's constructor name.
Object.defineProperty(ProgramCallSite, "name", { value: "CallSite" });

function method(value: unknown, name: string): (...args: unknown[]) => unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new TypeError("Invalid V8 stack object");
  const fn: unknown = Reflect.get(value, name);
  if (typeof fn !== "function") throw new TypeError(`Missing V8 stack method ${name}`);
  return function (this: unknown, ...args: unknown[]): unknown { return Reflect.apply(fn, this, args); };
}
