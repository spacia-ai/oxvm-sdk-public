/*!
 * `path.matchesGlob` as Node.js v24.18.1 answers it. Node calls its vendored minimatch with
 * `{ nocase: false (Linux), windowsPathsNoEscape: true, nonegate: true, nocomment: true, optimizationLevel: 2 }`.
 * This file is a TypeScript adaptation of that matcher for exactly those options, and of the brace expansion it uses.
 *
 * minimatch: Copyright Isaac Z. Schlueter and Contributors, Blue Oak Model License 1.0.0 (https://blueoakcouncil.org/license/1.0.0).
 * brace-expansion and balanced-match: Copyright Julian Gruber, MIT License.
 * Provenance: lib/internal/deps/minimatch/index.js of Node.js v24.18.1; every rule below is covered by controls recorded from that Node.
 */

import { invalidArgType, type Inspect } from "./node-arg-type.ts";

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

// ---- one path portion ------------------------------------------------------------------------------------------------------------

const QMARK = "[^/]", STAR = `${QMARK}*?`, STAR_NO_EMPTY = `${QMARK}+?`;
const START_NO_TRAVERSAL = "(?!(?:^|/)\\.\\.?(?:$|/))", START_NO_DOT = "(?!\\.)";
const regexpEscape = (text: string): string => text.replace(/[-[\]{}()*+?.,\\^$|#\s]/gu, "\\$&");
const classEscape = (text: string): string => text.replace(/[[\]\\-]/gu, "\\$&");
const unescape = (text: string): string => text.replace(/((?!\\).|^)\[([^/\\])\]/gu, "$1$2").replace(/\\([^/])/gu, "$1");

/** POSIX class → [Unicode property ranges, needs the `u` flag, is a negated set]. */
const POSIX_CLASSES: Readonly<Record<string, readonly [string, boolean, boolean?]>> = {
  "[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true], "[:alpha:]": ["\\p{L}\\p{Nl}", true], "[:ascii:]": ["\\x00-\\x7f", false],
  "[:blank:]": ["\\p{Zs}\\t", true], "[:cntrl:]": ["\\p{Cc}", true], "[:digit:]": ["\\p{Nd}", true], "[:graph:]": ["\\p{Z}\\p{C}", true, true],
  "[:lower:]": ["\\p{Ll}", true], "[:print:]": ["\\p{C}", true], "[:punct:]": ["\\p{P}", true], "[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
  "[:upper:]": ["\\p{Lu}", true], "[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true], "[:xdigit:]": ["A-Fa-f0-9", false],
};
interface Parsed { readonly source: string; readonly unicode: boolean; readonly consumed: number; readonly magic: boolean }
/** A `[...]` class starting at `position`; `consumed` is 0 when the bracket never closes and is therefore a literal. */
function parseClass(glob: string, position: number): Parsed {
  const ranges: string[] = [], negated: string[] = [];
  let index = position + 1, sawStart = false, unicode = false, negate = false, end = position, rangeStart = "";
  scan: while (index < glob.length) {
    const char = glob.charAt(index);
    if ((char === "!" || char === "^") && index === position + 1) { negate = true; index++; continue; }
    if (char === "]" && sawStart) { end = index + 1; break; }
    sawStart = true;
    if (char === "[") {
      for (const [name, [properties, needsUnicode, negative]] of Object.entries(POSIX_CLASSES)) {
        if (!glob.startsWith(name, index)) continue;
        if (rangeStart !== "") return { source: "$.", unicode: false, consumed: glob.length - position, magic: true };
        index += name.length;
        (negative === true ? negated : ranges).push(properties);
        unicode ||= needsUnicode;
        continue scan;
      }
    }
    if (rangeStart !== "") {
      // An inverted range is dropped; the rest of the class still matches.
      if (char > rangeStart) ranges.push(`${classEscape(rangeStart)}-${classEscape(char)}`); else if (char === rangeStart) ranges.push(classEscape(char));
      rangeStart = ""; index++; continue;
    }
    if (glob.startsWith("-]", index + 1)) { ranges.push(classEscape(`${char}-`)); index += 2; continue; }
    if (glob.startsWith("-", index + 1)) { rangeStart = char; index += 2; continue; }
    ranges.push(classEscape(char)); index++;
  }
  if (end < index) return { source: "", unicode: false, consumed: 0, magic: false };
  // A class that can match nothing poisons the whole portion.
  if (ranges.length === 0 && negated.length === 0) return { source: "$.", unicode: false, consumed: glob.length - position, magic: true };
  const only = ranges[0];
  if (negated.length === 0 && ranges.length === 1 && only !== undefined && /^\\?.$/u.test(only) && !negate) {
    return { source: regexpEscape(only.length === 2 ? only.slice(-1) : only), unicode: false, consumed: end - position, magic: false };
  }
  const positive = `[${negate ? "^" : ""}${ranges.join("")}]`, negative = `[${negate ? "" : "^"}${negated.join("")}]`;
  const source = ranges.length !== 0 && negated.length !== 0 ? `(${positive}|${negative})` : ranges.length !== 0 ? positive : negative;
  return { source, unicode, consumed: end - position, magic: true };
}
function parseGlob(glob: string, noEmpty: boolean): Omit<Parsed, "consumed"> {
  let source = "", unicode = false, magic = false;
  for (let index = 0; index < glob.length; index++) {
    const char = glob.charAt(index);
    if (char === "[") {
      const parsed = parseClass(glob, index);
      if (parsed.consumed !== 0) { source += parsed.source; unicode ||= parsed.unicode; magic ||= parsed.magic; index += parsed.consumed - 1; continue; }
    }
    if (char === "*") { source += noEmpty && glob === "*" ? STAR_NO_EMPTY : STAR; magic = true; continue; }
    if (char === "?") { source += QMARK; magic = true; continue; }
    source += regexpEscape(char);
  }
  return { source, unicode, magic };
}

type ExtglobType = "!" | "?" | "+" | "*" | "@";
function extglobType(char: string): ExtglobType | undefined { return char === "!" || char === "?" || char === "+" || char === "*" || char === "@" ? char : undefined; }
/** What an extglob may take over from a single nested extglob (`+(?(a))` is `*(a)`), as minimatch flattens them. */
const ADOPT: Readonly<Record<ExtglobType, string>> = { "!": "@", "?": "?@", "@": "@", "*": "*+?@", "+": "+@" };
const ADOPT_WITH_SPACE: Readonly<Record<ExtglobType, string>> = { "!": "?", "?": "", "@": "?", "*": "", "+": "?*" };
const ADOPT_ANY: Readonly<Record<ExtglobType, string>> = { "!": "?@", "?": "?@", "@": "?@", "*": "*+?@", "+": "+@?*" };
const USURP: Readonly<Record<ExtglobType, Readonly<Partial<Record<ExtglobType, ExtglobType>>>>> = {
  "!": { "!": "@" }, "?": { "*": "*", "+": "*" }, "@": { "!": "!", "?": "?", "@": "@", "*": "*", "+": "+" }, "+": { "?": "*", "*": "*" }, "*": {},
};
const MAX_EXTGLOB_DEPTH = 2;
interface Compiled { readonly source: string; readonly body: string; readonly magic: boolean; readonly unicode: boolean }

/** A parsed portion: a list (`type` null) of text and extglobs, or an extglob whose parts are its alternatives. */
class Ast {
  type: ExtglobType | null;
  parts: (string | Ast)[] = [];
  parent: Ast | undefined;
  readonly root: Ast;
  readonly parentIndex: number;
  emptyExt = false;
  magic: boolean | undefined;
  unicode = false;
  /** Root only: every `!(` node, and whether their tails were filled in. */
  readonly negations: Ast[] = [];
  filledNegations = false;

  constructor(type: ExtglobType | null, parent?: Ast) {
    this.type = type; this.parent = parent;
    this.root = parent === undefined ? this : parent.root;
    this.parentIndex = parent === undefined ? 0 : parent.parts.length;
    if (type !== null) this.magic = true;
    if (type === "!" && !this.root.filledNegations) this.root.negations.push(this);
  }
  push(...parts: (string | Ast)[]): void { for (const part of parts) if (part !== "") this.parts.push(part); }
  text(): string {
    const inner = this.parts.map(part => typeof part === "string" ? part : part.text());
    return this.type === null ? inner.join("") : `${this.type}(${inner.join("|")})`;
  }
  isStart(): boolean {
    if (this.root === this) return true;
    if (this.parent?.isStart() !== true) return false;
    // Negations ahead of this one match nothing themselves, so this is still the start.
    return this.parent.parts.slice(0, this.parentIndex).every(part => typeof part !== "string" && part.type === "!");
  }
  isEnd(): boolean {
    if (this.root === this || this.parent === undefined) return true;
    if (this.parent.type === "!") return true;
    if (!this.parent.isEnd()) return false;
    return this.type === null || this.parentIndex === this.parent.parts.length - 1;
  }
  copyIn(part: string | Ast): void { this.push(typeof part === "string" ? part : part.clone(this)); }
  clone(parent: Ast): Ast {
    const copy = new Ast(this.type, parent);
    for (const part of this.parts) copy.copyIn(part);
    return copy;
  }
  canAdoptType(type: string, map: Readonly<Record<ExtglobType, string>> = ADOPT_ANY): boolean { return this.type !== null && map[this.type].includes(type); }
  #grandchild(child: string | Ast | undefined): Ast | undefined {
    if (child === undefined || typeof child === "string" || child.type !== null || child.parts.length !== 1 || this.type === null) return undefined;
    const inner = child.parts[0];
    return inner === undefined || typeof inner === "string" || inner.type === null ? undefined : inner;
  }
  #adopt(inner: Ast, index: number): void {
    this.parts.splice(index, 1, ...inner.parts);
    for (const part of inner.parts) if (typeof part !== "string") part.parent = this;
  }
  flatten(): void {
    if (this.type === null) { for (const part of this.parts) if (typeof part !== "string") part.flatten(); return; }
    let done = false;
    for (let iterations = 0; !done && iterations < 10; iterations++) {
      done = true;
      for (let index = 0; index < this.parts.length; index++) {
        const child = this.parts[index];
        if (child === undefined || typeof child === "string") continue;
        child.flatten();
        const inner = this.#grandchild(child);
        const innerType = inner?.type;
        if (inner === undefined || innerType === null || innerType === undefined) continue;
        if (this.canAdoptType(innerType, ADOPT)) { done = false; this.#adopt(inner, index); }
        else if (this.canAdoptType(innerType, ADOPT_WITH_SPACE)) {
          done = false;
          const blank = new Ast(null, inner); blank.parts.push("");
          inner.push(blank); this.#adopt(inner, index);
        } else if (this.parts.length === 1) {
          const next: ExtglobType | undefined = USURP[this.type][innerType];
          if (next === undefined) continue;
          done = false;
          this.parts = inner.parts;
          for (const part of this.parts) if (typeof part !== "string") part.parent = this;
          this.type = next; this.emptyExt = false;
        }
      }
    }
  }
  /** Copies what follows each negation into it: `!(a)b` must refuse "ab", not every name starting with "a". */
  fillNegations(): void {
    if (this.filledNegations) return;
    this.filledNegations = true;
    for (let negation = this.negations.pop(); negation !== undefined; negation = this.negations.pop()) {
      if (negation.type !== "!") continue;
      let current: Ast = negation;
      for (let above = current.parent; above !== undefined; current = above, above = current.parent) {
        for (let index = current.parentIndex + 1; above.type === null && index < above.parts.length; index++) {
          const tail = above.parts[index];
          for (const part of negation.parts) if (typeof part !== "string" && tail !== undefined) part.copyIn(tail);
        }
      }
    }
  }
  compile(allowDot?: boolean): Compiled {
    const dot = allowDot ?? false;
    if (this.root === this) { this.flatten(); this.fillNegations(); }
    if (this.type === null) {
      const noEmpty = this.isStart() && this.isEnd() && this.parts.every(part => typeof part === "string");
      const source = this.parts.map(part => {
        const compiled = typeof part === "string" ? parseGlob(part, noEmpty) : part.compile(allowDot);
        this.magic = this.magic === true || compiled.magic; this.unicode ||= compiled.unicode;
        return compiled.source;
      }).join("");
      let start = "";
      const first = this.parts[0];
      if (this.isStart() && typeof first === "string" && !(this.parts.length === 1 && (first === "." || first === ".."))) {
        const guarded = (char: string): boolean => char === "[" || char === ".";
        // A portion that could match "." or ".." is kept from doing so, and a leading wildcard from matching a dot file.
        const noTraversal = (dot && guarded(source.charAt(0))) || (source.startsWith("\\.") && guarded(source.charAt(2))) || (source.startsWith("\\.\\.") && guarded(source.charAt(4)));
        start = noTraversal ? START_NO_TRAVERSAL : !dot && allowDot !== true && guarded(source.charAt(0)) ? START_NO_DOT : "";
      }
      const end = this.isEnd() && this.root.filledNegations && this.parent?.type === "!" ? "(?:$|\\/)" : "";
      this.magic = this.magic === true;
      return { source: start + source + end, body: unescape(source), magic: this.magic, unicode: this.unicode };
    }
    const repeated = this.type === "*" || this.type === "+";
    let body = this.#alternatives(dot);
    if (this.isStart() && this.isEnd() && body === "" && this.type !== "!") {
      // An extglob that is the whole portion and can only be empty is its own literal text.
      const text = this.text();
      this.parts = [text]; this.type = null; this.magic = undefined;
      return { source: text, body: unescape(text), magic: false, unicode: false };
    }
    let dotAllowed = !repeated || allowDot === true || dot ? "" : this.#alternatives(true);
    if (dotAllowed === body) dotAllowed = "";
    if (dotAllowed !== "") body = `(?:${body})(?:${dotAllowed})*?`;
    let source: string;
    if (this.type === "!" && this.emptyExt) source = (this.isStart() && !dot ? START_NO_DOT : "") + STAR_NO_EMPTY;
    else if (this.type === "!") source = `(?:(?!(?:${body}))${this.isStart() && !dot && allowDot !== true ? START_NO_DOT : ""}${STAR})`;
    else {
      const close = this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && dotAllowed !== "" ? ")" : this.type === "*" && dotAllowed !== "" ? ")?" : `)${this.type}`;
      source = `(?:${body}${close}`;
    }
    this.magic = this.magic === true;
    return { source, body: unescape(body), magic: this.magic, unicode: this.unicode };
  }
  #alternatives(dot: boolean): string {
    const whole = this.isStart() && this.isEnd();
    return this.parts.map(part => {
      if (typeof part === "string") return regexpEscape(part);
      const compiled = part.compile(dot);
      this.unicode ||= compiled.unicode;
      return compiled.source;
    }).filter(source => !whole || source !== "").join("|");
  }
}

