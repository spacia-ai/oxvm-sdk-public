/** Canonical Linux resolution and authoritative bytes, supplied by the task's
 * file owner. Runtime module instances never own filesystem state. */
export type ModuleFormat = "commonjs" | "module" | "json";
/** A module's bytes and format. `typelessPackage` names the `package.json` without `"type"` under which Node's
 * syntax detection made the file an ES module, outside `node_modules`: importing it prints Node's warning. */
export interface ModuleSource { readonly source: string; readonly format: ModuleFormat; readonly typelessPackage?: string }
export interface ModulePathInfo { readonly path: string; readonly mode: number }
/**
 * A module's identity. Node keys an imported module by its whole URL, so `file:///a.js?v=1` and `file:///a.js?v=2` are
 * two modules of one file. An identity is the file's path, followed for such a URL by NUL (which no Linux path
 * contains) and the URL's query and fragment. Only `resolve` with kind "import" answers with the long form.
 */
export function moduleIdentity(path: string, suffix: string): string {
  return suffix === "" ? path : `${path}\0${suffix}`;
}
/** The file an identity names and the query and fragment it was imported with ("" for none). */
export function moduleLocation(identity: string): { readonly path: string; readonly suffix: string } {
  const at = identity.indexOf("\0");
  return at === -1 ? { path: identity, suffix: "" } : { path: identity.slice(0, at), suffix: identity.slice(at + 1) };
}

export interface LocalModuleFiles {
  readonly dependencies?: ModuleDependencyIdentity;
  readonly loadNative?: (path: string) => unknown;
  /** A path or a built-in's `node:` name; for kind "import" a `moduleIdentity`, whose file `read` takes. */
  resolve(specifier: string, parent: string, kind: "require" | "import"): string;
  /** `kind` is how the module is loaded when the caller knows it; Node admits fewer extensions to `import`. */
  read(path: string, kind?: "require" | "import"): ModuleSource;
}
import type { AssistedDependencyIdentity } from "../../protocol/assistance-broker.ts";
import type { JSProcessIdentity } from "../../js-process/codec.js";
import type { NativeProcessProfile } from "../../userspace-command-abi.js";
export type ModuleDependencyIdentity = AssistedDependencyIdentity | JSProcessIdentity | { readonly generation: bigint; readonly profile: NativeProcessProfile["identity"]; readonly roots: NativeProcessProfile["roots"]; readonly runtime: "node" | "bun"; readonly moduleSearchPaths: readonly string[] };
