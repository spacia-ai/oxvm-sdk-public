/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/process/per_thread.js (cpuUsage, threadCpuUsage, resourceUsage,
 * ref, unref, loadEnvFile), lib/internal/process/execution.js (setUncaughtExceptionCaptureCallback) and
 * lib/internal/bootstrap/node.js.
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

import { invalidArgType, type Inspect } from "./node-arg-type.js";
import { unavailableNodeApi } from "./node-capability.js";
import { parseDotenv } from "./node-dotenv.js";
import { createEnvironmentFlags } from "./node-process-environment-flags.js";
import { createFinalization, type FinalizationHost } from "./node-process-finalization.js";
import { nodeUtil } from "./node-util.js";

/** `process.versions` of Node.js 24.18.1 (node:24.18.1-alpine), in Node's order. `node-process-extras.test.ts` keeps it
 * equal to the recorded controls. */
export const NODE_24_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  node: "24.18.1", acorn: "8.16.0", ada: "3.4.4", amaro: "1.1.9", ares: "1.34.6", brotli: "1.2.0", cldr: "48.0", icu: "78.3", llhttp: "9.4.3",
  merve: "1.2.2", modules: "137", napi: "10", nbytes: "0.1.4", ncrypto: "0.0.1", nghttp2: "1.69.0", nghttp3: "", ngtcp2: "", openssl: "3.5.7",
  simdjson: "4.6.4", simdutf: "6.4.0", sqlite: "3.53.1", tz: "2026b", undici: "7.29.0", unicode: "17.0", uv: "1.52.1", uvwasi: "0.0.23",
  v8: "13.6.233.17-node.50", zlib: "1.3.1-e00f703", zstd: "1.5.7",
});

/** `process.release` of the same build: the musl build the guest image runs comes from unofficial-builds.nodejs.org. */
export const NODE_24_RELEASE = Object.freeze({
  name: "node", lts: "Krypton",
  sourceUrl: "https://unofficial-builds.nodejs.org/download/release/v24.18.1/node-v24.18.1.tar.gz",
  headersUrl: "https://unofficial-builds.nodejs.org/download/release/v24.18.1/node-v24.18.1-headers.tar.gz",
});

/** The process these properties are defined on. Each member is read when it is used, so a program's replacement counts. */
export interface ProcessExtrasHost extends FinalizationHost {
  readonly env: Record<string, string | undefined>;
}

export interface ProcessExtrasPorts {
  readonly process: ProcessExtrasHost;
  /** The process's monotonic clock in milliseconds since it started (the one behind `process.uptime`). */
  readonly now: () => number;
  /** Linux's memory, in bytes: `os.totalmem()` and `os.freemem()`. `constrained` is a cgroup limit, when Linux reports one. */
  readonly memory: () => { readonly total: number; readonly free: number; readonly constrained?: number };
  /** The main CommonJS module, or undefined when the entry is an ES module. */
  readonly mainModule: () => unknown;
  /** `fs.readFileSync(path, "utf8")` of the process, relative to its working directory. */
  readonly readFile: (path: string) => string;
  readonly format: (...values: unknown[]) => string;
  /** Writes to the process's standard error. */
  readonly writeError: (text: string) => void;
  /** Delivers an uncaught exception; true when the program handled it. */
  readonly fatal: (error: unknown) => boolean;
  /** Sends a signal through Linux. Returns nothing or 0 when sent, a negative errno otherwise. */
  readonly kill?: (pid: number, signal: number) => number | undefined;
  /** What keeps the event loop alive, by Node's resource names (`Timeout`, `TCPSocketWrap`, ...). */
  readonly activeResources?: () => string[];
  readonly release?: Readonly<Record<string, string>>;
  readonly inspect?: Inspect;
}

