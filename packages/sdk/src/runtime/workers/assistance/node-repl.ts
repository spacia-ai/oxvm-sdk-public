/*!
 * Adapted from Node.js v24.18.1 lib/repl.js and lib/internal/modules/helpers.js (addBuiltinLibsToObject).
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
import type { NodeReadline, ReadlineInterface } from "./node-readline.ts";
import { complete, type CompletionCallback, type CompletionResult } from "./node-repl-complete.ts";
import { createDefaultEval, type ReplCallback, toDynamicImport, trimReplStack, uncaughtText } from "./node-repl-eval.ts";
import { type ReplFiles, setupReplHistory } from "./node-repl-history.ts";
import { type ReplGlobals, createReplGlobals, truthy } from "./node-repl-context.ts";
import { isValidSyntax } from "./node-repl-syntax.ts";
import { named, validateFunction } from "./node-util-validators.ts";

export type { ReplFiles } from "./node-repl-history.ts";
type Callable = (...args: unknown[]) => unknown;

/** What the process owner lends the `repl` built-in. */
export interface NodeReplDependencies {
  /** The process's `readline` module: `REPLServer` extends its `Interface`. */
  readonly readline: Pick<NodeReadline, "Interface">;
  /** `vm.runInThisContext`: the default evaluation of typed code, in the process's global scope. */
  readonly runInThisContext: (code: string, options?: { readonly filename: string }) => unknown;
  /** `util.inspect` (with its `defaultOptions`), the default writer. */
  readonly inspect: (value: unknown, options?: unknown) => string;
  /** `util.deprecate`. */
  readonly deprecate: (fn: Callable, message: string, code: string) => Callable;
  /** `util.types.isProxy`: completion does not look into proxies. */
  readonly isProxy: (value: unknown) => boolean;
  /** `fs`, for `.save`, `.load` and the history file. */
  readonly files: ReplFiles;
  /** The process: default streams, and `env.HOME` for the default history file. */
  readonly process: { readonly stdin: unknown; readonly stdout: unknown; readonly env: Readonly<Record<string, string | undefined>> };
  /** `module.builtinModules`: the loader's built-in names, underscored and `node:`-only ones included. Asked for on
   * first use, so the module can be built before the loader that knows them. */
  readonly builtinModules: () => readonly string[];
  readonly nextTick: (callback: () => void) => void;
  /** The process's `require`, for the REPL's `require` global and its lazily loaded built-in globals (`fs`, `os`…). */
  readonly require?: (id: string) => unknown;
  /** `--pending-deprecation`: `repl.builtinModules`, `repl._builtinLibs` and the stream aliases then warn. */
  readonly pendingDeprecation?: boolean;
}

export interface ReplCommand { help?: string; action: Callable }
export type ReplWriter = ((value: unknown) => string) & { options: Record<string, unknown> };
/** A REPL: a `readline.Interface` that evaluates each line. */
export type ReplServer = ReadlineInterface & {
  allowBlockingCompletions: boolean; useColors: boolean; useGlobal: boolean; ignoreUndefined: boolean; replMode: unknown;
  underscoreAssigned: boolean; last: unknown; underscoreErrAssigned: boolean; lastError: unknown; breakEvalOnSigint: boolean; editorMode: boolean;
  eval: Callable; input: unknown; output: unknown; completer: unknown; _initialPrompt: string; context: unknown;
  lines: string[] & { level: unknown[] }; commands: Record<string, ReplCommand>; writer: unknown; history: string[]; historySize: number;
  setupHistory(historyConfig?: unknown, callback?: unknown): void;
  clearBufferedCommand(): void;
  createContext(): unknown;
  resetContext(): void;
  displayPrompt(preserveCursor?: unknown): void;
  complete(...args: unknown[]): void;
  completeOnEditorMode(callback: unknown): (error: unknown, results?: unknown) => void;
  defineCommand(keyword: unknown, command: unknown): void;
};
/** The `repl` module. `builtinModules` and its deprecated alias `_builtinLibs` are accessors defined on the object. */
export interface NodeRepl {
  start: (prompt?: unknown, source?: unknown, evaluate?: unknown, useGlobal?: unknown, ignoreUndefined?: unknown, replMode?: unknown) => ReplServer;
  writer: ReplWriter;
  REPLServer: new (prompt?: unknown, stream?: unknown, evaluate?: unknown, useGlobal?: unknown, ignoreUndefined?: unknown, replMode?: unknown) => ReplServer;
  REPL_MODE_SLOPPY: symbol;
  REPL_MODE_STRICT: symbol;
  Recoverable: new (error: unknown) => { err: unknown };
  isValidSyntax: (input: unknown) => boolean;
}
export interface NodeReplModule {
  readonly module: NodeRepl;
  /** Removes what REPLs defined on the global object (`_`, `_error`, `require`, the built-in module globals). */
  readonly restore: () => void;
}

