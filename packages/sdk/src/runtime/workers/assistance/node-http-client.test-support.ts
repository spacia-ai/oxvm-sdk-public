import { createRequire } from "node:module";
import { Buffer } from "buffer";
import type { Readable } from "readable-stream";
import { createAsyncContext } from "./async-context.js";
import { createNodeSockets } from "./node-socket.js";
import { createHttpClients } from "./node-http-client.js";
import { createHttpConnection } from "./node-http-connection.js";
import { createHttpResponses } from "./node-http-response.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

/** An in-memory HTTP server behind assisted sockets: each Linux connect gets a server-side socket served by `handler`. */
const wasm: unknown = createRequire(import.meta.url)("undici/lib/llhttp/llhttp-wasm.js");
if (!(wasm instanceof Uint8Array)) throw new TypeError("Missing llhttp artifact");
export const module = new WebAssembly.Module(new Uint8Array(wasm));
export function fixture(handler: Parameters<typeof createHttpConnection>[3]["request"]) {
  const context = createAsyncContext(); const responses = createHttpResponses(context);
  type Endpoint = { peer: number; queue: Uint8Array<ArrayBuffer>[]; reader?: PromiseWithResolvers<AssistanceResult> };
  const endpoints = new Map<number, Endpoint>(); let connections = 0; let active = 0;
  function endpoint(fd: number): Endpoint { const value = endpoints.get(fd); if (value === undefined) throw new Error("Bad fd"); return value; }
  function push(fd: number, bytes: Uint8Array<ArrayBuffer>): void {
    const entry = endpoint(fd);
    if (entry.reader !== undefined) { const reader = entry.reader; delete entry.reader; reader.resolve({ kind: "data", bytes }); }
    else entry.queue.push(bytes);
  }
  function info(fd: number): AssistanceResult {
    return { kind: "socket", fd, local: { address: "127.0.0.1", port: fd % 2 === 0 ? 3000 : 2000 + fd }, peer: { address: "127.0.0.1", port: fd % 2 === 0 ? 2000 + fd - 1 : 3000 } };
  }
  const net = createNodeSockets({ retain: () => () => {}, callSync(operation) {
    return operation.kind === "socket-address" ? info(operation.fd) : { kind: "unit" };
  }, call(operation) {
    if (operation.kind === "socket-connect-local") {
      const client = ++connections * 2 - 1; const server = client + 1;
      endpoints.set(client, { peer: server, queue: [] }); endpoints.set(server, { peer: client, queue: [] });
      const socket = new net.Socket({ fd: server, allowHalfOpen: true });
      createHttpConnection(socket, module, context, { Response: responses.ServerResponse, request: handler, upgrade: () => false, clientError: () => false, closed() {} });
      return Promise.resolve(info(client));
    }
    if (operation.kind === "socket-read") {
      const entry = endpoint(operation.fd); const bytes = entry.queue.shift();
      if (bytes !== undefined) return Promise.resolve({ kind: "data", bytes });
      const reader = Promise.withResolvers<AssistanceResult>(); entry.reader = reader; return reader.promise;
    }
    if (operation.kind === "socket-write") { push(endpoint(operation.fd).peer, operation.bytes); return Promise.resolve({ kind: "written", count: operation.bytes.length }); }
    if (operation.kind === "socket-close" || operation.kind === "socket-shutdown") {
      push(endpoint(operation.fd).peer, new Uint8Array());
      if (operation.kind === "socket-close") push(operation.fd, new Uint8Array());
    }
    return Promise.resolve({ kind: "unit" });
  } }, context);
  const retain = () => { active++; return () => { active--; }; };
  return { http: createHttpClients(net, module, context, queueMicrotask, retain), net, context, retain, connections: () => connections, active: () => active };
}
export function body(message: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    message.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Body bytes required"); chunks.push(bytes); });
    message.once("end", () => resolve(Buffer.concat(chunks).toString())); message.once("error", reject);
  });
}

