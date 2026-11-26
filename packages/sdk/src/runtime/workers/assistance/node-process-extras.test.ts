import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { record } from "../../decode.js";
import { NodeProcess } from "./node-process.js";
import { NODE_24_ENVIRONMENT_FLAGS } from "./node-process-environment-flags.js";
import { createProcessExtras, NODE_24_RELEASE, NODE_24_VERSIONS, type ProcessExtrasPorts } from "./node-process-extras.js";
import { nodeUtil } from "./node-util.js";

// Recorded from `docker run --rm -i node:24.18.1-alpine node --no-warnings -`.
const control = record(JSON.parse(readFileSync(new URL("./node-process-extras.controls.json", import.meta.url), "utf8")), "process controls");
const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new TypeError("not a list"); return value; };

function failure(run: () => unknown): unknown {
  try { run(); return null; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const code: unknown = Reflect.get(error, "code");
    return { name: error.name, code: code ?? null, message: error.message };
  }
}

function setup(overrides: Partial<ProcessExtrasPorts> = {}) {
  const warnings: unknown[][] = [], errors: string[] = [];
  let clock = 1500.25;
  const env: Record<string, string | undefined> = { PATH: "/bin" };
  const host = Object.assign(new NodeProcess(() => { throw new Error("terminated"); }, "24.18.1"), { env });
  host.on("warning", (...args) => { warnings.push(args); });
  const extras = createProcessExtras({
    process: host, now: () => clock, memory: () => ({ total: 4096, free: 1024 }), mainModule: () => undefined,
    readFile: () => { throw new Error("unexpected read"); }, format: (...values) => nodeUtil.format(...values), writeError: text => { errors.push(text); },
    fatal: () => false, ...overrides,
  });
  Object.defineProperties(host, extras.descriptors);
  const read = (name: string): unknown => Reflect.get(host, name);
  const call = (name: string, ...args: unknown[]): unknown => {
    const method = read(name);
    if (typeof method !== "function") throw new TypeError(`process.${name} is not a function`);
    return Reflect.apply(method, host, args);
  };
  return { host, extras, read, call, warnings, errors, advance: (milliseconds: number) => { clock += milliseconds; } };
}

it("holds pinned Node's versions and release", () => {
  expect(NODE_24_VERSIONS).toEqual(control["versions"]);
  expect(Object.keys(NODE_24_VERSIONS)).toEqual(Object.keys(record(control["versions"], "versions")));
  expect(NODE_24_RELEASE).toEqual(control["release"]);
  const { read } = setup();
  expect(read("release")).toEqual(control["release"]);
  expect(Object.getOwnPropertyDescriptor(read("release"), "name")).toEqual({ value: "node", writable: false, enumerable: true, configurable: true });
  expect(Object.isFrozen(read("release"))).toBe(false);
});

it("defines each property with Node's function name, length and attributes", () => {
  const { host } = setup();
  const shapes = record(control["shapes"], "shapes");
  // Native accessors in Node that report themselves as data properties; plain accessors here.
  const accessorsHere = new Set(["title", "debugPort"]);
  for (const [name, recorded] of Object.entries(shapes)) {
    // Defined by the process identity (node-os.ts), not here.
    if (name === "getgroups") continue;
    // Node turns this accessor into a data property on its first read, which is how it was recorded.
    if (name === "allowedNodeEnvironmentFlags") { expect(typeof Object.getOwnPropertyDescriptor(host, name)?.get).toBe("function"); Reflect.get(host, name); }
    const expected = record(recorded, name), descriptor = Object.getOwnPropertyDescriptor(host, name);
    if (descriptor === undefined) throw new TypeError(`process.${name} is missing`);
    expect([name, descriptor.enumerable, descriptor.configurable]).toEqual([name, expected["enumerable"], expected["configurable"]]);
    if (accessorsHere.has(name)) { expect(typeof descriptor.get).toBe("function"); continue; }
    expect([name, descriptor.get === undefined ? "data" : "accessor"]).toEqual([name, expected["kind"]]);
    if (descriptor.get === undefined) expect([name, descriptor.writable]).toEqual([name, expected["writable"]]);
    const value: unknown = descriptor.value;
    if (typeof value === "function") expect([name, value.name, value.length]).toEqual([name, expected["name"], expected["length"]]);
  }
  expect(Object.getOwnPropertyDescriptor(host, "_exiting")?.get?.name).toBe("get");
  expect(Object.getOwnPropertyDescriptor(host, "finalization")?.set?.name).toBe("set");
});

