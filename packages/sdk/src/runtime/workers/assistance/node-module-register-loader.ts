import type { LocalModuleFiles, ModuleFormat, ModuleSource } from "./module-files.ts";
import { moduleLocation } from "./module-files.ts";
import { unavailableNodeApi } from "./node-capability.ts";
import type { createModuleHooks, HookBridge } from "./node-module-hooks.ts";
import type { RegisteredHooks } from "./node-module-register.ts";

/**
 * `module.register()` without a loader thread.
 *
 * Node runs registered hooks on a separate thread and blocks the program's thread on them, so they serve `import`,
 * `import.meta.resolve()` and the synchronous loads alike. Here the hooks run in the program's own thread:
 *
 * - `import` (static and dynamic) awaits the hook chains, composed with `module.registerHooks()` hooks in Node's
 *   order: the synchronous hooks outside, then the registered hooks last-registered first, then the loader.
 * - A synchronous hook cannot wait for a promise. Its `next` step is answered from what the registered chain
 *   already said for the same request; the chain is asked first with the request as the loader made it, and when a
 *   synchronous hook passes on a different request, that one is asked for and the synchronous hooks run again.
 * - A synchronous load (`require()`, the imports of a required ES module, `import.meta.resolve()`) cannot wait
 *   either. It skips the registered hooks, which is what Node 24 does for a plain `require()`, and is refused as a
 *   late failure when a registered `load` hook would plausibly have changed the outcome: the file's extension is
 *   not one Node loads itself.
 * - The hooks module is loaded in a second loader of its own (its own module map and CommonJS cache, as on Node's
 *   thread), sharing the built-ins and the global object with the program.
 */
export interface RegisteredLoadingPorts {
  readonly registry: RegisteredHooks;
  readonly hooks: ReturnType<typeof createModuleHooks>;
  readonly files: LocalModuleFiles;
  /** An admitted file's text as it is on disk, for a load hook that asks the loader for a TypeScript file. */
  readonly readSource?: ((path: string) => string) | undefined;
  readonly fileURLToPath: (url: string) => string;
  readonly buffer: (text: string) => unknown;
  /** This loader is the hooks' own: its imports run through the chains without waiting for registrations. */
  readonly hooksRealm: boolean;
  /** Loads a hooks module in the hooks' own loader: at once when nothing has to be awaited, or as an `import`. */
  readonly loadHooks: { now(specifier: string, parent: string | undefined): unknown; later(specifier: string, parent: string | undefined): Promise<unknown> };
}

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };
const SUSPENDED = new Error("module.register: a synchronous hook is waiting for the registered hooks");
const NODE_EXTENSIONS = new Set(["", ".js", ".mjs", ".cjs", ".json", ".node", ".wasm"]);
const extension = (path: string): string => /\.[^./]*$/u.exec(path)?.[0] ?? "";

function keyOf(argument: unknown, context: Record<string, unknown>): string {
  try { return JSON.stringify([typeof argument, argument, context["parentURL"], context["format"], context["importAttributes"], context["conditions"]]); }
  catch { return `${typeof argument}:${String(argument)}`; }
}

/** Runs a synchronous attempt until every answer it needs from the registered chain is known. */
async function replay<Result>(synchronousHooks: boolean, attempt: (bridge: HookBridge, probe: boolean) => Result, ask: HookBridge): Promise<Result> {
  const known = new Map<string, Outcome>();
  for (let turn = 0; turn < 64; turn++) {
    const probe = turn === 0;
    let wanted: (() => unknown) | undefined, key = "";
    let outcome: { readonly value: Result } | { readonly error: unknown };
    try {
      outcome = { value: attempt((argument, context, own) => {
        const answer = known.get(keyOf(argument, context));
        if (answer === undefined) {
          if (wanted === undefined) { const snapshot = { ...context }; key = keyOf(argument, context); wanted = () => ask(argument, snapshot, own); }
          throw SUSPENDED;
        }
        if (!answer.ok) throw answer.error;
        return answer.value;
      }, probe) };
    } catch (error) { outcome = { error }; }
    if (wanted !== undefined) {
      const pending = wanted;
      known.set(key, await (async (): Promise<Outcome> => { try { return { ok: true, value: await pending() }; } catch (error) { return { ok: false, error }; } })());
      continue;
    }
    // The first turn only asked the registered chain what the loader's own request gives: the synchronous hooks decide.
    if (probe && synchronousHooks) continue;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
  return unavailableNodeApi("module.register: synchronous hooks that keep changing their request");
}

function thenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";
}
function clone(data: unknown, transferList: unknown): unknown {
  const transfer: unknown[] = [];
  const iterate: unknown = transferList === undefined || transferList === null ? undefined : Reflect.get(Object(transferList), Symbol.iterator);
  if (typeof iterate === "function") {
    const iterator: unknown = Reflect.apply(iterate, transferList, []);
    for (let step: unknown = next(iterator); !done(step); step = next(iterator)) transfer.push(Reflect.get(Object(step), "value"));
  }
  // The hooks run in this thread; the copy keeps what a thread boundary gives them: their own `data`, and moved ports.
  const copied: unknown = Reflect.apply(structuredClone, undefined, transferList === undefined ? [data] : [data, { transfer }]);
  return copied;
}
function next(iterator: unknown): unknown {
  const advance: unknown = Reflect.get(Object(iterator), "next");
  return typeof advance === "function" ? Reflect.apply(advance, iterator, []) : { done: true };
}
function done(step: unknown): boolean { return Boolean(Reflect.get(Object(step), "done")); }

