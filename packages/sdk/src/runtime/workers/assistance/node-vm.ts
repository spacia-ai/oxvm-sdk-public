import { VMError } from "../../errors.ts";
import { invalidArgType } from "./node-arg-type.ts";
import { nodeUtil } from "./node-util.ts";

type Evaluate = (source: string, filename: string) => unknown;
export type EvaluateContext = (source: string, context: object, filename: string) => unknown;

const refuse = (name: string): ((...args: unknown[]) => never) => () => {
  throw new VMError("FEATURE_NOT_AVAILABLE", `vm.${name} is not supported: an isolated browser worker has one realm and cannot create another V8 context`, { builtin: "vm", export: name });
};

/** The realm's own indirect `eval`, looked up at call time so the runtime's
 * generated-function policy (not this module) decides whether it exists. */
export function realmEvaluator(): Evaluate {
  return (source, filename) => {
    const indirect: unknown = Reflect.get(globalThis, "eval");
    if (typeof indirect !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", `vm cannot evaluate ${filename}: eval is unavailable in this process`, { builtin: "vm", filename });
    const result: unknown = Reflect.apply(indirect, undefined, [source]);
    return result;
  };
}

/** The `vm` builtin: `runInThisContext` and `Script` are real evaluations in
 * the process's own realm through the runtime's generated-function policy;
 * general V8 contexts refuse. A qualified runtime can supply bounded data-script evaluation, and then
 * `createContext`, `runInContext` and `runInNewContext` run data scripts over a plain object. */
/** `createContext` options that change nothing a data script can observe: a name for the inspector, and switches
 * that only forbid generating code, which a data script cannot do anyway. */
function inertContextOptions(options: unknown): boolean {
  if (options === undefined) return true;
  if (typeof options !== "object" || options === null) return false;
  return Object.entries(options).every(([key, value]: [string, unknown]) => key === "name" || key === "origin" ? typeof value === "string"
    : key === "codeGeneration" && typeof value === "object" && value !== null
      && Object.entries(value).every(([name, allowed]: [string, unknown]) => (name === "strings" || name === "wasm") && allowed === false));
}

export interface VmScript {
  runInThisContext(): unknown;
  readonly runInContext: (context?: unknown, options?: unknown) => unknown;
  readonly runInNewContext: (context?: unknown, options?: unknown) => unknown;
  createCachedData(): Uint8Array;
}
export interface NodeVm {
  readonly Script: new (source: unknown, options?: unknown) => VmScript;
  readonly runInThisContext: (source: unknown, options?: unknown) => unknown;
  readonly isContext: (context: unknown) => boolean;
  readonly createContext: (context?: unknown, options?: unknown) => unknown;
  readonly runInContext: (source: unknown, context?: unknown, options?: unknown) => unknown;
  readonly runInNewContext: (source: unknown, context?: unknown, options?: unknown) => unknown;
  readonly compileFunction: (...args: unknown[]) => never;
  readonly createScript: (code: unknown, options?: unknown) => VmScript;
  readonly measureMemory: (options?: unknown) => Promise<never>;
  readonly constants: Readonly<{ USE_MAIN_CONTEXT_DEFAULT_LOADER: symbol; DONT_CONTEXTIFY: symbol }>;
}

const inspect = (value: unknown, options?: { readonly depth: number }): string => nodeUtil.inspect(value, options);
/** Node's `validateOneOf` for a property of the options object. */
function oneOf(value: unknown, name: string, allowed: readonly string[]): void {
  if (typeof value === "string" && allowed.includes(value)) return;
  throw Object.assign(new TypeError(`The property '${name}' must be one of: ${allowed.map(item => `'${item}'`).join(", ")}. Received ${inspect(value)}`), { code: "ERR_INVALID_ARG_VALUE" });
}
/** Symbols Node hands out for `importModuleDynamically` and `vm.createContext`; one pair per process. */
const vmConstants: NodeVm["constants"] = Object.freeze({
  __proto__: null, USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"), DONT_CONTEXTIFY: Symbol("vm_context_no_contextify"),
});

export function createNodeVm(evaluate: Evaluate, evaluateContext?: EvaluateContext): NodeVm {
  const filenameOf = (options: unknown): string => {
    const value: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "filename") : typeof options === "string" ? options : undefined;
    return typeof value === "string" ? value : "evalmachine.<anonymous>";
  };
  /** Objects `createContext` returned. None is a V8 context: a script run "in" one is a data script over it. */
  const contexts = new WeakSet<object>();
  const createContext = (context: unknown = {}, options?: unknown): unknown => {
    if (evaluateContext === undefined) return refuse("createContext")();
    if (typeof context !== "object" || context === null) throw Object.assign(new TypeError("The \"contextObject\" argument must be of type object"), { code: "ERR_INVALID_ARG_TYPE" });
    if (!inertContextOptions(options)) return refuse("createContext options")();
    contexts.add(context);
    return context;
  };
  class Script {
    readonly #source: string;
    readonly #filename: string;
    constructor(source: unknown, options?: unknown) {
      if (typeof source !== "string") throw Object.assign(new TypeError("The \"code\" argument must be of type string"), { code: "ERR_INVALID_ARG_TYPE" });
      this.#source = source; this.#filename = filenameOf(options);
    }
    runInThisContext(): unknown { return evaluate(this.#source, this.#filename); }
    readonly runInContext = (context?: unknown, options?: unknown): unknown => {
      if (evaluateContext === undefined) return refuse("runInContext")();
      if (typeof context !== "object" || context === null || !contexts.has(context)) throw Object.assign(new TypeError("The \"contextifiedObject\" argument must be an vm.Context"), { code: "ERR_INVALID_ARG_TYPE" });
      if (options !== undefined) return refuse("runInContext options")();
      return evaluateContext(this.#source, context, this.#filename);
    };
    readonly runInNewContext = (context: unknown = {}, options?: unknown): unknown => {
      if (evaluateContext === undefined) return refuse("runInNewContext")();
      if (typeof context !== "object" || context === null) throw new TypeError("VM data context must be an object");
      if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).length !== 0)) return refuse("runInNewContext options")();
      return evaluateContext(this.#source, context, this.#filename);
    };
    createCachedData(): Uint8Array { return new Uint8Array(0); }
  }
  return Object.freeze({
    Script,
    runInThisContext: (source: unknown, options?: unknown): unknown => new Script(source, options).runInThisContext(),
    isContext: (context: unknown): boolean => typeof context === "object" && context !== null && contexts.has(context),
    createContext,
    runInContext: (source: unknown, context?: unknown, options?: unknown): unknown => {
      if (evaluateContext !== undefined && options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some(key => key !== "filename"))) return refuse("runInContext options")();
      return new Script(source, options).runInContext(context);
    },
    runInNewContext: (source: unknown, context?: unknown, options?: unknown) => {
      if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some(key => key !== "filename"))) return refuse("runInNewContext options")();
      return new Script(source, options).runInNewContext(context);
    },
    compileFunction: refuse("compileFunction"),
    createScript(code: unknown, options?: unknown): VmScript { return new Script(code, options); },
    // The realm has no V8 heap measurement: after Node's own validation the promise rejects as Node's does when a context cannot be measured.
    measureMemory(options: unknown = {}): Promise<never> {
      if (options === null || typeof options !== "object" || Array.isArray(options)) throw invalidArgType("options", "object", options, inspect);
      const mode: unknown = Reflect.get(options, "mode") ?? "summary", execution: unknown = Reflect.get(options, "execution") ?? "default";
      oneOf(mode, "options.mode", ["summary", "detailed"]);
      oneOf(execution, "options.execution", ["default", "eager"]);
      return Promise.reject(Object.assign(new Error("context used is not initialized"), { code: "ERR_CONTEXT_NOT_INITIALIZED" }));
    },
    constants: vmConstants,
  });
}
