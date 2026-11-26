import { readFileSync } from "node:fs";
import { types } from "node:util";
import { PassThrough } from "readable-stream";
import { record } from "../../decode.js";
import { createNodeReadline } from "./node-readline.js";
import { createNodeRepl, type NodeReplDependencies, type NodeReplModule, type ReplFiles, type ReplServer } from "./node-repl.js";
import { nodeUtil } from "./node-util.js";
import { createNodeVm, realmEvaluator } from "./node-vm.js";

export function loadControls(file: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")), file);
}
export function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError("not a list"); return value; }

/** The recorder's own description of an object's properties and of a call's outcome. */
export function shape(target: object): Record<string, unknown> {
  return Object.fromEntries(Reflect.ownKeys(target).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), value: unknown = descriptor?.value;
    return [String(key), [typeof value, typeof value === "function" ? value.name : null, typeof value === "function" ? value.length : null, descriptor?.enumerable, descriptor?.writable ?? null, descriptor?.configurable, typeof descriptor?.get, typeof descriptor?.set]];
  }));
}
export function outcome(run: () => unknown, constructorName = true): unknown {
  try { const value = run(); return { ok: value === undefined ? "$undefined" : value }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const code: unknown = Reflect.get(error, "code");
    return { error: { name: error.name, ...(code === undefined ? {} : { code }), message: error.message, ...(constructorName ? { ctor: error.constructor.name } : {}) } };
  }
}

/** An in-memory `fs` with the three operations the REPL uses. */
export function memoryFiles(directories: readonly string[], initial: Readonly<Record<string, string>> = {}) {
  const files = new Map<string, { data: string; mode: number }>(Object.entries(initial).map(([path, data]) => [path, { data, mode: 0o644 }]));
  const dirs = new Set(directories);
  const failure = (code: string, path: string): Error => Object.assign(new Error(`${code}: ${path}`), { code });
  const port: ReplFiles = {
    readFileSync(path) {
      if (dirs.has(path)) throw failure("EISDIR", path);
      const file = files.get(path);
      if (file === undefined) throw failure("ENOENT", path);
      return file.data;
    },
    writeFileSync(path, data, options) {
      if (dirs.has(path)) throw failure("EISDIR", path);
      if (!dirs.has(path.slice(0, path.lastIndexOf("/")))) throw failure("ENOENT", path);
      const existing = files.get(path);
      files.set(path, { data, mode: existing?.mode ?? options?.mode ?? 0o644 });
      return undefined;
    },
    statSync(path) {
      if (dirs.has(path)) return { isFile: () => false };
      if (!files.has(path)) throw failure("ENOENT", path);
      return { isFile: () => true };
    },
  };
  return { port, files };
}

export interface ReplHarness extends NodeReplModule {
  readonly warnings: { code: string; message: string }[];
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
}
/** A `repl` module over the runtime's own readline, vm and inspect, as the process wires it. */
export function createHarness(overrides: Partial<NodeReplDependencies> = {}): ReplHarness {
  const warnings: { code: string; message: string }[] = [], warned = new Set<string>();
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdout.resume();
  const vm = createNodeVm(realmEvaluator());
  const created = createNodeRepl({
    readline: createNodeReadline({ nextTick: callback => { process.nextTick(callback); } }),
    runInThisContext: (code, options) => vm.runInThisContext(code, options),
    inspect: nodeUtil.inspect,
    deprecate: (fn, message, code) => named(function (this: unknown, ...args: unknown[]): unknown { if (!warned.has(code)) { warned.add(code); warnings.push({ code, message }); } return Reflect.apply(fn, this, args); }, fn),
    isProxy: value => types.isProxy(value),
    files: memoryFiles([]).port,
    process: { stdin, stdout, env: {} },
    builtinModules: () => [],
    nextTick: callback => { process.nextTick(callback); },
    ...overrides,
  });
  return { ...created, warnings, stdin, stdout };
}
/** A deprecation wrapper, like Node's: called `deprecated`, with the wrapped function's length. */
function named<T extends (...args: never[]) => unknown>(wrapper: T, original: (...args: never[]) => unknown): T {
  Object.defineProperty(wrapper, "name", { value: "deprecated" });
  Object.defineProperty(wrapper, "length", { value: original.length });
  return wrapper;
}

/** Calls a method by name and answers with what it returned, whatever its declared type. */
export function invoke(target: object, method: string, ...args: unknown[]): unknown {
  const operation: unknown = Reflect.get(target, method);
  if (typeof operation !== "function") throw new TypeError(`no ${method}`);
  const result: unknown = Reflect.apply(operation, target, args);
  return result;
}
/** Calls a function as Node's callers may: without `new`, or with it. */
export function call(target: unknown, args: unknown[]): unknown {
  if (typeof target !== "function") throw new TypeError("not callable");
  const result: unknown = Reflect.apply(target, undefined, args);
  return result;
}
export function read(target: unknown, key: string): unknown {
  const value: unknown = Reflect.get(asObject(target), key);
  return value;
}
export function asObject(value: unknown): object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new TypeError("not an object");
  return value;
}
export function prototypeOf(target: unknown): object {
  const prototype: unknown = typeof target === "function" ? target.prototype : undefined;
  if (typeof prototype !== "object" || prototype === null) throw new TypeError("no prototype");
  return prototype;
}

const turn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
/** Lets pending ticks, promise jobs and immediates run. */
export async function settle(turns = 3): Promise<void> { for (let index = 0; index < turns; index++) await turn(); }

export interface Session {
  readonly server: ReplServer;
  readonly events: string[];
  /** Writes one line and answers with what the REPL wrote for it. */
  readonly type: (line: string, afterWrite?: () => void) => Promise<string>;
  readonly end: () => Promise<string>;
  readonly take: () => string;
}
export function openSession(harness: ReplHarness, options: Record<string, unknown>, prompts: readonly string[] = ["> ", "| "]): Session {
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk: unknown) => { text += String(chunk); });
  const events: string[] = [];
  const server = harness.module.start({ input, output, terminal: false, ...options });
  for (const event of ["exit", "reset", "close"]) server.on(event, () => { events.push(event); });
  const take = (): string => { const taken = text; text = ""; return taken; };
  /** Waits for the next prompt (an evaluation may be waiting on a promise or a timer) or for the REPL to close. */
  const answered = async (): Promise<string> => {
    for (let turns = 0; turns < 2000 && !server.closed && !prompts.some(prompt => text.endsWith(prompt)); turns++) await turn();
    await settle();
    return take();
  };
  return {
    server, events, take,
    type: async (line, afterWrite) => { input.write(`${line}\n`); afterWrite?.(); return answered(); },
    end: async () => { input.end(); await settle(); return take(); },
  };
}
