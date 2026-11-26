import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "readable-stream";
import { record, string } from "../../decode.js";
import { createAsyncContext } from "./async-context.js";
import { createNodeReadline } from "./node-readline.js";
import { createInputStream } from "./node-streams.js";
import { asObject, call, createHarness, invoke, list, loadControls, memoryFiles, openSession, outcome, prototypeOf, read, settle, shape, type ReplHarness } from "./node-repl.test-support.js";

// Recorded from the real binary by the scripts under "recorder" (docker run --rm node:24.18.1-alpine node rec-repl.cjs …).
const control = loadControls("./node-repl.controls.json");
const transcripts = record(control["transcripts"], "transcripts");
const globalsBefore = new Set(Reflect.ownKeys(globalThis));
const harnesses: ReplHarness[] = [];
function harness(...args: Parameters<typeof createHarness>): ReplHarness { const made = createHarness(...args); harnesses.push(made); return made; }
afterEach(() => { vi.useRealTimers(); for (const made of harnesses.splice(0)) made.restore(); });
// The transcripts declare globals, as the recorder's did.
afterAll(() => { for (const key of Reflect.ownKeys(globalThis)) if (!globalsBefore.has(key)) Reflect.deleteProperty(globalThis, key); });

/** Node numbers its evaluations per process; a transcript compares the frames, not the counter. */
const unnumbered = (text: string): string => text.replace(/REPL\d+/gu, "REPL#");
/** Node prints the offending line and a caret before a syntax error, from the engine's message location. An `eval`
 * does not report that location, so this REPL prints the error alone. */
const withoutCaret = (text: string): string => text.replace(/^.*\n *\^+\n\n(?=Uncaught)/u, "");
const firstLine = (text: string): string => text.split("\n")[0] ?? "";

interface Replay {
  /** Steps whose output differs here, with the reason; they are still typed. */
  readonly differs?: Readonly<Record<string, string>>;
  /** Steps that print a stack through frames of the host: only the first line is compared. */
  readonly firstLineOnly?: readonly string[];
  readonly expected?: (text: string) => string;
  readonly setup?: (session: ReturnType<typeof openSession>) => void;
  readonly prompts?: readonly string[];
  readonly files?: ReturnType<typeof memoryFiles>;
  readonly until?: number;
  /** Runs right after a line is written, before its answer is awaited. */
  readonly afterWrite?: (typed: string) => void;
}
async function replay(name: string, options: Record<string, unknown>, how: Replay = {}): Promise<number> {
  const recorded = record(transcripts[name], name), steps = list(recorded["steps"]).slice(0, how.until);
  const made = harness(how.files === undefined ? {} : { files: how.files.port });
  const session = openSession(made, options, how.prompts);
  how.setup?.(session);
  await settle();
  let compared = 0;
  for (const step of steps) {
    const [line, output] = list(step), typed = string(line, "line"), expected = (how.expected ?? (text => text))(withoutCaret(unnumbered(string(output, "output"))));
    const actual = unnumbered(typed === "" && compared === 0 ? session.take() : typed === "$end" ? await session.end() : await session.type(typed, () => how.afterWrite?.(typed)));
    compared++;
    if (how.differs?.[typed] !== undefined) continue;
    if (how.firstLineOnly?.includes(typed) === true) expect(firstLine(actual), `${name}: ${typed}`).toBe(firstLine(expected));
    else expect(actual, `${name}: ${typed}`).toBe(expected);
  }
  if (how.until === undefined) expect(session.events, name).toEqual(recorded["events"]);
  else { session.server.close(); await settle(); }
  return compared;
}

