import { unavailableNodeApi } from "./node-capability.ts";
import { nodeV8Serialization } from "./node-v8-serdes.ts";
import { invalidType, named } from "./node-util-validators.ts";

/** Pins the `name` and `length` a program can read of a function whose parameters are never used. */
function shaped<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return named(target, name);
}

/** The process's async resources as `async_hooks.createHook` reads them: promises are resources of type PROMISE. */
export interface PromiseLifecycle {
  createHook(callbacks: unknown): { enable(): unknown; disable(): unknown };
}
type PromiseHook = (...args: unknown[]) => unknown;
const HOOK_NAMES = ["init", "before", "after", "settled"] as const;
type HookName = typeof HOOK_NAMES[number];
const AsyncFunction: unknown = Object.getPrototypeOf(async function () { await Promise.resolve(); });

/** Node's `validatePlainFunction`: a function that is not an async function. */
function plainFunction(value: unknown, name: string): PromiseHook {
  if (typeof value !== "function" || Object.getPrototypeOf(value) === AsyncFunction) throw invalidType(name, "function", value);
  return (...args) => { const result: unknown = Reflect.apply(value, undefined, args); return result; };
}

/**
 * `v8.promiseHooks` on the lifecycle the process already records for AsyncLocalStorage. Differences from V8's own
 * hooks: only promises created while a hook is installed are followed; `settled` of a reaction's promise comes
 * after its `after`, where V8 reports it before; and a promise the engine creates without the process's Promise
 * constructor (inside native async functions) is not seen.
 */
function createPromiseHooks(lifecycle: PromiseLifecycle) {
  const hooks: Record<HookName, PromiseHook[]> = { init: [], before: [], after: [], settled: [] };
  const promises = new Map<number, WeakRef<object>>();
  const run = (name: HookName, ...args: unknown[]): void => {
    const failures: unknown[] = [];
    for (const hook of [...hooks[name]]) { try { hook(...args); } catch (error) { failures.push(error); } }
    // Every hook has run before the first failure is reported, as in Node.
    if (failures.length !== 0) throw failures[0];
  };
  const followed = (id: unknown): object | undefined => typeof id === "number" ? promises.get(id)?.deref() : undefined;
  const source = lifecycle.createHook({
    init(id: unknown, type: unknown, trigger: unknown, resource: unknown): void {
      if (type !== "PROMISE" || typeof id !== "number" || typeof resource !== "object" || resource === null) return;
      promises.set(id, new WeakRef(resource));
      run("init", resource, followed(trigger));
    },
    before(id: unknown): void { const promise = followed(id); if (promise !== undefined) run("before", promise); },
    after(id: unknown): void { const promise = followed(id); if (promise !== undefined) run("after", promise); },
    promiseResolve(id: unknown): void { const promise = followed(id); if (promise !== undefined) run("settled", promise); },
    destroy(id: unknown): void { if (typeof id === "number") promises.delete(id); },
  });
  const update = (): void => {
    if (HOOK_NAMES.some(name => hooks[name].length !== 0)) source.enable();
    else { source.disable(); promises.clear(); }
  };
  const use = (name: HookName) => named((hook: unknown): () => void => {
    const list = hooks[name], installed = plainFunction(hook, `${name}Hook`);
    list.push(installed);
    update();
    return () => { const index = list.indexOf(installed); if (index >= 0) { list.splice(index, 1); update(); } };
  }, "");
  const onInit = use("init"), onBefore = use("before"), onAfter = use("after"), onSettled = use("settled");
  const createHook = (...rest: unknown[]): () => void => {
    const given = rest.length === 0 || rest[0] === undefined ? {} : rest[0];
    if (given === null) throw new TypeError("Cannot destructure property 'init' of 'object' as it is null.");
    const stops: (() => void)[] = [], read = (name: string): unknown => Reflect.get(Object(given), name);
    for (const [name, install] of [["init", onInit], ["before", onBefore], ["after", onAfter], ["settled", onSettled]] as const) {
      const hook = read(name);
      if (hook !== undefined && hook !== null && hook !== false && hook !== 0 && hook !== "") stops.push(install(hook));
    }
    return () => { for (const stop of stops) stop(); };
  };
  return { createHook: named(createHook, "createHook"), onInit, onBefore, onAfter, onSettled };
}

function refusedPromiseHooks() {
  const refuse = (name: string) => named((): never => unavailableNodeApi(`v8.promiseHooks.${name}`), name);
  return { createHook: refuse("createHook"), onInit: refuse("onInit"), onBefore: refuse("onBefore"), onAfter: refuse("onAfter"), onSettled: refuse("onSettled") };
}

function notBuildingSnapshot(): never {
  throw Object.assign(new Error("Operation cannot be invoked when not building startup snapshot"), { code: "ERR_NOT_BUILDING_SNAPSHOT" });
}
/** Node's class; nothing here can profile the collector, so constructing one is refused. */
function GCProfiler(): never { return unavailableNodeApi("v8.GCProfiler"); }
named(GCProfiler, "GCProfiler");

