import { VMError } from "../../errors.js";
import { endNodeProcess, type NodeProcess } from "./node-process.js";
import { rejectionDomain } from "./node-domain.ts";

export type ExceptionOrigin = "uncaughtException" | "unhandledRejection" | "rejectionHandled";

/** Application exceptions can reach Node listeners. Failed transport cannot. */
export function deliverProcessException(process: NodeProcess, error: unknown, origin: ExceptionOrigin, print: (error: unknown) => void, unhandled?: (error: unknown) => void, promise?: Promise<unknown>, capture?: () => ((error: unknown) => void) | undefined): boolean {
  if (error instanceof VMError && (error.code === "PROTOCOL_ERROR" || error.code === "VM_FAULT" || error.code === "ABORTED")) return false;
  if (origin === "rejectionHandled") {
    if (promise === undefined) throw new VMError("PROTOCOL_ERROR", "Handled rejection has no Promise identity");
    try { process.emit("rejectionHandled", promise); return true; }
    catch (failure) { return deliverProcessException(process, failure, "uncaughtException", print, unhandled, undefined, capture); }
  }
  function finish(failure: unknown, code: 1 | 7): never {
    if (unhandled === undefined) print(failure); else unhandled(failure);
    return endNodeProcess(process, "uncaught", code);
  }
  if (origin === "unhandledRejection") {
    // Node's emitUnhandledRejection: a promise of a domain reports to that domain's 'error' instead.
    const domain = rejectionDomain(promise);
    try { if (domain === undefined ? process.emit("unhandledRejection", error, promise) : domain.emit("error", error)) return true; }
    catch (failure) { return deliverProcessException(process, failure, "uncaughtException", print, unhandled, undefined, capture); }
  }
  try {
    process.emit("uncaughtExceptionMonitor", error, origin);
    // process.setUncaughtExceptionCaptureCallback: Node hands the error to the callback instead of 'uncaughtException'.
    const captured = capture?.();
    if (captured !== undefined) { captured(error); return true; }
    if (process.listenerCount("uncaughtException") !== 0) { process.emit("uncaughtException", error, origin); return true; }
  } catch (failure) { return finish(failure, 7); }
  return finish(error, 1);
}