/** Fills `node` from `text` at `position`; answers where it stopped. An extglob that never closes becomes literal text to the end. */
function parseNode(text: string, node: Ast, position: number, depth: number): number {
  let inClass = false, classStart = -1, classNegated = false;
  const inBracket = (char: string, index: number): boolean => {
    if (inClass) {
      if (index === classStart + 1) { if (char === "^" || char === "!") classNegated = true; }
      else if (char === "]" && !(index === classStart + 2 && classNegated)) inClass = false;
      return true;
    }
    if (char === "[") { inClass = true; classStart = index; classNegated = false; return true; }
    return false;
  };
  if (node.type === null) {
    let index = position, pending = "";
    while (index < text.length) {
      const char = text.charAt(index++);
      if (inBracket(char, index)) { pending += char; continue; }
      const type = extglobType(char);
      if (type !== undefined && text.charAt(index) === "(" && depth <= MAX_EXTGLOB_DEPTH) {
        node.push(pending); pending = "";
        const extglob = new Ast(type, node);
        index = parseNode(text, extglob, index, depth + 1);
        node.push(extglob);
        continue;
      }
      pending += char;
    }
    node.push(pending);
    return index;
  }
  let index = position + 1, pending = "", part = new Ast(null, node);
  const alternatives: Ast[] = [];
  while (index < text.length) {
    const char = text.charAt(index++);
    if (inBracket(char, index)) { pending += char; continue; }
    const type = extglobType(char);
    if (type !== undefined && text.charAt(index) === "(" && (depth <= MAX_EXTGLOB_DEPTH || node.canAdoptType(type))) {
      part.push(pending); pending = "";
      const extglob = new Ast(type, part);
      part.push(extglob);
      index = parseNode(text, extglob, index, depth + (node.canAdoptType(type) ? 0 : 1));
      continue;
    }
    if (char === "|") { part.push(pending); pending = ""; alternatives.push(part); part = new Ast(null, node); continue; }
    if (char === ")") {
      if (pending === "" && node.parts.length === 0) node.emptyExt = true;
      part.push(pending);
      node.push(...alternatives, part);
      return index;
    }
    pending += char;
  }
  node.type = null; node.magic = undefined; node.parts = [text.substring(position - 1)];
  return index;
}

