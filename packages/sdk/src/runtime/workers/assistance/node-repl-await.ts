/*!
 * Adapted from Node.js v24.18.1 lib/internal/repl/await.js.
 * Copyright Node.js contributors. All rights reserved.
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
import { type AstNode, child, childList, childNodes, field, isRecoverableSyntax, nameOf, parseSource } from "./node-repl-syntax.ts";

/** Source text edited in place by position, as Node's transform does: one slot per UTF-16 unit. */
class Edits {
  readonly #units: string[];
  constructor(source: string) { this.#units = source.split(""); }
  replace(from: number, to: number, text: string): void {
    for (let index = from; index < to; index++) this.#units[index] = "";
    this.#units[from] = from === to ? text + (this.#units[from] ?? "") : text;
  }
  prepend(node: AstNode, text: string): void { this.#units[node.start] = text + (this.#units[node.start] ?? ""); }
  append(node: AstNode, text: string): void { this.#units[node.end - 1] = (this.#units[node.end - 1] ?? "") + text; }
  text(): string { return this.#units.join(""); }
}

interface Lowering {
  readonly edits: Edits;
  /** The statement list whose declarations are the REPL's top level. */
  readonly body: AstNode;
  /** Inside the async wrapper every `var` and function leaves the wrapper; without it only strict code needs that. */
  readonly wrapped: boolean;
  readonly hoisted: string[];
  containsAwait: boolean;
  containsReturn: boolean;
}

/** Names a declaration's pattern binds. */
function bound(pattern: AstNode | undefined, names: string[]): void {
  if (pattern === undefined) return;
  switch (pattern.type) {
    case "Identifier": names.push(nameOf(pattern)); break;
    case "ObjectPattern": for (const property of childList(pattern, "properties")) bound(child(property, "value") ?? child(property, "argument"), names); break;
    case "ArrayPattern": for (const element of childList(pattern, "elements")) bound(element, names); break;
    case "AssignmentPattern": bound(child(pattern, "left"), names); break;
    case "RestElement": bound(child(pattern, "argument"), names); break;
    default: break;
  }
}

function lowerVariables(node: AstNode, parent: AstNode | undefined, state: Lowering): void {
  const kind = String(field(node, "kind")), declarations = childList(node, "declarations");
  const iterable = parent?.type === "ForOfStatement" || parent?.type === "ForInStatement";
  if (kind !== "var" && parent !== state.body) return;
  state.edits.replace(node.start, node.start + kind.length + (iterable ? 1 : 0), kind === "var" && iterable ? "" : `void${declarations.length === 1 ? "" : " ("}`);
  if (!iterable) {
    for (const declaration of declarations) {
      state.edits.prepend(declaration, "(");
      // Node resets a declaration without a value to undefined inside the wrapper; outside it a `var x` keeps x.
      state.edits.append(declaration, child(declaration, "init") !== undefined || !state.wrapped ? ")" : "=undefined)");
    }
    const last = declarations.at(-1);
    if (declarations.length !== 1 && last !== undefined) state.edits.append(last, ")");
  }
  const names: string[] = [];
  for (const declaration of declarations) bound(child(declaration, "id"), names);
  // Node hoists `let` for lexical declarations; here every hoisted name is a `var`, which an eval can make global.
  if (names.length > 0) state.hoisted.push(`var ${names.join(", ")}; `);
}

function lower(node: AstNode, parent: AstNode | undefined, state: Lowering): void {
  switch (node.type) {
    case "FunctionExpression": case "ArrowFunctionExpression": case "MethodDefinition": return;
    case "FunctionDeclaration": {
      const name = nameOf(child(node, "id"));
      // Inside the wrapper Node prepends the assignment; without the wrapper it goes after the declaration, which keeps
      // the function's own columns as typed.
      if (state.wrapped) state.edits.prepend(node, `this.${name} = ${name}; `); else state.edits.append(node, `;void (this.${name} = ${name});`);
      state.hoisted.push(`var ${name}; `);
      return;
    }
    case "ClassDeclaration":
      if (parent === state.body) {
        const name = nameOf(child(node, "id"));
        // Without the wrapper the assignment would be the input's value; a class declaration has none.
        if (state.wrapped) state.edits.prepend(node, `${name}=`); else { state.edits.prepend(node, `void (${name}=`); state.edits.append(node, ")"); }
        state.hoisted.push(`var ${name}; `);
      }
      break;
    case "ForOfStatement": if (field(node, "await") === true) state.containsAwait = true; break;
    case "AwaitExpression": state.containsAwait = true; break;
    case "ReturnStatement": state.containsReturn = true; break;
    case "VariableDeclaration": lowerVariables(node, parent, state); break;
    default: break;
  }
  for (const next of childNodes(node)) lower(next, node, state);
}

export type TopLevelAwait =
  /** The input does not use top-level await (or cannot be wrapped): evaluate it as typed. */
  | { readonly kind: "plain" }
  /** More input may complete it. */
  | { readonly kind: "recoverable"; readonly error: SyntaxError }
  /** `code` evaluates to a promise of `{ value }` (or of undefined); `hoisted` declares what the input declared. */
  | { readonly kind: "wrapped"; readonly hoisted: string; readonly code: string };

const WRAP_PREFIX = "(async () => { ";

/** Wraps input that awaits at the top level in an async function, moving its declarations out of the wrapper, so the
 * REPL can evaluate it and wait for the result (Node's `processTopLevelAwait`). */
export function processTopLevelAwait(source: string): TopLevelAwait {
  const wrapped = `${WRAP_PREFIX}${source} })()`;
  const outcome = parseSource(wrapped);
  if (!outcome.ok) {
    const { failure } = outcome;
    if (failure.reason.startsWith("Unterminated")) return { kind: "recoverable", error: new SyntaxError(failure.message) };
    // An error before the first `await` is the input's own: the plain evaluation reports it.
    if (source.indexOf("await") > failure.pos - WRAP_PREFIX.length) return { kind: "plain" };
    // Node builds its own SyntaxError from acorn's message here. Without acorn, an input that is merely unfinished
    // stays recoverable and anything else is reported by the engine when the input is evaluated as typed.
    const fallback = source.replace(/\bawait\b/gu, "");
    if (!parseSource(fallback).ok && isRecoverableSyntax(fallback)) return { kind: "recoverable", error: new SyntaxError(failure.message) };
    return { kind: "plain" };
  }
  const statement = childList(outcome.program, "body")[0], call = statement === undefined ? undefined : child(statement, "expression");
  const arrow = call === undefined ? undefined : child(call, "callee"), body = arrow === undefined ? undefined : child(arrow, "body");
  if (body === undefined) return { kind: "plain" };
  const state: Lowering = { edits: new Edits(wrapped), body, wrapped: true, hoisted: [], containsAwait: false, containsReturn: false };
  for (const next of childList(body, "body")) lower(next, body, state);
  // A false alarm (no await expression), or a top-level return, which is not allowed.
  if (!state.containsAwait || state.containsReturn) return { kind: "plain" };
  const last = childList(body, "body").findLast(node => node.type !== "EmptyStatement"), expression = last?.type === "ExpressionStatement" ? child(last, "expression") : undefined;
  if (last !== undefined && expression !== undefined) {
    // `{ value: … }` keeps the caller from awaiting a promise the expression evaluates to.
    state.edits.prepend(expression, "{ value: (");
    state.edits.prepend(last, "return ");
    state.edits.append(expression, ") }");
  }
  return { kind: "wrapped", hoisted: state.hoisted.join(""), code: state.edits.text() };
}

/** What an indirect `eval` needs changed so that input behaves like a script typed at Node's prompt. */
export interface LoweredSource { readonly parsed: boolean; readonly hoisted: string; readonly code: string }

/** A script's top-level `let`, `const` and `class` live in the realm's global scope and are visible to the next
 * script. Code run through `eval` gets a scope of its own instead, so they are rewritten into `var`: the names
 * survive to the next input, without the redeclaration and constant-assignment errors a real declaration gives. */
export function lowerSloppy(source: string): LoweredSource {
  const outcome = parseSource(source);
  if (!outcome.ok) return { parsed: false, hoisted: "", code: source };
  const edits = new Edits(source);
  for (const statement of childList(outcome.program, "body")) {
    if (statement.type === "VariableDeclaration") {
      const kind = String(field(statement, "kind"));
      // Padded to the keyword's length, so the columns of later errors stay as typed.
      if (kind === "let" || kind === "const") edits.replace(statement.start, statement.start + kind.length, "var".padEnd(kind.length));
    } else if (statement.type === "ClassDeclaration") edits.prepend(statement, `var ${nameOf(child(statement, "id"))} = `);
  }
  return { parsed: true, hoisted: "", code: edits.text() };
}

/** Strict code run through `eval` keeps even `var` and functions to itself. Its declarations become assignments to
 * names that `hoisted`, evaluated first as sloppy code, declares globally. `prefix` is the strict-mode directive line
 * the REPL puts in front. */
export function lowerStrict(prefix: string, source: string): LoweredSource {
  const full = prefix + source, outcome = parseSource(full);
  if (!outcome.ok) return { parsed: false, hoisted: "", code: full };
  const state: Lowering = { edits: new Edits(full), body: outcome.program, wrapped: false, hoisted: [], containsAwait: false, containsReturn: false };
  for (const next of childList(outcome.program, "body")) lower(next, outcome.program, state);
  return { parsed: true, hoisted: state.hoisted.join(""), code: state.edits.text() };
}
