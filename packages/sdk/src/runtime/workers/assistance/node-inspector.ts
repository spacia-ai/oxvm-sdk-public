import { VMError } from "../../errors.ts";
import { named, validateObject } from "./node-util-validators.ts";

function unsupported(name: string): () => never {
  return () => { throw new VMError("FEATURE_NOT_AVAILABLE", `inspector.${name} is not supported in the assisted process`, { builtin: "inspector", export: name }); };
}

/** Pins the `name` and `length` a program can read; the parameters themselves are never used. */
function shaped<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return named(target, name);
}

const NETWORK_EVENTS = ["requestWillBeSent", "responseReceived", "loadingFinished", "loadingFailed", "dataSent", "dataReceived", "webSocketCreated", "webSocketClosed", "webSocketHandshakeResponseReceived"] as const;
const DOM_STORAGE_EVENTS = ["domStorageItemAdded", "domStorageItemRemoved", "domStorageItemUpdated", "domStorageItemsCleared", "registerStorage"] as const;
const CONSOLE_METHODS = ["debug", "error", "info", "log", "warn", "dir", "dirxml", "table", "trace", "group", "groupCollapsed", "groupEnd", "clear", "count", "countReset", "assert", "profile", "profileEnd", "time", "timeLog", "timeEnd", "timeStamp"] as const;

/** What `inspector` takes from its process. */
export interface InspectorPorts {
  /** `process.emitWarning`, for the one call Node answers with a warning. Without it the call is silent. */
  readonly emitWarning?: (message: string) => void;
}

/**
 * Node's protocol-event senders (`inspector.Network`, `inspector.DOMStorage`): each checks its parameters and
 * tells the attached inspector. None is ever attached here, so after the check nothing happens, as in Node
 * without `--inspect`.
 */
function protocolEvents(names: readonly string[]): Record<string, (params?: unknown) => void> {
  const broadcast = (params: unknown = {}): void => { validateObject(params, "params"); };
  // One parameter and the event's own name, as Node's arrow functions have.
  return Object.fromEntries(names.map(name => [name, named((params: unknown): void => { broadcast(params); }, name)]));
}

/** `inspector.console`: V8's console that writes to the inspector only. With no inspector its calls do nothing. */
function inspectorConsole(): object {
  const console = {};
  Object.setPrototypeOf(console, {});
  for (const name of CONSOLE_METHODS) Object.defineProperty(console, name, { value: named((): void => undefined, name), enumerable: true, writable: true, configurable: true });
  Object.defineProperty(console, "context", { value: shaped((): object => inspectorConsole(), "context", 1), enumerable: true, writable: true, configurable: true });
  Object.defineProperty(console, Symbol.toStringTag, { value: "console", enumerable: false, writable: false, configurable: true });
  return console;
}

/**
 * The `inspector` and `inspector/promises` builtins: no inspector is ever attached to an assisted process, so
 * `url()` answers undefined and the protocol-event senders do nothing, as Node does without `--inspect`;
 * `waitForDebugger()` fails with Node's own error for that state; opening an inspector or creating a session
 * is refused explicitly, because no debugger can attach.
 */
export function createNodeInspector(ports: InspectorPorts = {}) {
  class Session {
    constructor() { unsupported("Session")(); }
    connect(): never { return unsupported("Session.connect")(); }
    connectToMainThread(): never { return unsupported("Session.connectToMainThread")(); }
    post(): never { return unsupported("Session.post")(); }
    disconnect(): never { return unsupported("Session.disconnect")(); }
  }
  named(Session, "Session");
  const post: unknown = Reflect.get(Session.prototype, "post");
  if (typeof post === "function") shaped(post, "post", 3);
  class PromiseSession extends Session {}
  named(PromiseSession, "Session");
  // Node's promisified `post`: an own, enumerable property of the promise session's prototype.
  Object.defineProperty(PromiseSession.prototype, "post", { enumerable: true, writable: true, configurable: true,
    value: shaped(async function (): Promise<never> { return Promise.resolve(unsupported("Session.post")()); }, "post", 3) });
  const put = (): void => {
    // Node registers a resource only under --experimental-inspector-network-resource, which no assisted process has.
    ports.emitWarning?.("The --experimental-inspector-network-resource option is not enabled. Please enable it to use the putNetworkResource function");
  };
  const waitForDebugger = (): never => { throw Object.assign(new Error("Inspector is not active"), { code: "ERR_INSPECTOR_NOT_ACTIVE" }); };
  const module = {
    open: shaped(unsupported("open"), "inspectorOpen", 3),
    close: named((): void => undefined, "_debugEnd"),
    url: named((): string | undefined => undefined, "url"),
    waitForDebugger: named(waitForDebugger, "inspectorWaitForDebugger"),
    console: inspectorConsole(),
    Session,
    Network: protocolEvents(NETWORK_EVENTS),
    NetworkResources: { put: shaped(put, "put", 2) },
    DOMStorage: protocolEvents(DOM_STORAGE_EVENTS),
  };
  return { module, promises: { ...module, Session: PromiseSession } };
}

/** The builtin for a process that reports no warning. */
export const nodeInspector = createNodeInspector().module;