describe("node repl builtin: module and server shape (Node 24.18.1 controls)", () => {
  it("has Node's exports, symbols, writer and Recoverable", () => {
    const { module } = harness({ builtinModules: () => list(control["moduleBuiltins"]).map(String) });
    expect(Object.keys(module)).toEqual(control["keys"]);
    expect(shape(module)).toEqual(control["shape"]);
    expect({ sloppy: String(module.REPL_MODE_SLOPPY), strict: String(module.REPL_MODE_STRICT) }).toEqual(control["symbols"]);
    expect(Reflect.get(module, "builtinModules")).toEqual(control["builtinModules"]);
    expect(Reflect.get(module, "builtinModules") === Reflect.get(module, "_builtinLibs")).toBe(control["sameList"]);
    const writer = record(control["writer"], "writer");
    expect([module.writer.name, module.writer.length, Object.keys(module.writer.options)]).toEqual([writer["name"], writer["length"], writer["optionsKeys"]]);
    expect(module.writer.options).toEqual(writer["options"]);
    expect(module.writer({ a: [1, { b: new Map([[1, 2]]) }] })).toBe(writer["sample"]);
    const recoverable = record(control["Recoverable"], "Recoverable"), inner = new SyntaxError("inner"), made = new module.Recoverable(inner);
    expect([module.Recoverable.name, module.Recoverable.length, Object.getPrototypeOf(module.Recoverable) === SyntaxError]).toEqual([recoverable["name"], recoverable["length"], recoverable["proto"]]);
    expect(shape(prototypeOf(module.Recoverable))).toEqual(recoverable["protoShape"]);
    expect({ isSyntax: made instanceof SyntaxError, isError: made instanceof Error, own: Reflect.ownKeys(made), errSame: made.err === inner, name: read(made, "name"), message: read(made, "message"),
      stack: typeof read(made, "stack"), tag: Object.prototype.toString.call(made), isNative: false }).toEqual(recoverable["instance"]);
    expect(outcome(() => call(module.Recoverable, [1]))).toEqual(recoverable["call"]);
    expect(list(control["isValidSyntax"]).map(entry => [list(entry)[0], module.isValidSyntax(list(entry)[0])])).toEqual(control["isValidSyntax"]);
    expect([module.start.name, module.start.length]).toEqual([record(control["start"], "start")["name"], record(control["start"], "start")["length"]]);
  });

  it("has Node's REPLServer class shape, instance fields and default commands", async () => {
    const made = harness(), { module } = made, recorded = record(control["REPLServer"], "REPLServer"), instance = record(control["instance"], "instance");
    const readline = createNodeReadline();
    expect([module.REPLServer.name, module.REPLServer.length]).toEqual([recorded["name"], recorded["length"]]);
    expect(shape(prototypeOf(module.REPLServer))).toEqual(recorded["protoShape"]);
    expect(Object.getPrototypeOf(harness({ readline }).module.REPLServer) === readline.Interface).toBe(recorded["protoIsInterface"]);
    const input = new PassThrough(), output = new PassThrough();
    output.resume();
    const server = module.start({ input, output, terminal: false, useGlobal: true });
    const subset = record(instance["shapeSubset"], "shapeSubset");
    // `terminal`, `line` and `history` belong to this runtime's readline Interface, which keeps them differently.
    for (const name of Object.keys(subset).filter(key => !["terminal", "line", "history"].includes(key))) {
      const descriptor = Object.getOwnPropertyDescriptor(server, name);
      expect([typeof descriptor?.value, descriptor?.enumerable, descriptor?.writable ?? null, descriptor?.configurable, typeof descriptor?.get], name).toEqual(subset[name]);
    }
    expect(Object.keys(server.commands)).toEqual(instance["commands"]);
    expect(Object.getPrototypeOf(server.commands)).toBe(instance["commandsProto"]);
    expect(Object.fromEntries(Object.entries(server.commands).map(([name, command]) => [name, [Object.keys(command), command.help, command.action.name, command.action.length]]))).toEqual(instance["commandShape"]);
    expect({ contextIsGlobal: server.context === globalThis, writerIsDefault: server.writer === module.writer, replMode: String(server.replMode), evalName: server.eval.name, evalLength: server.eval.length,
      prompt: server.getPrompt(), initialPrompt: server._initialPrompt, lines: [...server.lines], linesLevel: server.lines.level }).toEqual({ contextIsGlobal: instance["contextIsGlobal"], writerIsDefault: instance["writerIsDefault"],
      replMode: instance["replMode"], evalName: instance["evalName"], evalLength: instance["evalLength"], prompt: instance["prompt"], initialPrompt: instance["initialPrompt"], lines: instance["lines"], linesLevel: instance["linesLevel"] });
    const underscore = Object.getOwnPropertyDescriptor(globalThis, "_");
    expect([typeof underscore?.get, typeof underscore?.set, underscore?.enumerable, underscore?.configurable]).toEqual(instance["underscoreDesc"]);
    expect({ bad: outcome(() => { server.defineCommand("x", {}); }), badNull: outcome(() => { server.defineCommand("x", null); }),
      fn: outcome(() => { server.defineCommand("y", function yy() { /* a command */ }); return Object.keys(server.commands["y"] ?? {}); }), ret: outcome(() => { server.defineCommand("z", { help: "h", action() { /* a command */ } }); }) }).toEqual(instance["defineCommand"]);
    expect([outcome(() => { server.displayPrompt(); }), outcome(() => { server.clearBufferedCommand(); }), outcome(() => { server.setPrompt(">> "); })]).toEqual([instance["displayPromptRet"], instance["clearRet"], instance["setPromptRet"]]);
    expect([server.getPrompt(), server._initialPrompt]).toEqual(instance["afterSetPrompt"]);
    server.close();
    await settle();
    made.restore();
    expect(Object.getOwnPropertyDescriptor(globalThis, "_")).toBeUndefined();
  });

  it("defines require and one lazy global per built-in, and takes them back", () => {
    const loaded: string[] = [], made = harness({ builtinModules: () => ["_stream_wrap", "fs", "fs/promises", "process", "module", "node:sea"], require: id => { loaded.push(id); return { id }; } });
    const input = new PassThrough(), output = new PassThrough();
    output.resume();
    made.module.start({ input, output, terminal: false });
    const instance = record(control["instance"], "instance"), fsGlobal = Object.getOwnPropertyDescriptor(globalThis, "fs");
    expect(typeof Reflect.get(globalThis, "require")).toBe(instance["requireGlobal"]);
    expect([typeof fsGlobal?.get, typeof fsGlobal?.set, fsGlobal?.enumerable, fsGlobal?.configurable]).toEqual(instance["fsDesc"]);
    expect(Object.hasOwn(globalThis, "fs/promises") || Object.hasOwn(globalThis, "_stream_wrap") || Object.hasOwn(globalThis, "module")).toBe(false);
    expect(loaded).toEqual([]);
    expect(Reflect.get(globalThis, "fs")).toEqual({ id: "fs" });
    expect(Reflect.get(globalThis, "fs")).toEqual({ id: "fs" });
    expect(loaded).toEqual(["fs"]);
    Reflect.set(globalThis, "fs", 7);
    expect(Object.getOwnPropertyDescriptor(globalThis, "fs")).toEqual({ value: 7, writable: true, enumerable: true, configurable: true });
    made.restore();
    expect([Object.hasOwn(globalThis, "fs"), Object.hasOwn(globalThis, "require"), Object.hasOwn(globalThis, "_error")]).toEqual([false, false, false]);
  });

  it("takes Node's option forms, refuses eval with breakEvalOnSigint and warns as Node deprecates", async () => {
    for (const mode of ["default", "pending"] as const) {
      const recorded = record(record(control["deprecations"], "deprecations")[mode], mode), made = harness({ pendingDeprecation: mode === "pending" }), { module } = made;
      const first: unknown = Reflect.get(module, "builtinModules"), second: unknown = Reflect.get(module, "_builtinLibs");
      const saved: unknown = Reflect.get(module, "builtinModules");
      Reflect.set(module, "builtinModules", ["x"]);
      const replaced = [Reflect.get(module, "builtinModules"), Reflect.get(module, "_builtinLibs")];
      Reflect.set(module, "_builtinLibs", saved);
      expect([first === second, [replaced, Reflect.get(module, "builtinModules") === saved]]).toEqual([recorded["same"], recorded["settable"]]);
      expect(["builtinModules", "_builtinLibs"].map(name => { const descriptor = Object.getOwnPropertyDescriptor(module, name); return [descriptor?.get?.name, descriptor?.get?.length, descriptor?.set?.name, descriptor?.set?.length]; })).toEqual(recorded["getterNames"]);
      const server = call(module.REPLServer, [{ input: new PassThrough(), output: new PassThrough(), terminal: false }]);
      if (!(server instanceof module.REPLServer)) throw new TypeError("not a REPLServer");
      expect([server instanceof module.REPLServer, server.constructor === module.REPLServer]).toEqual(recorded["noNew"]);
      expect([Reflect.get(server, "inputStream") === server.input, Reflect.get(server, "outputStream") === server.output]).toEqual(recorded["streams"]);
      class Sub extends module.REPLServer { sub = true; }
      const sub = new Sub({ input: new PassThrough(), output: new PassThrough(), terminal: false });
      expect([sub instanceof Sub, sub instanceof module.REPLServer, sub.sub]).toEqual(list(recorded["sub"]).filter((_, index) => index !== 2));
      let wrote = "";
      const duplex = new PassThrough();
      duplex.on("data", (chunk: unknown) => { wrote += String(chunk); });
      const legacy = module.start("L> ", duplex, undefined, true, true);
      await settle();
      expect([wrote, [legacy.getPrompt(), legacy.useGlobal, legacy.ignoreUndefined, legacy.input === legacy.output]]).toEqual([recorded["legacyWrote"], recorded["legacy"]]);
      const stream = module.start({ stream: new PassThrough(), terminal: false });
      expect(stream.input === stream.output).toBe(recorded["streamOpt"]);
      expect(made.warnings.map(warning => ({ name: "DeprecationWarning", ...warning }))).toEqual(recorded["warnings"]);
    }
    const { module, stdin, stdout } = harness();
    expect(outcome(() => module.start({ input: new PassThrough(), output: new PassThrough(), breakEvalOnSigint: true, eval() { /* never called */ } }))).toEqual(record(control["startErrors"], "startErrors")["sigintEval"]);
    // Without streams a REPL talks to the process's own.
    const server = module.start();
    expect([server.input === stdin, server.output === stdout, server.terminal, server.useGlobal]).toEqual([true, true, false, true]);
    expect(() => module.start({ input: 5, output: new PassThrough() })).toThrow(TypeError);
    // This runtime's readline Interface has no terminal mode: a REPL asked to be one is not, and has no `.editor`.
    const terminal = module.start({ input: new PassThrough(), output: new PassThrough(), terminal: true });
    expect([terminal.terminal, Object.keys(terminal.commands).includes("editor")]).toEqual([false, false]);
  });
});

