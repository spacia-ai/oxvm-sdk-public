/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/modules/cjs/loader.js (Module._initPaths,
 * Module._resolveLookupPaths, Module._findPath) and lib/internal/modules/package_json_reader.js
 * (findPackageJSON, getPackageJSONURL).
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
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
import { createNodePath } from "./node-path.ts";
import { createNodeUrl } from "./node-url.ts";
import { invalidType } from "./node-util-validators.ts";

/** What one search directory holds for a request; `exports` when a package's "exports" map chose the file. */
export interface FoundModulePath { readonly path: string; readonly exports: boolean }
/** A path as Linux has it: its kind and, for a file, its canonical (symlink-free) path. */
export interface LocatedModulePath { readonly kind: "file" | "directory"; readonly path: string }

/**
 * The module file owner's lookups behind `Module._findPath` and `module.findPackageJSON`: the loader's own
 * resolution steps (extensions, `package.json` "main" and "exports", index files, canonical paths), one search
 * directory at a time. A class, so that a loader handed plain `LocalModuleFiles` can tell whether it has one.
 */
export class ModuleLookup {
  /** `directory` is absolute, or "" for an absolute request; `directoryOnly` when the request ends in a slash. */
  readonly findPath: (request: string, directory: string, directoryOnly: boolean) => FoundModulePath | undefined;
  readonly locate: (path: string) => LocatedModulePath | undefined;
  constructor(findPath: ModuleLookup["findPath"], locate: ModuleLookup["locate"]) {
    this.findPath = findPath;
    this.locate = locate;
  }
}

export interface ModulePathPorts {
  readonly cwd: () => string;
  /** The process's current environment: `_initPaths` reads HOME and NODE_PATH from it each time. */
  readonly env: () => Readonly<Record<string, string | undefined>>;
  readonly execPath: () => string;
  readonly isBuiltin: (request: unknown) => boolean;
  readonly lookup: ModuleLookup | undefined;
}

export type ModulePaths = ReturnType<typeof createModulePaths>;

function coded<Failure extends Error>(error: Failure, code: string, extra: Readonly<Record<string, unknown>> = {}): Failure {
  return Object.assign(error, { code, ...extra });
}
/** Node's wording of a received value, without the leading "Received ". */
function received(value: unknown): string {
  return invalidType("v", "t", value).message.slice("The \"v\" argument must be of type t. Received ".length);
}
function invalidUrl(input: unknown): TypeError { return coded(new TypeError("Invalid URL"), "ERR_INVALID_URL", { input }); }

