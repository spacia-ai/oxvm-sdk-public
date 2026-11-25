import { lateFailureError } from "../../js-process/late-failure.ts";

/** The constant tables `process.binding("constants")` holds: the ones `fs.constants` and `os.constants` export. */
export interface BindingConstants { readonly fs: object; readonly os: object }

/**
 * Node's deprecated `process.binding` (DEP0111), for the one binding programs still read: `"constants"`.
 * Emscripten's Node file layer takes the `open(2)` flag values from `process.binding("constants").fs`.
 *
 * Node's object also has `crypto`, `zlib` and `trace` tables; this one has `fs` and `os` only. Every other
 * binding is Node's internal C++ surface, which the fast path does not have: it is refused as a limitation
 * that is remembered, so the program's next run uses Linux.
 */
export function createProcessBinding(constants: BindingConstants): (name: unknown) => object {
  return function binding(name: unknown): object {
    if (name === "constants") return { os: constants.os, fs: constants.fs };
    const subject = `process.binding('${String(name).slice(0, 64)}')`;
    throw lateFailureError("unavailable-builtin", `${subject} is unavailable in browser-assisted processes`, `node:${subject}`);
  };
}