/** What `v8` takes from its process. */
export interface V8Ports {
  /** `context.resources` of the process. Without it `v8.promiseHooks` is refused. */
  readonly promises?: PromiseLifecycle;
  /**
   * The VM's configured memory in bytes: Linux's `MemTotal`, which is `os.totalmem()`. Without it
   * `v8.getHeapStatistics` is refused. A failure of the read itself is thrown by the port and is not caught here.
   */
  readonly heapLimit?: () => number;
}

/**
 * `v8.getHeapStatistics` by owner decision of 2026-11-27 (engine ADR 0026, "Heap statistics"). No browser gives a
 * dedicated worker a measurement of its heap, so nothing here is one:
 *
 * - `heap_size_limit` and `total_available_size` are the VM's configured memory, a stated configuration and not the
 *   browser's real ceiling for this worker's heap, which may be lower;
 * - `number_of_native_contexts` is 1, the one realm a process runs in;
 * - `does_zap_garbage` is 0, as in every release build of Node;
 * - every other field is 0, which means "not measured" and never "empty".
 *
 * A program that sizes a cache from the limit works. A program that watches heap pressure sees none.
 */
function heapStatistics(limit: (() => number) | undefined): Record<string, number> {
  const configured = limit?.();
  if (configured === undefined || !Number.isSafeInteger(configured) || configured <= 0) return unavailableNodeApi("v8.getHeapStatistics");
  // Node's key order.
  return {
    total_heap_size: 0, total_heap_size_executable: 0, total_physical_size: 0, total_available_size: configured,
    used_heap_size: 0, heap_size_limit: configured, malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0,
    number_of_native_contexts: 1, number_of_detached_contexts: 0, total_global_handles_size: 0,
    used_global_handles_size: 0, external_memory: 0,
  };
}

/**
 * The `v8` builtin. Heap snapshots, per-space and code statistics, profilers and heap queries have no browser
 * equivalent and are refused; a process never builds a startup snapshot and never collects coverage, so those answer
 * as Node does in that state. `getHeapStatistics` answers the VM's configured memory (see `heapStatistics`).
 */
export function createNodeV8(ports: V8Ports = {}) {
  return Object.freeze({
    ...nodeV8Serialization,
    getHeapStatistics: named((): Record<string, number> => heapStatistics(ports.heapLimit), "getHeapStatistics"),
    getHeapSpaceStatistics: () => unavailableNodeApi("v8.getHeapSpaceStatistics"),
    getHeapCodeStatistics: () => unavailableNodeApi("v8.getHeapCodeStatistics"),
    getHeapSnapshot: () => unavailableNodeApi("v8.getHeapSnapshot"),
    writeHeapSnapshot: () => unavailableNodeApi("v8.writeHeapSnapshot"),
    setHeapSnapshotNearHeapLimit: () => unavailableNodeApi("v8.setHeapSnapshotNearHeapLimit"),
    setFlagsFromString: () => unavailableNodeApi("v8.setFlagsFromString"),
    getCppHeapStatistics: shaped((): never => unavailableNodeApi("v8.getCppHeapStatistics"), "getCppHeapStatistics", 0),
    queryObjects: shaped((): never => unavailableNodeApi("v8.queryObjects"), "queryObjects", 1),
    startCpuProfile: shaped((): never => unavailableNodeApi("v8.startCpuProfile"), "startCpuProfile", 0),
    GCProfiler,
    // Without NODE_V8_COVERAGE Node has no coverage to write or stop.
    takeCoverage: named((): void => undefined, "takeCoverage"),
    stopCoverage: named((): void => undefined, "stopCoverage"),
    promiseHooks: ports.promises === undefined ? refusedPromiseHooks() : createPromiseHooks(ports.promises),
    startupSnapshot: {
      addDeserializeCallback: shaped(notBuildingSnapshot, "addDeserializeCallback", 2),
      addSerializeCallback: shaped((): never => notBuildingSnapshot(), "addSerializeCallback", 2),
      setDeserializeMainFunction: shaped((): never => notBuildingSnapshot(), "setDeserializeMainFunction", 2),
      // Node 24.18.1 answers the native flag itself, the number 0.
      isBuildingSnapshot: named((): number => 0, "isBuildingSnapshot"),
    },
  });
}

/** The builtin for a process that offers neither its promise lifecycle nor a configured memory. */
export const nodeV8Memory = createNodeV8();

/**
 * `process.memoryUsage` of a process object that was given no memory ports: both calls refuse. A running process
 * replaces it with `createProcessMemory(...).memoryUsage` (node-process-memory.ts), whose `rss` is Linux's.
 */
export const processMemoryUsage = Object.assign(() => unavailableNodeApi("process.memoryUsage"), {
  rss: () => unavailableNodeApi("process.memoryUsage.rss"),
});