export function createRegisteredLoading(ports: RegisteredLoadingPorts) {
  const { registry, hooks } = ports;

  /** Node's `defaultLoad` as a registered hook sees it: bytes for every format but CommonJS, whose loader reads
   * the file itself, and no bytes at all for a built-in. A format the hook states is taken without looking. */
  function defaultLoad(target: string, context: Record<string, unknown>, check: ((format: ModuleFormat) => void) | undefined): unknown {
    if (target.startsWith("node:")) return { format: "builtin", responseURL: target, source: null };
    const parsed = new URL(target);
    if (parsed.protocol !== "file:") {
      throw Object.assign(new Error(`Only URLs with a scheme in: file and data are supported by the default ESM loader. Received protocol '${parsed.protocol}'`), { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" });
    }
    const path = ports.fileURLToPath(`file://${parsed.pathname}`), suffix = extension(path), typescript = /^\.[cm]?ts$/u.test(suffix);
    const text = (): string => typescript && ports.readSource !== undefined ? ports.readSource(path) : ports.files.read(path, "import").source;
    const stated = context["format"];
    if (typeof stated === "string") return { format: stated, responseURL: target, source: stated === "commonjs" ? undefined : ports.buffer(text()) };
    if (!NODE_EXTENSIONS.has(suffix) && !typescript) throw Object.assign(new TypeError(`Unknown file extension "${suffix}" for ${path}`), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    if (typescript) {
      // Node names the format after the package's "type"; this loader reads the file's own syntax instead.
      const source = text(), module = suffix === ".mts" || (suffix === ".ts" && /^\s*(?:import|export)\b/mu.test(source));
      return { format: module ? "module-typescript" : "commonjs-typescript", responseURL: target, source: ports.buffer(source) };
    }
    const input = ports.files.read(path, "import");
    check?.(input.format);
    return { format: input.format, responseURL: target, source: input.format === "commonjs" ? undefined : ports.buffer(input.source) };
  }

  async function resolve(specifier: string, parent: string | undefined, attributes: Readonly<Record<string, string>>): Promise<string> {
    if (!registry.has("resolve")) return hooks.resolve(specifier, parent, "import");
    return replay(hooks.has("resolve"), (bridge, probe) => hooks.resolve(specifier, parent, "import", bridge, probe, attributes),
      (request, context, own) => registry.resolve(request, context["parentURL"], context["importAttributes"], own));
  }

  async function read(identity: string, attributes: Readonly<Record<string, string>>, check: (format: ModuleFormat) => void): Promise<ModuleSource> {
    if (!registry.has("load")) return hooks.read(identity, "import", attributes, check);
    // Node hands the registered chain the synchronous hooks' whole context, and its own shorter one without them.
    const synchronous = hooks.has("load");
    return replay(synchronous, (bridge, probe) => hooks.read(identity, "import", attributes, check, bridge, probe),
      (url, context) => registry.load(url, synchronous ? context : { format: context["format"], importAttributes: context["importAttributes"] },
        (target, merged) => defaultLoad(target, merged, check)));
  }

  /** A built-in's load, which the registered hooks see and may not replace here. */
  async function builtin(identity: string, attributes: Readonly<Record<string, string>>): Promise<undefined> {
    if (!registry.has("load")) return undefined;
    const loaded = await registry.load(identity, { format: undefined, importAttributes: { ...attributes } }, (target, merged) => defaultLoad(target, merged, undefined));
    if (loaded.format !== "builtin") unavailableNodeApi("module.register: a load hook that replaces a built-in module");
    return undefined;
  }

  function register(specifier: string, base: string, data: unknown, transferList: unknown): void {
    const copied = clone(data, transferList);
    let parent: string | undefined;
    if (base.startsWith("file:")) {
      parent = ports.fileURLToPath(base.split(/[?#]/u)[0] ?? base);
      if (parent.endsWith("/")) parent += "[register]";
    }
    // A relative specifier is a URL reference, query and all; anything else is the loader's to resolve.
    const target = /^\.{0,2}\//u.test(specifier) && base.startsWith("file:") ? new URL(specifier, base).href : specifier;
    const install = (exports: unknown): unknown => registry.add(specifier, exports)?.(copied);
    if (!registry.engaged) {
      let exports: unknown, loaded = true;
      try { exports = ports.loadHooks.now(target, parent); } catch (error) {
        // An ES module with a top-level `await` cannot finish before `register()` returns.
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "ERR_REQUIRE_ASYNC_MODULE") throw error;
        loaded = false;
      }
      if (loaded) {
        const initialized = install(exports);
        if (thenable(initialized)) registry.defer(async () => { await initialized; });
        return;
      }
    }
    // Earlier hooks see this module's load, as on Node's loader thread, so it is an `import` the next imports wait
    // for. They are given the specifier as written, unless only its URL form carries a query to the loader.
    const asked = /[?#]/u.test(specifier) ? target : specifier;
    registry.defer(async () => { await install(await ports.loadHooks.later(asked, parent)); });
  }

  return {
    register,
    resolve,
    read,
    builtin,
    /** Whether an `import` has to take the awaited path. */
    get active(): boolean { return registry.has("resolve") || registry.has("load"); },
    /** What an `import` of the program waits for first: the registrations `register()` could not finish. */
    waiting(): Promise<void> | undefined { return ports.hooksRealm || !registry.waiting ? undefined : registry.ready(); },
    /** The rule for a load that cannot wait (see the head of this file). */
    unhooked(path: string): void {
      if (registry.has("load") && !NODE_EXTENSIONS.has(extension(moduleLocation(path).path))) unavailableNodeApi("module.register: require() through asynchronous hooks");
    },
    /** `import.meta.resolve()` answers at once: without the registered hooks, and refused when that fails. */
    metaResolve(specifier: string, parent: string): string {
      try { return hooks.resolve(specifier, parent, "import"); } catch (error) {
        if (registry.has("resolve")) unavailableNodeApi("module.register: import.meta.resolve() through asynchronous hooks");
        throw error;
      }
    },
  };
}

/** One question the loader's graph walk puts to the hooks: answered at once for `require`, awaited for `import`. */
export class Question<Answer> {
  readonly #start: (awaited: boolean) => Answer | Promise<Answer>;
  #answer: { readonly value: Answer } | undefined;
  constructor(start: (awaited: boolean) => Answer | Promise<Answer>) { this.#start = start; }
  now(): void {
    const value = this.#start(false);
    if (value instanceof Promise) throw new TypeError("A synchronous module load cannot wait");
    this.#answer = { value };
  }
  async later(): Promise<void> { this.#answer = { value: await this.#start(true) }; }
  take(): Answer {
    if (this.#answer === undefined) throw new TypeError("The module walk went on without its answer");
    return this.#answer.value;
  }
}
export type Walk<Result> = Generator<Question<unknown>, Result, void>;
export function* ask<Answer>(start: (awaited: boolean) => Answer | Promise<Answer>): Walk<Answer> {
  const question = new Question(start);
  yield question;
  return question.take();
}
export function walkNow<Result>(walk: Walk<Result>): Result {
  for (let step = walk.next(); ; step = walk.next()) {
    if (step.done === true) return step.value;
    step.value.now();
  }
}
export async function walkLater<Result>(walk: Walk<Result>): Promise<Result> {
  for (let step = walk.next(); ; step = walk.next()) {
    if (step.done === true) return step.value;
    await step.value.later();
  }
}