const GLOBSTAR = Symbol("**");
type Portion = typeof GLOBSTAR | string | ((name: string) => boolean);
function compilePortion(pattern: string): Portion {
  if (pattern === "**") return GLOBSTAR;
  if (pattern === "") return "";
  const root = new Ast(null);
  parseNode(pattern, root, 0, 0);
  const compiled = root.compile();
  if (!compiled.magic && root.magic !== true) return compiled.body;
  // The common shapes skip the expression, with the same answers.
  let match: RegExpExecArray | null;
  if (/^\*+$/u.test(pattern)) return name => name.length !== 0 && !name.startsWith(".");
  if ((match = /^\*+([^+@!?*[(]*)$/u.exec(pattern)) !== null) { const ext = match[1] ?? ""; return name => !name.startsWith(".") && name.endsWith(ext); }
  if ((match = /^\?+([^+@!?*[(]*)?$/u.exec(pattern)) !== null) { const length = match[0].length, ext = match[1] ?? ""; return name => name.length === length && !name.startsWith(".") && name.endsWith(ext); }
  if (/^\*+\.\*+$/u.test(pattern)) return name => !name.startsWith(".") && name.includes(".");
  if (/^\.\*+$/u.test(pattern)) return name => name !== "." && name !== ".." && name.startsWith(".");
  let expression: RegExp;
  try { expression = new RegExp(`^${compiled.source}$`, compiled.unicode ? "u" : ""); } catch { return () => false; }
  return name => expression.test(name);
}

// ---- whole paths -----------------------------------------------------------------------------------------------------------------

function slashSplit(text: string, windows: boolean): string[] {
  return windows && /^\/\/[^/]+/u.test(text) ? ["", ...text.split(/\/+/u)] : text.split(/\/+/u);
}
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
function optimizeFile(parts: string[], windows: boolean): string[] {
  for (let changed = true; changed;) {
    changed = squeeze(parts);
    for (let dots = parts.indexOf("..", 1); dots !== -1; dots = parts.indexOf("..", dots + 1)) {
      const before = parts[dots - 1];
      if (before !== undefined && before !== "" && before !== "." && before !== ".." && before !== "**" && !(windows && /^[a-z]:$/iu.test(before))) {
        changed = true; parts.splice(dots - 1, 2); dots -= 2;
      }
    }
  }
  return parts.length === 0 ? [""] : parts;
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

const hidden = (name: string | undefined): boolean => name === undefined || name.startsWith(".");
function matchPortions(file: readonly string[], pattern: readonly Portion[], fileIndex: number, patternIndex: number): boolean {
  let fi = fileIndex, pi = patternIndex;
  for (; fi < file.length && pi < pattern.length; fi++, pi++) {
    const portion = pattern[pi], name = file[fi] ?? "";
    if (portion === undefined || portion === GLOBSTAR) return false;
    if (!(typeof portion === "string" ? name === portion : portion(name))) return false;
  }
  if (fi === file.length) return pi === pattern.length;
  // A trailing slash on the path is allowed.
  return fi === file.length - 1 && file[fi] === "";
}
type Section = readonly [body: readonly Portion[], after: number];
function matchSections(file: readonly string[], sections: readonly Section[], start: number, sectionIndex: number, depth: number, sawTail: boolean): boolean | null {
  const section = sections[sectionIndex];
  if (section === undefined) {
    let saw = sawTail;
    for (let index = start; index < file.length; index++) { saw = true; if (hidden(file[index])) return false; }
    return saw;
  }
  const [body, after] = section;
  for (let fileIndex = start; fileIndex <= after; fileIndex++) {
    if (matchPortions(file.slice(0, fileIndex + body.length), body, fileIndex, 0) && depth < 200) {
      const below = matchSections(file, sections, fileIndex + body.length, sectionIndex + 1, depth + 1, sawTail);
      if (below !== false) return below;
    }
    if (hidden(file[fileIndex])) return false;
  }
  return null;
}
function matchGlobstar(file: readonly string[], pattern: readonly Portion[], fileStart: number, patternStart: number): boolean {
  const first = pattern.indexOf(GLOBSTAR, patternStart), last = pattern.lastIndexOf(GLOBSTAR);
  const head = pattern.slice(patternStart, first), body = pattern.slice(first + 1, last), tail = pattern.slice(last + 1);
  let fileIndex = fileStart;
  if (head.length !== 0) {
    if (!matchPortions(file.slice(fileIndex, fileIndex + head.length), head, 0, 0)) return false;
    fileIndex += head.length;
  }
  let tailLength = 0;
  if (tail.length !== 0) {
    if (tail.length + fileIndex > file.length) return false;
    const tailStart = file.length - tail.length;
    if (matchPortions(file, tail, tailStart, 0)) tailLength = tail.length;
    else {
      if (file.at(-1) !== "" || fileIndex + tail.length === file.length) return false;
      if (!matchPortions(file, tail, tailStart - 1, 0)) return false;
      tailLength = tail.length + 1;
    }
  }
  if (body.length === 0) {
    let saw = tailLength !== 0;
    for (let index = fileIndex; index < file.length - tailLength; index++) { saw = true; if (hidden(file[index])) return false; }
    return saw;
  }
  const bodies: Portion[][] = [[]], sums: number[] = [0];
  let plain = 0;
  for (const portion of body) {
    if (portion === GLOBSTAR) { sums.push(plain); bodies.push([]); } else { bodies.at(-1)?.push(portion); plain++; }
  }
  const length = file.length - tailLength;
  const sections = bodies.map((portions, index): Section => [portions, length - ((sums[bodies.length - 1 - index] ?? 0) + portions.length)]);
  return matchSections(file, sections, fileIndex, 0, 0, tailLength !== 0) === true;
}
function matchOne(input: readonly string[], pattern: Portion[], windows: boolean): boolean {
  let fileStart = 0, patternStart = 0;
  if (windows) {
    // A drive letter, bare or behind `//?/`, compares without case and may line up `c:` with `//?/c:`.
    const drive = (parts: readonly (string | Portion | undefined)[]): number | undefined => {
      const letter = (part: string | Portion | undefined): boolean => typeof part === "string" && /^[a-z]:$/iu.test(part);
      return letter(parts[0]) ? 0 : parts[0] === "" && parts[1] === "" && parts[2] === "?" && letter(parts[3]) ? 3 : undefined;
    };
    const fileDrive = drive(input), patternDrive = drive(pattern);
    const name = fileDrive === undefined ? undefined : input[fileDrive], wanted = patternDrive === undefined ? undefined : pattern[patternDrive];
    if (fileDrive !== undefined && patternDrive !== undefined && name !== undefined && typeof wanted === "string" && name.toLowerCase() === wanted.toLowerCase()) {
      pattern[patternDrive] = name; patternStart = patternDrive; fileStart = fileDrive;
    }
  }
  const file = optimizeFile(input.slice(), windows);
  return pattern.includes(GLOBSTAR) ? matchGlobstar(file, pattern, fileStart, patternStart) : matchPortions(file, pattern, fileStart, patternStart);
}

/** Node's `matchGlobPattern(path, pattern, windows)`. */
export function matchGlob(path: unknown, pattern: unknown, windows: boolean, inspect: Inspect): boolean {
  if (typeof path !== "string") throw invalidArgType("path", "string", path, inspect);
  if (typeof pattern !== "string") throw invalidArgType("pattern", "string", pattern, inspect);
  if (pattern.length > 65536) throw new TypeError("pattern is too long");
  // Backslashes are path separators here, never escapes.
  const glob = pattern.replaceAll("\\", "/");
  if (glob === "") return path === "";
  const patterns = optimizePatterns([...new Set(braceExpand(glob))].map(item => slashSplit(item, windows)));
  const file = slashSplit(windows ? path.replaceAll("\\", "/") : path, windows);
  return patterns.some(parts => {
    const portions = parts.map(compilePortion);
    // `//?/c:` is a drive root, where the `?` is text and not a wildcard.
    const drive = portions[3];
    if (windows && portions[0] === "" && portions[1] === "" && parts[2] === "?" && typeof drive === "string" && /^[a-z]:$/iu.test(drive)) portions[2] = "?";
    return matchOne(file, portions, windows);
  });
}
