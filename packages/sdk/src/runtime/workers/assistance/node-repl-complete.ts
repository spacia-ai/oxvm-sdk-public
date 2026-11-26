/*!
 * Adapted from Node.js v24.18.1 lib/internal/repl/completion.js.
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
import { truthy } from "./node-repl-context.ts";
import type { ReplEval } from "./node-repl-eval.ts";
import { type AstNode, child, childList, field, isIdentifierName, nameOf, parseSource, walk } from "./node-repl-syntax.ts";

export type CompletionResult = [completions: string[], completeOn: string | undefined];
export type CompletionCallback = (error: unknown, result?: CompletionResult) => void;

/** The REPL a completion is computed for. */
export interface CompletionHost {
  readonly commands: Readonly<Record<string, unknown>>;
  readonly context: unknown;
  readonly evaluate: ReplEval;
  /** The names `require('` completes: `repl.builtinModules`. */
  readonly builtinLibs: () => readonly string[];
  /** Built-ins that load only with the `node:` scheme, already prefixed. */
  readonly schemeOnly: readonly string[];
  readonly isProxy: (value: unknown) => boolean;
  readonly resourceName: () => string;
}

const importRE = /\bimport\s*\(\s*['"`](([\w@./:-]+\/)?(?:[\w@./:-]*))(?![^'"`])$/u;
const requireRE = /\brequire\s*\(\s*['"`](([\w@./:-]+\/)?(?:[\w@./:-]*))(?![^'"`])$/u;
const LEGACY = new Set(["__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
const COMMON_WORDS = ["async", "await", "break", "case", "catch", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "false", "finally", "for", "function", "if",
  "import", "in", "instanceof", "let", "new", "null", "return", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield"];

const isArrayIndex = (name: string): boolean => /^(?:0|[1-9]\d{0,9})$/u.test(name) && Number(name) < 4_294_967_295;
const isObject = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";
const prototypeOf = (value: object): object | null => { const prototype: unknown = Object.getPrototypeOf(value); return isObject(prototype) ? prototype : null; };

/** An object's own string-named properties that can follow a dot. `Object.prototype` also loses its legacy accessors. */
function filteredOwnPropertyNames(value: unknown): string[] {
  if (!isObject(value)) return [];
  let isObjectPrototype = false;
  if (prototypeOf(value) === null) {
    const constructor: unknown = Object.getOwnPropertyDescriptor(value, "constructor")?.value;
    if (isObject(constructor)) { const parent = prototypeOf(constructor); isObjectPrototype = parent !== null && prototypeOf(parent) === value; }
  }
  return Object.getOwnPropertyNames(value).filter(name => !isArrayIndex(name) && isIdentifierName(name) && !(isObjectPrototype && LEGACY.has(name)));
}

/** The last part of `code` that can be evaluated to find completions, or null when there is none (or when evaluating
 * it could have side effects: a call, an assignment, an update or a loop). */
function findExpressionCompleteTarget(code: string): string | null {
  if (code === "") return null;
  if (code.endsWith(".")) {
    const optional = code.endsWith("?.");
    const result = findExpressionCompleteTarget(code.slice(0, optional ? -2 : -1));
    return result === null || result === "" ? result : `${result}${optional ? "?." : "."}`;
  }
  const outcome = parseSource(code, { module: true });
  if (!outcome.ok) {
    // The code may only be unfinished (`{ a: obj.te`): try its last space-separated word.
    const words = code.split(" "), last = words.at(-1);
    return words.length > 1 && last !== undefined ? findExpressionCompleteTarget(last) : null;
  }
  const statement = childList(outcome.program, "body").at(-1);
  if (statement === undefined || statement.type === "BlockStatement") return null;
  const source = (node: AstNode): string => code.slice(node.start, node.end);
  const expression = statement.type === "ExpressionStatement" ? child(statement, "expression") : undefined;
  const right = expression === undefined ? undefined : child(expression, "right");
  if (right !== undefined) return findExpressionCompleteTarget(source(right));
  if (statement.type === "VariableDeclaration") {
    const last = childList(statement, "declarations").at(-1), init = last === undefined ? undefined : child(last, "init");
    return init === undefined ? null : findExpressionCompleteTarget(source(init));
  }
  const argument = expression?.type === "UnaryExpression" ? child(expression, "argument") : undefined;
  if (argument !== undefined) return findExpressionCompleteTarget(source(argument));
  const callee = expression?.type === "NewExpression" ? child(expression, "callee") : undefined;
  if (callee !== undefined) return findExpressionCompleteTarget(source(callee));
  const effects = ["ForInStatement", "ForOfStatement", "CallExpression", "AssignmentExpression", "UpdateExpression"];
  const found = { effect: false };
  walk(statement, node => {
    if (effects.includes(node.type)) found.effect = true;
    return !found.effect;
  });
  return found.effect ? null : source(statement);
}

function propertyHasGetterOrIsProxy(host: CompletionHost, target: unknown, property: unknown, done: (includes: boolean) => void): void {
  if (!isObject(target) || (typeof property !== "string" && typeof property !== "number")) { done(false); return; }
  if (typeof Object.getOwnPropertyDescriptor(target, property)?.get === "function") { done(true); return; }
  const value: unknown = Reflect.get(target, property);
  done(host.isProxy(value));
}

/** Whether evaluating a member expression would run a getter or reach into a proxy; `last` is what it evaluated to. */
function includesProxiesOrGetters(host: CompletionHost, expression: AstNode | undefined, source: string, done: (includes: boolean, last?: unknown) => void): void {
  if (expression?.type !== "MemberExpression") { done(false); return; }
  const target = child(expression, "object"), property = child(expression, "property");
  const evaluate = (code: string, then: (error: unknown, value?: unknown) => void): void => { host.evaluate(code, host.context, host.resourceName(), then); };
  const hasGetterOrIsProxy = (value: unknown, then: (includes: boolean) => void): void => {
    // Node asks `!obj`, which is false for every object: only an object can have a getter.
    if (!truthy(value) || property === undefined) { then(false); return; }
    if (property.type === "Literal") { propertyHasGetterOrIsProxy(host, value, field(property, "value"), then); return; }
    if (property.type === "Identifier" && source.at(property.start - 1) === ".") { propertyHasGetterOrIsProxy(host, value, nameOf(property), then); return; }
    evaluate(`try { ${source.slice(property.start, property.end)} } catch {} `, (error, name) => {
      if (truthy(error) || typeof name !== "string") { then(false); return; }
      propertyHasGetterOrIsProxy(host, value, name, then);
    });
  };
  if (target?.type === "MemberExpression") {
    includesProxiesOrGetters(host, target, source.slice(0, target.end), (includes, last) => {
      if (includes || host.isProxy(last)) { done(true); return; }
      hasGetterOrIsProxy(last, done);
    });
    return;
  }
  if (target?.type !== "Identifier") { done(false); return; }
  evaluate(`try { ${nameOf(target)} } catch {}`, (error, value) => {
    if (truthy(error)) { done(false); return; }
    if (host.isProxy(value)) { done(true); return; }
    hasGetterOrIsProxy(value, includes => {
      if (includes) { done(true); return; }
      evaluate(`try { ${source} } catch {} `, (failure, evaluated) => { if (truthy(failure)) done(false); else done(false, evaluated); });
    });
  });
}

/** Filters, sorts within each group, removes duplicates and joins the groups, the nearest group last. */
function finish(groups: string[][], filter: string, completeOn: string | undefined, callback: CompletionCallback): void {
  let kept = groups;
  if (groups.length > 0 && filter !== "") {
    const lower = filter.toLocaleLowerCase();
    kept = groups.map(group => group.filter(entry => entry.toLocaleLowerCase().startsWith(lower))).filter(group => group.length > 0);
  }
  const completions: string[] = [], unique = new Set<string>([""]);
  for (const group of kept) {
    group.sort((left, right) => (right > left ? 1 : -1));
    const before = unique.size;
    for (const entry of group) if (!unique.has(entry)) { completions.unshift(entry); unique.add(entry); }
    // A separator between groups.
    if (unique.size !== before) completions.unshift("");
  }
  if (completions[0] === "") completions.shift();
  callback(null, [completions, completeOn]);
}

/** The members of `expression`'s value, one group per object of its prototype chain. */
function completeMembers(host: CompletionHost, target: string, expression: string, filter: string, callback: CompletionCallback): void {
  // A target ending in a dot does not parse; an identifier completes it.
  const parsable = target.endsWith(".") ? `${target}x` : target;
  const outcome = parseSource(parsable, { module: true });
  if (!outcome.ok) { finish([], filter, target, callback); return; }
  const statement = childList(outcome.program, "body")[0];
  includesProxiesOrGetters(host, statement === undefined ? undefined : child(statement, "expression"), parsable, includes => {
    // A getter or a proxy can do anything when it is evaluated: no completions.
    if (includes) { finish([], filter, target, callback); return; }
    const chaining = expression.endsWith("?") ? "?." : ".", base = expression.endsWith("?") ? expression.slice(0, -1) : expression;
    host.evaluate(`try { ${base} } catch {}`, host.context, host.resourceName(), (_error, value) => {
      const memberGroups: string[][] = [];
      try {
        let prototype: object | null;
        if (isObject(value)) { memberGroups.push(filteredOwnPropertyNames(value)); prototype = prototypeOf(value); }
        else {
          // A primitive completes from its wrapper's prototype; null and undefined throw here, as in Node.
          const constructor: unknown = Reflect.get(Object(value), "constructor");
          if (value === null || value === undefined) throw new TypeError("no members");
          const wrapper: unknown = isObject(constructor) ? Reflect.get(constructor, "prototype") : null;
          prototype = isObject(wrapper) ? wrapper : null;
        }
        // Circular prototype chains are possible: at most five levels.
        for (let sentinel = 5; prototype !== null && sentinel !== 0; sentinel--) { memberGroups.push(filteredOwnPropertyNames(prototype)); prototype = prototypeOf(prototype); }
      } catch { /* A proxy without an ownKeys trap, or a value without members: no completions. */ }
      const prefix = `${base}${chaining}`;
      if (memberGroups.length === 0) { finish([], filter, target, callback); return; }
      finish(memberGroups.map(group => group.map(member => `${prefix}${member}`)), filter === "" ? "" : `${prefix}${filter}`, target, callback);
    });
  });
}

/** Completions for the text before the cursor: REPL commands, built-in module names inside `require('` and
 * `import('`, global names, and the members of an expression (Node's `complete`). Completing module names from
 * `node_modules` and file names (`allowBlockingCompletions`) is not implemented: only built-ins are offered. */
export function complete(host: CompletionHost, text: string, callback: CompletionCallback): void {
  const line = text.trimStart();
  const command = /^\s*\.(\w*)$/u.exec(line);
  if (command !== null) { const on = command[1] ?? ""; finish([Object.keys(host.commands)], on, on, callback); return; }
  const module = requireRE.exec(line) ?? importRE.exec(line);
  if (module !== null) {
    const on = module[1] ?? "", libs = host.builtinLibs();
    finish([[...libs], [...libs.map(lib => `node:${lib}`), ...host.schemeOnly]], on, on, callback);
    return;
  }
  if (line.length !== 0 && !/\w|\.|\$/u.test(line.at(-1) ?? "")) { finish([], "", undefined, callback); return; }
  const target = line.length === 0 ? line : findExpressionCompleteTarget(line);
  if (target === null || (line.length !== 0 && target === "")) { finish([], "", undefined, callback); return; }
  let expression = "", filter = "";
  if (line.endsWith(".")) expression = target.slice(0, -1);
  else if (line.length !== 0) { const bits = target.split("."); filter = bits.pop() ?? ""; expression = bits.join("."); }
  if (expression !== "") { completeMembers(host, target, expression, filter, callback); return; }
  // Global names. Node also asks the inspector for the names of the global lexical scope; here a top-level `let`,
  // `const` or `class` typed at the prompt is a property of the global object and is found below.
  const groups: string[][] = [];
  for (let prototype = isObject(host.context) ? prototypeOf(host.context) : null; prototype !== null; prototype = prototypeOf(prototype)) groups.push(filteredOwnPropertyNames(prototype));
  groups.push(filteredOwnPropertyNames(host.context));
  if (filter !== "") groups.push([...COMMON_WORDS]);
  finish(groups, filter, target, callback);
}
