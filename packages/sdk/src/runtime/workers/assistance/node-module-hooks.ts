/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/modules/customization_hooks.js (registerHooks, buildHooks,
 * validateResolve, validateLoad).
 * Copyright Node.js contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { VMError } from "../../errors.ts";
import { moduleIdentity, moduleLocation, type LocalModuleFiles, type ModuleSource } from "./module-files.ts";
import { invalidType, named } from "./node-util-validators.ts";

type Hook = (...input: unknown[]) => unknown;
type Step = (argument: unknown, context: Record<string, unknown>) => unknown;
/** Stands in for the loader's own step when `module.register()` hooks sit between the synchronous hooks and the
 * loader: it is given that step, `own`, to end its chain with. */
export type HookBridge = (argument: unknown, context: Record<string, unknown>, own: Step) => unknown;
const hooksId = Symbol("kModuleHooksIdKey");
let nextId = 0;

/** What `module.registerHooks()` returns: the two hooks as given, and `deregister()`. */
export class ModuleHooks {
  readonly resolve: unknown;
  readonly load: unknown;
  readonly [hooksId]: number = nextId++;
  readonly #registered: ModuleHooks[];
  constructor(resolve: unknown, load: unknown, registered: ModuleHooks[]) {
    this.resolve = resolve;
    this.load = load;
    this.#registered = registered;
  }
  deregister(): void {
    const index = this.#registered.indexOf(this);
    if (index !== -1) this.#registered.splice(index, 1);
  }
}

function invalidReturn(expected: string, hook: string, property: string, value: unknown): TypeError {
  const got = invalidType("v", "t", value).message.slice("The \"v\" argument must be of type t. Received ".length);
  return Object.assign(new TypeError(`Expected ${expected} to be returned for the "${property}" from the "${hook}" hook but got ${got}.`), { code: "ERR_INVALID_RETURN_PROPERTY_VALUE" });
}
function member(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
  const boxed: unknown = Object(value);
  return typeof boxed === "object" && boxed !== null || typeof boxed === "function" ? Reflect.get(boxed, key) : undefined;
}
function truthy(value: unknown): boolean { return Boolean(value); }
function isHook(value: unknown): value is Hook { return typeof value === "function"; }

function validateResolve(result: unknown): unknown {
  const url = member(result, "url"), format = member(result, "format"), importAttributes = member(result, "importAttributes");
  if (typeof url !== "string") throw invalidReturn("a URL string", "resolve", "url", url);
  if (truthy(format) && typeof format !== "string") throw invalidReturn("a string", "resolve", "format", format);
  if (truthy(importAttributes) && typeof importAttributes !== "object") throw invalidReturn("an object", "resolve", "importAttributes", importAttributes);
  return { url, format, importAttributes };
}
function validateLoad(result: unknown): unknown {
  const source = member(result, "source"), format = member(result, "format");
  if (truthy(format) && typeof format !== "string") throw invalidReturn("a string", "load", "format", format);
  if (source !== null && source !== undefined && sourceText(source) === undefined) throw invalidReturn("a string, an ArrayBuffer, or a TypedArray", "load", "source", source);
  return result;
}
function sourceText(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return new TextDecoder().decode(source);
  return undefined;
}

/** Runs one hook chain, Node's `buildHooks`: the last registered hook first, the loader's own step last. A hook
 * that answers without calling the next one has to say `shortCircuit: true`. */
function run(name: "resolve" | "load", hooks: readonly Hook[], defaultStep: Step, validate: (result: unknown) => unknown, argument: unknown, merged: Record<string, unknown>): unknown {
  let lastRun = hooks.length;
  const wrap = (index: number, step: (argument: unknown, context: Record<string, unknown>, next: unknown) => unknown, next: unknown) =>
    named(function (argument: unknown, context: unknown): unknown {
      lastRun = index;
      if (typeof context === "object" && context !== null && context !== merged) Object.assign(merged, context);
      const result = step(argument, merged, next);
      if (lastRun > 0 && lastRun === index && !truthy(member(result, "shortCircuit"))) throw invalidReturn("true", name, "shortCircuit", member(result, "shortCircuit"));
      return validate(result);
    }, "nextStep");
  let chain: unknown = wrap(0, defaultStep, undefined);
  hooks.forEach((hook, index) => { chain = wrap(index + 1, (argument, context, next) => Reflect.apply(hook, undefined, [argument, context, next]), chain); });
  return isHook(chain) ? chain(argument, merged) : undefined;
}