const MULTILINE_PROMPT = "| ";
const get = (target: unknown, name: string): unknown => (typeof target === "object" && target !== null) || typeof target === "function" ? Reflect.get(target, name) : undefined;
const isCallable = (value: unknown): value is Callable => typeof value === "function";
const isCommand = (value: unknown): value is ReplCommand => isCallable(get(value, "action"));
/** Node gives a REPL's command table no prototype. */
function bare<T extends object>(value: T): T { Object.setPrototypeOf(value, null); return value; }
/** Calls a stream's method when it has one. */
function send(stream: unknown, method: string, ...args: unknown[]): void {
  const operation = get(stream, method);
  if (isCallable(operation)) Reflect.apply(operation, stream, args);
}

/** `repl.Recoverable`: a SyntaxError by prototype only. Node's constructor does not run Error's, so an instance has
 * `err` and no stack. */
class Recoverable {
  err: unknown;
  constructor(error: unknown) { this.err = error; }
}
Object.setPrototypeOf(Recoverable.prototype, SyntaxError.prototype);
Object.setPrototypeOf(Recoverable, SyntaxError);
named(Recoverable, "Recoverable");

/** What `new REPLServer(...)` was asked for, from an options object or Node's legacy positional arguments. */
function readOptions(dependencies: NodeReplDependencies, first: unknown, positional: readonly unknown[]) {
  const given = first !== null && typeof first === "object";
  const options: Record<string, unknown> = given ? { ...first } : {};
  let [stream, evaluate, useGlobal, ignoreUndefined, replMode] = positional, prompt = first;
  if (given) {
    stream = truthy(options["stream"]) ? options["stream"] : options["socket"];
    ({ eval: evaluate, useGlobal, ignoreUndefined, prompt, replMode } = options);
  }
  let input = options["input"], output = options["output"];
  if (!truthy(input) && !truthy(output)) {
    // A duplex stream such as a socket, an object with two streams, or the process.
    const source: unknown = truthy(stream) ? stream : dependencies.process;
    const stdin = get(source, "stdin"), stdout = get(source, "stdout");
    input = truthy(stdin) ? stdin : source;
    output = truthy(stdout) ? stdout : source;
  }
  return { options, input, output, prompt, evaluate, useGlobal, ignoreUndefined, replMode };
}

/** The input a REPL hands to `readline.Interface`: the real stream's events, with listeners that `close` removes.
 * The Interface never removes its own, and a listener left on `process.stdin` would keep the process alive after
 * `.exit`, which Node's REPL does not. */
function detachableInput(input: unknown): { readonly adapter: object; readonly detach: () => void } {
  if (!isCallable(get(input, "on"))) throw Object.assign(new TypeError("The \"input\" argument must be a readable stream"), { code: "ERR_INVALID_ARG_TYPE" });
  const listeners: [string, Callable][] = [];
  const adapter = {
    on(event: string, listener: Callable): unknown { listeners.push([event, listener]); send(input, "on", event, listener); return adapter; },
    pause(): void { send(input, "pause"); },
    resume(): void { send(input, "resume"); },
  };
  return { adapter, detach: () => { for (const [event, listener] of listeners.splice(0)) send(input, "removeListener", event, listener); send(input, "pause"); } };
}

