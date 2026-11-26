import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as compilerNamespace from "@swc/wasm-web";
import { record, string } from "../../decode.js";
import { initializeCompiler, type AssistanceCompiler } from "./compiler.js";
import { createGuestModules } from "./guest-modules.js";
import { createLocalModuleLoader, type ModuleProcess } from "./module-loader.js";

export const UNDEFINED = "<undefined>";
/** The recorders write `undefined` as a marker JSON can hold. */
export function revive(value: unknown): unknown { return value === UNDEFINED ? undefined : value; }

export interface Tree { readonly files: Map<string, string>; readonly links: Map<string, string> }
export function tree(value: unknown): Tree {
  const entries = (part: unknown): Map<string, string> => new Map(Object.entries(record(part, "tree part")).map(([path, text]) => [path, string(text, "tree entry")]));
  const input = record(value, "tree");
  return { files: entries(input["files"]), links: entries(input["links"] ?? {}) };
}

/** Linux's view of a recorded file tree: files, the directories that hold them, and symbolic links. */
export function linuxFiles({ files, links }: Tree) {
  const missing = (path: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });
  function real(path: string): string {
    for (let turn = 0; turn < 16; turn++) {
      const link = [...links.keys()].find(candidate => path === candidate || path.startsWith(`${candidate}/`));
      if (link === undefined) return path;
      path = `${links.get(link) ?? ""}${path.slice(link.length)}`;
    }
    throw new Error("ELOOP");
  }
  const directory = (path: string): boolean => path === "/" || [...files.keys()].some(file => file.startsWith(`${path}/`));
  return {
    readFileSync(path: string): string {
      const text = files.get(real(path));
      if (text === undefined) throw missing(path);
      return text;
    },
    statSync(path: string) {
      const target = real(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
      const file = files.has(target) && !path.endsWith("/"), folder = directory(target);
      if (!file && !folder) throw missing(path);
      return { isFile: () => file, isDirectory: () => folder };
    },
    realpathSync(path: string): string {
      const target = real(path);
      if (!files.has(target) && !directory(target)) throw missing(path);
      return target;
    },
  };
}

let compiler: Promise<{ readonly compiler: AssistanceCompiler; readonly system: string }> | undefined;
/** The pinned SWC compiler and SystemJS, as the worker bundle carries them. */
export function toolchain(): Promise<{ readonly compiler: AssistanceCompiler; readonly system: string }> {
  compiler ??= (async () => {
    const require = createRequire(import.meta.url), root = dirname(require.resolve("@swc/wasm-web"));
    return {
      compiler: initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm")))),
      system: await readFile(require.resolve("systemjs/dist/s.js"), "utf8"),
    };
  })();
  return compiler;
}

export interface FixtureOptions { readonly cwd?: string; readonly process?: ModuleProcess; readonly builtins?: Record<string, object>; readonly searchPaths?: readonly string[] }
/** A process's loader over a recorded tree, with every `node_modules` folder of `/workspace` admitted. */
export async function loaderOver(files: Tree, options: FixtureOptions = {}) {
  const tools = await toolchain();
  const roots = [...new Set([...files.files.keys(), ...files.links.keys()].flatMap(path => {
    const at = path.indexOf("/node_modules/");
    return at === -1 ? [] : [path.slice(0, at + "/node_modules".length)];
  }))].map(path => ({ kind: "dependencies", path }) as const);
  const identity = { generation: 1n, profile: "node24-bun1-v1", roots, runtime: "node", moduleSearchPaths: options.searchPaths ?? [] } as const;
  const modules = createGuestModules(linuxFiles(files), identity);
  const loader = createLocalModuleLoader(tools.compiler, tools.system, modules, options.builtins ?? {}, options.cwd ?? "/workspace/app",
    options.process === undefined ? {} : { process: options.process });
  return { loader, modules, Module: loader.require("module") };
}

/** A call's outcome as the recorders write it. */
export function outcome(call: () => unknown): Record<string, unknown> {
  try { const value = call(); return { value: value === undefined ? UNDEFINED : value }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const code: unknown = Reflect.get(error, "code");
    return { error: { name: error.constructor.name, code: code ?? null, message: error.message } };
  }
}
/** A property of a value the loader made. */
export function member(target: unknown, name: string): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) throw new TypeError(`no ${name} on a primitive`);
  return Reflect.get(target, name);
}
/** Calls a member of an object the loader made, such as a static of `Module`. */
export function call(target: unknown, name: string, ...input: unknown[]): unknown {
  const method = member(target, name);
  if (typeof method !== "function") throw new TypeError(`${name} is not a function`);
  return Reflect.apply(method, target, input);
}
