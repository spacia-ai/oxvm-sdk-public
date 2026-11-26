import { parse } from "@babel/parser";

/** A node of the parser's ESTree output: only what the REPL reads. Other fields are read by name. */
export interface AstNode { readonly type: string; readonly start: number; readonly end: number }
export function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
    && typeof Reflect.get(value, "start") === "number" && typeof Reflect.get(value, "end") === "number";
}
export function child(node: AstNode, key: string): AstNode | undefined {
  const value: unknown = Reflect.get(node, key);
  return isAstNode(value) ? value : undefined;
}
export function childList(node: AstNode, key: string): AstNode[] {
  const value: unknown = Reflect.get(node, key);
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}
export function field(node: AstNode, key: string): unknown { return Reflect.get(node, key); }
/** An identifier's name, or the name of the identifier under `key`. */
export function nameOf(node: AstNode | undefined): string {
  const name: unknown = node === undefined ? undefined : Reflect.get(node, "name");
  return typeof name === "string" ? name : "";
}

/** Fields that hold positions and comments, not syntax. */
const NOT_SYNTAX = new Set(["loc", "range", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "errors"]);
export function childNodes(node: AstNode): AstNode[] {
  const found: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_SYNTAX.has(key)) continue;
    if (isAstNode(value)) found.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isAstNode(item)) found.push(item);
  }
  return found;
}
/** Visits `node` and what is under it, parents first. A visitor that returns `false` keeps the walk out of that node. */
export function walk(node: AstNode, visit: (node: AstNode, parent: AstNode | undefined) => boolean, parent?: AstNode): void {
  if (!visit(node, parent)) return;
  for (const next of childNodes(node)) walk(next, visit, node);
}

export interface ParseOptions { readonly module?: boolean; readonly allowAwait?: boolean }
/** Why the parser stopped: its reason code, the offset it stopped at and its message. */
export interface SyntaxFailure { readonly reason: string; readonly pos: number; readonly message: string }
export type ParseOutcome = { readonly ok: true; readonly program: AstNode } | { readonly ok: false; readonly failure: SyntaxFailure };

/** Parses JavaScript into an ESTree program. Node's REPL uses acorn; this runtime ships Babel's parser, whose
 * `estree` output has the same node shapes for everything the REPL inspects. */
export function parseSource(code: string, options: ParseOptions = {}): ParseOutcome {
  try {
    const file = parse(code, { sourceType: options.module === true ? "module" : "script", plugins: ["estree"], allowAwaitOutsideFunction: options.allowAwait === true });
    const program: unknown = file.program;
    if (!isAstNode(program)) throw new TypeError("The parser returned no program");
    return { ok: true, program };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const reason: unknown = Reflect.get(error, "reasonCode"), pos: unknown = Reflect.get(error, "pos");
    return { ok: false, failure: { reason: typeof reason === "string" ? reason : "", pos: typeof pos === "number" ? pos : 0, message: error.message } };
  }
}

/** Node's `repl.isValidSyntax`: the input parses as it is, or as the right-hand side of an assignment. */
export function isValidSyntax(input: unknown): boolean {
  const code = String(input);
  return parseSource(code, { allowAwait: true }).ok || parseSource(`_=${code}`, { allowAwait: true }).ok;
}
/** `{ a: 1 }` typed at the prompt is an object literal, not a block, unless a semicolon ends it. */
export function isObjectLiteral(code: string): boolean { return /^\s*\{/u.test(code) && !/;\s*$/u.test(code); }

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
export function isIdentifierName(text: string): boolean { return IDENTIFIER.test(text); }

/** Whether more input could complete `code` (Node's `isRecoverableError`): the parser ran out of input, or stopped
 * inside a token that may span lines (a template, a comment, a string continued with a backslash).
 *
 * Node asks acorn whether the error was raised after the end-of-input token was read. Babel's parser does not expose
 * that, so this compares the error's position with the end of the input and names the errors acorn raises late
 * (a `try` without a handler, a newline after `throw`, a `const` without a value, `new.target` outside a function,
 * a strict-mode `delete` of a name). */
export function isRecoverableSyntax(code: string): boolean {
  // As in `defaultEval`, an input starting with a brace may be an unfinished object literal.
  if (/^\s*\{/u.test(code) && isRecoverableSyntax(`(${code}`)) return true;
  const outcome = parseSource(code);
  if (outcome.ok) return false;
  const { reason, pos } = outcome.failure;
  switch (reason) {
    case "UnterminatedTemplate": case "UnterminatedComment": return true;
    case "UnterminatedString": return /\\(?:\r\n?|\n|\u2028|\u2029)$/u.test(code);
    case "NoCatchOrFinally": return /\}\s*$/u.test(code);
    case "NewlineAfterThrow": case "DeclarationMissingInitializer": return code.slice(pos).trim() === "";
    case "UnexpectedNewTarget": return /new\.target\s*$/u.test(code);
    case "StrictDelete": return /^delete\s+[\p{ID_Continue}$]+\s*$/u.test(code.slice(pos));
    default:
      // Empty parentheses may still become an arrow function's parameters: acorn reads on to the end of the input.
      if (/\(\s*\)\s*$/u.test(code) && code.slice(pos).trim() === ")") return true;
      return pos >= code.length && !/\bexport\s*$/u.test(code);
  }
}