it("keeps the title and the debug port in the process", () => {
  const { host, read } = setup();
  expect([read("title"), read("debugPort"), read("_exiting"), read("moduleLoadList")]).toEqual(["node", 9229, false, []]);
  Reflect.set(host, "title", 5);
  expect(read("title")).toBe("5");
  expect(() => Reflect.set(host, "title", Symbol("x"))).toThrow("Cannot convert a Symbol value to a string");
  const errors = record(control["errors"], "errors");
  for (const [value, expected] of [["x", 0], [5000.5, 5000], ["6000", 6000], [65535, 65535], [1024, 1024], [2 ** 32 + 2000, 2000], [0, 0]] as const) {
    Reflect.set(host, "debugPort", value);
    expect(read("debugPort")).toBe(expected);
  }
  expect(failure(() => Reflect.set(host, "debugPort", 1023))).toEqual(errors["debugPortLow"]);
  expect(failure(() => Reflect.set(host, "debugPort", 65536))).toEqual(errors["debugPortHigh"]);
  expect(failure(() => Reflect.set(host, "debugPort", -1))).toEqual(errors["debugPortNegative"]);
  expect(read("debugPort")).toBe(0);
});

it("asks the loader for the main module until a program assigns one", () => {
  const main = { id: "." };
  const { host, read } = setup({ mainModule: () => main });
  expect(read("mainModule")).toBe(main);
  Reflect.set(host, "mainModule", 5);
  expect(read("mainModule")).toBe(5);
  Reflect.set(host, "mainModule", undefined);
  expect(read("mainModule")).toBeUndefined();
});

it("offers Node's read-only set of NODE_OPTIONS flags", () => {
  expect(NODE_24_ENVIRONMENT_FLAGS).toEqual(control["flags"]);
  const { host, read } = setup();
  const flags = read("allowedNodeEnvironmentFlags");
  if (!(flags instanceof Set)) throw new TypeError("not a Set");
  expect(read("allowedNodeEnvironmentFlags")).toBe(flags);
  expect([flags.constructor.name, Object.isFrozen(flags), Object.isFrozen(Object.getPrototypeOf(flags)), Object.isFrozen(flags.constructor)]).toEqual(["NodeEnvironmentFlagsSet", true, true, true]);
  expect([flags.size, [...flags].length, [...flags.keys()].length, [...flags.entries()][0]]).toEqual([277, control["flagsUnique"], control["flagsUnique"], ["--tls-max-v1.3", "--tls-max-v1.3"]]);
  flags.clear();
  expect([flags.add("zz"), flags.delete("--max-old-space-size"), flags.size]).toEqual([flags, false, 277]);
  expect(list(control["flagProbes"]).map(probe => { const key: unknown = list(probe)[0]; return [key, flags.has(key)]; })).toEqual(control["flagProbes"]);
  expect([flags.has(1), flags.has(undefined)]).toEqual([false, false]);
  const visited: unknown[] = [];
  flags.forEach(function (this: unknown, value, key, set) { visited.push(value); expect([key, set, this]).toEqual([value, flags, "self"]); }, "self");
  expect(visited).toEqual(control["flags"]);
  expect([Reflect.get(flags, "keys"), Reflect.get(flags, Symbol.iterator)]).toEqual([Reflect.get(flags, "values"), Reflect.get(flags, "values")]);
  expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(flags), "keys")).toMatchObject({ writable: false, enumerable: false, configurable: false });
  // The first read, like an assignment, replaced the accessor with a data property, as in Node.
  expect(Object.getOwnPropertyDescriptor(host, "allowedNodeEnvironmentFlags")).toEqual({ value: flags, writable: true, enumerable: true, configurable: true });
  const assigned = setup().host;
  Reflect.set(assigned, "allowedNodeEnvironmentFlags", 5);
  expect(Object.getOwnPropertyDescriptor(assigned, "allowedNodeEnvironmentFlags")).toEqual({ value: 5, writable: true, enumerable: true, configurable: true });
});

