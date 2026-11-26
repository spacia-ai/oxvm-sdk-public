import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNodePath } from "./node-path.ts";

/** `path.win32` answers recorded from `node:24.18.1-alpine` with the process in /workspace/app. */
type Outcome = { readonly v: unknown } | { readonly e: unknown };
function field(value: unknown, key: string): unknown { return (typeof value === "object" || typeof value === "function") && value !== null ? Reflect.get(value, key) : undefined; }
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("control must be an array");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("control must be a string");
  return value;
}
const controls: unknown = JSON.parse(readFileSync(new URL("./node-path-win32.controls.json", import.meta.url), "utf8"));
const win32 = createNodePath(() => text(field(controls, "cwd"))).win32;
const outcome = (run: () => unknown): Outcome => {
  try { return { v: run() }; } catch (error) { return { e: [error instanceof Error ? error.constructor.name : typeof error, field(error, "code"), field(error, "message")] }; }
};
const paths = list(field(controls, "paths")).map(text);
const single = field(controls, "single");

describe("path.win32", () => {
  it("has a wide recorded table", () => {
    expect(paths.length).toBeGreaterThanOrEqual(60);
    expect(list(field(controls, "pairs")).length).toBeGreaterThanOrEqual(600);
  });

  it.each(["normalize", "isAbsolute", "dirname", "basename", "extname", "parse", "toNamespacedPath", "resolve"] as const)("%s matches Node for every recorded path", name => {
    const expected = list(field(single, name));
    paths.forEach((path, index) => { expect(outcome(() => win32[name](path)), `${name}(${JSON.stringify(path)})`).toEqual(expected[index]); });
  });

  it("joins, relates, resolves and trims pairs as Node does", () => {
    const values = list(field(controls, "pairArgs")).map(text);
    const pairs = list(field(controls, "pairs"));
    let index = 0;
    for (const a of values) for (const b of values) {
      const expected = list(pairs[index++]);
      const label = `(${JSON.stringify(a)}, ${JSON.stringify(b)})`;
      expect(outcome(() => win32.join(a, b)), `join${label}`).toEqual(expected[0]);
      expect(outcome(() => win32.relative(a, b)), `relative${label}`).toEqual(expected[1]);
      expect(outcome(() => win32.resolve(a, b)), `resolve${label}`).toEqual(expected[2]);
      expect(outcome(() => win32.basename(a, b)), `basename${label}`).toEqual(expected[3]);
    }
  });

  it("formats, takes several segments and refuses bad arguments as Node does", () => {
    const misc = field(controls, "misc");
    for (const entry of list(field(misc, "format"))) { const [input, expected] = list(entry); expect(outcome(() => win32.format(input)), JSON.stringify(input)).toEqual(expected); }
    for (const entry of list(field(misc, "multi"))) {
      const [input, joined, resolved] = list(entry);
      const args = list(input);
      expect(outcome(() => win32.join(...args)), `join ${JSON.stringify(args)}`).toEqual(joined);
      expect(outcome(() => win32.resolve(...args)), `resolve ${JSON.stringify(args)}`).toEqual(resolved);
    }
    const symbol = Symbol.iterator;
    const refusals: Record<string, () => unknown> = {
      "normalize": () => win32.normalize(1), "join": () => win32.join("a", 1), "resolve": () => win32.resolve("a", null), "isAbsolute": () => win32.isAbsolute({}),
      "relative-from": () => win32.relative(1, "a"), "relative-to": () => win32.relative("a", undefined), "dirname": () => win32.dirname(symbol), "basename": () => win32.basename(1),
      "basename-suffix": () => win32.basename("a", 1), "extname": () => win32.extname([]), "parse": () => win32.parse(() => 1), "format-null": () => win32.format(null),
      "format-string": () => win32.format("x"), "format-array": () => win32.format([]), "toNamespacedPath": () => win32.toNamespacedPath(5),
      "matchesGlob-path": () => win32.matchesGlob(1, "a"), "matchesGlob-pattern": () => win32.matchesGlob("a", 1),
    };
    for (const entry of list(field(misc, "errors"))) {
      const [name, expected] = list(entry);
      const run = refusals[text(name)];
      if (run === undefined) throw new TypeError(`no refusal for ${text(name)}`);
      expect(outcome(run), text(name)).toEqual(expected);
    }
  });

  it("has Node's module shape, linked to the POSIX flavour", () => {
    const path = createNodePath(() => "/workspace/app");
    const [keys, sep, delimiter, , functions] = list(field(field(controls, "misc"), "shape"));
    expect(Object.keys(path.win32)).toEqual(keys);
    expect([path.win32.sep, path.win32.delimiter]).toEqual([sep, delimiter]);
    expect(Object.keys(path.win32).filter(key => typeof field(path.win32, key) === "function").map(key => [key, field(field(path.win32, key), "name"), field(field(path.win32, key), "length")])).toEqual(functions);
    expect(field(path.win32, "_makeLong")).toBe(field(path.win32, "toNamespacedPath"));
    expect(field(path, "_makeLong")).toBe(field(path, "toNamespacedPath"));
    expect([path._makeLong(5), path._makeLong("a"), path.toNamespacedPath.name, path.toNamespacedPath.length]).toEqual([5, "a", "toNamespacedPath", 1]);
    expect([path.win32.win32 === path.win32, path.win32.posix === path, field(path.posix, "win32") === path.win32, path.posix === path]).toEqual([true, true, true, true]);
    expect(Object.keys(path).slice(-4)).toEqual(["matchesGlob", "win32", "posix", "_makeLong"]);
  });
});
