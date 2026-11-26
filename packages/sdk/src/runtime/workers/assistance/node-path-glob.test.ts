import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNodePath } from "./node-path.ts";

/** `path.posix.matchesGlob` and `path.win32.matchesGlob` answers recorded from `node:24.18.1-alpine`: one row of
 * "0"/"1" per pattern, one column per path. */
function strings(value: unknown, key: string): string[] {
  const item: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (!Array.isArray(item) || !item.every((entry): entry is string => typeof entry === "string")) throw new TypeError(`control field ${key} must be strings`);
  return item;
}
const raw: unknown = JSON.parse(readFileSync(new URL("./node-path-glob.controls.json", import.meta.url), "utf8"));
const controls = { patterns: strings(raw, "patterns"), paths: strings(raw, "paths"), posix: strings(raw, "posix"), win32: strings(raw, "win32") };
const path = createNodePath(() => "/workspace/app");

describe("path.matchesGlob", () => {
  it("has a wide recorded table", () => {
    expect(controls.patterns.length).toBeGreaterThanOrEqual(150);
    expect(controls.paths.length).toBeGreaterThanOrEqual(100);
    expect(controls.posix.join("")).toMatch(/^[01]+$/u);
    expect(controls.win32.join("")).toMatch(/^[01]+$/u);
  });

  it.each(controls.patterns.map((pattern, index) => ({ pattern, index })))("matches $pattern as Node does", ({ pattern, index }) => {
    const row = (match: (path: string, pattern: string) => boolean): string => controls.paths.map(file => match(file, pattern) ? "1" : "0").join("");
    const differences = (actual: string, expected: string): string[] => controls.paths.filter((_, column) => actual[column] !== expected[column]).map((file, _, all) => `${JSON.stringify(file)} (${all.length})`);
    expect(differences(row((file, glob) => path.matchesGlob(file, glob)), controls.posix[index] ?? ""), "posix").toEqual([]);
    expect(differences(row((file, glob) => path.win32.matchesGlob(file, glob)), controls.win32[index] ?? ""), "win32").toEqual([]);
  });

  it("validates its arguments and keeps Node's function shape", () => {
    const failure = (run: () => unknown): unknown[] => { try { run(); } catch (error) { return error instanceof TypeError ? [true, Reflect.get(error, "code"), error.message] : [false]; } return []; };
    expect(failure(() => path.matchesGlob(1, "a"))).toEqual([true, "ERR_INVALID_ARG_TYPE", "The \"path\" argument must be of type string. Received type number (1)"]);
    expect(failure(() => path.matchesGlob("a", 1))).toEqual([true, "ERR_INVALID_ARG_TYPE", "The \"pattern\" argument must be of type string. Received type number (1)"]);
    expect(failure(() => path.matchesGlob(undefined, undefined))).toEqual([true, "ERR_INVALID_ARG_TYPE", "The \"path\" argument must be of type string. Received undefined"]);
    expect(failure(() => path.win32.matchesGlob("a", 1))).toEqual([true, "ERR_INVALID_ARG_TYPE", "The \"pattern\" argument must be of type string. Received type number (1)"]);
    const posix: unknown = Reflect.get(path, "matchesGlob"), win32: unknown = Reflect.get(path.win32, "matchesGlob");
    expect([posix, win32].map(match => typeof match === "function" ? [match.name, match.length] : [])).toEqual([["matchesGlob", 2], ["matchesGlob", 2]]);
    expect(Reflect.get(path.posix, "matchesGlob")).toBe(posix);
    expect(win32).not.toBe(posix);
  });
});