/** The `repl` built-in of one process. Cheap to construct: nothing is parsed, evaluated or defined on the global
 * object until a REPL is started.
 *
 * Differences from Node that follow from the browser worker:
 * - One realm. Node's default (`useGlobal: false`) evaluates in a new V8 context whose globals are copies of the main
 *   context's; here every REPL evaluates in the process's global scope and reports `useGlobal: true` and
 *   `context === globalThis`, so `.clear` is the alias for `.break` and never resets a context.
 * - Never a terminal. `readline.Interface` here has no terminal mode, so `terminal: true` behaves as `terminal:
 *   false`: no line editing, no `.editor` command, no completion on Tab, no preview, no history navigation.
 * - No domain. Node prints an error thrown later by code the REPL started (a timer, a rejected promise) as
 *   `Uncaught …` and keeps going; here such an error is the process's uncaught exception.
 * - `breakEvalOnSigint` is accepted and has no effect: a running evaluation cannot be interrupted. */
export function createNodeRepl(dependencies: NodeReplDependencies): NodeReplModule {
  const REPL_MODE_SLOPPY = Symbol("repl-sloppy"), REPL_MODE_STRICT = Symbol("repl-strict");
  const globals: ReplGlobals = createReplGlobals();
  // `repl.builtinModules`: Node's public built-ins, which a program may replace through the accessor.
  const libs: { loaded: boolean; value: unknown } = { loaded: false, value: undefined };
  const builtinLibs = (): unknown => {
    if (!libs.loaded) { libs.loaded = true; libs.value = dependencies.builtinModules().filter(name => !name.startsWith("_") && !name.startsWith("node:")); }
    return libs.value;
  };
  const libNames = (): string[] => { const current = builtinLibs(); return Array.isArray(current) ? current.map(String) : []; };
  const schemeOnly = (): string[] => dependencies.builtinModules().filter(name => name.startsWith("node:"));
  let nextResource = 1;
  const resourceName = (): string => `REPL${String(nextResource++)}`;
  const defaults = get(dependencies.inspect, "defaultOptions");
  const writer: ReplWriter = Object.assign(named((value: unknown): string => dependencies.inspect(value, writerOptions()), "writer"),
    { options: { ...(typeof defaults === "object" && defaults !== null ? defaults : {}), showProxy: true } });
  function writerOptions(): unknown { return writer.options; }
  const warnInstantiation = dependencies.deprecate(() => undefined, "Instantiating REPLServer without the 'new' keyword has been deprecated.", "DEP0185");
  const pending = dependencies.pendingDeprecation === true;
  const maybeDeprecated = (fn: Callable, message: string, code: string): Callable => (pending ? dependencies.deprecate(fn, message, code) : fn);
  const Interface = dependencies.readline.Interface;

  class REPLServer extends Interface {
    allowBlockingCompletions: boolean; useColors: boolean; useGlobal: boolean; ignoreUndefined: boolean; replMode: unknown;
    underscoreAssigned = false; last: unknown = undefined; underscoreErrAssigned = false; lastError: unknown = undefined;
    breakEvalOnSigint: boolean; editorMode = false; eval: Callable; input: unknown; output: unknown; completer: unknown; _initialPrompt: string;
    context: unknown = undefined; lines: string[] & { level: unknown[] } = Object.assign([], { level: [] });
    commands: Record<string, ReplCommand> = bare({}); writer: unknown; history: string[] = []; historySize: number;
    #buffered = "";
    #paused = false;
    #closedWhilePaused = false;
    readonly #basePrompt: (prompt: string) => void;
    readonly #baseClose: () => void;

    constructor(prompt?: unknown, stream?: unknown, evaluate?: unknown, useGlobal?: unknown, ignoreUndefined?: unknown, replMode?: unknown) {
      const settings = readOptions(dependencies, prompt, [stream, evaluate, useGlobal, ignoreUndefined, replMode]);
      const { options } = settings, source = detachableInput(settings.input);
      super({ input: source.adapter, output: settings.output, prompt: settings.prompt });
      this.#basePrompt = text => { super.setPrompt(text); };
      this.#baseClose = () => { super.close(); };
      const aliases = "repl.inputStream and repl.outputStream are deprecated. Use repl.input and repl.output instead";
      for (const [alias, name] of [["inputStream", "input"], ["outputStream", "output"]] as const) {
        Object.defineProperty(this, alias, { get: maybeDeprecated(() => this[name], aliases, "DEP0141"), set: maybeDeprecated(value => { this[name] = value; }, aliases, "DEP0141"), enumerable: false, configurable: true });
      }
      this.allowBlockingCompletions = truthy(options["allowBlockingCompletions"]);
      this.useColors = truthy(options["useColors"]);
      // One realm: there is no context but the process's own (see createNodeRepl).
      this.useGlobal = true;
      this.ignoreUndefined = truthy(settings.ignoreUndefined);
      this.replMode = truthy(settings.replMode) ? settings.replMode : REPL_MODE_SLOPPY;
      this.breakEvalOnSigint = truthy(options["breakEvalOnSigint"]);
      const custom = settings.evaluate;
      // breakEvalOnSigint affects only the default eval; allowing both would not reflect user expectations.
      if (this.breakEvalOnSigint && truthy(custom)) throw Object.assign(new TypeError("Cannot specify both \"breakEvalOnSigint\" and \"eval\" for REPL"), { code: "ERR_INVALID_REPL_EVAL_CONFIG" });
      const evaluator: unknown = truthy(custom) ? custom : createDefaultEval({
        runInThisContext: dependencies.runInThisContext, strict: () => this.replMode === REPL_MODE_STRICT, recoverable: error => new Recoverable(error),
        thrown: error => { this.#reportError(error); }, pause: () => { this.#paused = true; }, unpause: () => { this.#unpause(); },
      });
      // Node binds the evaluator to the REPL's domain; the bound function is what `repl.eval` holds.
      this.eval = named((...args: unknown[]): unknown => (isCallable(evaluator) ? Reflect.apply(evaluator, this, args) : undefined), "runBound");
      this.input = settings.input;
      this.output = settings.output;
      this.completer = truthy(options["completer"]) ? options["completer"] : named((text: unknown, callback: unknown): void => { this.#complete(text, this.editorMode ? this.completeOnEditorMode(callback) : callback); }, "completer");
      this._initialPrompt = this.getPrompt();
      this.historySize = typeof options["historySize"] === "number" ? options["historySize"] : 30;
      this.resetContext();
      this.#defineDefaultCommands();
      this.writer = truthy(options["writer"]) ? options["writer"] : writer;
      // Conditionally turn on ANSI coloring.
      if (this.writer === writer) writer.options["colors"] = this.useColors;
      this.on("close", () => {
        source.detach();
        if (this.#paused) { this.#closedWhilePaused = true; return; }
        this.emit("exit");
      });
      this.on("line", (line: unknown) => { this.#onLine(typeof line === "string" ? line : ""); });
      this.displayPrompt();
    }

    setupHistory(historyConfig: unknown = {}, callback?: unknown): void {
      setupReplHistory(this, { files: dependencies.files, env: dependencies.process.env, nextTick: dependencies.nextTick, write: text => { this.#write(text); } }, historyConfig, callback);
    }
    clearBufferedCommand(): void { this.#buffered = ""; }
    override close(): void { dependencies.nextTick(() => { this.#baseClose(); }); }
    /** The process's global object, with the REPL's `require` and one lazily loaded global per built-in module. */
    createContext(): unknown {
      if (dependencies.require !== undefined) globals.defineModules(dependencies.require, libNames());
      return globalThis;
    }
    resetContext(): void {
      this.context = this.createContext();
      this.underscoreAssigned = false;
      this.underscoreErrAssigned = false;
      this.lines = Object.assign([], { level: [] });
      globals.define("_", { configurable: true, get: () => this.last, set: (value: unknown) => {
        this.last = value;
        if (!this.underscoreAssigned) { this.underscoreAssigned = true; this.#write("Expression assignment to _ now disabled.\n"); }
      } });
      globals.define("_error", { configurable: true, get: () => this.lastError, set: (value: unknown) => {
        this.lastError = value;
        if (!this.underscoreErrAssigned) { this.underscoreErrAssigned = true; this.#write("Expression assignment to _error now disabled.\n"); }
      } });
      // Lets REPL extensions extend the new context.
      this.emit("reset", this.context);
    }
    displayPrompt(preserveCursor?: unknown): void {
      void preserveCursor;
      // `_initialPrompt` is not overwritten here.
      this.#basePrompt(this.#buffered.length > 0 ? MULTILINE_PROMPT : this._initialPrompt);
      this.prompt();
    }
    /** As an API method, this also replaces the prompt shown after each result. */
    override setPrompt(prompt: unknown): void {
      this._initialPrompt = typeof prompt === "string" ? prompt : String(prompt);
      this.#basePrompt(this._initialPrompt);
    }
    complete(...args: unknown[]): void {
      const completer = this.completer;
      if (!isCallable(completer)) throw new TypeError("this.completer.apply is not a function");
      Reflect.apply(completer, this, args);
    }
    completeOnEditorMode(callback: unknown): (error: unknown, results?: unknown) => void {
      const done = (...args: unknown[]): void => { if (isCallable(callback)) Reflect.apply(callback, undefined, args); };
      return (error, results) => {
        if (truthy(error)) { done(error); return; }
        const list: unknown = get(results, "0"), on: unknown = get(results, "1") ?? "";
        let result: unknown[] = Array.isArray(list) ? list.filter(Boolean) : [];
        if (truthy(on) && result.length !== 0) result = [commonPrefix(result.map(String))];
        done(null, [result, on]);
      };
    }
    defineCommand(keyword: unknown, command: unknown): void {
      let definition: ReplCommand;
      if (isCallable(command)) definition = { action: command };
      else {
        if (command === null || command === undefined) throw new TypeError(`Cannot read properties of ${String(command)} (reading 'action')`);
        validateFunction(get(command, "action"), "cmd.action");
        if (!isCommand(command)) return;
        definition = command;
      }
      this.commands[String(keyword)] = definition;
    }

    #write(text: string): void { send(this.output, "write", text); }
    #format(value: unknown): string { return isCallable(this.writer) ? String(Reflect.apply(this.writer, this, [value])) : String(value); }
    #complete(text: unknown, callback: unknown): void {
      const done: CompletionCallback = (error: unknown, result?: CompletionResult) => { if (isCallable(callback)) Reflect.apply(callback, undefined, [error, result]); };
      complete({ commands: this.commands, context: this.context, evaluate: (code, context, file, then) => { this.eval(code, context, file, then); },
        builtinLibs: libNames, schemeOnly: schemeOnly(), isProxy: dependencies.isProxy, resourceName }, String(text), done);
    }
    #unpause(): void {
      if (!this.#paused) return;
      this.#paused = false;
      if (this.#closedWhilePaused) { this.#closedWhilePaused = false; this.emit("exit"); }
    }
    /** Node's `_memory`: the session's lines, which `.save` writes. */
    #remember(command: string): void {
      this.lines.push(command);
      if (command === "") this.lines.level = [];
    }
    /** What Node's domain does with an error from evaluated code: remember it as `_error`, print it, start over. */
    #reportError(error: unknown): void {
      let text = "";
      if (error instanceof Error) {
        if (typeof error.stack === "string" && error.stack !== "") {
          let stack = trimReplStack(error.stack);
          if (error.name === "SyntaxError") {
            // A syntax error has no stack worth showing. Node also prints the offending line and a caret from the
            // engine's message location, which an `eval` does not report.
            stack = stack.replace(/^REPL\d+:\d+\r?\n/u, "").replace(/^\s+at\s.*\n?/gmu, "");
            if (error.message.includes("Cannot use import statement outside a module")) {
              error.message = `Cannot use import statement inside the Node.js REPL, alternatively use dynamic import: ${toDynamicImport(this.lines.at(-1) ?? "")}`;
              stack = stack.replace(/SyntaxError:.*\n/u, () => `SyntaxError: ${error.message}\n`);
            }
          } else if (this.replMode === REPL_MODE_STRICT) {
            // The strict-mode directive is a line of its own before the input.
            stack = stack.replace(/(\s+at\s+REPL\d+:)(\d+)/u, (_match, before: string, line: string) => `${before}${String(Number(line) - 1)}`);
          }
          try { error.stack = stack; } catch { /* A frozen error keeps its stack. */ }
        }
        text = this.#format(error);
        // One-line error braces are removed to keep the old style.
        if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
      }
      if (!this.underscoreErrAssigned) this.lastError = error;
      if (text === "") text = this.#format(error);
      const breakLength = writer.options["breakLength"];
      this.#write(uncaughtText(text, typeof breakLength === "number" ? breakLength : 80));
      this.clearBufferedCommand();
      this.lines.level = [];
      if (!this.closed) this.displayPrompt();
    }
    #onLine(command: string): void {
      if (this.editorMode) { this.#buffered += `${command}\n`; this.#remember(command); return; }
      // REPL keywords and empty lines are checked against the trimmed line.
      const trimmed = command.trim();
      const finish: ReplCallback = (...results: unknown[]): void => {
        const [error, value] = results;
        this.#remember(command);
        const recoverable = error instanceof Recoverable;
        if (truthy(error) && this.#buffered === "" && trimmed.startsWith("npm ") && !recoverable) {
          this.#write("npm should be run outside of the Node.js REPL, in your normal shell.\n(Press Ctrl+D to exit.)\n");
          this.displayPrompt();
          return;
        }
        // A syntax error that more input can fix starts a multiline command.
        if (recoverable) { this.#buffered += `${command}\n`; this.displayPrompt(); return; }
        if (truthy(error)) { const inner = get(error, "err"); this.#reportError(truthy(inner) ? inner : error); }
        this.clearBufferedCommand();
        // Only an evaluation that answered with a value (a second argument) prints one.
        if (!truthy(error) && results.length === 2 && (!this.ignoreUndefined || value !== undefined)) {
          if (!this.underscoreAssigned) this.last = value;
          this.#write(`${this.#format(value)}\n`);
        }
        // After an error the prompt was already displayed.
        if (!this.closed && !truthy(error)) this.displayPrompt();
      };
      if (trimmed !== "" && trimmed.startsWith(".") && trimmed.charAt(1) !== "." && Number.isNaN(Number.parseFloat(trimmed))) {
        const matches = /^\.([^\s]+)\s*(.*)$/u.exec(trimmed), entry = matches?.[1] === undefined ? undefined : this.commands[matches[1]];
        if (entry !== undefined) { Reflect.apply(entry.action, this, [matches?.[2]]); return; }
        if (this.#buffered === "") { this.#write("Invalid REPL keyword\n"); finish(null); return; }
      }
      try { this.eval(`${this.#buffered}${command}\n`, this.context, resourceName(), finish); }
      // Node's domain catches what a custom eval throws.
      catch (error) { this.#reportError(error); }
    }
    #defineDefaultCommands(): void {
      const self = (target: unknown): REPLServer => { if (!(target instanceof REPLServer)) throw new TypeError("REPL commands run on their REPLServer"); return target; };
      const missing = "The \"file\" argument must be specified";
      this.defineCommand("break", { help: "Sometimes you get stuck, this gets you out", action: named(function (this: unknown): void { const repl = self(this); repl.clearBufferedCommand(); repl.displayPrompt(); }, "action") });
      // With one realm there is no local context to clear.
      this.defineCommand("clear", { help: "Alias for .break", action: named(function (this: unknown): void { const repl = self(this); repl.clearBufferedCommand(); repl.displayPrompt(); }, "action") });
      this.defineCommand("exit", { help: "Exit the REPL", action: named(function (this: unknown): void { self(this).close(); }, "action") });
      this.defineCommand("help", { help: "Print this help message", action: named(function (this: unknown): void {
        const repl = self(this), names = Object.keys(repl.commands).sort(), longest = Math.max(...names.map(name => name.length));
        for (const name of names) {
          const help = repl.commands[name]?.help;
          repl.#write(`.${name}${typeof help === "string" && help !== "" ? " ".repeat(longest - name.length + 3) + help : ""}\n`);
        }
        repl.#write("\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n");
        repl.displayPrompt();
      }, "action") });
      this.defineCommand("save", { help: "Save all evaluated commands in this REPL session to a file", action: named(function (this: unknown, file: unknown): void {
        const repl = self(this), path = String(file);
        if (path === "") repl.#write(`${missing}\n`);
        else {
          try { dependencies.files.writeFileSync(path, repl.lines.join("\n")); repl.#write(`Session saved to: ${path}\n`); }
          catch { repl.#write(`Failed to save: ${path}\n`); }
        }
        repl.displayPrompt();
      }, "action") });
      this.defineCommand("load", { help: "Load JS from a file into the REPL session", action: named(function (this: unknown, file: unknown): void {
        const repl = self(this), path = String(file);
        if (path === "") repl.#write(`${missing}\n`);
        else {
          try {
            const stats: unknown = dependencies.files.statSync(path), isFile: unknown = get(stats, "isFile");
            if (isCallable(isFile) && truthy(Reflect.apply(isFile, stats, []))) {
              // The file is read as one buffered command, then a newline evaluates it.
              repl.editorMode = true; repl.#basePrompt("");
              const data = String(dependencies.files.readFileSync(path, "utf8"));
              repl.write(data);
              repl.editorMode = false; repl.setPrompt(repl._initialPrompt);
              repl.write("\n");
            } else repl.#write(`Failed to load: ${path} is not a valid file\n`);
          } catch { repl.#write(`Failed to load: ${path}\n`); }
        }
        repl.displayPrompt();
      }, "action") });
    }
  }
  named(REPLServer, "REPLServer");
  // Node assigns these methods to the prototype, most of them as anonymous functions: enumerable, and so named.
  for (const [method, name] of [["setupHistory", "setupHistory"], ["clearBufferedCommand", "clearBufferedCommand"], ["close", "close"], ["createContext", ""], ["resetContext", ""],
    ["displayPrompt", ""], ["setPrompt", "setPrompt"], ["complete", ""], ["completeOnEditorMode", ""], ["defineCommand", ""]] as const) {
    const implementation: unknown = Object.getOwnPropertyDescriptor(REPLServer.prototype, method)?.value;
    if (isCallable(implementation)) Object.defineProperty(REPLServer.prototype, method, { value: named(implementation, name), enumerable: true, writable: true, configurable: true });
  }
  // Node's REPLServer is a function: called without `new` it still constructs, with a deprecation warning.
  const Server = new Proxy(REPLServer, { apply(target, _receiver, args: unknown[]): unknown { warnInstantiation(); const made: unknown = Reflect.construct(target, args); return made; } });
  Object.defineProperty(REPLServer.prototype, "constructor", { value: Server, writable: true, enumerable: false, configurable: true });
  const RecoverableFunction = new Proxy(Recoverable, { apply(): undefined { return undefined; } });
  function start(prompt?: unknown, source?: unknown, evaluate?: unknown, useGlobal?: unknown, ignoreUndefined?: unknown, replMode?: unknown): ReplServer {
    return new Server(prompt, source, evaluate, useGlobal, ignoreUndefined, replMode);
  }
  const module: NodeRepl = { start: named(start, "start"), writer, REPLServer: Server, REPL_MODE_SLOPPY, REPL_MODE_STRICT, Recoverable: RecoverableFunction, isValidSyntax: named((input: unknown): boolean => isValidSyntax(input), "isValidSyntax") };
  for (const [name, code] of [["builtinModules", "DEP0191"], ["_builtinLibs", "DEP0142"]] as const) {
    const message = `repl.${name} is deprecated. Check module.builtinModules instead`;
    Object.defineProperty(module, name, { get: maybeDeprecated(named(() => builtinLibs(), ""), message, code), set: maybeDeprecated(named((value: unknown) => { libs.loaded = true; libs.value = value; }, ""), message, code), enumerable: false, configurable: true });
  }
  return { module, restore: globals.restore };
}

/** The longest prefix every string shares (Node's `commonPrefix`). */
function commonPrefix(strings: readonly string[]): string {
  const sorted = [...strings].sort(), first = sorted[0], last = sorted.at(-1);
  if (first === undefined || last === undefined) return "";
  if (sorted.length === 1) return first;
  let index = 0;
  while (index < first.length && first[index] === last[index]) index++;
  return first.slice(0, index);
}
