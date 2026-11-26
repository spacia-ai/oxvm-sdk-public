import { Buffer } from "buffer";
import { VMError } from "../../errors.js";
import type { createNativeChildren, PipedChildHandle } from "./node-children.js";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.js";
import { streamError } from "./node-streams.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import { TLS_SERVER_MAX_OPTIONS, tlsServerGuestArguments } from "./node-tls-server-guest.ts";
import { decodeTlsServerEvent, tlsServerError, type TlsServerCommand, type TlsServerEvent } from "./node-tls-server-wire.ts";

export type TlsServerChildren = Pick<ReturnType<typeof createNativeChildren>, "spawnService">;
export type TlsServerCallbacks = {
  event(event: Exclude<TlsServerEvent, { kind: "fatal" | "done" }>): void;
  /** Plaintext of one connection; `null` ends its stream. */
  data(id: number, bytes: Buffer | null): void;
  /** The helper is gone; `error` is set unless it finished its work. */
  retired(error?: Error): void;
};
/** The plaintext of one data frame, after its 4-byte connection id. */
export const TLS_SERVER_FRAME = 65532;

/** One helper owns one listening TLS server and all its connections. Each pipe is read one frame at a time and
 * the frame is delivered through the process's dispatch before the next is read, so Linux holds what the
 * program has not taken. Rust owns the helper process and retires it with the worker's process. */
export class TlsServerBridge {
  readonly #child: PipedChildHandle;
  readonly #callbacks: TlsServerCallbacks;
  readonly #scheduler: ProcessScheduler | undefined;
  #done = false;
  #failed: Error | undefined;
  constructor(children: TlsServerChildren, start: Readonly<Record<string, unknown>>, callbacks: TlsServerCallbacks, scheduler?: ProcessScheduler) {
    const initial = encodeOptions(start);
    this.#callbacks = callbacks; this.#scheduler = scheduler;
    this.#child = children.spawnService("/usr/bin/node", tlsServerGuestArguments());
    this.#child.on("error", error => { this.fail(streamError(error)); });
    this.#child.stdin.on("error", error => { this.fail(streamError(error)); });
    const control = this.#control().catch((error: unknown) => { this.fail(streamError(error)); });
    const data = this.#data().catch((error: unknown) => { this.fail(streamError(error)); });
    this.#child.on("close", (code, signal) => {
      void Promise.all([control, data]).then(() => {
        if (!this.#done || code !== 0 || signal !== null) this.fail(failure("ERR_TLS_BRIDGE_EXIT", "Native TLS server exited before completion"));
        return this.#deliver(() => { callbacks.retired(this.#failed); });
      });
    });
    this.#stage(initial); this.send({ kind: "start" });
  }
  /** Stages an options record for the next `secure-context` or `add-context` command. */
  options(value: Readonly<Record<string, unknown>>): void { this.#stage(encodeOptions(value)); }
  send(command: TlsServerCommand): void {
    if (this.#failed !== undefined || this.#done) return;
    this.#write(encodeNativeFrame(1, Buffer.from(JSON.stringify(command)))).catch((error: unknown) => { this.fail(streamError(error)); });
  }
  /** One data frame for a connection; resolves when the helper's pipe has taken it. */
  write(id: number, bytes: Uint8Array): Promise<void> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#done) return Promise.reject(failure("ERR_SOCKET_CLOSED", "TLS server is closed"));
    return this.#write(frame(id, bytes));
  }
  fail(error: Error): void {
    if (this.#failed !== undefined) return;
    this.#failed = error; this.#child.kill("SIGKILL");
  }
  #stage(bytes: Buffer): void {
    for (let offset = 0; offset < bytes.length; offset += TLS_SERVER_FRAME) {
      if (this.#failed !== undefined) return;
      this.#write(frame(0, bytes.subarray(offset, offset + TLS_SERVER_FRAME))).catch((error: unknown) => { this.fail(streamError(error)); });
    }
  }
  #write(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => { this.#child.stdin.write(bytes, error => { if (error) reject(error); else resolve(); }); });
  }
  #deliver(callback: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const run = () => { try { callback(); } finally { resolve(); } };
      try { if (this.#scheduler === undefined) queueMicrotask(run); else this.#scheduler.enqueue(run); }
      catch (error) { reject(streamError(error)); }
    });
  }
  async #control(): Promise<void> {
    for (;;) {
      const next = await readNativeFrame(this.#child.stderr);
      if (next === null) { if (!this.#done && this.#failed === undefined) throw failure("ERR_TLS_BRIDGE_EOF", "TLS server control channel ended unexpectedly"); return; }
      if (next.tag !== 1 || this.#done) throw new VMError("PROTOCOL_ERROR", "Invalid native TLS server control frame");
      const event = decodeTlsServerEvent(next.bytes);
      if (event.kind === "fatal") { this.fail(tlsServerError(event.error)); continue; }
      if (event.kind === "done") { this.#done = true; continue; }
      if (this.#failed === undefined) await this.#deliver(() => { this.#callbacks.event(event); });
    }
  }
  async #data(): Promise<void> {
    for (;;) {
      const next = await readNativeFrame(this.#child.stdout); if (next === null) return;
      if (next.tag !== 0 || next.bytes.length < 4) throw new VMError("PROTOCOL_ERROR", "Invalid native TLS server data frame");
      const id = next.bytes.readUInt32BE(0), bytes = next.bytes.length === 4 ? null : Buffer.from(next.bytes.subarray(4));
      if (id === 0) throw new VMError("PROTOCOL_ERROR", "Invalid native TLS server connection");
      if (this.#failed === undefined) await this.#deliver(() => { this.#callbacks.data(id, bytes); });
    }
  }
}
function frame(id: number, bytes: Uint8Array): Buffer {
  const payload = Buffer.allocUnsafe(4 + bytes.length); payload.writeUInt32BE(id, 0); payload.set(bytes, 4);
  return encodeNativeFrame(0, payload);
}
function encodeOptions(value: Readonly<Record<string, unknown>>): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > TLS_SERVER_MAX_OPTIONS) throw new VMError("QUOTA_EXCEEDED", "TLS server options exceed their 1 MiB limit");
  return bytes;
}
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
