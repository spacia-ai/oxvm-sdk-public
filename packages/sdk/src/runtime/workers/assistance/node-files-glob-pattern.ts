/*!
 * How Node.js v24.18.1's `fs.glob` reads a pattern: its vendored minimatch's `set` and `globParts` for the options
 * `{ nocase: false (Linux), windowsPathsNoEscape: true, nonegate: true, nocomment: true, optimizationLevel: 2 }`.
 *
 * minimatch: Copyright Isaac Z. Schlueter and Contributors, Blue Oak Model License 1.0.0 (https://blueoakcouncil.org/license/1.0.0).
 * brace-expansion and balanced-match: Copyright Julian Gruber, MIT License.
 * Provenance: lib/internal/deps/minimatch/index.js of Node.js v24.18.1.
 *
 * shortcut: the brace expansion and the first optimization phase below are copies of the private functions of
 * node-path-glob.ts, which exports only `matchGlob`. Exporting `braceExpand`, `optimizePatterns`, `compilePortion`
 * and `GLOBSTAR` there removes the copies and the per-name `matchGlob` call of `compilePart`.
 */
import { matchGlob } from "./node-path-glob.ts";
import { inspectValue } from "./node-util-validators.ts";

// ---- brace expansion -------------------------------------------------------------------------------------------------------------

/** Stand-ins for a `{` or `}` that must stay literal; a path pattern cannot contain these private-use characters meaningfully. */
const OPEN = "", CLOSE = "";
interface Balanced { readonly pre: string; readonly body: string; readonly post: string }
/** The first balanced `{…}` pair, or the leftmost closed pair when the nesting never balances. */
function balanced(text: string): Balanced | undefined {
  let open = text.indexOf("{"), close = text.indexOf("}", open + 1), index = open;
  if (open < 0 || close <= 0) return undefined;
  const begins: number[] = [];
  let left = text.length, right = -1, found: readonly [number, number] | undefined;
  while (index >= 0 && found === undefined) {
    if (index === open) { begins.push(index); open = text.indexOf("{", index + 1); }
    else if (begins.length === 1) { found = [begins.pop() ?? 0, close]; }
    else {
      const begin = begins.pop();
      if (begin !== undefined && begin < left) { left = begin; right = close; }
      close = text.indexOf("}", index + 1);
    }
    index = open < close && open >= 0 ? open : close;
  }
  if (begins.length !== 0 && right >= 0) found = [left, right];
  return found === undefined ? undefined : { pre: text.slice(0, found[0]), body: text.slice(found[0] + 1, found[1]), post: text.slice(found[1] + 1) };
}
function commaParts(text: string): string[] {
  if (text === "") return [""];
  const match = balanced(text);
  if (match === undefined) return text.split(",");
  const parts = match.pre.split(",");
  const after = match.post.length !== 0 ? commaParts(match.post) : [""];
  // The braces stay with the option they sit in; what follows them continues it up to the next comma.
  const last = `${parts.pop() ?? ""}{${match.body}}${after.shift() ?? ""}`;
  return [...parts, last, ...after];
}
const numeric = (text: string): number => Number.isNaN(Number(text)) ? text.charCodeAt(0) : parseInt(text, 10);
function sequence(parts: readonly string[], alpha: boolean): string[] {
  const from = numeric(parts[0] ?? ""), to = numeric(parts[1] ?? "");
  const width = Math.max((parts[0] ?? "").length, (parts[1] ?? "").length);
  const step = Math.max(Math.abs(parts.length === 3 ? numeric(parts[2] ?? "") : 1), 1) * (to < from ? -1 : 1);
  const padded = parts.some(part => /^-?0\d/u.test(part));
  const items: string[] = [];
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
    if (alpha) { items.push(String.fromCharCode(value)); continue; }
    let text = String(value);
    const need = width - text.length;
    if (padded && need > 0) text = value < 0 ? `-${"0".repeat(need)}${text.slice(1)}` : "0".repeat(need) + text;
    items.push(text);
  }
  return items;
}
function expand(text: string, top: boolean): string[] {
  const match = balanced(text);
  if (match === undefined) return [text];
  const post = match.post.length !== 0 ? expand(match.post, false) : [""];
  if (match.pre.endsWith("$")) return post.map(rest => `${match.pre}{${match.body}}${rest}`);
  const isNumeric = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/u.test(match.body), isAlpha = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/u.test(match.body);
  const isSequence = isNumeric || isAlpha;
  if (!isSequence && !match.body.includes(",")) {
    // `{a},b}`: the first brace closes nothing, so its `}` is literal and the rest may still expand.
    return /,(?!,).*\}/u.test(match.post) ? expand(`${match.pre}{${match.body}${CLOSE}${match.post}`, false) : [text];
  }
  let options: string[];
  if (isSequence) options = sequence(match.body.split(".."), isAlpha);
  else {
    let parts = commaParts(match.body);
    if (parts.length === 1) {
      // `x{{a,b}}y` keeps one pair of braces around each alternative.
      parts = expand(parts[0] ?? "", false).map(part => `{${part}}`);
      if (parts.length === 1) return post.map(rest => match.pre + (parts[0] ?? "") + rest);
    }
    options = parts.flatMap(part => expand(part, false));
  }
  const result: string[] = [];
  for (const option of options) for (const rest of post) {
    const expansion = match.pre + option + rest;
    if (!top || isSequence || expansion !== "") result.push(expansion);
  }
  return result;
}
function braceExpand(pattern: string): string[] {
  if (!/\{(?:(?!\{).)*\}/u.test(pattern)) return [pattern];
  const text = pattern.startsWith("{}") ? OPEN + CLOSE + pattern.slice(2) : pattern;
  return expand(text, true).map(item => item.replaceAll(OPEN, "{").replaceAll(CLOSE, "}"));
}

// ---- pattern sets ----------------------------------------------------------------------------------------------------------------

/** Drops `.` and empty portions after the first (a UNC `//` stays), then answers whether anything changed. */
function squeeze(parts: string[]): boolean {
  let changed = false;
  for (let index = 1; index < parts.length - 1; index++) {
    const part = parts[index];
    if (index === 1 && part === "" && parts[0] === "") continue;
    if (part === "." || part === "") { changed = true; parts.splice(index, 1); index--; }
  }
  if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) { changed = true; parts.pop(); }
  return changed;
}
function optimizePatterns(patterns: string[][]): string[][] {
  for (let changed = true; changed;) {
    changed = false;
    for (const parts of patterns) {
      for (let star = parts.indexOf("**"); star !== -1; star = parts.indexOf("**", star + 1)) {
        let last = star;
        while (parts[last + 1] === "**") last++;
        if (last > star) parts.splice(star + 1, last - star);
        const after = parts[star + 2], beyond = parts[star + 3];
        if (parts[star + 1] !== ".." || after === undefined || after === "" || after === "." || after === ".." || beyond === undefined || beyond === "" || beyond === "." || beyond === "..") continue;
        // `**/../x/y` is both `x/y` below any directory's parent and `**/x/y`.
        changed = true;
        parts.splice(star, 1);
        const other = parts.slice();
        other[star] = "**";
        patterns.push(other);
        star--;
      }
      if (squeeze(parts)) changed = true;
      for (let dots = parts.indexOf("..", 1); dots !== -1; dots = parts.indexOf("..", dots + 1)) {
        const before = parts[dots - 1];
        if (before === undefined || before === "" || before === "." || before === ".." || before === "**") continue;
        changed = true;
        parts.splice(dots - 1, 2, ...(dots === 1 && parts[dots + 1] === "**" ? ["."] : []));
        if (parts.length === 0) parts.push("");
        dots -= 2;
      }
    }
  }
  return patterns;
}