const previous = new Map<string, unknown>([
  ["str", "x"], ["num", 1], ["arr", []], ["empty", {}], ["userstr", { user: "1", system: 1 }], ["sysstr", { user: 1, system: "1" }], ["sysmissing", { user: 1 }],
  ["neg", { user: -1, system: 1 }], ["negs", { user: 1, system: -1 }], ["inf", { user: Infinity, system: 1 }], ["nan", { user: NaN, system: 1 }],
  ["big", { user: 2 ** 53, system: 1 }], ["fn", function fn() { return undefined; }], ["true", true],
]);

it.each(["cpuUsage", "threadCpuUsage"])("%s reports the process's elapsed time as user CPU time and validates like Node", name => {
  const { call, advance } = setup();
  expect(call(name)).toEqual({ user: 1_500_250, system: 0 });
  const first = call(name);
  advance(2.5);
  expect(call(name, first)).toEqual({ user: 2500, system: 0 });
  // Any falsy value is no previous reading; an array carrying both numbers is one.
  for (const none of [null, 0, false, "", undefined]) expect(call(name, none)).toEqual({ user: 1_502_750, system: 0 });
  expect(call(name, Object.assign([], { user: 2750, system: 0 }))).toEqual({ user: 1_500_000, system: 0 });
  expect(call(name, { user: 0.5, system: 7 })).toEqual({ user: 1_502_749.5, system: -7 });
  expect(call(name, { user: Number.MAX_SAFE_INTEGER, system: 0 })).toEqual({ user: 1_502_750 - Number.MAX_SAFE_INTEGER, system: 0 });
  const errors = record(control[`${name}Errors`], "errors");
  expect([...previous.keys()].sort()).toEqual(Object.keys(errors).sort());
  for (const [label, value] of previous) expect([label, failure(() => call(name, value))]).toEqual([label, errors[label]]);
});

it("reports Node's sixteen resource counters, of which only the CPU time is known", () => {
  const { call } = setup();
  const usage = record(call("resourceUsage"), "usage");
  expect(Object.keys(usage)).toEqual(control["resourceUsageKeys"]);
  expect(usage["userCPUTime"]).toBe(1_500_250);
  expect(Object.values(usage).filter(value => value === 0)).toHaveLength(15);
});

it("reads memory from Linux on every call", () => {
  let memory: { total: number; free: number; constrained?: number } = { total: 4096, free: 1024 };
  const { call } = setup({ memory: () => memory });
  expect([call("availableMemory"), call("constrainedMemory")]).toEqual([1024, 0]);
  memory = { total: 4096, free: 3000, constrained: 2048 };
  expect([call("availableMemory"), call("constrainedMemory")]).toEqual([2048, 2048]);
  // A limit above the total is no limit, as in libuv.
  memory = { total: 4096, free: 3000, constrained: 2 ** 64 };
  expect([call("availableMemory"), call("constrainedMemory")]).toEqual([3000, 2 ** 64]);
});

it("refs and unrefs through the nodejs symbols first, then the methods", () => {
  const { call } = setup();
  const log: string[] = [];
  const both = { ref() { log.push("ref"); }, unref() { log.push("unref"); }, [Symbol.for("nodejs.ref")]() { log.push("symbol ref"); }, [Symbol.for("nodejs.unref")](this: unknown) { log.push(this === both ? "symbol unref" : "wrong this"); } };
  call("ref", both); call("unref", both);
  call("ref", { ref() { log.push("ref"); } }); call("unref", { unref() { log.push("unref"); } });
  // A truthy symbol member that is not a function wins and nothing is called, as in Node.
  call("ref", { ref() { log.push("never"); }, [Symbol.for("nodejs.ref")]: 6 });
  for (const value of [undefined, null, 1, "text", {}, { ref: 5 }]) { call("ref", value); call("unref", value); }
  expect(log).toEqual(["symbol ref", "symbol unref", "ref", "unref"]);
});

it("lists active resources from its port and has no handle objects to show", () => {
  const names = ["Timeout", "TCPSocketWrap"];
  const { call } = setup({ activeResources: () => names });
  expect(call("getActiveResourcesInfo")).toEqual(names);
  expect(call("getActiveResourcesInfo")).not.toBe(names);
  expect([setup().call("getActiveResourcesInfo"), call("_getActiveHandles"), call("_getActiveRequests")]).toEqual([[], [], []]);
});

