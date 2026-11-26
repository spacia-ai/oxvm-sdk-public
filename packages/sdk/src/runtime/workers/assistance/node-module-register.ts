/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/modules/esm/hooks.js (AsyncLoaderHooksOnLoaderHookWorker:
 * addCustomLoader, resolve, load; pluckHooks; nextHookFactory).
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
import { invalidType, invalidValue, named, validateObject } from "./node-util-validators.ts";

/** The loader's own step at the end of a chain: Node's `defaultResolve` or `defaultLoad`. */
export type FinalStep = (argument: string, context: Record<string, unknown>) => unknown;
type Next = (argument?: unknown, context?: unknown) => Promise<unknown>;
type ValidateArguments = (identifier: string, argument: unknown, context: unknown) => void;
interface Link { readonly url: string; readonly hook: unknown }
interface Meta { chainFinished: boolean; readonly context: Record<string, unknown>; identifier: string; shortCircuited: boolean }
export interface AsyncResolution { readonly url: string; readonly format: unknown; readonly importAttributes: unknown }
export interface AsyncLoad { readonly format: string; readonly responseURL: string; readonly source: unknown }

const IMPORT_CONDITIONS = ["node", "import", "module-sync", "node-addons"];

function truthy(value: unknown): boolean { return Boolean(value); }
function got(value: unknown): string { return invalidType("v", "t", value).message.slice("The \"v\" argument must be of type t. Received ".length); }
function invalidReturnValue(identifier: string, value: unknown): TypeError {
  return Object.assign(new TypeError(`Expected an object to be returned from the "${identifier}" function but got ${got(value)}.`), { code: "ERR_INVALID_RETURN_VALUE" });
}
function invalidReturnProperty(expected: string, identifier: string, property: string, value: unknown): TypeError {
  return Object.assign(new TypeError(`Expected ${expected} to be returned for the "${property}" from the "${identifier}" hook but got ${got(value)}.`), { code: "ERR_INVALID_RETURN_PROPERTY_VALUE" });
}
function incomplete(identifier: string): Error {
  return Object.assign(new Error(`"${identifier}" did not call the next hook in its chain and did not explicitly signal a short circuit. If this is intentional, include \`shortCircuit: true\` in the hook's return.`), { code: "ERR_LOADER_CHAIN_INCOMPLETE" });
}
function output(identifier: string, value: unknown): object {
  if (typeof value !== "object" || value === null) throw invalidReturnValue(identifier, value);
  return value;
}

/**
 * The hooks `module.register()` installed, in registration order, and the registrations still loading. Node keeps
 * them on a separate loader thread; here they run in the program's thread, so a chain is a promise the loader's
 * `import` awaits (and a synchronous `require` cannot wait for).
 */
export class RegisteredHooks {
  readonly #resolve: Link[] = [];
  readonly #load: Link[] = [];
  #pending: Promise<void> | undefined;
  readonly #failures: unknown[] = [];

