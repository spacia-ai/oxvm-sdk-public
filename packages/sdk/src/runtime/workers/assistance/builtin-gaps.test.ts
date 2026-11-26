import { describe, expect, it } from "vitest";
import { NODE_BUILTIN_EXPORTS } from "./builtin-exports.generated.ts";
import gaps from "./builtin-gaps.controls.json" with { type: "json" };

type Gaps = Readonly<Record<string, string | readonly string[]>>;
const groups: readonly (readonly [string, Gaps])[] = [["linux", gaps.linux], ["pending", gaps.pending]];

describe("the recorded gaps between the fast path's built-ins and Node.js v24.18.1", () => {
  it("names only exports the pinned Node really has", () => {
    for (const [group, modules] of groups) {
      for (const [module, names] of Object.entries(modules)) {
        const real = NODE_BUILTIN_EXPORTS[module];
        // The generated table covers the public modules; `sqlite`, `test`, `sea` and the old underscore names are outside it.
        if (real === undefined || typeof names === "string") continue;
        expect(names.filter(name => !real.includes(name)), `${group} ${module}`).toEqual([]);
      }
    }
  });

  it("lists each export once, sorted, and in one group only", () => {
    for (const [group, modules] of groups) {
      for (const [module, names] of Object.entries(modules)) {
        if (typeof names === "string") { expect(names, `${group} ${module}`).toBe("module"); continue; }
        expect(names, `${group} ${module}`).toEqual([...new Set(names)].sort());
      }
    }
    const pending: Gaps = gaps.pending;
    for (const [module, names] of Object.entries(gaps.linux)) {
      const other = pending[module];
      if (typeof names === "string") expect(other, module).toBeUndefined();
      else if (other !== undefined && typeof other !== "string") expect(names.filter(name => other.includes(name)), module).toEqual([]);
    }
  });
});