it("stores one uncaught-exception capture callback", () => {
  const { call, extras } = setup();
  const errors = record(control["errors"], "errors");
  expect([call("hasUncaughtExceptionCaptureCallback"), extras.captureCallback()]).toEqual([false, undefined]);
  expect(failure(() => call("setUncaughtExceptionCaptureCallback"))).toEqual(errors["captureUndefined"]);
  expect(failure(() => call("setUncaughtExceptionCaptureCallback", 1))).toEqual(errors["captureNumber"]);
  expect(failure(() => call("setUncaughtExceptionCaptureCallback", {}))).toEqual(errors["captureObject"]);
  const seen = vi.fn<(error: unknown) => void>();
  expect(call("setUncaughtExceptionCaptureCallback", seen)).toBeUndefined();
  expect(call("hasUncaughtExceptionCaptureCallback")).toBe(true);
  const thrown = new Error("boom");
  extras.captureCallback()?.(thrown);
  expect(seen.mock.calls).toEqual([[thrown]]);
  expect(failure(() => call("setUncaughtExceptionCaptureCallback", () => undefined))).toEqual(errors["captureTwice"]);
  expect(failure(() => call("setUncaughtExceptionCaptureCallback", 1))).toEqual(errors["captureNumber"]);
  call("setUncaughtExceptionCaptureCallback", null); call("setUncaughtExceptionCaptureCallback", null);
  expect([call("hasUncaughtExceptionCaptureCallback"), extras.captureCallback()]).toEqual([false, undefined]);
});

it("resumes and returns the process's current stdin", () => {
  const { host, call } = setup();
  const stdin = { resume: vi.fn<() => void>() };
  Object.assign(host, { stdin });
  expect(call("openStdin")).toBe(stdin);
  expect(stdin.resume).toHaveBeenCalledTimes(1);
});

it("loads an env file without replacing variables the environment has", () => {
  const paths: string[] = [];
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open '.env'"), { errno: -2, code: "ENOENT", syscall: "open", path: ".env" });
  const sources = new Map([["/tmp/.env", "A=1\nPATH=zz\nB=\"x y\"\n"], ["/tmp/a b", "C=3\n"]]);
  const { host, call } = setup({ readFile: path => {
    paths.push(path);
    if (path === "/tmp") throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
    const source = sources.get(path);
    if (source === undefined) throw missing;
    return source;
  } });
  expect(call("loadEnvFile", "/tmp/.env")).toBeUndefined();
  expect(host.env).toEqual({ PATH: "/bin", A: "1", B: "x y" });
  call("loadEnvFile", new URL("file:///tmp/a%20b")); call("loadEnvFile", new TextEncoder().encode("/tmp/a b"));
  expect(host.env["C"]).toBe("3");
  // The default path, also for null.
  for (const args of [[], [undefined], [null]]) expect(() => call("loadEnvFile", ...args)).toThrow(missing);
  expect(paths).toEqual(["/tmp/.env", "/tmp/a b", "/tmp/a b", ".env", ".env", ".env"]);
  const errors = record(control["errors"], "errors");
  expect(failure(() => call("loadEnvFile", 1))).toEqual(errors["loadEnvNumber"]);
  expect(failure(() => call("loadEnvFile", {}))).toEqual(errors["loadEnvObject"]);
  expect(failure(() => call("loadEnvFile", "a\0b"))).toEqual(errors["loadEnvNul"]);
  expect(failure(() => call("loadEnvFile", new URL("http://x/y")))).toEqual(errors["loadEnvScheme"]);
  expect(failure(() => call("loadEnvFile", "/tmp"))).toEqual(errors["loadEnvDirectory"]);
});

