/*!
 * Adapted from Node.js v24.18.1 lib/repl.js (defaultEval and the REPL's error output).
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
import { lowerSloppy, lowerStrict, processTopLevelAwait } from "./node-repl-await.ts";
import { type AstNode, child, childList, field, isObjectLiteral, isRecoverableSyntax, isValidSyntax, nameOf, parseSource } from "./node-repl-syntax.ts";

export type ReplCallback = (error: unknown, result?: unknown) => void;
export type ReplEval = (code: string, context: unknown, file: string, callback: ReplCallback) => void;

/** What the default evaluation needs from its REPL. */
export interface ReplEvalHost {
  /** `vm.runInThisContext`: evaluates a script in the process's global scope. */
  readonly runInThisContext: (code: string, options?: { readonly filename: string }) => unknown;
  readonly strict: () => boolean;
  /** Wraps a syntax error that more input may fix (`repl.Recoverable`). */
  readonly recoverable: (error: unknown) => unknown;
  /** Reports an error the evaluated code threw. Node sends it to the REPL's domain, which prints it. */
  readonly thrown: (error: unknown) => void;
  /** While an awaited result is pending, the REPL defers its `exit`. */
  readonly pause: () => void;
  readonly unpause: () => void;
}

const STRICT_PREFIX = "'use strict'; void 0;\n";
const isSyntaxError = (error: unknown): boolean => typeof error === "object" && error !== null && Reflect.get(error, "name") === "SyntaxError";

/** Node's default `eval` for a REPL, over the one evaluation this runtime has: `vm.runInThisContext`, an indirect
 * `eval` in the process's global scope. A browser worker cannot create a second V8 context, so the code always runs
 * with the process's globals (`useGlobal: true` in Node's terms).
 *
 * Node compiles a script and then runs it. `eval` does both at once, so a syntax error counts as the input's own
 * only when the parser rejected the input too; otherwise it is an error the code threw while running. */
export function createDefaultEval(host: ReplEvalHost): ReplEval {
  const run = (code: string, file: string): unknown => host.runInThisContext(`${code}${code.endsWith("\n") ? "" : "\n"}//# sourceURL=${file}`, { filename: file });
  return function defaultEval(code, _context, file, callback): void {
    const input = code;
    let wrappedCommand = false, awaited: { readonly hoisted: string; readonly code: string } | undefined;
    if (isObjectLiteral(code) && isValidSyntax(code)) {
      // Parentheses make the engine read an expression where it would read a block.
      code = `(${code.trim()})\n`;
      wrappedCommand = true;
    }
    if (code.includes("await")) {
      const outcome = processTopLevelAwait(code);
      if (outcome.kind === "recoverable") { callback(host.recoverable(outcome.error)); return; }
      if (outcome.kind === "wrapped") { awaited = outcome; wrappedCommand = true; }
    }
    if (code === "\n") { callback(null); return; }
    let result: unknown, wrappedError: unknown;
    for (;;) {
      const strict = host.strict() && !/^\s*$/u.test(code);
      // "void 0" keeps the REPL from answering 'use strict' for statements that have no value.
      const prefix = strict ? STRICT_PREFIX : "";
      const lowered = awaited !== undefined ? { parsed: true, hoisted: strict ? awaited.hoisted : "", code: `${prefix}${strict ? "" : awaited.hoisted}${awaited.code}` }
        : strict ? lowerStrict(prefix, code) : lowerSloppy(code);
      try {
        if (lowered.hoisted !== "") run(lowered.hoisted, file);
        result = run(lowered.code, file);
        break;
      } catch (error) {
        if (lowered.parsed || !isSyntaxError(error)) { host.thrown(error); return; }
        if (wrappedCommand) {
          // Unwrap and try the input as typed.
          wrappedCommand = false; awaited = undefined; code = input; wrappedError = error;
          continue;
        }
        const reported = wrappedError ?? error;
        callback(isRecoverableSyntax(prefix + code) ? host.recoverable(reported) : reported);
        return;
      }
    }
    if (awaited === undefined) { callback(null, result); return; }
    host.pause();
    Promise.resolve(result).then(
      (settled: unknown) => {
        const value: unknown = typeof settled === "object" && settled !== null ? Reflect.get(settled, "value") : undefined;
        try { callback(null, value); } finally { host.unpause(); }
      },
      (error: unknown) => {
        try { if (truthy(error)) host.thrown(error); else callback(error); } finally { host.unpause(); }
      });
  };
}

/** Node cuts a stack at the script's own top-level frame, so an error shows only frames of code typed at the prompt.
 * Here that frame is the `eval` of the input; the frames of functions typed at the prompt lose the `eval` label the
 * engine gives every unnamed frame of evaluated code. */
export function trimReplStack(stack: string): string {
  const lines = stack.split("\n");
  const top = lines.findLastIndex(line => /^\s+at (?:async )?(?:eval \(REPL\d+:\d+:\d+\)|REPL\d+:\d+:\d+)$/u.test(line));
  const kept = top === -1 ? lines : lines.slice(0, top);
  return kept.map(line => line.replace(/^(\s+at (?:async )?)eval \((REPL\d+:\d+:\d+)\)$/u, "$1$2")).join("\n");
}

/** The dynamic `import()` a static import statement stands for, which Node suggests in its place. */
export function toDynamicImport(line: string): string {
  const outcome = parseSource(line, { module: true });
  if (!outcome.ok) return "";
  let statement = "";
  for (const node of childList(outcome.program, "body")) {
    if (node.type !== "ImportDeclaration") continue;
    const source: unknown = field(child(node, "source") ?? node, "value"), specifiers = childList(node, "specifiers");
    const awaitImport = `await import(${JSON.stringify(source)});`;
    const local = (specifier: AstNode): string => nameOf(child(specifier, "local"));
    const first = specifiers[0];
    if (first === undefined) statement += awaitImport;
    else if (specifiers.length === 1 && first.type === "ImportNamespaceSpecifier") statement += `const ${local(first)} = ${awaitImport}`;
    else {
      const names = specifiers.map(specifier => {
        const imported = child(specifier, "imported"), importedName = imported === undefined ? "default" : nameOf(imported);
        return local(specifier) === importedName && imported !== undefined ? local(specifier) : `${importedName}: ${local(specifier)}`;
      });
      statement += `const { ${names.join(", ")} } = ${awaitImport}`;
    }
  }
  return statement;
}

/** What Node's REPL writes for an error: the writer's text of it, labelled `Uncaught`. `breakLength` is the default
 * writer's. */
export function uncaughtText(text: string, breakLength: number): string {
  const lines = text.split(/(?<=\n)/u);
  let matched = false, output = "";
  for (const line of lines) {
    if (!matched && /^\[?(?:[A-Z][a-z0-9_]*)*Error/u.test(line)) {
      output += breakLength >= line.length ? `Uncaught ${line}` : `Uncaught:\n${line}`;
      matched = true;
    } else output += line;
  }
  if (!matched) output = `Uncaught${lines.length === 1 ? " " : ":\n"}${output}`;
  return output.endsWith("\n") ? output : `${output}\n`;
}
