import { linuxErrnoConstants } from "../../linux-errno.js";
import { SYSTEM_ERROR_MESSAGES } from "./node-system-errors.js";

type SystemErrorInfo = { errno: number; code: string; message: string; syscall: string };

/** Node's `SystemError` with code ERR_SYSTEM_ERROR; its class is named `NodeError` there too. */
class NodeError extends Error {
  declare code: string;
  declare info: SystemErrorInfo;
  declare errno: number;
  declare syscall: string;
  constructor(info: SystemErrorInfo) {
    super(`A system error occurred: ${info.syscall} returned ${info.code} (${info.message})`);
    Object.defineProperty(this, "code", { value: "ERR_SYSTEM_ERROR", enumerable: true, writable: true, configurable: true });
    // Node captures the stack while the name carries the code, then restores the name.
    Object.defineProperty(this, "name", { value: "SystemError [ERR_SYSTEM_ERROR]", enumerable: false, writable: true, configurable: true });
    const capture: unknown = Reflect.get(Error, "captureStackTrace");
    if (typeof capture === "function") Reflect.apply(capture, Error, [this, systemError]);
    // A stack formatter runs on first read: read it while the name is the one Node's stack shows.
    Reflect.get(this, "stack");
    Object.defineProperty(this, "name", { value: "SystemError", enumerable: false, writable: true, configurable: true });
    Object.defineProperties(this, {
      info: { value: info, enumerable: true, configurable: true, writable: false },
      errno: { get: () => info.errno, set: (value: number) => { info.errno = value; }, enumerable: true, configurable: true },
      syscall: { get: () => info.syscall, set: (value: string) => { info.syscall = value; }, enumerable: true, configurable: true },
    });
  }
}
// The bundle renames classes; programs read this one's name.
Object.defineProperty(NodeError, "name", { value: "NodeError" });

/** The error Node throws when a libuv call (`uv_os_getpriority`, `uv_os_get_passwd`, ...) fails with a Linux errno. */
export function systemError(code: keyof typeof linuxErrnoConstants, syscall: string): Error {
  return new NodeError({ errno: -linuxErrnoConstants[code], code, message: SYSTEM_ERROR_MESSAGES[code] ?? "unknown error", syscall });
}
