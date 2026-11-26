import type { ModuleHooks } from "./node-module-hooks.ts";
import type { ModulePaths } from "./node-module-paths.ts";
import { createStripTypeScriptTypes, type TypeScriptPorts } from "./node-module-typescript.ts";
import { templateText } from "./node-util-validators.ts";

export interface ModuleApiPorts {
  readonly paths: ModulePaths;
  readonly registerHooks: (hooks: unknown) => ModuleHooks;
  /** Loads a hooks module and installs its asynchronous hooks. `base` is the parent URL, "data:" by default. */
  readonly register: (specifier: string, base: string, data: unknown, transferList: unknown) => void;
  /** Re-reads every evaluated built-in's exports into its ES module bindings. */
  readonly syncBuiltinESMExports: () => void;
  readonly typescript: TypeScriptPorts;
}

function coded<Failure extends Error>(error: Failure, code: string): Failure { return Object.assign(error, { code }); }
/** Pins what a program can read of a function: production code is minified, and Node's arities count no defaults. */
function shaped<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "name", { value: name, configurable: true });
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return target;
}
function constantTable<Table extends object>(table: Table): Readonly<Table> {
  Object.setPrototypeOf(table, null);
  return Object.freeze(table);
}

/**
 * The parts of Node 24's `module` built-in that are not the CommonJS loader itself, defined on the loader's
 * `Module` as Node defines them: enumerable, writable data properties, so a named import finds each.
 */
export function installModuleApi(Module: object, ports: ModuleApiPorts): void {
  const DISABLED = 3;
  const api: Record<string, unknown> = {
    syncBuiltinESMExports: shaped((): void => { ports.syncBuiltinESMExports(); }, "syncBuiltinESMExports", 0),
    registerHooks: shaped((hooks: unknown) => ports.registerHooks(hooks), "registerHooks", 1),
    /** Node's own argument checks; the hooks then run in this thread (see node-module-register-loader.ts). */
    register: shaped((...input: unknown[]): void => {
      let parent: unknown = input[1] ?? "data:", options: unknown = input[2];
      if (typeof parent === "object" && parent !== null && !(parent instanceof URL)) { options = parent; parent = Reflect.get(parent, "parentURL") ?? "data:"; }
      const transferList: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "transferList") : undefined;
      if (transferList !== undefined && transferList !== null && typeof Reflect.get(Object(transferList), Symbol.iterator) !== "function") {
        throw coded(new TypeError("Optional transferList argument must be an iterable"), "ERR_INVALID_ARG_TYPE");
      }
      const specifier = templateText(input[0]), base = templateText(parent);
      if (!URL.canParse(specifier) && !URL.canParse(specifier, base)) {
        throw coded(new TypeError(`Failed to resolve module specifier "${specifier}" from "${base}": Invalid relative URL or base scheme is not hierarchical.`), "ERR_UNSUPPORTED_RESOLVE_REQUEST");
      }
      ports.register(specifier, base, typeof options === "object" && options !== null ? Reflect.get(options, "data") : undefined, transferList ?? undefined);
    }, "register", 1),
    constants: constantTable({ compileCacheStatus: constantTable({ FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED }) }),
    /** There is no V8 code cache here: the answer is Node's own for a cache that is switched off. */
    enableCompileCache: shaped((options?: unknown) => {
      const directory: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "directory") : options;
      if (directory !== undefined && typeof directory !== "string") throw coded(new TypeError("cacheDir should be a string"), "ERR_INVALID_ARG_TYPE");
      return { status: DISABLED, message: "Disabled by NODE_DISABLE_COMPILE_CACHE" };
    }, "enableCompileCache", 1),
    findPackageJSON: shaped((...input: unknown[]) => ports.paths.findPackageJSON(input.length, input[0], input[1]), "findPackageJSON", 1),
    flushCompileCache: shaped((keepDeserializedCache: unknown = false): void => {
      if (typeof keepDeserializedCache !== "boolean") throw coded(new TypeError("keepDeserializedCache should be a boolean"), "ERR_INVALID_ARG_TYPE");
    }, "flushCompileCache", 0),
    getCompileCacheDir: shaped((): undefined => undefined, "getCompileCacheDir", 0),
    stripTypeScriptTypes: shaped(createStripTypeScriptTypes(ports.typescript), "stripTypeScriptTypes", 1),
  };
  for (const [name, value] of Object.entries(api)) Object.defineProperty(Module, name, { value, enumerable: true, writable: true, configurable: true });
}
