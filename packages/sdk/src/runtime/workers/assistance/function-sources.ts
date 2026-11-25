import { VMError } from "../../errors.ts";

/** What a marker starts with; a module's markers continue `<module>:<start>:<end>`. */
const PREFIX = "oxidevm:source:";
const NATIVE_TEXT = "function toString() { [native code] }";
// Captured before application code runs, so a patched String.prototype cannot steer the lookup.
const apply = Reflect.apply, indexOf: unknown = Reflect.get(String.prototype, "indexOf"), slice: unknown = Reflect.get(String.prototype, "slice"),
  codeAt: unknown = Reflect.get(String.prototype, "charCodeAt");

function find(text: string, part: string, from: number): number {
  const at: unknown = typeof indexOf === "function" ? apply(indexOf, text, [part, from]) : undefined;
  if (typeof at !== "number") throw new TypeError("Missing string search intrinsic");
  return at;
}
function cut(text: string, start: number, end: number): string {
  const part: unknown = typeof slice === "function" ? apply(slice, text, [start, end]) : undefined;
  if (typeof part !== "string") throw new TypeError("Missing string slice intrinsic");
  return part;
}
function code(text: string, at: number): number {
  const unit: unknown = typeof codeAt === "function" ? apply(codeAt, text, [at]) : undefined;
  if (typeof unit !== "number") throw new TypeError("Missing character intrinsic");
  return unit;
}
/** Reads decimal digits (at most 15) up to a `stop` character; undefined when the field is anything else. */
function field(text: string, from: number, ...stops: readonly number[]): { readonly value: number; readonly next: number } | undefined {
  let value = 0, at = from;
  for (; at < text.length && at - from <= 15; at++) {
    const unit = code(text, at);
    if (stops.includes(unit)) return at === from ? undefined : { value, next: at + 1 };
    if (unit < 48 || unit > 57) return undefined;
    value = value * 10 + (unit - 48);
  }
  return undefined;
}

/**
 * The source text of functions in lowered ES modules.
 *
 * A lowered module does not run its own text: imports, `import.meta`, `import()` and async functions are rewritten, so
 * the engine's `Function.prototype.toString` would return the rewritten text. Programs write that text into what they
 * build (Vite copies its preload helper into every bundle this way), where the rewritten names do not exist. Each
 * function and class of a registered module therefore carries a marker naming its range in the module's source, and
 * `text` answers with that range.
 *
 * Markers are data inside application code, so a program can write one itself. It can only name text of a module this
 * process loaded, which the program can read anyway.
 */
export class FunctionSources {
  readonly #sources: string[] = [];
  #characters = 0;
  readonly #budget: number;

  constructor(budget = 32 * 1024 * 1024) { this.#budget = budget; }

  /** Keeps a module's source and returns the start of its markers, or undefined once the budget is used up
   * (that module's functions then report their lowered text). */
  register(source: string): string | undefined {
    if (this.#sources.length >= 65_536 || this.#characters + source.length > this.#budget) return undefined;
    this.#characters += source.length;
    this.#sources.push(source);
    return `${PREFIX}${String(this.#sources.length)}:`;
  }

  /** The source text of the function whose lowered text this is; undefined when it carries no usable marker. */
  text(lowered: string): string | undefined {
    // The function's own marker spans every other marker in its text: those belong to functions inside it.
    let owner: string | undefined, low = Infinity, high = -1, spanned = false;
    for (let at = find(lowered, PREFIX, 0); at !== -1; at = find(lowered, PREFIX, at + PREFIX.length)) {
      const module = field(lowered, at + PREFIX.length, 58), start = module && field(lowered, module.next, 58);
      const end = start && field(lowered, start.next, 34, 39);
      const source = module === undefined ? undefined : this.#sources[module.value - 1];
      if (source === undefined || start === undefined || end === undefined || start.value >= end.value || end.value > source.length) return undefined;
      if (owner !== undefined && source !== owner) return undefined;
      owner = source;
      if (start.value <= low && end.value >= high) { low = start.value; high = end.value; spanned = true; }
      else if (start.value < low || end.value > high) { low = Math.min(low, start.value); high = Math.max(high, end.value); spanned = false; }
    }
    return owner === undefined || !spanned ? undefined : cut(owner, low, high);
  }
}

/** Replaces the realm's `Function.prototype.toString` with one that answers from `sources`; returns the undo. */
export function installFunctionSources(realmValue: unknown, sources: FunctionSources): () => void {
  const constructor: unknown = typeof realmValue === "object" && realmValue !== null ? Reflect.get(realmValue, "Function") : undefined;
  const prototype: unknown = typeof constructor === "function" ? Reflect.get(constructor, "prototype") : undefined;
  if ((typeof prototype !== "object" && typeof prototype !== "function") || prototype === null) throw new TypeError("realm has no Function prototype");
  const previous = Object.getOwnPropertyDescriptor(prototype, "toString"), intrinsic: unknown = previous?.value;
  if (previous === undefined || previous.configurable !== true || typeof intrinsic !== "function") throw new TypeError("Function prototype has no replaceable toString");
  const holder = {
    toString(this: unknown): string {
      if (this === replacement) return NATIVE_TEXT;
      const lowered: unknown = apply(intrinsic, this, []);
      if (typeof lowered !== "string") throw new VMError("PROTOCOL_ERROR", "Function source text is not a string");
      return find(lowered, PREFIX, 0) === -1 ? lowered : sources.text(lowered) ?? lowered;
    },
  };
  const replacement: unknown = Reflect.get(holder, "toString");
  Object.defineProperty(prototype, "toString", { ...previous, value: replacement });
  return () => { Object.defineProperty(prototype, "toString", previous); };
}
