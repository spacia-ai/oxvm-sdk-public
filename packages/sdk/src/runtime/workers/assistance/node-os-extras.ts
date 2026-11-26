import { Buffer } from "buffer";
import { VMError } from "../../errors.ts";
import { invalidArgType, type Inspect } from "./node-arg-type.js";
import { systemError } from "./node-os-system-error.js";

type LinuxFiles = { readFileSync(path: string, encoding: "utf8"): unknown };

/** What these calls need beyond Linux's files. */
export interface OsExtrasPorts {
  /** The process's own monotonic clock, in milliseconds. Used only when Linux's uptime cannot be read. */
  readonly now: () => number;
  /** The Linux task's identity (`createProcessIdentity`). */
  readonly identity: { readonly pid: number; geteuid(): number };
  readonly inspect: Inspect;
}

const MIN_INT32 = -2_147_483_648, MAX_INT32 = 2_147_483_647;
/** `Buffer#toString` encodings by the names Node's `ParseEncoding` accepts; anything else is UTF-8. */
const ENCODINGS: Readonly<Record<string, "hex" | "base64" | "latin1" | "ascii" | "utf16le">> = {
  hex: "hex", base64: "base64", latin1: "latin1", binary: "latin1", ascii: "ascii", ucs2: "utf16le", "ucs-2": "utf16le", utf16le: "utf16le", "utf-16le": "utf16le",
};

/** Linux answered that the file cannot be read (an errno), as opposed to a failed transport, which must surface. */
function unreadable(error: unknown): boolean {
  if (error instanceof VMError || !(error instanceof Error) || !("code" in error)) return false;
  return typeof error.code === "string" && /^E[A-Z0-9]+$/u.test(error.code);
}

/** Node's `addNumericalSeparator`. */
function separated(text: string): string {
  let result = "", index = text.length;
  const start = text.startsWith("-") ? 1 : 0;
  for (; index >= start + 4; index -= 3) result = `_${text.slice(index - 3, index)}${result}`;
  return `${text.slice(0, index)}${result}`;
}

/** `os.userInfo`, `os.uptime`, `os.loadavg`, `os.getPriority` and `os.setPriority` of Node.js 24.18.1 on Linux. */
export function createOsExtras(files: LinuxFiles, ports: OsExtrasPorts) {
  function text(path: string): string | undefined {
    try {
      const value = files.readFileSync(path, "utf8");
      if (typeof value !== "string" || value.length > 1024 * 1024) throw new VMError("PROTOCOL_ERROR", "Invalid Linux OS information", { path });
      return value;
    } catch (error) {
      if (unreadable(error)) return undefined;
      throw error;
    }
  }
  /** Node's `validateInt32`. */
  function int32(value: unknown, name: string, min = MIN_INT32, max = MAX_INT32): number {
    if (typeof value !== "number") throw invalidArgType(name, "number", value, ports.inspect);
    const range = !Number.isInteger(value) ? "an integer" : value < min || value > max ? `>= ${min} && <= ${max}` : undefined;
    if (range === undefined) return value;
    const received = Number.isInteger(value) && Math.abs(value) > 2 ** 32 ? separated(String(value)) : ports.inspect(value, { depth: -1 });
    throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${received}`), { code: "ERR_OUT_OF_RANGE" });
  }

  /** libuv's `uv_os_get_passwd`: the passwd entry of the effective user. The environment is not consulted. */
  function userInfo(options?: unknown): Record<string, unknown> {
    const requested: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "encoding") : undefined;
    const encoding = typeof requested === "string" ? requested.toLowerCase() : "utf8";
    const uid = String(ports.identity.geteuid());
    const entry = (text("/etc/passwd") ?? "").split("\n").map(line => line.split(":")).find(fields => fields.length === 7 && fields[2] === uid);
    const [username, , , group, , homedir, shell] = entry ?? [];
    if (username === undefined || group === undefined || homedir === undefined || shell === undefined || !/^\d+$/u.test(group)) throw systemError("ENOENT", "uv_os_get_passwd");
    const encode = (value: string): unknown => {
      if (encoding === "buffer") return Buffer.from(value, "utf8");
      if (encoding === "base64url") return Buffer.from(value, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      const known = Object.hasOwn(ENCODINGS, encoding) ? ENCODINGS[encoding] : undefined;
      return known === undefined ? value : Buffer.from(value, "utf8").toString(known);
    };
    // Node returns an object without a prototype.
    return { __proto__: null, uid: Number(uid), gid: Number(group), username: encode(username), homedir: encode(homedir), shell: encode(shell) };
  }

  /** libuv reads /proc/uptime and falls back to a clock in whole seconds; here that clock is the process's own. */
  const uptime = function (): number {
    const seconds = Number.parseFloat(text("/proc/uptime") ?? "");
    return Number.isFinite(seconds) ? seconds : Math.floor(ports.now() / 1000);
  };
  // Node wraps this one: its name is the wrapper's, and it converts to its own result.
  Object.defineProperty(uptime, "name", { value: "wrappedFn" });
  Object.defineProperty(uptime, Symbol.toPrimitive, { value: Object.defineProperty(() => uptime(), "name", { value: "" }), enumerable: true, writable: true, configurable: true });

  function loadavg(): number[] {
    const fields = /^\s*(\S+)\s+(\S+)\s+(\S+)/u.exec(text("/proc/loadavg") ?? "")?.slice(1).map(Number.parseFloat) ?? [];
    return fields.length === 3 && fields.every(Number.isFinite) ? fields : [0, 0, 0];
  }

  // Scheduling priority is kept here: Linux is not told, and the guest scheduler does not see it. Only this
  // process is known, so every other PID is reported as absent (ESRCH), as for a process that does not exist.
  let nice = 0;
  const own = (pid: number): boolean => pid === 0 || pid === ports.identity.pid;
  function getPriority(pid?: unknown): number {
    const target = pid === undefined ? 0 : int32(pid, "pid");
    if (!own(target)) throw systemError("ESRCH", "uv_os_getpriority");
    return nice;
  }
  function setPriority(pid?: unknown, priority?: unknown): void {
    if (priority === undefined) { priority = pid; pid = 0; }
    const target = int32(pid, "pid"), value = int32(priority, "priority", -20, 19);
    if (!own(target)) throw systemError("ESRCH", "uv_os_setpriority");
    // Linux lets only a privileged task raise its priority (RLIMIT_NICE is 0 by default).
    if (value < nice && ports.identity.geteuid() !== 0) throw systemError("EACCES", "uv_os_setpriority");
    nice = value;
  }
  // Production code is minified; programs read these names.
  Object.defineProperty(userInfo, "name", { value: "userInfo" });
  Object.defineProperty(loadavg, "name", { value: "loadavg" });
  Object.defineProperty(getPriority, "name", { value: "getPriority" });
  Object.defineProperty(setPriority, "name", { value: "setPriority" });
  return { userInfo, uptime, loadavg, getPriority, setPriority };
}