/** minimatch's `partsMatch`: one pattern that matches what both do, when they differ only by `*` against a name or by an empty `**`. */
function merged(a: readonly string[], b: readonly string[]): string[] | undefined {
  let ai = 0, bi = 0, which = "";
  const result: string[] = [];
  while (ai < a.length && bi < b.length) {
    const left = a[ai] ?? "", right = b[bi] ?? "";
    if (left === right) { result.push(which === "b" ? right : left); ai++; bi++; }
    else if (left === "**" && right === a[ai + 1]) { result.push(left); ai++; }
    else if (right === "**" && left === b[bi + 1]) { result.push(right); bi++; }
    else if (left === "*" && right !== "" && !right.startsWith(".") && right !== "**") { if (which === "b") return undefined; which = "a"; result.push(left); ai++; bi++; }
    else if (right === "*" && left !== "" && !left.startsWith(".") && left !== "**") { if (which === "a") return undefined; which = "b"; result.push(right); ai++; bi++; }
    else return undefined;
  }
  return a.length === b.length ? result : undefined;
}
/** minimatch's second optimization phase: of two patterns one of which covers the other, only the wider stays. */
function mergePatterns(patterns: string[][]): string[][] {
  for (let i = 0; i < patterns.length - 1; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      const match = merged(patterns[i] ?? [], patterns[j] ?? []);
      if (match !== undefined) { patterns[i] = []; patterns[j] = match; break; }
    }
  }
  return patterns.filter(parts => parts.length !== 0);
}

export const GLOBSTAR = Symbol("**");
/** One path portion of a pattern: `**`, a literal name, or a test of a name (minimatch's regular expression). */
export type GlobPart = typeof GLOBSTAR | string | { test(name: string): boolean };
/** The literal a portion without wildcards stands for (`[a]` is `a`), or undefined when it has magic. An unclosed
 * extglob such as `@(a` counts as magic here: it still matches only its own text, but it is looked up by listing. */
function literalOf(text: string): string | undefined {
  if (/[*?]/u.test(text) || /[!?+*@]\(/u.test(text)) return undefined;
  const simple = text.replace(/\[([^/\\!^[\]])\]/gu, "$1"), open = simple.indexOf("[");
  return open !== -1 && simple.includes("]", open) ? undefined : simple;
}
function compilePart(text: string): GlobPart {
  if (text === "**") return GLOBSTAR;
  if (text === "") return "";
  const literal = literalOf(text);
  if (literal !== undefined) return literal;
  const answers = new Map<string, boolean>();
  return { test(name: string): boolean {
    let answer = answers.get(name);
    if (answer === undefined) { answer = matchGlob(name, text, false, inspectValue); answers.set(name, answer); }
    return answer;
  } };
}

export interface GlobSet { readonly parts: readonly GlobPart[]; readonly strings: readonly string[] }
/** minimatch's `set` with the `globParts` each came from. An empty pattern has no set. */
export function compileGlob(pattern: string): GlobSet[] {
  const glob = pattern.replaceAll("\\", "/");
  if (glob === "") return [];
  const patterns = mergePatterns(optimizePatterns([...new Set(braceExpand(glob))].map(item => item.split(/\/+/u))));
  return patterns.map(strings => ({ strings, parts: strings.map(compilePart) }));
}
/** minimatch's `match` of a whole path against a pattern, as the `exclude` list uses it. */
export function matchesGlob(path: string, pattern: string): boolean { return matchGlob(path, pattern, false, inspectValue); }