it("runs finalization callbacks at exit for objects still alive", async () => {
  const { host, read, warnings } = setup();
  const finalization = record(read("finalization"), "finalization");
  expect(read("finalization")).toBe(finalization);
  for (const [name, recorded] of Object.entries(record(control["finalizationShape"], "shape"))) {
    const expected = record(recorded, name), descriptor = Object.getOwnPropertyDescriptor(finalization, name), value: unknown = descriptor?.value;
    if (typeof value !== "function") throw new TypeError(`finalization.${name} is not a function`);
    expect([value.name, value.length, descriptor?.enumerable, descriptor?.writable, descriptor?.configurable]).toEqual([expected["name"], expected["length"], true, true, true]);
  }
  const use = (name: string, ...args: unknown[]): unknown => { const method = finalization[name]; if (typeof method !== "function") throw new TypeError(name); return Reflect.apply(method, finalization, args); };
  const errors = record(control["errors"], "errors");
  expect(failure(() => use("register"))).toEqual(errors["registerUndefined"]);
  expect(failure(() => use("register", 1, () => undefined))).toEqual(errors["registerNumber"]);
  expect(failure(() => use("registerBeforeExit", null, () => undefined))).toEqual(errors["registerNull"]);
  expect(failure(() => use("register", [], () => undefined))).toEqual(errors["registerArray"]);
  expect([host.listenerCount("exit"), host.listenerCount("beforeExit")]).toEqual([0, 0]);
  // Before anything is registered there is no registry to refuse the token.
  expect(use("unregister", 1)).toBeUndefined();

  const kept = { name: "kept" }, dropped = { name: "dropped" }, early = () => undefined;
  const calls: unknown[][] = [];
  const record_ = (...args: unknown[]): void => { calls.push(args); };
  use("register", kept, record_); use("register", dropped, record_); use("registerBeforeExit", early, record_);
  expect([host.listenerCount("exit"), host.listenerCount("beforeExit")]).toEqual([1, 1]);
  expect(() => use("unregister", 1)).toThrow("Invalid unregisterToken ('1')");
  use("unregister", dropped);
  host.emit("beforeExit", 0);
  expect(calls).toEqual([[early, "beforeExit"]]);
  expect([host.listenerCount("exit"), host.listenerCount("beforeExit")]).toEqual([1, 1]);
  host.emit("exit", 0);
  expect(calls).toEqual([[early, "beforeExit"], [kept, "exit"]]);
  // Each list is emptied once it has run.
  host.emit("exit", 0);
  expect(calls).toHaveLength(2);
  use("unregister", kept);
  expect([host.listenerCount("exit"), host.listenerCount("beforeExit")]).toEqual([0, 0]);
  // Node does not check the callback until it is called.
  use("register", kept, 1);
  expect(() => host.emit("exit", 0)).toThrow("fn is not a function");
  // One experimental warning per function, delivered on the next tick.
  await Promise.resolve();
  expect(warnings.map(([warning]) => warning instanceof Error ? [warning.name, warning.message] : warning)).toEqual(["register", "registerBeforeExit", "unregister"].map(name =>
    ["ExperimentalWarning", `process.finalization.${name} is an experimental feature and might change at any time`]));
  Reflect.set(host, "finalization", 5);
  expect([read("finalization"), typeof Object.getOwnPropertyDescriptor(host, "finalization")?.get]).toEqual([5, "function"]);
});

it("writes _rawDebug to standard error and delegates _fatalException and _kill", () => {
  const fatal = vi.fn<(error: unknown) => boolean>().mockReturnValue(true);
  const kill = vi.fn<(pid: number, signal: number) => number | undefined>().mockReturnValueOnce(undefined).mockReturnValueOnce(-3).mockReturnValue(0);
  const { call, errors } = setup({ fatal, kill });
  call("_rawDebug", "a %s", "b", { c: 1 }); call("_rawDebug");
  expect(errors).toEqual(["a b { c: 1 }\n", "\n"]);
  expect(call("_tickCallback")).toBeUndefined();
  const thrown = new Error("boom");
  expect(call("_fatalException", thrown, true)).toBe(true);
  expect(fatal.mock.calls).toEqual([[thrown]]);
  expect([call("_kill", 42, 15), call("_kill", 999_999, 0), call("_kill"), call("_kill", "x", "y"), call("_kill", 7.9, "9")]).toEqual([0, -3, 0, 0, 0]);
  expect(kill.mock.calls).toEqual([[42, 15], [999_999, 0], [0, 0], [0, 0], [7, 9]]);
  expect(() => setup().call("_kill", 1, 0)).toThrow("process._kill");
});