/** Node's `determineSpecificType` wording for a property (`prevValue.user`) rather than an argument. */
function propertyType(name: string, expected: string, value: unknown, inspect: Inspect): TypeError {
  const error = invalidArgType(name, expected, value, inspect);
  error.message = error.message.replace(`The "${name}" argument`, `The "${name}" property`);
  return error;
}
function named<Callable extends (...args: never[]) => unknown>(name: string, callable: Callable): Callable {
  // Production code is minified; programs read these names.
  return Object.defineProperty(callable, "name", { value: name });
}

/**
 * The parts of Node.js 24.18.1's `process` that need nothing from Linux beyond the given ports. Define `descriptors` on
 * the process object; `captureCallback` is what `process.setUncaughtExceptionCaptureCallback` last stored.
 */
export function createProcessExtras(ports: ProcessExtrasPorts) {
  const process = ports.process;
  const inspect: Inspect = ports.inspect ?? ((value, options) => nodeUtil.inspect(value, options));
  const show = (value: unknown): string => nodeUtil.inspect(value);

  // title and debugPort are native accessors in Node that report themselves as data properties; here they are
  // plain accessors. The title is kept in the worker: Linux's process name is not changed.
  let title = "node", debugPort = 9229;
  let mainModule: { readonly value: unknown } | undefined;

  /**
   * The worker has no Linux CPU clock for this process. CPU time is approximated by the time the process has existed:
   * all of it is reported as user time and none as system time, so differences between two calls are elapsed time.
   */
  const cpuMicroseconds = (): number => Math.floor(ports.now() * 1000);
  const previousValueIsValid = (value: unknown): value is number => typeof value === "number" && value <= Number.MAX_SAFE_INTEGER && value >= 0;
  function cpuTimes(previous: unknown): { user: number; system: number } {
    const user = cpuMicroseconds(), system = 0;
    // Node takes any truthy value for a previous reading and checks its two numbers.
    const given = Boolean(previous);
    if (!given) return { user, system };
    const boxed: unknown = Object(previous);
    const prior = (key: "user" | "system"): number => {
      const value: unknown = typeof boxed === "object" && boxed !== null || typeof boxed === "function" ? Reflect.get(boxed, key) : undefined;
      if (previousValueIsValid(value)) return value;
      if (key === "user" && (typeof previous !== "object" || Array.isArray(previous))) throw invalidArgType("prevValue", "object", previous, inspect);
      if (typeof value !== "number") throw propertyType(`prevValue.${key}`, "number", value, inspect);
      throw Object.assign(new RangeError(`The property 'prevValue.${key}' is invalid. Received ${show(value)}`), { code: "ERR_INVALID_ARG_VALUE" });
    };
    const priorUser = prior("user"), priorSystem = prior("system");
    return { user: user - priorUser, system: system - priorSystem };
  }
  const cpuUsage = named("cpuUsage", (prevValue?: unknown) => cpuTimes(prevValue));
  const threadCpuUsage = named("threadCpuUsage", (prevValue?: unknown) => cpuTimes(prevValue));
  /** Only the CPU time is known (see above); Linux's other counters for this process are not available and read 0. */
  const resourceUsage = named("resourceUsage", () => ({
    userCPUTime: cpuMicroseconds(), systemCPUTime: 0, maxRSS: 0, sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0,
    minorPageFault: 0, majorPageFault: 0, swappedOut: 0, fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0, signalsCount: 0,
    voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
  }));

  /** libuv: the cgroup limit when there is one below the total, and Linux's available memory otherwise. */
  const constrainedMemory = named("constrainedMemory", (): number => ports.memory().constrained ?? 0);
  const availableMemory = named("availableMemory", (): number => {
    const { total, free, constrained = 0 } = ports.memory();
    return constrained > 0 && constrained <= total ? Math.max(0, Math.min(free, constrained)) : free;
  });

  function toggle(target: unknown, symbol: symbol, method: "ref" | "unref"): void {
    if (target === undefined || target === null) return;
    const boxed: unknown = Object(target);
    if (typeof boxed !== "object" && typeof boxed !== "function" || boxed === null) return;
    const preferred: unknown = Reflect.get(boxed, symbol), fallback: unknown = Reflect.get(boxed, method);
    const hasPreferred = Boolean(preferred), selected = hasPreferred ? preferred : fallback;
    if (typeof selected === "function") Reflect.apply(selected, target, []);
  }
  const ref = named("ref", (maybeRefable?: unknown): void => { toggle(maybeRefable, Symbol.for("nodejs.ref"), "ref"); });
  const unref = named("unref", (maybeUnrefable?: unknown): void => { toggle(maybeUnrefable, Symbol.for("nodejs.unref"), "unref"); });

  let capture: ((error: unknown) => void) | undefined;
  const setUncaughtExceptionCaptureCallback = named("setUncaughtExceptionCaptureCallback", (fn?: unknown): void => {
    if (fn === null) { capture = undefined; return; }
    if (typeof fn !== "function") throw invalidArgType("fn", "function or null", fn, inspect);
    if (capture !== undefined) {
      throw Object.assign(new Error("`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active"), { code: "ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET" });
    }
    capture = (error: unknown): void => { Reflect.apply(fn, undefined, [error]); };
  });
  const hasUncaughtExceptionCaptureCallback = named("hasUncaughtExceptionCaptureCallback", (): boolean => capture !== undefined);

  function envPath(path: unknown): string {
    let text: unknown = path;
    if (path instanceof URL) {
      if (path.protocol !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
      text = decodeURIComponent(path.pathname);
    } else if (path instanceof Uint8Array) text = new TextDecoder().decode(path);
    if (typeof text !== "string") throw invalidArgType("path", "string or an instance of Buffer or URL", path, inspect);
    if (text.includes("\0")) {
      throw Object.assign(new TypeError(`The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ${show(path)}`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    return text;
  }
  /** A variable the environment already has keeps its value, as in Node. */
  const loadEnvFile = named("loadEnvFile", (...args: unknown[]): void => {
    const path = args[0] === undefined || args[0] === null ? ".env" : envPath(args[0]);
    let content: string;
    try { content = ports.readFile(path); }
    catch (error) {
      // Node reads the path itself and reports anything it cannot read as text this way; a missing file stays ENOENT.
      if (error instanceof Error && "code" in error && error.code === "EISDIR") throw Object.assign(new TypeError(`Contents of '${path}' should be a valid string.`), { code: "ERR_INVALID_ARG_TYPE" });
      throw error;
    }
    const env = process.env;
    for (const [key, value] of Object.entries(parseDotenv(content))) if (!Object.hasOwn(env, key)) env[key] = value;
  });

  const openStdin = named("", (): unknown => {
    const stdin: unknown = Reflect.get(process, "stdin");
    const resume: unknown = typeof stdin === "object" && stdin !== null ? Reflect.get(stdin, "resume") : undefined;
    if (typeof resume !== "function") throw new TypeError("process.stdin.resume is not a function");
    Reflect.apply(resume, stdin, []);
    return stdin;
  });
  const rawDebug = named("_rawDebug", (...args: unknown[]): void => { ports.writeError(`${ports.format(...args)}\n`); });
  /** Node runs its next-tick queue here; this process's scheduler drains its own. */
  const tickCallback = named("runNextTicks", (): void => undefined);
  // The second parameter is Node's `fromPromise`; the origin is the port's to decide.
  const fatalException = Object.defineProperty(named("", (error?: unknown): boolean => ports.fatal(error)), "length", { value: 2 });
  /** Node's binding: no validation, both arguments as 32-bit integers, and the result is 0 or a negative errno. */
  const kill = named("_kill", (...args: unknown[]): number => {
    if (ports.kill === undefined) return unavailableNodeApi("process._kill");
    return ports.kill(Number(args[0]) | 0, Number(args[1]) | 0) ?? 0;
  });
  const getActiveResourcesInfo = named("getActiveResourcesInfo", (): string[] => [...(ports.activeResources?.() ?? [])]);
  /** Node returns its internal handle and request objects; this process has none to show. */
  const getActiveHandles = named("_getActiveHandles", (): unknown[] => []);
  const getActiveRequests = named("_getActiveRequests", (): unknown[] => []);

  /** Node's lazy accessors. `finalization` stays an accessor whose value an assignment replaces;
   * `allowedNodeEnvironmentFlags` becomes a data property on its first read or assignment. */
  function lazy(name: string, build: () => unknown, replace: "value" | "property"): PropertyDescriptor {
    let current: { value: unknown } | undefined;
    const settle = (target: unknown, value: unknown): void => {
      current = { value };
      if (replace === "property" && typeof target === "object" && target !== null) Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: true });
    };
    return {
      enumerable: true, configurable: true,
      get: named("get", function (this: unknown): unknown {
        if (current === undefined) settle(this, build());
        return current?.value;
      }),
      set: named("set", function (this: unknown, value: unknown): void { settle(this, value); }),
    };
  }
  // Node's release object: not frozen, each property read-only.
  const release: Record<string, string> = {};
  for (const [key, value] of Object.entries(ports.release ?? NODE_24_RELEASE)) Object.defineProperty(release, key, { value, writable: false, enumerable: true, configurable: true });
  const method = (value: unknown): PropertyDescriptor => ({ value, writable: true, enumerable: true, configurable: true });
  const descriptors = {
    release: { value: release, writable: false, enumerable: true, configurable: true },
    title: { enumerable: true, configurable: true, get: (): string => title, set: (value: unknown): void => {
      if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
      title = String(value);
    } },
    debugPort: { enumerable: true, configurable: true, get: (): number => debugPort, set: (value: unknown): void => {
      if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a number");
      const port = Number(value) | 0;
      if ((port !== 0 && port < 1024) || port > 65535) throw Object.assign(new RangeError("process.debugPort must be 0 or in range 1024 to 65535"), { code: "ERR_OUT_OF_RANGE" });
      debugPort = port;
    } },
    // Node defines mainModule as a data property when the main CommonJS module loads; here the loader is asked.
    mainModule: { enumerable: true, configurable: true, get: (): unknown => mainModule === undefined ? ports.mainModule() : mainModule.value, set: (value: unknown): void => { mainModule = { value }; } },
    allowedNodeEnvironmentFlags: lazy("allowedNodeEnvironmentFlags", createEnvironmentFlags, "property"),
    finalization: lazy("finalization", () => createFinalization(process, inspect), "value"),
    // Node lists the internal modules its bootstrap loaded; this runtime has none of them.
    moduleLoadList: { value: [], writable: false, enumerable: true, configurable: true },
    cpuUsage: method(cpuUsage), threadCpuUsage: method(threadCpuUsage), resourceUsage: method(resourceUsage),
    availableMemory: method(availableMemory), constrainedMemory: method(constrainedMemory),
    ref: method(ref), unref: method(unref),
    getActiveResourcesInfo: method(getActiveResourcesInfo), _getActiveHandles: method(getActiveHandles), _getActiveRequests: method(getActiveRequests),
    setUncaughtExceptionCaptureCallback: method(setUncaughtExceptionCaptureCallback), hasUncaughtExceptionCaptureCallback: method(hasUncaughtExceptionCaptureCallback),
    openStdin: method(openStdin), loadEnvFile: method(loadEnvFile),
    _rawDebug: method(rawDebug), _tickCallback: method(tickCallback), _fatalException: method(fatalException), _kill: method(kill),
  } satisfies PropertyDescriptorMap;
  return {
    descriptors,
    /** The callback a program set to receive uncaught exceptions instead of 'uncaughtException', if any. */
    captureCallback: (): ((error: unknown) => void) | undefined => capture,
  };
}