  has(name: "resolve" | "load"): boolean { return (name === "resolve" ? this.#resolve : this.#load).length !== 0; }
  /** Whether a hooks module has to be loaded through `import`: an earlier registration's hooks see its load, or
   * that registration has not finished. */
  get engaged(): boolean { return this.#pending !== undefined || this.#resolve.length !== 0 || this.#load.length !== 0; }

  /** Node's `addCustomLoader`: the hooks join their chains before `initialize` runs. Returns `initialize`. */
  add(url: string, exports: unknown): ((data: unknown) => unknown) | undefined {
    const read = (name: string): unknown => (typeof exports === "object" && exports !== null) || typeof exports === "function" ? Reflect.get(exports, name) : undefined;
    const resolve = read("resolve"), load = read("load"), initialize = read("initialize");
    if (truthy(resolve)) this.#resolve.push({ url, hook: resolve });
    if (truthy(load)) this.#load.push({ url, hook: load });
    if (!truthy(initialize)) return undefined;
    return (data: unknown): unknown => {
      if (typeof initialize !== "function") throw new TypeError("initialize is not a function");
      const result: unknown = Reflect.apply(initialize, undefined, [data]);
      return result;
    };
  }

  /** Queues a registration that cannot finish before `register()` returns. Every `import` of the program that
   * starts later waits for it; its failure, which Node throws from `register()`, is the next such import's. */
  defer(task: () => Promise<void>): void {
    const gate: Promise<void> = (this.#pending ?? Promise.resolve()).then(task).then(undefined, (error: unknown) => { this.#failures.push(error); })
      .then(() => { if (this.#pending === gate) this.#pending = undefined; });
    this.#pending = gate;
  }
  get waiting(): boolean { return this.#pending !== undefined || this.#failures.length !== 0; }
  async ready(): Promise<void> {
    while (this.#pending !== undefined) await this.#pending;
    if (this.#failures.length !== 0) throw this.#failures.shift();
  }

  #chain(name: "resolve" | "load", links: readonly Link[], final: FinalStep, meta: Meta, validateArguments: ValidateArguments): Next {
    const nextName = name === "resolve" ? "nextResolve" : "nextLoad";
    let next: Next = named((): Promise<unknown> => { throw Object.assign(new Error(`ESM custom loader '${name}' advanced beyond the end of the chain.`), { code: "ERR_INTERNAL_ASSERTION" }); }, "chainAdvancedTooFar");
    [{ url: `node:internal/modules/esm/${name}`, hook: final }, ...links].forEach((link, index) => {
      const following = next;
      next = named(async (argument?: unknown, context?: unknown): Promise<unknown> => {
        meta.identifier = `${link.url} '${name}'`;
        validateArguments(`${meta.identifier} hook's ${nextName}()`, argument, context);
        if (index === 0) meta.chainFinished = true;
        if (typeof context === "object" && context !== null) Object.assign(meta.context, context);
        if (typeof link.hook !== "function") throw new TypeError("hook is not a function");
        const result = output(`${link.url} '${name}' hook's ${nextName}()`, await Reflect.apply(link.hook, undefined, [argument, meta.context, following]));
        if (Reflect.get(result, "shortCircuit") === true) meta.shortCircuited = true;
        return result;
      }, nextName);
    });
    return next;
  }
  #finish(meta: Meta, value: unknown): object {
    const result = output(meta.identifier, value);
    if (Reflect.get(result, "shortCircuit") === true) meta.shortCircuited = true;
    if (!meta.chainFinished && !meta.shortCircuited) throw incomplete(meta.identifier);
    return result;
  }

  /** Runs the `resolve` chain, the last registered hook first, as the loader thread does for one `import`. */
  async resolve(specifier: unknown, parentURL: unknown, importAttributes: unknown, final: FinalStep): Promise<AsyncResolution> {
    const meta: Meta = { chainFinished: false, context: { conditions: [...IMPORT_CONDITIONS], importAttributes, parentURL }, identifier: "", shortCircuited: false };
    const next = this.#chain("resolve", this.#resolve, final, meta, (identifier, supplied, context) => {
      if (typeof supplied !== "string") throw invalidType(`${identifier} specifier`, "string", supplied);
      if (truthy(context)) validateObject(context, `${identifier} context`);
    });
    const resolution = this.#finish(meta, await next(specifier, meta.context));
    const url: unknown = Reflect.get(resolution, "url"), format: unknown = Reflect.get(resolution, "format"), attributes: unknown = Reflect.get(resolution, "importAttributes");
    if (typeof url !== "string" || !URL.canParse(url)) throw invalidReturnProperty("a URL string", meta.identifier, "url", url);
    if (attributes !== null && attributes !== undefined && typeof attributes !== "object") throw invalidReturnProperty("an object", meta.identifier, "importAttributes", attributes);
    if (format !== null && format !== undefined && typeof format !== "string") throw invalidReturnProperty("a string", meta.identifier, "format", format);
    return { format, importAttributes: attributes, url };
  }

  /** Runs the `load` chain. `context` is the loader's own object: a hook's changes to it reach the next hook. */
  async load(url: unknown, context: Record<string, unknown>, final: FinalStep): Promise<AsyncLoad> {
    const meta: Meta = { chainFinished: false, context, identifier: "", shortCircuited: false };
    const next = this.#chain("load", this.#load, final, meta, (identifier, supplied, given) => {
      // Node's own wording, article and all.
      if (typeof supplied !== "string") throw Object.assign(new TypeError(`The "${identifier} url" ${identifier.includes(".") ? "property" : "argument"} must be an a URL string. Received ${got(supplied)}`), { code: "ERR_INVALID_ARG_TYPE" });
      if (!URL.canParse(supplied)) throw invalidValue(`${identifier} url`, supplied, "should be a URL string");
      if (truthy(given)) validateObject(given, `${identifier} context`);
    });
    const loaded = this.#finish(meta, await next(url, context));
    const format: unknown = Reflect.get(loaded, "format"), source: unknown = Reflect.get(loaded, "source"), responseURL: unknown = Reflect.get(loaded, "responseURL") ?? url;
    if (typeof responseURL !== "string" || URL.parse(responseURL)?.href !== responseURL) {
      throw invalidReturnProperty("undefined or a fully resolved URL string", meta.identifier, "responseURL", responseURL);
    }
    if (format === null || format === undefined) throw Object.assign(new RangeError(`Unknown module format: ${String(format)} for URL ${String(url)}`), { code: "ERR_UNKNOWN_MODULE_FORMAT" });
    if (typeof format !== "string") throw invalidReturnProperty("a string", meta.identifier, "format", format);
    if (source !== null && source !== undefined && typeof source !== "string" && !(source instanceof ArrayBuffer) && !(source instanceof SharedArrayBuffer) && !ArrayBuffer.isView(source)) {
      throw invalidReturnProperty("a string, an ArrayBuffer, or a TypedArray", meta.identifier, "source", source);
    }
    return { format, responseURL, source };
  }
}
