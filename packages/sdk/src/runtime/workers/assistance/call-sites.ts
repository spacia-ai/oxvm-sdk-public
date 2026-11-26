import { record } from "../../decode.ts";

/** One frame of a SpiderMonkey or JavaScriptCore stack, read from its `function@url:line:column` line. */
interface Frame {
  readonly name: string | null;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly native: boolean;
  readonly evaluated: boolean;
  readonly asynchronous: boolean;
}

/** The V8 call-site object Node programs receive in `Error.prepareStackTrace`. Values an engine's stack text
 * does not carry (receiver, function object, type and method name) are absent, as V8 reports them in strict code. */
class CallSite {
  readonly #frame: Frame;
  constructor(frame: Frame) { this.#frame = frame; }
  getThis(): undefined { return undefined; }
  getTypeName(): null { return null; }
  getFunction(): undefined { return undefined; }
  getFunctionName(): string | null { return this.#frame.name; }
  getMethodName(): null { return null; }
  getFileName(): string | null { return this.#frame.file; }
  getLineNumber(): number | null { return this.#frame.line; }
  getColumnNumber(): number | null { return this.#frame.column; }
  getEnclosingLineNumber(): number | null { return this.#frame.line; }
  getEnclosingColumnNumber(): number | null { return this.#frame.column; }
  getScriptNameOrSourceURL(): string | null { return this.#frame.file; }
  getScriptHash(): string { return ""; }
  getEvalOrigin(): string | undefined { return this.#frame.evaluated && this.#frame.file !== null ? `eval at ${this.#frame.file}` : undefined; }
  getPosition(): number { return 0; }
  getPromiseIndex(): null { return null; }
  isToplevel(): boolean { return this.#frame.name === null && this.#frame.file !== null && !this.#frame.evaluated; }
  isEval(): boolean { return this.#frame.evaluated; }
  isNative(): boolean { return this.#frame.native; }
  isConstructor(): boolean { return false; }
  isAsync(): boolean { return this.#frame.asynchronous; }
  isPromiseAll(): boolean { return false; }
  toString(): string {
    const { name, file, line, column, native, asynchronous } = this.#frame;
    const location = native ? "native" : file === null ? "<anonymous>" : line === null || column === null ? file : `${file}:${String(line)}:${String(column)}`;
    return `${asynchronous ? "async " : ""}${name === null ? location : `${name} (${location})`}`;
  }
}

const LOCATION = /^(.*):(\d+):(\d+)$/u, EVALUATED = /^(.*) line \d+ > (?:eval|Function)$/u;
const SCRIPT_CODE = new Set(["global code", "module code", "eval code"]);

/** SpiderMonkey names a function by the path of functions around it (`outer/inner`, `outer/<` for one without a
 * name, `outer/inner<` for one defined inside); V8 gives the function's own name, or none. */
function functionName(label: string): string | null {
  const own = label.slice(label.lastIndexOf("/") + 1).replace(/[<*]+$/u, "");
  return own === "" ? null : own;
}

function parseFrame(text: string): Frame {
  const at = text.indexOf("@");
  let label = at < 0 ? "" : text.slice(0, at);
  const place = at < 0 ? text : text.slice(at + 1);
  const asynchronous = label.startsWith("async*");
  if (asynchronous) label = label.slice("async*".length);
  let evaluated = label === "eval code";
  const name = label === "" || SCRIPT_CODE.has(label) ? null : functionName(label);
  if (place === "[native code]") return { name, file: null, line: null, column: null, native: true, evaluated, asynchronous };
  const location = LOCATION.exec(place);
  if (location === null) return { name, file: place === "" ? null : place, line: null, column: null, native: false, evaluated, asynchronous };
  let file = location[1] ?? "";
  const outer = EVALUATED.exec(file);
  if (outer !== null) { file = outer[1] ?? file; evaluated = true; }
  return { name, file, line: Number(location[2]), column: Number(location[3]), native: false, evaluated, asynchronous };
}

function header(target: object): string {
  const name: unknown = Reflect.get(target, "name"), message: unknown = Reflect.get(target, "message");
  const title = typeof name === "string" ? name : "Error", detail = typeof message === "string" ? message : "";
  return title === "" ? detail : detail === "" ? title : `${title}: ${detail}`;
}

/** True when the realm's own `captureStackTrace` calls `prepareStackTrace` with frames, which only V8 does. */
function nativeCallSites(constructor: object, capture: unknown): boolean {
  if (typeof capture !== "function") return false;
  const previous = Object.getOwnPropertyDescriptor(constructor, "prepareStackTrace");
  let structured = false;
  try {
    Object.defineProperty(constructor, "prepareStackTrace", { configurable: true, writable: true, value: (_error: unknown, frames: unknown) => { structured = Array.isArray(frames); return ""; } });
    const probe = {};
    Reflect.apply(capture, constructor, [probe]);
    // V8 formats lazily, on the first read.
    Reflect.get(probe, "stack");
  } catch { structured = false; }
  if (previous === undefined) Reflect.deleteProperty(constructor, "prepareStackTrace");
  else Object.defineProperty(constructor, "prepareStackTrace", previous);
  return structured;
}

/** Node programs read their callers through V8's stack API: `Error.captureStackTrace` with `Error.prepareStackTrace`
 * and `Error.stackTraceLimit` (the `depd` package under Express does). SpiderMonkey and JavaScriptCore have none of
 * it, so in those realms `captureStackTrace` is served here from the engine's stack text. A V8 realm is left alone.
 * Where `stack` is an accessor on `Error.prototype` (SpiderMonkey), reading it goes through `Error.prepareStackTrace`
 * too, as in V8: the runtime's formatter gives the text Node programs expect, and a formatter the program installed
 * receives call sites. With no `prepareStackTrace` at all the engine's own text is returned untouched.
 * Not covered: an engine that stores `stack` on each error (JavaScriptCore) never passes through here. */
export function installCallSites(realmValue: unknown): () => void {
  const constructorValue = record(realmValue, "call-site realm")["Error"];
  if (typeof constructorValue !== "function") throw new TypeError("Realm has no Error constructor");
  const constructor: object = constructorValue;
  const previousCapture = Object.getOwnPropertyDescriptor(constructor, "captureStackTrace");
  if (nativeCallSites(constructor, previousCapture?.value)) return () => undefined;
  const previousLimit = Object.getOwnPropertyDescriptor(constructor, "stackTraceLimit");
  if (previousLimit === undefined) Object.defineProperty(constructor, "stackTraceLimit", { configurable: true, enumerable: true, writable: true, value: 10 });
  const stackReader = installStackReader(constructor);
  const captureStackTrace = (target: unknown, constructorOpt?: unknown): void => {
    if ((typeof target !== "object" || target === null) && typeof target !== "function") throw new TypeError("Invalid argument");
    // SpiderMonkey cuts its stack text at `Error.stackTraceLimit`, and this function's own frames would use the
    // limit up (an old `depd` sets it to 2). The engine's text is taken whole; the limit is applied to the caller's frames below.
    const limit: unknown = Reflect.get(constructor, "stackTraceLimit");
    Reflect.set(constructor, "stackTraceLimit", Infinity);
    let raw: unknown;
    // The engine's text, not what a program's formatter makes of it: that formatter is called below, once.
    try { const probe: unknown = Reflect.construct(constructorValue, []); raw = typeof probe === "object" && probe !== null ? stackReader.raw(probe) : undefined; }
    finally { Reflect.set(constructor, "stackTraceLimit", limit); }
    // The first line is this function's own frame.
    let frames = (typeof raw === "string" ? raw.split("\n") : []).filter(line => line !== "").slice(1).map(parseFrame);
    const above: unknown = typeof constructorOpt === "function" ? Reflect.get(constructorOpt, "name") : "";
    const cut = typeof above !== "string" || above === "" ? -1 : frames.findIndex(frame => frame.name === above);
    if (cut >= 0) frames = frames.slice(cut + 1);
    const sites = frames.slice(0, typeof limit === "number" && limit > 0 ? Math.floor(limit) : 0).map(frame => new CallSite(frame));
    const prepare: unknown = Reflect.get(constructor, "prepareStackTrace");
    const value: unknown = typeof prepare === "function" ? Reflect.apply(prepare, constructor, [target, sites])
      : header(target) + sites.map(site => `\n    at ${site.toString()}`).join("");
    Object.defineProperty(target, "stack", { configurable: true, enumerable: false, writable: true, value });
  };
  Object.defineProperty(constructor, "captureStackTrace", { configurable: true, writable: true, value: captureStackTrace });
  return () => {
    stackReader.restore();
    if (previousCapture === undefined) Reflect.deleteProperty(constructor, "captureStackTrace");
    else Object.defineProperty(constructor, "captureStackTrace", previousCapture);
    if (previousLimit === undefined) Reflect.deleteProperty(constructor, "stackTraceLimit");
  };
}

/** `Error.prepareStackTrace`'s result for an error's own stack text, computed once per error as V8 computes it once. */
function installStackReader(constructor: object): { readonly raw: (error: object) => unknown; readonly restore: () => void } {
  const untouched = { raw: (error: object): unknown => Reflect.get(error, "stack"), restore: (): void => undefined };
  const prototype: unknown = Reflect.get(constructor, "prototype");
  if (typeof prototype !== "object" || prototype === null) return untouched;
  const previous = Object.getOwnPropertyDescriptor(prototype, "stack");
  if (previous === undefined || previous.configurable !== true) return untouched;
  const read: unknown = Reflect.get(previous, "get"), write: unknown = Reflect.get(previous, "set");
  if (typeof read !== "function") return untouched;
  const formatted = new WeakMap<object, { readonly value: unknown }>();
  Object.defineProperty(prototype, "stack", {
    configurable: true, enumerable: previous.enumerable ?? false,
    get(this: unknown): unknown {
      const raw: unknown = Reflect.apply(read, this, []);
      if (typeof this !== "object" || this === null || typeof raw !== "string") return raw;
      const done = formatted.get(this);
      if (done !== undefined) return done.value;
      const prepare: unknown = Reflect.get(constructor, "prepareStackTrace");
      if (typeof prepare !== "function") return raw;
      const limit: unknown = Reflect.get(constructor, "stackTraceLimit");
      const sites = raw.split("\n").filter(line => line !== "").slice(0, typeof limit === "number" && limit > 0 ? Math.floor(limit) : 0).map(line => new CallSite(parseFrame(line)));
      // Kept before the formatter runs: a formatter that reads the stack of the error it is formatting gets text.
      formatted.set(this, { value: raw });
      const value: unknown = Reflect.apply(prepare, constructor, [this, sites]);
      formatted.set(this, { value });
      return value;
    },
    set(this: unknown, value: unknown): void {
      if (typeof this === "object" && this !== null) formatted.delete(this);
      if (typeof write === "function") Reflect.apply(write, this, [value]);
    },
  });
  return { raw: (error): unknown => Reflect.apply(read, error, []), restore: () => { Object.defineProperty(prototype, "stack", previous); } };
}
