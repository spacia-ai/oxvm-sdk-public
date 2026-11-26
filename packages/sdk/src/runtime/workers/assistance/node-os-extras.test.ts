import { readFileSync } from "node:fs";
import { Buffer } from "buffer";
import { expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { createNodeOs } from "./node-os.js";

// Recorded from `docker run --rm -i node:24.18.1-alpine node --no-warnings -`; the missing passwd entry with `--user 12345`.
const control = record(JSON.parse(readFileSync(new URL("./node-os-extras.controls.json", import.meta.url), "utf8")), "os controls");
const PASSWD = string(control["passwd"], "passwd");

function failure(run: () => unknown): unknown {
  try { run(); return null; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const code: unknown = Reflect.get(error, "code");
    return { name: error.name, code: code ?? null, message: error.message };
  }
}
/** Everything the recorder kept of a SystemError. */
function systemFailure(run: () => unknown): unknown {
  try { run(); return null; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    const read = (key: string): unknown => Reflect.get(error, key);
    const info = Object.getOwnPropertyDescriptor(error, "info");
    return { name: error.name, code: read("code"), message: error.message, info: read("info"), errno: read("errno"), syscall: read("syscall"), keys: Object.keys(error),
      constructorName: error.constructor.name, isError: true, infoDescriptor: { writable: info?.writable, enumerable: info?.enumerable, configurable: info?.configurable },
      errnoAccessor: typeof Object.getOwnPropertyDescriptor(error, "errno")?.get === "function" };
  }
}

function linux(overrides: Readonly<Record<string, string | Error>> = {}, ids: { uid?: number; pid?: number } = {}) {
  const sources = new Map<string, string | Error>(Object.entries({
    "/proc/self/status": `Name:\tnode\nPid:\t${ids.pid ?? 42}\nPPid:\t1\nUid:\t7\t${ids.uid ?? 0}\t7\t7\nGid:\t9\t9\t9\t9\nGroups:\t0 1 2 \n`,
    "/etc/passwd": `${PASSWD}app:x:1000:1001:Application,,,:/home/app:\nbroken:x:2000\n`,
    "/proc/uptime": "66490.84 1008657.68\n", "/proc/loadavg": "4.67 1.59 1.01 2/2179 13\n", ...overrides,
  }));
  const files = { readFileSync(path: string): string {
    const source = sources.get(path);
    if (source === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (source instanceof Error) throw source;
    return source;
  } };
  return { os: createNodeOs(files, {}, undefined, () => 12_999), sources, files };
}

it("defines the functions with Node's names, lengths and attributes", () => {
  const { os } = linux();
  const shapes = record(control["shapes"], "shapes");
  for (const name of ["userInfo", "uptime", "loadavg", "getPriority", "setPriority"]) {
    const expected = record(shapes[name], name), descriptor = Object.getOwnPropertyDescriptor(os, name), value: unknown = descriptor?.value;
    if (typeof value !== "function") throw new TypeError(`os.${name} is not a function`);
    expect([name, value.name, value.length, descriptor?.enumerable, descriptor?.writable, descriptor?.configurable])
      .toEqual([name, expected["name"], expected["length"], expected["enumerable"], expected["writable"], expected["configurable"]]);
  }
  const primitive = Object.getOwnPropertyDescriptor(os.uptime, Symbol.toPrimitive), convert: unknown = primitive?.value, expected = record(shapes["uptimeToPrimitive"], "toPrimitive");
  if (typeof convert !== "function") throw new TypeError("os.uptime has no primitive conversion");
  expect([convert.name, convert.length, primitive?.enumerable, primitive?.writable, primitive?.configurable]).toEqual([expected["name"], expected["length"], expected["enumerable"], expected["writable"], expected["configurable"]]);
  expect(Number(os.uptime)).toBe(66490.84);
});

it("reads the effective user's passwd entry, in the encoding asked for", () => {
  const { os } = linux();
  expect(os.userInfo()).toEqual(control["userInfo"]);
  expect([Object.getPrototypeOf(os.userInfo()), Object.keys(os.userInfo())]).toEqual([null, ["uid", "gid", "username", "homedir", "shell"]]);
  expect(os.userInfo({ encoding: "hex" })).toEqual(control["userInfoHex"]);
  expect(os.userInfo({ encoding: "base64" })).toEqual(control["userInfoBase64"]);
  expect(os.userInfo({ encoding: "base64url" })["username"]).toBe("cm9vdA");
  // Node ignores options that are not an object and encodings it does not know.
  for (const options of [1, "x", null, [], () => undefined, { encoding: 5 }, { encoding: "bogus" }, { encoding: "utf8" }]) expect(os.userInfo(options)).toEqual(control["userInfo"]);
  const buffers = os.userInfo({ encoding: "BUFFER" });
  expect(Object.fromEntries(Object.entries(buffers).map(([key, value]) => [key, Buffer.isBuffer(value) ? { hex: value.toString("hex") } : value]))).toEqual(control["userInfoBuffer"]);
  // The group is the entry's, not the process's; an empty shell stays empty; HOME and USER are not consulted.
  expect(linux({}, { uid: 1000 }).os.userInfo()).toEqual({ uid: 1000, gid: 1001, username: "app", homedir: "/home/app", shell: "" });
});

it("fails like libuv when the user has no passwd entry", () => {
  const expected = record(record(control["systemErrors"], "system errors")["userInfoMissing"], "missing");
  const missing = { ...expected, infoDescriptor: { writable: false, enumerable: true, configurable: true }, errnoAccessor: true };
  expect(systemFailure(() => linux({}, { uid: 12_345 }).os.userInfo())).toEqual(missing);
  // A line without all seven fields is not an entry.
  expect(systemFailure(() => linux({}, { uid: 2000 }).os.userInfo())).toEqual(missing);
  expect(systemFailure(() => linux({ "/etc/passwd": Object.assign(new Error("missing"), { code: "ENOENT" }) }).os.userInfo())).toEqual(missing);
  let thrown: unknown;
  try { linux({}, { uid: 12_345 }).os.userInfo(); } catch (error) { thrown = error; }
  if (!(thrown instanceof Error)) throw new TypeError("nothing thrown");
  expect(thrown.stack?.split("\n")[0]).toBe("SystemError [ERR_SYSTEM_ERROR]: A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)");
  Reflect.set(thrown, "errno", -5);
  expect(Reflect.get(thrown, "info")).toMatchObject({ errno: -5 });
});

it("reads uptime and load averages from Linux and falls back as libuv does", () => {
  const { os, sources } = linux();
  expect([os.uptime(), os.loadavg()]).toEqual([66490.84, [4.67, 1.59, 1.01]]);
  sources.set("/proc/uptime", "66491.5 1.0\n"); sources.set("/proc/loadavg", "0.00 0.01 0.05 1/100 7\n");
  expect([os.uptime(), os.loadavg()]).toEqual([66491.5, [0, 0.01, 0.05]]);
  sources.delete("/proc/uptime"); sources.delete("/proc/loadavg");
  // The process's own clock, in whole seconds.
  expect([os.uptime(), os.loadavg()]).toEqual([12, [0, 0, 0]]);
  sources.set("/proc/uptime", "garbage\n"); sources.set("/proc/loadavg", "1.0 x 2.0\n");
  expect([os.uptime(), os.loadavg()]).toEqual([12, [0, 0, 0]]);
  sources.set("/proc/loadavg", Object.assign(new Error("denied"), { code: "EACCES" }));
  expect(os.loadavg()).toEqual([0, 0, 0]);
  // A failed transport is not an answer from Linux.
  const broken = new VMError("PROTOCOL_ERROR", "broken");
  sources.set("/proc/uptime", broken); sources.set("/proc/loadavg", broken);
  expect(() => os.uptime()).toThrow(broken);
  expect(() => os.loadavg()).toThrow(broken);
});

const getInputs = new Map<string, readonly unknown[]>([["string", ["x"]], ["null", [null]], ["object", [{}]], ["boolean", [true]], ["fraction", [1.5]], ["high", [2 ** 31]], ["low", [-(2 ** 31) - 1]], ["missing", [999_999]], ["negative", [-1]]]);
const setInputs = new Map<string, readonly unknown[]>([["none", []], ["pidString", ["x", 3]], ["priorityString", [0, "x"]], ["priorityHigh", [0, 20]], ["priorityLow", [0, -21]], ["priorityFraction", [0, 1.5]],
  ["pidFraction", [1.5, 1]], ["priorityNull", [0, null]], ["pidNull", [null, 1]], ["pidUndefined", [undefined, 4]], ["onlyHigh", [20]], ["onlyLow", [-21]], ["pidHigh", [2 ** 31, 1]],
  ["bothUndefined", [undefined, undefined]], ["onlyNaN", [NaN]], ["missing", [999_999, 3]]]);

it("validates priorities like Node and keeps this process's own", () => {
  const { os } = linux();
  const getErrors = record(control["getPriorityErrors"], "errors"), setErrors = record(control["setPriorityErrors"], "errors");
  expect([[...getInputs.keys()].sort(), [...setInputs.keys()].sort()]).toEqual([Object.keys(getErrors).sort(), Object.keys(setErrors).sort()]);
  for (const [label, args] of getInputs) expect([label, failure(() => Reflect.apply(os.getPriority, os, [...args]))]).toEqual([label, getErrors[label]]);
  for (const [label, args] of setInputs) expect([label, failure(() => Reflect.apply(os.setPriority, os, [...args]))]).toEqual([label, setErrors[label]]);
  expect(failure(() => os.getPriority(2 ** 40))).toMatchObject({ message: 'The value of "pid" is out of range. It must be >= -2147483648 && <= 2147483647. Received 1_099_511_627_776' });
  expect([os.getPriority(), os.getPriority(0), os.getPriority(42), os.getPriority(undefined)]).toEqual([0, 0, 0, 0]);
  const after = (...args: unknown[]): number => { Reflect.apply(os.setPriority, os, args); return os.getPriority(); };
  expect([after(5), after(42, 19), os.getPriority(42), after(0, undefined), after(-20)]).toEqual([5, 19, 19, 0, -20]);
  const errors = record(control["systemErrors"], "system errors");
  expect(systemFailure(() => os.getPriority(999_999))).toEqual(errors["getPriorityMissing"]);
  expect(systemFailure(() => os.setPriority(999_999, 3))).toEqual(errors["setPriorityMissing"]);
  // Without privilege Linux refuses a higher priority than the current one.
  const user = linux({}, { uid: 1000 }).os;
  user.setPriority(0, 5); user.setPriority(5);
  expect(systemFailure(() => { user.setPriority(0, 4); })).toEqual(errors["setPriorityDenied"]);
  expect(user.getPriority()).toBe(5);
});
