import { EventEmitter } from "./node-streams.ts";
import { createReadlineCallbacks, createReadlineTransaction, type NextTick, type ReadlineCallbacks, type ReadlineTransaction } from "./node-readline-callbacks.ts";
import { createEmitKeypressEvents, type KeypressTimers } from "./node-readline-keys.ts";
import { named, validateAbortSignal } from "./node-util-validators.ts";

interface ReadableLike { on(event: string, listener: (...args: unknown[]) => void): unknown; pause?(): unknown; resume?(): unknown }
interface WritableLike { write(chunk: unknown): unknown }

function isReadable(value: unknown): value is ReadableLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "on") === "function";
}
function isWritable(value: unknown): value is WritableLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "write") === "function";
}
function text(value: unknown): string {
  return typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
}

/** `readline.createInterface` over the runtime's streams: input chunks are
 * split at `\n`, `\r\n` and `\r`; `line`, `close`, `pause` and `resume` events,
 * `question`, `prompt`, `setPrompt`, `write` and `close` follow Node. The
 * interface is never a terminal in the assisted process. */
/** The members both readline interfaces share: the runtime's EventEmitter plus
 * Node's methods. Declared explicitly so the exported factory's classes keep
 * their private state out of the emitted declarations. */
interface ReadlineInterfaceMembers {
  readonly terminal: boolean;
  line: string;
  readonly closed: boolean;
  setPrompt(prompt: unknown): void;
  getPrompt(): string;
  prompt(): void;
  write(data: unknown): void;
  pause(): this;
  resume(): this;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<string, undefined>;
}
type ReadlineInterfaceBase = InstanceType<typeof EventEmitter> & ReadlineInterfaceMembers;
/** `readline.Interface`: `question` answers through a callback. */
export type ReadlineInterface = ReadlineInterfaceBase & { question(query: unknown, options?: unknown, callback?: unknown): void };
/** `readline/promises.Interface`: `question` answers through a promise, rejected with an AbortError when `options.signal` aborts. */
export type ReadlinePromisesInterface = ReadlineInterfaceBase & { question(query: unknown, options?: unknown): Promise<string> };
/** The `readline/promises` module, also `readline.promises`. */
export interface NodeReadlinePromises {
  readonly Interface: new (input?: unknown, output?: unknown, completer?: unknown, terminal?: unknown) => ReadlinePromisesInterface;
  readonly Readline: new (stream: unknown, ...rest: unknown[]) => ReadlineTransaction;
  readonly createInterface: (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown) => ReadlinePromisesInterface;
}
export interface NodeReadline extends ReadlineCallbacks {
  readonly Interface: new (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown) => ReadlineInterface;
  readonly createInterface: (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown) => ReadlineInterface;
  readonly emitKeypressEvents: (stream: unknown, iface?: unknown) => void;
  readonly promises: NodeReadlinePromises;
}
/** What the process owner lends the module. Without it, callbacks wait a microtask and the escape timeout uses the
 * global timers as they are when a key arrives. */
export interface NodeReadlineDependencies {
  readonly nextTick?: NextTick;
  readonly timers?: KeypressTimers;
}

function globalTimers(): KeypressTimers {
  return { setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay), clearTimeout: handle => { if (typeof handle === "number" || handle === undefined) globalThis.clearTimeout(handle); else Reflect.apply(globalThis.clearTimeout, globalThis, [handle]); } };
}
function abortError(cause: unknown): Error {
  return Object.assign(new Error("The operation was aborted", { cause }), { name: "AbortError", code: "ABORT_ERR" });
}