export interface HookedModulePorts {
  readonly files: LocalModuleFiles;
  /** The loader's own resolution: a path, a `node:` name or, for an import, a module identity. */
  readonly resolve: (specifier: unknown, parent: string | undefined, kind: "require" | "import") => string;
  /** Admits an identity a hook answered with, as the loader admits its own. */
  readonly accept: (identity: string) => void;
  readonly pathToFileURL: (path: string) => string;
  readonly fileURLToPath: (url: string) => string;
  /** Node hands an imported module's bytes to a load hook as a Buffer. */
  readonly buffer: (text: string) => unknown;
  /** Called before a module is read without `module.register()`'s hooks: a `require`, which cannot wait for them. */
  readonly unhooked?: (path: string) => void;
  /** A format Node loads and this loader does not, answered by a `module.register()` load chain: a refusal. */
  readonly unsupportedFormat: (format: string) => never;
}

const REQUIRE_CONDITIONS = ["require", "node", "node-addons", "module-sync"];
export const IMPORT_CONDITIONS = ["node", "import", "module-sync", "node-addons"];

/** Node's synchronous, in-thread module hooks (`module.registerHooks`), threaded through this loader's resolution
 * and read steps for `require` and `import`. Without a registered hook both steps are the loader's own. */
export function createModuleHooks(ports: HookedModulePorts) {
  const registered: ModuleHooks[] = [];
  /** The format a resolve hook gave an identity: the load hook's `context.format`. */
  const formats = new Map<string, unknown>();
  /** A module loaded through one door and evaluated through the other is read once: its second reader takes this. */
  const handoff = new Map<string, { readonly kind: "require" | "import"; readonly source: ModuleSource }>();
  const chain = (name: "resolve" | "load"): Hook[] => registered.map(entry => entry[name]).filter(isHook);
  const location = (identity: string): string => {
    if (identity.startsWith("node:")) return identity;
    const { path, suffix } = moduleLocation(identity);
    return ports.pathToFileURL(path) + suffix;
  };
  const extension = (path: string): string => /\.[^./]*$/u.exec(path)?.[0] ?? "";

  function registerHooks(hooks: unknown): ModuleHooks {
    if (hooks === null || hooks === undefined) throw new TypeError(`Cannot destructure property 'resolve' of 'hooks' as it is ${String(hooks)}.`);
    const resolve = member(hooks, "resolve"), load = member(hooks, "load");
    if (truthy(resolve) && typeof resolve !== "function") throw invalidType("hooks.resolve", "function", resolve);
    if (truthy(load) && typeof load !== "function") throw invalidType("hooks.load", "function", load);
    const entry = new ModuleHooks(resolve, load, registered);
    registered.push(entry);
    return entry;
  }

  function identityOf(url: string, parent: string | undefined, kind: "require" | "import"): string {
    if (url.startsWith("node:")) return ports.resolve(url, parent, kind);
    if (kind === "require" && url.startsWith("/")) return url;
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: url }); }
    if (parsed.protocol !== "file:") {
      throw new VMError("FEATURE_NOT_AVAILABLE", "module hooks that resolve to a URL other than file: or node: are unavailable in browser-assisted processes",
        { backend: "assisted-node", lateFailure: "unavailable-builtin", subject: "module.registerHooks (non-file URL)" });
    }
    const path = ports.fileURLToPath(`file://${parsed.pathname}`);
    return kind === "import" ? moduleIdentity(path, parsed.search + parsed.hash) : path;
  }
  function parentOf(context: Record<string, unknown>): string | undefined {
    const url = context["parentURL"];
    if (typeof url !== "string") return undefined;
    return url.startsWith("file:") ? ports.fileURLToPath(url.split(/[?#]/u)[0] ?? url) : url;
  }

  /** With a `bridge` the loader's own step is the bridge's to call; `probe` leaves the synchronous hooks out. */
  function resolve(specifier: unknown, parent: string | undefined, kind: "require" | "import", bridge?: HookBridge, probe = false,
    attributes: Readonly<Record<string, string>> = {}): string {
    const hooks = probe ? [] : chain("resolve");
    if (hooks.length === 0 && bridge === undefined) return ports.resolve(specifier, parent, kind);
    const context: Record<string, unknown> = {
      parentURL: parent === undefined ? undefined : location(parent),
      importAttributes: kind === "import" ? { ...attributes } : undefined,
      conditions: [...(kind === "require" ? REQUIRE_CONDITIONS : IMPORT_CONDITIONS)],
    };
    const own: Step = (request, merged) => {
      // Node resolves a `require` against the module that asked, whatever a hook made of `parentURL`.
      const identity = ports.resolve(request, kind === "require" ? parent : parentOf(merged), kind);
      let format: string | null | undefined;
      if (identity.startsWith("node:")) format = kind === "require" && !(typeof request === "string" && request.startsWith("node:")) ? undefined : kind === "require" ? "builtin" : undefined;
      else if (kind === "import") format = { ".mjs": "module", ".cjs": "commonjs", ".json": "json" }[extension(moduleLocation(identity).path)] ?? null;
      return { url: location(identity), format };
    };
    const result = run("resolve", hooks, bridge === undefined ? own : (request, merged) => bridge(request, merged, own), validateResolve, specifier, context);
    const url = member(result, "url");
    const identity = identityOf(typeof url === "string" ? url : "", kind === "require" ? parent : parentOf(context), kind);
    if (!identity.startsWith("node:")) {
      ports.accept(identity);
      if (formats.size >= 65_536) formats.clear();
      formats.set(identity, member(result, "format"));
    }
    return identity;
  }

  /** `check` is the loader's own step's test of an import's attributes against the format it read: a hook that
   * answers itself skips it, as in Node. */
  function read(identity: string, kind: "require" | "import" = "require", attributes: Readonly<Record<string, string>> = {}, check?: (format: ModuleSource["format"]) => void,
    bridge?: HookBridge, probe = false): ModuleSource {
    const path = moduleLocation(identity).path;
    const kept = handoff.get(path);
    if (kept !== undefined && kept.kind !== kind) { handoff.delete(path); return kept.source; }
    if (bridge === undefined) ports.unhooked?.(path);
    const hooks = probe ? [] : chain("load");
    if (hooks.length === 0 && bridge === undefined) {
      const input = ports.files.read(path, kind);
      check?.(input.format);
      return input;
    }
    const url = location(identity);
    const byExtension = { ".mjs": "module", ".cjs": "commonjs", ".json": "json" }[extension(path)];
    const context: Record<string, unknown> = {
      // Under `module.register()` hooks the format is the resolve chain's answer, absent when it gave none.
      format: bridge !== undefined && formats.has(identity) ? formats.get(identity) : formats.get(identity) ?? (kind === "require" ? byExtension : byExtension ?? null),
      importAttributes: kind === "import" ? { ...attributes } : undefined,
      conditions: [...(kind === "require" ? REQUIRE_CONDITIONS : IMPORT_CONDITIONS)],
    };
    const fromDisk = (target: unknown): ModuleSource => ports.files.read(typeof target === "string" && target.startsWith("file:") ? ports.fileURLToPath(target.split(/[?#]/u)[0] ?? target) : path, kind);
    const own: Step = target => {
      const input = fromDisk(target);
      check?.(input.format);
      if (kind === "import") return { format: input.format, responseURL: target, source: ports.buffer(input.source) };
      // Node names CommonJS for a `require` only when the file's name does (.cjs).
      return { source: input.source, format: input.format === "commonjs" ? (byExtension === "commonjs" ? "commonjs" : undefined) : input.format };
    };
    const result = run("load", hooks, bridge === undefined ? own : (target, merged) => bridge(target, merged, own), validateLoad, url, context);
    // `require` falls back on the format the file's name gives; `import` takes the hook's answer alone.
    const given = member(result, "format"), format = (given === null || given === undefined) && kind === "require" ? context["format"] : given;
    if (kind === "import" && format === "builtin") throw Object.assign(new Error(`No such built-in module: ${url}`), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
    const provided = member(result, "source");
    let text = sourceText(provided);
    if (text === undefined) {
      // Node reads an imported CommonJS or JSON module itself when the hook names the format without the text.
      if (bridge !== undefined && format === "module") throw invalidReturn("string, array buffer, or typed array", "load", "source", provided);
      if (kind !== "import" || (format !== "commonjs" && format !== "json")) throw invalidReturn("a string, an ArrayBuffer, or a TypedArray", "load", "source", provided);
      text = fromDisk(url).source;
    }
    let source: ModuleSource;
    if (kind === "require") source = { source: text, format: format === "module" ? "module" : path.endsWith(".json") ? "json" : "commonjs" };
    else if (format === "module" || format === "commonjs" || format === "json") source = { source: text, format };
    else if (bridge !== undefined && (format === "module-typescript" || format === "commonjs-typescript" || format === "wasm" || format === "addon")) return ports.unsupportedFormat(format);
    else {
      const shown = typeof format === "string" ? format : format === null || context["format"] === null ? "null" : "undefined";
      throw Object.assign(new RangeError(`Unknown module format: ${shown} for URL ${url}`), { code: "ERR_UNKNOWN_MODULE_FORMAT" });
    }
    // An imported CommonJS module runs through `require`, and a required ES module through the import path.
    if ((kind === "import" && source.format === "commonjs") || (kind === "require" && source.format === "module")) {
      if (handoff.size >= 4_096) handoff.clear();
      handoff.set(path, { kind, source });
    }
    return source;
  }

  return { registerHooks, resolve, read, has: (name: "resolve" | "load"): boolean => chain(name).length !== 0, get active(): boolean { return registered.length !== 0; } };
}
