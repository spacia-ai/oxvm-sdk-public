import { copyOptions, present, truthy, unsupportedOption } from "./node-connect-options.js";
import { closeHttpConnections, reopenHttpConnections } from "./node-http-server.ts";
import { isEventListener } from "./node-streams.js";
import type { TlsServer, TlsServers } from "./node-tls-server.ts";
import { validateObject } from "./node-util-validators.ts";

export type HttpsServer = TlsServer & {
  timeout: number; keepAliveTimeout: number; keepAliveTimeoutBuffer: number;
  setTimeout(duration: unknown, callback?: unknown): HttpsServer;
  closeIdleConnections(): void;
  closeAllConnections(): void;
};
export type HttpsServers = {
  readonly Server: new (options?: unknown, listener?: unknown) => HttpsServer;
  readonly createServer: (options?: unknown, listener?: unknown) => HttpsServer;
};
/** The HTTP half of the process's `http` module that an HTTPS server shares: Node's `http._connectionListener`. */
export type HttpsServerPorts = { readonly _connectionListener: (this: unknown, socket: unknown) => void };

/** `http.Server` options the assisted HTTP connection does not take (plain `http.createServer` accepts none of them either). */
const UNSUPPORTED_HTTP_OPTIONS = ["IncomingMessage", "ServerResponse", "requestTimeout", "headersTimeout", "connectionsCheckingInterval", "insecureHTTPParser", "maxHeaderSize",
  "requireHostHeader", "joinDuplicateHeaders", "rejectNonStandardBodyWrites", "uniqueHeaders", "shouldUpgradeCallback"] as const;

/**
 * `https.Server` and `https.createServer`: a `tls.Server` whose accepted TLSSocket objects are served by the
 * same HTTP connection handling as `http.Server`, so requests, upgrades, CONNECT, keep-alive and the idle
 * timers behave as they do there. `req.socket` is the TLSSocket.
 */
export function createHttpsServers(tls: Pick<TlsServers, "Server">, http: HttpsServerPorts): HttpsServers {
  class Server extends tls.Server {
    timeout = 0;
    keepAliveTimeout = 5000;
    keepAliveTimeoutBuffer = 1000;
    httpAllowHalfOpen = false;
    constructor(options?: unknown, listener?: unknown) {
      const callback = typeof options === "function" ? options : listener, given = typeof options === "function" || options === null || options === undefined ? {} : options;
      validateObject(given, "options");
      const source = copyOptions(given);
      const refused = UNSUPPORTED_HTTP_OPTIONS.find(name => present(source[name]));
      if (refused !== undefined) throw unsupportedOption(refused, "https.createServer", "https");
      super({ noDelay: true, ...source, ALPNProtocols: truthy(source["ALPNProtocols"]) ? source["ALPNProtocols"] : ["http/1.1"] });
      for (const name of ["keepAliveTimeout", "keepAliveTimeoutBuffer"] as const) { const value = source[name]; if (typeof value === "number") this[name] = value; }
      this.on("secureConnection", http._connectionListener);
      if (callback !== undefined && callback !== null && callback !== false) {
        if (!isEventListener(callback)) throw new TypeError("https.Server requires a request callback");
        this.on("request", callback);
      }
      this.on("tlsClientError", (error: unknown, socket: unknown) => {
        if (this.emit("clientError", error, socket)) return;
        if (typeof socket === "object" && socket !== null && "destroy" in socket && typeof socket.destroy === "function") Reflect.apply(socket.destroy, socket, [error]);
      });
      this.on("listening", () => { reopenHttpConnections(this); });
    }
    setTimeout(duration: unknown, callback?: unknown): this {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw new RangeError("https.Server timeout must be a nonnegative finite number");
      if (callback !== undefined) {
        if (!isEventListener(callback)) throw new TypeError("https.Server timeout requires a callback");
        this.on("timeout", callback);
      }
      this.timeout = duration; return this;
    }
    override close(...args: unknown[]): this {
      super.close(args[0]); closeHttpConnections(this, "when-idle");
      return this;
    }
    closeIdleConnections(): void { closeHttpConnections(this, "idle"); }
    closeAllConnections(): void { closeHttpConnections(this, "all"); }
  }
  Object.defineProperty(Server, "name", { value: "Server" }); Object.defineProperty(Server, "length", { value: 2 });
  function createServer(options?: unknown, listener?: unknown): HttpsServer { return new Server(options, listener); }
  Object.defineProperty(createServer, "name", { value: "createServer" }); Object.defineProperty(createServer, "length", { value: 2 });
  return { Server, createServer };
}
