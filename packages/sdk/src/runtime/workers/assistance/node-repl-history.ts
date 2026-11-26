import { truthy } from "./node-repl-context.ts";
import { outOfRange, invalidInstance, validateNumber } from "./node-util-validators.ts";

/** The file operations the REPL uses: `.save`, `.load` and the history file. The process's `fs` module serves them. */
export interface ReplFiles {
  readonly readFileSync: (path: string, encoding: "utf8") => unknown;
  readonly writeFileSync: (path: string, data: string, options?: { readonly mode: number }) => unknown;
  readonly statSync: (path: string) => unknown;
}

/** The REPL whose history is set up. */
export interface HistoryHost {
  history: string[];
  historySize: number;
  readonly closed: boolean;
  getPrompt(): string;
  pause(): unknown;
  resume(): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}
export interface HistoryPorts {
  readonly files: ReplFiles;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nextTick: (callback: () => void) => void;
  readonly write: (text: string) => void;
}

const read = (options: object, name: string): unknown => Reflect.get(options, name);

/** `REPLServer.prototype.setupHistory`: loads the history file into `repl.history` and rewrites it, then calls back
 * with `(null, repl)`. Node also calls back with null when the file cannot be opened, after saying so on the output.
 *
 * Node appends a line to the history only in terminal mode, and this REPL is never a terminal (see node-repl.ts), so
 * the file keeps what it had: it is read, cut to `size` entries and written back once, as Node does at start. The
 * file is read and written through the synchronous file port and the callback is delivered on the next tick. */
export function setupReplHistory(repl: HistoryHost, ports: HistoryPorts, config: unknown, callback: unknown): void {
  // A string is the file path; Node assigns the callback onto the options object it was given.
  const options: unknown = typeof config === "string" ? { filePath: config } : config;
  if (typeof callback === "function") {
    if (options === null || options === undefined) throw new TypeError(`Cannot set properties of ${String(options)} (setting 'onHistoryFileLoaded')`);
    const target: unknown = Object(options);
    if (typeof target === "object" && target !== null) Reflect.set(target, "onHistoryFileLoaded", callback);
  }
  if (options === null || options === undefined) throw new TypeError(`Cannot read properties of ${String(options)} (reading 'history')`);
  const settings: unknown = Object(options);
  if (typeof settings !== "object" || settings === null) return;
  const history: unknown = read(settings, "history"), size: unknown = read(settings, "size");
  if (history !== undefined && !Array.isArray(history)) throw invalidInstance("history", "Array", history);
  if (size !== undefined) { validateNumber(size, "size"); if (size < 0 || Number.isNaN(size)) throw outOfRange("size", ">= 0", size); }
  const limit = typeof size === "number" ? size : repl.historySize;
  repl.history = Array.isArray(history) ? history.map(String) : [];
  const loaded: unknown = read(settings, "onHistoryFileLoaded");
  // Node creates the history manager and reads the file only when there is something to call.
  if (!truthy(loaded)) return;
  if (typeof size === "number") repl.historySize = size;
  const ready = (): void => { if (typeof loaded === "function") Reflect.apply(loaded, undefined, [null, repl]); };
  const configured: unknown = read(settings, "filePath");
  let path: unknown = typeof configured === "string" ? configured.trim() : configured;
  // An empty path switches persistent history off.
  if (path === "") { ready(); return; }
  if (!truthy(path)) {
    const home = ports.env["HOME"];
    if (home === undefined || home === "") {
      ports.write("\nError: Could not get the home directory.\nREPL session history will not be persisted.\n");
      ready();
      return;
    }
    path = `${home.replace(/\/+$/u, "")}/.node_repl_history`;
  }
  repl.pause();
  let entries: string[] | undefined;
  try {
    if (typeof path !== "string") throw new TypeError("The history file path must be a string");
    let data: string;
    try { data = String(ports.files.readFileSync(path, "utf8")); }
    catch (error) {
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ENOENT") throw error;
      // History files are conventionally not readable by others.
      ports.files.writeFileSync(path, "", { mode: 0o600 });
      data = "";
    }
    entries = data === "" ? [] : data.split(/\r?\n+/u, limit);
    ports.files.writeFileSync(path, entries.join("\n"));
  } catch { entries = undefined; }
  const failed = entries === undefined;
  if (entries !== undefined) repl.history = entries;
  ports.nextTick(() => {
    if (failed) {
      // Node writes the message and redraws the prompt line, as its readline does after any out-of-band output.
      const prompt = repl.getPrompt();
      ports.write(`\nError: Could not open history file.\nREPL session history will not be persisted.\n\u001b[1G\u001b[0J${prompt}\u001b[${String(prompt.length + 1)}G`);
    } else {
      repl.emit("flushHistory");
      if (repl.closed) return;
    }
    repl.resume();
    ready();
  });
}
