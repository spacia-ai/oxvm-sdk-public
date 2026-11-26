/*!
 * Portions adapted from Node.js v24.18.1 lib/util.js, lib/internal/util.js and lib/internal/abort_controller.js; modified for OxVM's process owner.
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
import { nodeConstantsModule } from "./node-constants.ts";
import { invalidInstance, invalidValue, named, primitiveText, validateBoolean, validateInteger, validateObject } from "./node-util-validators.ts";

/** One frame of `util.getCallSites()`. */
export interface NodeCallSite {
  functionName: string;
  scriptId: string;
  scriptName: string;
  lineNumber: number;
  columnNumber: number;
  column: number;
}

function sourceMapOption(options: unknown): void {
  validateObject(options, "options");
  const sourceMap: unknown = Reflect.get(options, "sourceMap");
  if (sourceMap !== undefined) validateBoolean(sourceMap, "options.sourceMap");
}
function callSiteValue(site: unknown, method: string): unknown {
  if (typeof site !== "object" || site === null) return undefined;
  const read: unknown = Reflect.get(site, method);
  return typeof read === "function" ? Reflect.apply(read, site, []) : undefined;
}
function describe(site: unknown): NodeCallSite {
  const name = callSiteValue(site, "getFunctionName"), id = callSiteValue(site, "getScriptId"), script = callSiteValue(site, "getScriptNameOrSourceURL") ?? callSiteValue(site, "getFileName");
  const line = callSiteValue(site, "getLineNumber"), column = callSiteValue(site, "getColumnNumber");
  const columnNumber = typeof column === "number" ? column : 0;
  const frame: NodeCallSite = {
    functionName: typeof name === "string" ? name : "",
    // An engine whose stack carries no script identity reports V8's "no script" id.
    scriptId: typeof id === "number" || typeof id === "string" ? String(id) : "0",
    scriptName: typeof script === "string" ? script : "",
    lineNumber: typeof line === "number" ? line : 0, columnNumber, column: columnNumber,
  };
  Object.setPrototypeOf(frame, null);
  return frame;
}

/** `util.getCallSites(frameCount = 10, options?)`: the caller's stack as plain records, read through the realm's
 * `Error.captureStackTrace` (V8's own, or the one `call-sites.ts` installs for other engines). Source maps are not applied. */
export const getCallSites = named(function getCallSites(frameCount: unknown = 10, options?: unknown): NodeCallSite[] {
  let count: unknown = frameCount;
  if (options === undefined) {
    if (typeof frameCount === "object") { sourceMapOption(frameCount); count = 10; }
  } else sourceMapOption(options);
  validateInteger(count, "frameCount", 1, 200);
  const capture: unknown = Reflect.get(Error, "captureStackTrace");
  if (typeof capture !== "function") return [];
  const prepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), limit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  let sites: unknown[] = [];
  try {
    // One more than asked: the first frame is this function.
    Object.defineProperty(Error, "stackTraceLimit", { configurable: true, enumerable: true, writable: true, value: count + 1 });
    Object.defineProperty(Error, "prepareStackTrace", { configurable: true, enumerable: true, writable: true, value: (_error: unknown, frames: unknown): string => {
      if (Array.isArray(frames)) sites = frames;
      return "";
    } });
    const holder = {};
    Reflect.apply(capture, Error, [holder]);
    // V8 formats lazily, on the first read.
    Reflect.get(holder, "stack");
  } finally {
    if (prepare === undefined) Reflect.deleteProperty(Error, "prepareStackTrace"); else Object.defineProperty(Error, "prepareStackTrace", prepare);
    if (limit === undefined) Reflect.deleteProperty(Error, "stackTraceLimit"); else Object.defineProperty(Error, "stackTraceLimit", limit);
  }
  return sites.slice(1, count + 1).map(describe);
}, "getCallSites");

/** Linux signal numbers in the key order of Node's `os.constants.signals`. */
const SIGNALS = new Map<string, number>();
for (const [name, value] of Object.entries(nodeConstantsModule)) if (name.startsWith("SIG") && typeof value === "number") SIGNALS.set(name, value);

/** `util.convertProcessSignalToExitCode(signalCode)`: 128 plus the Linux signal number. */
export const convertProcessSignalToExitCode = named(function convertProcessSignalToExitCode(signalCode: unknown): number {
  const number = typeof signalCode === "string" ? SIGNALS.get(signalCode) : undefined;
  if (number === undefined) throw invalidValue("signalCode", signalCode, `must be one of: ${[...SIGNALS.keys()].map(name => `'${name}'`).join(", ")}`);
  return 128 + number;
}, "convertProcessSignalToExitCode");

/** `util.transferableAbortController()`: no structured-clone transfer exists here, so this is an ordinary controller. */
export const transferableAbortController = named(function transferableAbortController(): AbortController { return new AbortController(); }, "transferableAbortController");

/** `util.transferableAbortSignal(signal)`: the same signal, after Node's type check. */
export const transferableAbortSignal = named(function transferableAbortSignal(signal: unknown): AbortSignal {
  if (!(signal instanceof AbortSignal)) throw invalidInstance("signal", "AbortSignal", signal);
  return signal;
}, "transferableAbortSignal");

/** `util.setTraceSigInt(enable)`: there is no SIGINT watchdog to arm, and Node validates nothing. */
export const setTraceSigInt = named(function setTraceSigInt(enable: unknown): void { void enable; }, "setTraceSigInt");

/** `util._extend(target, source)`, before its DEP0060 wrapper: copies own enumerable keys, last key first. */
export function extend(target: unknown, source: unknown): unknown {
  if (source === null || typeof source !== "object") return target;
  const keys = Object.keys(source);
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index];
    if (key === undefined) continue;
    if (target === null || target === undefined) throw new TypeError(`Cannot set properties of ${String(target)} (setting '${key}')`);
    if (typeof target !== "object" && typeof target !== "function") throw new TypeError(`Cannot create property '${key}' on ${typeof target} '${primitiveText(target)}'`);
    if (!Reflect.set(target, key, Reflect.get(source, key))) throw new TypeError(`Cannot assign to read only property '${key}' of object`);
  }
  return target;
}
named(extend, "_extend");
