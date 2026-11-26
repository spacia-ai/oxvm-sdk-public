/*!
 * Adapted from Node.js v24.18.1 lib/trace_events.js.
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
import { nodeUtil } from "./node-util.ts";
import { invalidInstance, invalidType, named, validateObject } from "./node-util-validators.ts";

/** A `Tracing` object: a set of categories that is switched on and off as one. */
export interface TracingHandle {
  enable(): void;
  disable(): void;
  readonly enabled: boolean;
  readonly categories: string;
}
export interface NodeTraceEvents {
  readonly createTracing: (options: unknown) => TracingHandle;
  readonly getEnabledCategories: () => string | undefined;
}
export interface NodeTraceEventsDependencies {
  /** `process.emitWarning`, for Node's warning about more than ten enabled Tracing objects. */
  readonly emitWarning?: (message: string) => void;
}

/** What Node throws when `trace_events` is required in a worker thread, where tracing is unavailable. */
export function traceEventsUnavailable(): Error {
  return Object.assign(new Error("Trace events are unavailable"), { code: "ERR_TRACE_EVENTS_UNAVAILABLE" });
}

const customInspect = Symbol.for("nodejs.util.inspect.custom");
const kMaxTracingCount = 10;

function validateStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value)) throw invalidInstance(name, "Array", value);
  value.forEach((item: unknown, index) => { if (typeof item !== "string") throw invalidType(`${name}[${String(index)}]`, "string", item); });
}

/** The `trace_events` built-in of one process. The bookkeeping is Node's: which Tracing objects are enabled and the
 * union of their categories. Nothing is recorded or written anywhere: a browser worker has no trace sink (Node writes
 * `node_trace.*.log` through its tracing agent), so enabling a category changes only what `getEnabledCategories`
 * and `tracing.enabled` report. No category is enabled at start, as in Node without `--trace-event-categories`.
 * Node refuses the module in worker threads (ERR_TRACE_EVENTS_UNAVAILABLE); that is the loader's decision, not this
 * module's. */
export function createNodeTraceEvents(dependencies: NodeTraceEventsDependencies = {}): NodeTraceEvents {
  /** How many enabled Tracing objects hold each category: one stays enabled until every holder is disabled. */
  const holders = new Map<string, number>();
  const enabledObjects = new Set<object>();
  const hold = (categories: ReadonlySet<string>, change: 1 | -1): void => {
    for (const category of categories) {
      const count = (holders.get(category) ?? 0) + change;
      if (count <= 0) holders.delete(category); else holders.set(category, count);
    }
  };
  class Tracing {
    readonly #held: ReadonlySet<string>;
    readonly #categories: readonly string[];
    #enabled = false;
    constructor(categories: unknown) {
      // Node hands the value to its native category set, which aborts the process on anything but an array.
      if (!Array.isArray(categories)) throw invalidInstance("categories", "Array", categories);
      const names: string[] = categories.map((category: unknown) => String(category));
      // The native set does not hold an empty name.
      this.#held = new Set(names.filter(name => name !== ""));
      this.#categories = names;
    }
    enable(): void {
      if (this.#enabled) return;
      this.#enabled = true;
      hold(this.#held, 1);
      enabledObjects.add(this);
      if (enabledObjects.size > kMaxTracingCount) {
        dependencies.emitWarning?.("Possible trace_events memory leak detected. There are more than " + `${String(kMaxTracingCount)} enabled Tracing objects.`);
      }
    }
    disable(): void {
      if (!this.#enabled) return;
      this.#enabled = false;
      hold(this.#held, -1);
      enabledObjects.delete(this);
    }
    get enabled(): boolean { return this.#enabled; }
    get categories(): string { return this.#categories.join(","); }
    [customInspect](depth: unknown, options: unknown): unknown {
      // Node's method takes the inspection options and does not use them.
      void options;
      if (typeof depth === "number" && depth < 0) return this;
      return `Tracing ${nodeUtil.format({ enabled: this.enabled, categories: this.categories })}`;
    }
  }
  named(Tracing, "Tracing");
  function createTracing(options: unknown): TracingHandle {
    validateObject(options, "options");
    const categories: unknown = Reflect.get(options, "categories");
    validateStringArray(categories, "options.categories");
    if (categories.length <= 0) throw Object.assign(new TypeError("At least one category is required"), { code: "ERR_TRACE_EVENTS_CATEGORY_REQUIRED" });
    return new Tracing(categories);
  }
  /** Node joins its native set, which is ordered by the categories' bytes; an empty answer is `undefined`. */
  function getEnabledCategories(): string | undefined {
    const joined = [...holders.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).join(",");
    return joined === "" ? undefined : joined;
  }
  return { createTracing: named(createTracing, "createTracing"), getEnabledCategories: named(getEnabledCategories, "getEnabledCategories") };
}