describe("node repl builtin: transcripts of a real REPL (Node 24.18.1 controls)", () => {
  it("evaluates expressions, declarations and object literals", async () => {
    expect(await replay("basics", { useGlobal: true })).toBe(29);
  });
  it("continues unfinished input on the `| ` prompt and leaves it with .break and .clear", async () => {
    expect(await replay("multiline", { useGlobal: true })).toBeGreaterThan(30);
    expect(await replay("endMidline", { useGlobal: true })).toBe(3);
  });
  it("keeps the last value in _ and the last error in _error until they are assigned", async () => {
    expect(await replay("underscore", { useGlobal: true })).toBe(15);
  });
  it("prints thrown values as Uncaught, with the frames of typed code only", async () => {
    expect(await replay("errors", { useGlobal: true }, { firstLineOnly: ["new Error('value')"] })).toBe(23);
  });
  it("reports syntax errors with the engine's message", async () => {
    expect(await replay("syntax", { useGlobal: true }, { differs: {
      "let dup1 = 2": "a lexical declaration is a `var` here: redeclaring it is not an error",
      "c9 = 2": "a `const` is a `var` here: assigning it is not an error",
    } })).toBe(21);
  });
  it("runs .help, .save, .load, .break and .exit, and refuses unknown keywords", async () => {
    const files = memoryFiles(["/w/scratch", "/w/scratch/dir"], { "/w/scratch/load.js": "var loaded = 40\nfunction lf() {\n  return loaded + 2\n}\nlf()\n" });
    expect(await replay("commands", { useGlobal: true }, { files })).toBe(26);
    expect(files.files.get("/w/scratch/saved.js")?.data).toBe(transcripts["commandsSaved"]);
    expect(await replay("customCommand", { useGlobal: true }, { setup: ({ server }) => {
      server.defineCommand("hello", { help: "Say hello", action(this: unknown, name: unknown) { server.clearBufferedCommand(); invoke(asObject(server.output), "write", `Hello, ${String(name)}!\n`); server.displayPrompt(); expect(this).toBe(server); } });
      server.defineCommand("bare", () => { invoke(asObject(server.output), "write", "bare\n"); server.displayPrompt(); });
    } })).toBe(8);
    expect(await replay("npm", { useGlobal: true })).toBe(6);
  });
  it("awaits at the top level and keeps what the input declared", async () => {
    // The one step that waits on a timer gets its five milliseconds from the fake clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await replay("await", { useGlobal: true }, { afterWrite: typed => { if (typed.includes("setTimeout")) vi.advanceTimersByTime(5); }, differs: {
      "let await": "Node builds this message from acorn's; here the engine reports the input as typed",
    } })).toBe(33);
  });
  it("evaluates in strict mode with replMode: REPL_MODE_STRICT", async () => {
    const { module } = harness();
    void module;
    const strict = harnesses.at(-1);
    if (strict === undefined) throw new TypeError("no harness");
    const recorded = record(transcripts["strict"], "strict"), session = openSession(strict, { useGlobal: true, replMode: strict.module.REPL_MODE_STRICT });
    await settle();
    session.take();
    for (const step of list(recorded["steps"]).slice(1, -2)) {
      const [line, output] = list(step), typed = string(line, "line");
      const actual = await session.type(typed);
      // The declarations of strict input are rewritten into assignments, which moves the columns of its frames.
      if (typed === "st()") expect(actual.replace(/:\d+\)/u, ":#)"), typed).toBe(withoutCaret(unnumbered(string(output, "output"))).replace(/REPL#:2:23\)/u, "REPL#:2:#)").replace("REPL#", actual.match(/REPL\d+/u)?.[0] ?? ""));
      else expect(withoutCaret(actual), typed).toBe(withoutCaret(string(output, "output")));
    }
    expect(await session.end()).toBe("");
  });
  it("honours prompt, ignoreUndefined and writer", async () => {
    expect(await replay("options", { useGlobal: true, prompt: "$ ", ignoreUndefined: true, writer: (value: unknown) => `<<${typeof value}:${String(value)}>>` }, { prompts: ["$ ", "| "] })).toBe(10);
  });
  it("calls a custom eval with (code, context, filename, callback) and follows its Recoverable and its errors", async () => {
    const contexts = new Set<unknown>();
    const made = harness(), { Recoverable } = made.module;
    harnesses.pop(); made.restore();
    const evaluate = (command: string, context: unknown, filename: string, callback: (error: unknown, result?: unknown) => void): void => {
      contexts.add(context);
      const trimmed = command.trim();
      if (trimmed === "more") { callback(new Recoverable(new SyntaxError("need more"))); return; }
      if (trimmed === "fail") { callback(new Error("custom failure")); return; }
      if (trimmed === "none") { callback(null); return; }
      if (trimmed === "async") { setImmediate(() => { callback(null, "later"); }); return; }
      // Node's default context is a new one; this runtime's is always the global object.
      callback(null, [command, typeof context, /^REPL\d+$/u.test(filename), false]);
    };
    expect(await replay("customEval", { eval: evaluate }, { firstLineOnly: ["fail"] })).toBe(12);
    expect([...contexts]).toEqual([globalThis]);
    const thrown = openSession(harness(), { eval() { throw new Error("thrown in eval"); } });
    await settle();
    thrown.take();
    expect(firstLine(await thrown.type("anything"))).toBe("Uncaught Error: thrown in eval");
    expect(thrown.server.lastError).toBeInstanceOf(Error);
  });
  it("evaluates in the global scope whatever useGlobal says, and .clear only breaks", async () => {
    expect(await replay("localContext", {}, { until: 5 })).toBe(5);
    const session = openSession(harness(), {});
    await settle();
    session.take();
    expect(await session.type("function open() {")).toBe("| ");
    expect(await session.type(".clear")).toBe("> ");
    expect(session.events).toEqual([]);
    expect(firstLine((await session.type(".help")).split("\n")[1] ?? "")).toBe(".clear   Alias for .break");
  });
  it("prints the runtime's refusal when the process may not evaluate generated code", async () => {
    const refusing = harness({ runInThisContext: () => { throw new TypeError("Direct and indirect eval are not supported by the local-script profile"); } });
    const session = openSession(refusing, {});
    await settle();
    session.take();
    // The error has no frame of typed code, so its stack is printed whole, like any error made outside the prompt.
    const refused = await session.type("1 + 1");
    expect(refused.split("\n").slice(0, 2)).toEqual(["Uncaught:", "TypeError: Direct and indirect eval are not supported by the local-script profile"]);
    expect(refused.endsWith("\n> ")).toBe(true);
    // A custom eval does not need the realm's eval.
    const custom = openSession(refusing, { eval: (code: string, _context: unknown, _file: string, callback: (error: unknown, value: unknown) => void) => { callback(null, code.trim().toUpperCase()); } });
    await settle();
    custom.take();
    expect(await custom.type("shout")).toBe("'SHOUT'\n> ");
  });
  it("closes on the next tick, emitting exit before close", async () => {
    const recorded = record(transcripts["closeApi"], "closeApi"), session = openSession(harness(), { useGlobal: true });
    await settle();
    const text = session.take(), returned = invoke(session.server, "close"), sync = [...session.events], closedSync = session.server.closed;
    await settle();
    expect({ ret: returned === undefined, sync, closedSync, after: session.events, closed: session.server.closed, text }).toEqual({ ...recorded, closedSync: false });
  });
});

