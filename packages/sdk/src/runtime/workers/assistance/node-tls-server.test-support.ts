import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { createAsyncContext } from "./async-context.js";
import type { PipedChildHandle } from "./node-children.js";
import { createHttpServers } from "./node-http-server.ts";
import { createHttpsServers } from "./node-https-server.ts";
import { createNodeNet } from "./node-net.js";
import { EventEmitter, Readable, Writable } from "./node-streams.js";
import { createNodeTls } from "./node-tls.ts";
import { createTlsServers } from "./node-tls-server.ts";
import { nativeServiceFixture } from "./native-service.test-support.js";

const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
const parser = new WebAssembly.Module(new Uint8Array(wasm));

/** The Linux socket port is never used: a TLS server's sockets live in the guest helper. */
function unusedNet(context: ReturnType<typeof createAsyncContext>) {
  return createNodeNet({ retain: () => () => {}, callSync: () => { throw new Error("Unexpected Linux socket call"); }, call: () => Promise.reject(new Error("Unexpected Linux socket call")) }, context);
}

/** `tls` and `https` servers over the real helper program, run by the host's Node as the guest. */
export function assistedServers() {
  const fixture = nativeServiceFixture(), net = unusedNet(fixture.context);
  const tls = createNodeTls(fixture.native, fixture.context, fixture.retain);
  const servers = createTlsServers({ children: fixture.native, context: fixture.context, retain: fixture.retain, tls, net });
  const http = createHttpServers(net, parser, fixture.context);
  return { ...fixture, net, tls, servers, http, https: createHttpsServers(servers, http) };
}

export type SentFrame = { readonly tag: 0; readonly id: number; readonly bytes: Buffer } | { readonly tag: 1; readonly value: Record<string, unknown> };
function frame(tag: 0 | 1, payload: Uint8Array): Buffer {
  const result = Buffer.alloc(5 + payload.length); result[0] = tag; result.writeUInt32BE(payload.length, 1); result.set(payload, 5); return result;
}
/** A scripted helper: the test plays the guest's side of the wire and reads what the worker's side sent. */
export function scriptedServers() {
  const context = createAsyncContext(), net = unusedNet(context), sent: SentFrame[] = [], spawned: string[][] = [];
  let references = 0, pending = Buffer.alloc(0), killed = false;
  const stdout = new Readable({ read() {} }), stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk: unknown, _encoding, done) {
      if (!(chunk instanceof Uint8Array)) { done(new TypeError("Expected helper bytes")); return; }
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const size = pending.readUInt32BE(1), payload = pending.subarray(5, 5 + size);
        if (pending[0] === 0) sent.push({ tag: 0, id: payload.readUInt32BE(0), bytes: Buffer.from(payload.subarray(4)) });
        else { const value: unknown = JSON.parse(payload.toString("utf8")); if (typeof value === "object" && value !== null) sent.push({ tag: 1, value: { ...value } }); }
        pending = pending.subarray(5 + size);
      }
      done();
    },
  });
  const emitter = new EventEmitter();
  let exited = false;
  const exit = (code: number | null, signal: string | null): void => { if (exited) return; exited = true; stdout.push(null); stderr.push(null); emitter.emit("close", code, signal); };
  const child: PipedChildHandle = Object.assign(emitter, { pid: 1, exitCode: null, signalCode: null, killed: false, stdin, stdout, stderr, stdio: undefined,
    kill: (): boolean => { if (!killed) { killed = true; queueMicrotask(() => { exit(null, "SIGKILL"); }); } return true; },
    ref: (): PipedChildHandle => child, unref: (): PipedChildHandle => child });
  const children = { spawnService: (...args: unknown[]): PipedChildHandle => { spawned.push(Array.isArray(args[1]) ? args[1].map(String) : []); return child; } };
  const retain = () => { references++; return () => { references--; }; };
  const tls = createNodeTls(children, context, retain);
  const servers = createTlsServers({ children, context, retain, tls, net });
  return { tls, servers, sent, spawned, references: () => references, killed: () => killed, exit,
    controls: (): Record<string, unknown>[] => sent.flatMap(entry => entry.tag === 1 ? [entry.value] : []),
    event: (value: object): void => { stderr.push(frame(1, Buffer.from(JSON.stringify(value)))); },
    data: (id: number, bytes: Uint8Array): void => { const payload = Buffer.alloc(4 + bytes.length); payload.writeUInt32BE(id, 0); payload.set(bytes, 4); stdout.push(frame(0, payload)); },
    /** Lets the bridge read and deliver what the script pushed. */
    settle: async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await new Promise<void>(resolve => { setImmediate(resolve); }); } };
}
export const OPEN = { kind: "open", localAddress: "127.0.0.1", localPort: 8443, localFamily: "IPv4", remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4",
  authorized: false, authorizationError: null, alpnProtocol: false, servername: "localhost", protocol: "TLSv1.3",
  cipher: { name: "TLS_AES_256_GCM_SHA384", standardName: "TLS_AES_256_GCM_SHA384", version: "TLSv1.3" }, peer: null } as const;