export function createNodeReadline(dependencies: NodeReadlineDependencies = {}): NodeReadline {
  const nextTick: NextTick = dependencies.nextTick ?? (callback => { queueMicrotask(callback); });
  const timers = dependencies.timers;
  let ask: (rl: InterfaceBase, query: unknown, answer: (line: string) => void) => void;
  let cancel: (rl: InterfaceBase) => void;
  class InterfaceBase extends EventEmitter {
    static {
      ask = (rl, query, answer) => {
        if (rl.#closed) throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
        rl.#output?.write(text(query));
        rl.#question = answer;
      };
      // Node drops the pending question and ends the prompt line.
      cancel = rl => { if (rl.#question === undefined) return; rl.#question = undefined; rl.#output?.write("\r\n"); };
    }
    readonly terminal = false;
    #buffer = "";
    #prompt: string;
    readonly #input: ReadableLike;
    readonly #output: WritableLike | undefined;
    #closed = false;
    #paused = false;
    #question: ((answer: string) => void) | undefined;
    line = "";
    constructor(input: unknown, output?: unknown, completer?: unknown, terminal?: unknown) {
      super();
      void completer; void terminal;
      // Node takes either one options object or the legacy positional arguments.
      const options = typeof input === "object" && input !== null && Boolean(Reflect.get(input, "input"));
      const record = options ? input : { input, output };
      const source: unknown = Reflect.get(record, "input");
      if (!isReadable(source)) throw Object.assign(new TypeError("The \"input\" argument must be a readable stream"), { code: "ERR_INVALID_ARG_TYPE" });
      this.#input = source;
      const sink: unknown = Reflect.get(record, "output");
      this.#output = isWritable(sink) ? sink : undefined;
      const prompt: unknown = Reflect.get(record, "prompt");
      this.#prompt = typeof prompt === "string" ? prompt : "> ";
      source.on("data", (chunk: unknown) => { this.#feed(text(chunk)); });
      source.on("end", () => { if (this.#buffer !== "") { const last = this.#buffer; this.#buffer = ""; this.#emitLine(last); } this.close(); });
      source.on("error", (error: unknown) => { this.emit("error", error); });
    }
    #feed(text: string): void {
      this.#buffer += text;
      for (;;) {
        const match = /\r\n|\n|\r/u.exec(this.#buffer);
        if (match === null) break;
        const line = this.#buffer.slice(0, match.index);
        this.#buffer = this.#buffer.slice(match.index + match[0].length);
        this.#emitLine(line);
      }
    }
    #emitLine(line: string): void {
      if (this.#closed) return;
      const question = this.#question;
      if (question !== undefined) { this.#question = undefined; question(line); return; }
      this.emit("line", line);
    }
    setPrompt(prompt: unknown): void { this.#prompt = text(prompt); }
    getPrompt(): string { return this.#prompt; }
    prompt(): void { this.#output?.write(this.#prompt); }
    write(data: unknown): void { this.#feed(text(data)); }
    pause(): this { if (!this.#paused) { this.#paused = true; this.#input.pause?.(); this.emit("pause"); } return this; }
    resume(): this { if (this.#paused) { this.#paused = false; this.#input.resume?.(); this.emit("resume"); } return this; }
    close(): void { if (this.#closed) return; this.#closed = true; this.#question = undefined; this.emit("close"); }
    get closed(): boolean { return this.#closed; }
    [Symbol.asyncIterator](): AsyncIterator<string, undefined> {
      const queue: string[] = []; let waiting: ((result: IteratorResult<string, undefined>) => void) | undefined; let done = false;
      const settle = (result: IteratorResult<string, undefined>): void => { const wake = waiting; waiting = undefined; wake?.(result); };
      this.on("line", (line: unknown) => { if (typeof line !== "string") return; if (waiting !== undefined) settle({ value: line, done: false }); else queue.push(line); });
      this.on("close", () => { done = true; settle({ value: undefined, done: true }); });
      return { next: () => {
        const line = queue.shift();
        if (line !== undefined) return Promise.resolve({ value: line, done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { waiting = resolve; });
      } };
    }
  }
  class Interface extends InterfaceBase {
    // Declared so `Interface.length` is 4, as Node's legacy positional constructor has it.
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(input: unknown, output?: unknown, completer?: unknown, terminal?: unknown) { super(input, output, completer, terminal); }
    question(query: unknown, options?: unknown, callback?: unknown): void {
      if (typeof options === "function") callback = options;
      if (typeof callback !== "function") throw Object.assign(new TypeError("The \"callback\" argument must be of type function"), { code: "ERR_INVALID_ARG_TYPE" });
      const answer = callback;
      ask(this, query, value => { Reflect.apply(answer, undefined, [value]); });
    }
  }
  class PromisesInterface extends InterfaceBase {
    question(query: unknown, options: unknown = {}): Promise<string> {
      return new Promise((resolve, reject) => {
        const signal: unknown = typeof options === "object" && options !== null || typeof options === "function" ? Reflect.get(options, "signal") : undefined;
        const hasSignal = Boolean(signal);
        if (!hasSignal) { ask(this, query, resolve); return; }
        validateAbortSignal(signal, "options.signal");
        if (signal.aborted) { reject(abortError(signal.reason)); return; }
        const onAbort = (): void => { cancel(this); reject(abortError(signal.reason)); };
        signal.addEventListener("abort", onAbort, { once: true });
        ask(this, query, answer => { signal.removeEventListener("abort", onAbort); resolve(answer); });
      });
    }
  }
  named(Interface, "Interface");
  named(PromisesInterface, "Interface");
  const createInterface = (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown): ReadlineInterface => new Interface(input, output, completer, terminal);
  const createPromisesInterface = (input: unknown, output?: unknown, completer?: unknown, terminal?: unknown): ReadlinePromisesInterface => new PromisesInterface(input, output, completer, terminal);
  const promises: NodeReadlinePromises = Object.freeze({ Interface: PromisesInterface, Readline: createReadlineTransaction(nextTick), createInterface: named(createPromisesInterface, "createInterface") });
  return Object.freeze({ Interface, createInterface: named(createInterface, "createInterface"), ...createReadlineCallbacks(nextTick),
    emitKeypressEvents: createEmitKeypressEvents(() => timers ?? globalTimers()), promises });
}

/** The `readline/promises` module of a process: the very object its `readline.promises` is, as in Node. */
export function createNodeReadlinePromises(readline: NodeReadline): NodeReadlinePromises { return readline.promises; }