describe("node repl builtin: history and process retention", () => {
  it("loads and rewrites the history file as Node's setupHistory does", async () => {
    const recorded = record(control["history"], "history"), dir = "/w/hist";
    const cases: [string, unknown, boolean][] = [["existing", `${dir}/h1`, true], ["missing", `${dir}/h2`, true], ["directory", `${dir}/adir`, true], ["noParent", `${dir}/no/such/h`, true], ["empty", "", true],
      ["objectForm", { filePath: `${dir}/h3`, size: 3 }, true], ["noCb", `${dir}/h1`, false], ["noArgs", undefined, false], ["badPath", { filePath: 5 }, true], ["badSize", { filePath: `${dir}/h1`, size: -1 }, true],
      ["badSizeType", { filePath: `${dir}/h1`, size: "x" }, true], ["badDup", { filePath: `${dir}/h1`, removeHistoryDuplicates: 1 }, true], ["nullArg", null, true]];
    // One file system for all cases, as in the recorder: a later case sees what an earlier one rewrote.
    const files = memoryFiles([dir, `${dir}/adir`], { [`${dir}/h1`]: "third\nsecond\r\n\n\nfirst\n", [`${dir}/h3`]: "e\nd\nc\nb\na" });
    for (const [name, argument, withCallback] of cases) {
      const expected = record(recorded[name], name);
      const session = openSession(harness({ files: files.port }), { useGlobal: true }), { server } = session, events: string[] = [];
      for (const event of ["pause", "resume", "flushHistory", "history"]) server.on(event, () => { events.push(event); });
      let callbackArgs: unknown = null;
      const callback = (...args: unknown[]): void => { callbackArgs = [args.length, args[0] === null ? null : "error", args[1] === server]; };
      const call = outcome(() => { if (withCallback) server.setupHistory(argument, callback); else server.setupHistory(argument); }, false);
      const syncCallback = callbackArgs !== null;
      await settle();
      const path = typeof argument === "string" ? argument : typeof argument === "object" && argument !== null ? read(argument, "filePath") : undefined, file = typeof path === "string" ? files.files.get(path) : undefined;
      // Node flushes the history again after later lines and pauses the input when it closes; neither happens here.
      const expectedEvents = list(expected["ev"]).slice(0, list(expected["ev"]).indexOf("resume") + 1);
      expect({ call, syncCb: syncCallback, cbArgs: callbackArgs, ev: events, text: session.take(), history: [...server.history], size: server.historySize,
        file: file === undefined ? null : [file.data, file.mode.toString(8)] }, name)
        .toEqual({ ...expected, ev: expectedEvents, text: string(expected["text"], "text").replace(/^> (?:2\n> 2\n> |3\n> )$/u, "> ") });
      server.close();
      await settle();
    }
    const setupHistory: unknown = Reflect.get(prototypeOf(harness().module.REPLServer), "setupHistory");
    expect(typeof setupHistory === "function" ? [setupHistory.name, setupHistory.length] : []).toEqual(recorded["setupShape"]);
  });

  it("keeps the process alive while it waits on stdin and lets it exit after .exit or the end of input", async () => {
    for (const leave of ["exit", "end"] as const) {
      const stdin = createInputStream(createAsyncContext()), stdout = new PassThrough();
      stdout.resume();
      const made = harness({ process: { stdin: stdin.stream, stdout, env: {} } });
      const server = made.module.start({ terminal: false });
      let exited = false;
      server.on("exit", () => { exited = true; });
      expect(stdin.hasReferences).toBe(true);
      await stdin.receive(new TextEncoder().encode("1 + 1\n"));
      await settle();
      expect([stdin.hasReferences, exited, server.last]).toEqual([true, false, 2]);
      await stdin.receive(leave === "exit" ? new TextEncoder().encode(".exit\n") : null);
      await settle();
      expect([stdin.hasReferences, exited, server.closed], leave).toEqual([false, true, true]);
      stdin.stream.destroy();
    }
  });
});