export function createModulePaths(ports: ModulePathPorts) {
  const path = createNodePath(ports.cwd), urls = createNodeUrl(ports.cwd);
  /** Node's private `modulePaths`; `Module.globalPaths` is a copy for programs to read. */
  let modulePaths: string[] = [];

  /** Node's `Module._initPaths`: the copy `Module.globalPaths` becomes. */
  function initPaths(): string[] {
    const env = ports.env(), home = env["HOME"], nodePath = env["NODE_PATH"];
    const paths = [path.resolve(ports.execPath(), "..", "..", "lib", "node")];
    if (home !== undefined && home !== "") paths.unshift(path.resolve(home, ".node_modules"), path.resolve(home, ".node_libraries"));
    if (nodePath !== undefined && nodePath !== "") paths.unshift(...nodePath.split(":").filter(entry => entry !== ""));
    modulePaths = paths;
    return [...paths];
  }

  function resolveLookupPaths(request: unknown, parent: unknown): string[] | null {
    if (request === null || request === undefined) throw new TypeError("String.prototype.startsWith called on null or undefined");
    if (ports.isBuiltin(request)) return null;
    const text = typeof request === "string" ? request : undefined;
    const owner = typeof parent === "object" && parent !== null ? parent : undefined;
    if (text === undefined || !text.startsWith(".") || (text.length > 1 && text[1] !== "." && text[1] !== "/")) {
      const own: unknown = owner === undefined ? undefined : Reflect.get(owner, "paths");
      const paths = Array.isArray(own) && own.length !== 0 ? [...own.filter((entry: unknown) => typeof entry === "string"), ...modulePaths] : modulePaths;
      return paths.length > 0 ? paths : null;
    }
    const id: unknown = owner === undefined ? undefined : Reflect.get(owner, "id");
    const filename: unknown = owner === undefined ? undefined : Reflect.get(owner, "filename");
    if (id === undefined || id === null || id === "" || typeof filename !== "string" || filename === "") return ["."];
    return [path.dirname(filename)];
  }

  /** Node's `Module._findPath`, with `cache` as `Module._pathCache`. */
  function findPath(cache: Record<string, unknown>, request: unknown, paths: unknown): string | false {
    if (typeof request !== "string") throw invalidType("path", "string", request);
    const absolute = request.startsWith("/");
    let directories: ArrayLike<unknown>;
    if (absolute) directories = [""];
    else if (typeof paths === "string" || Array.isArray(paths)) directories = paths;
    else return false;
    if (directories.length === 0) return false;
    const key = `${request}\0${Array.from(directories, String).join("\0")}`;
    const known = cache[key];
    if (typeof known === "string" && known !== "") return known;
    const last = request.length - 1;
    const trailingSlash = request.endsWith("/") || (request.endsWith(".") && (last === 0 || request[last - 1] === "/" ||
      (request[last - 1] === "." && (last === 1 || request[last - 2] === "/"))));
    const relative = request === "." || request === ".." || request.startsWith("./") || request.startsWith("../");
    const inside = !(relative && path.normalize(request).startsWith(".."));
    for (let index = 0; index < directories.length; index++) {
      const directory = directories[index];
      if (typeof directory !== "string") throw coded(new TypeError(`The "paths" argument must be array of strings. Received ${received(paths)}`), "ERR_INVALID_ARG_TYPE");
      if (ports.lookup === undefined) continue;
      const base = directory === "" ? "" : path.resolve(directory);
      if (inside && base !== "" && ports.lookup.locate(base)?.kind !== "directory") continue;
      const found = ports.lookup.findPath(request, base, trailingSlash);
      if (found === undefined) continue;
      if (!found.exports) cache[key] = found.path;
      return found.path;
    }
    return false;
  }

  /** The directory a URL's relative references resolve against, as a path. */
  function fileOf(url: URL): string {
    if (url.protocol !== "file:") throw coded(new TypeError("The URL must be of scheme file"), "ERR_INVALID_URL_SCHEME");
    return urls.fileURLToPath(url);
  }
  function parentDirectory(file: string): string {
    return file.length > 1 && file.endsWith("/") ? file.slice(0, -1) : path.dirname(file);
  }
  function locate(file: string): LocatedModulePath | undefined { return ports.lookup?.locate(file); }

  function packageOf(name: string, parent: URL, base: unknown): string {
    if (parent.protocol !== "file:") throw invalidUrl(`./node_modules/${name}/package.json`);
    const from = fileOf(parent);
    for (let directory = parentDirectory(from); ; directory = path.dirname(directory)) {
      const root = path.join(directory, "node_modules", name);
      if (locate(root)?.kind === "directory") return path.join(root, "package.json");
      if (directory === "/") break;
    }
    throw coded(new Error(`Cannot find package '${name}' imported from ${typeof base === "string" && base.startsWith("/") ? base : from}`), "ERR_MODULE_NOT_FOUND");
  }

  /** Node's `module.findPackageJSON(specifier, base)`. */
  function findPackageJSON(provided: number, specifierValue: unknown, base: unknown = "data:"): string | undefined {
    if (provided === 0) throw coded(new TypeError("The \"specifier\" argument must be specified"), "ERR_MISSING_ARGS");
    if (typeof specifierValue === "symbol") throw invalidType("specifier", "string", specifierValue);
    const specifier = String(specifierValue);
    let parent: URL;
    if (base instanceof URL) parent = base;
    else {
      if (typeof base !== "string") throw invalidType("base", "string", base);
      if (base.startsWith("/")) parent = urls.pathToFileURL(base);
      else { try { parent = new URL(base); } catch { throw invalidUrl(base); } }
    }
    if (specifier !== "" && !specifier.startsWith(".") && !specifier.startsWith("/") && !URL.canParse(specifier)) {
      const parts = specifier.split("/"), name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? "";
      return packageOf(name, parent, base);
    }
    let target: URL;
    if (URL.canParse(specifier)) target = new URL(specifier);
    else {
      try { target = new URL(specifier, parent); }
      catch { throw coded(new TypeError(`Failed to resolve module specifier "${specifier}" from "${parent.href}": Invalid relative URL or base scheme is not hierarchical.`), "ERR_UNSUPPORTED_RESOLVE_REQUEST"); }
    }
    const file = fileOf(target), located = locate(file.length > 1 && file.endsWith("/") ? file.slice(0, -1) : file);
    if (located === undefined) {
      throw coded(new Error(`Cannot find module '${file}' imported from ${parent.protocol === "file:" ? fileOf(parent) : parent.href}`), "ERR_MODULE_NOT_FOUND", { url: target.href });
    }
    const resolved = located.kind === "file" ? located.path : file;
    for (let directory = parentDirectory(resolved); ; directory = path.dirname(directory)) {
      if (path.basename(directory) === "node_modules") break;
      const candidate = path.join(directory, "package.json");
      if (locate(candidate)?.kind === "file") return candidate;
      if (directory === "/") break;
    }
    // Node 24.18.1 answers with the resolved path itself when no package.json encloses it.
    return resolved;
  }

  return { initPaths, resolveLookupPaths, findPath, findPackageJSON };
}
