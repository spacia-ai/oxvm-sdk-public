import { keepingDependencyWrites } from "./dependency-writes.js";
import { refusingModules } from "./module-refusal.js";
import { refusingAddonLoader } from "./native-addon-refusal.js";
import type { SocketRuntime } from "./node-socket-defaults.js";
import { createNodeStreamWeb } from "./node-stream-web.ts";
import { nodeUtilTypes, exactPromiseUtilTypes } from "./node-util-types.ts";
import { createNodePerfHooks } from "./node-perf-hooks.ts";
import { createNodeDiagnosticsChannel } from "./node-diagnostics-channel.ts";
import { nodeStringDecoder } from "./node-string-decoder.ts";
import { createNodeWorkerThreads, type WorkerThreadFactory, type WorkerThreadRuntime } from "./node-worker-threads.ts";
import { createNodeInspector } from "./node-inspector.ts";
import { createNodeFilesGaps } from "./node-files-gaps.ts";
import { createNodeUtf8Stream } from "./node-files-utf8-stream.ts";
import { createTlsServers } from "./node-tls-server.ts";
import { createHttpsServers } from "./node-https-server.ts";
import { translatePeerCertificate } from "./node-tls-server-certificate.ts";
import { createNodeWebSocket } from "./node-websocket.ts";
import { createProcessMemory } from "./node-process-memory.ts";
import { createNodeChown, type ChownPorts } from "./node-files-chown.ts";
import { deferNodeDomain } from "./node-domain.ts";
import { createNodeDgram, type DgramSockets } from "./node-dgram.ts";
import { createNodeRepl } from "./node-repl.ts";
import { createNodeTraceEvents } from "./node-trace-events.ts";
import { createHttpExtras, createLegacyHttpModules } from "./node-http-extras.ts";
import { createDnsTransport, type DnsSockets } from "./node-dns-transport.ts";
import { createNodeAsyncHooks } from "./node-async-hooks.ts";
import { createNodeEvents } from "./node-events.ts";
import { createNodeBuffer } from "./node-buffer.ts";
import { createNodeTimersPromises } from "./node-timers-promises.ts";
import { createNodeExec } from "./node-exec.ts";
import { withNativeRealpath } from "./node-files-extra.ts";
import { createNodeCryptoModule } from "./node-crypto-module.ts";
import { createNodeFilesMore } from "./node-files-more.ts";
import { createNodeWriteStreams } from "./node-write-stream.js";
import { createNodeReadStreams } from "./node-read-stream.js";
import { createNodeReadline, createNodeReadlinePromises } from "./node-readline.ts";
import { invalidArgType } from "./node-arg-type.ts";
import { nodePunycode } from "./node-punycode.ts";
import { fsModeConstants, nodeConstantsModule, osExtraConstants } from "./node-constants.ts";
import { createProcessExtras, NODE_24_VERSIONS } from "./node-process-extras.ts";
import { nodeStreamConsumers } from "./node-stream-consumers.ts";
import { HttpOutgoing } from "./node-http-outgoing.js";
import { evaluateContextData } from "./node-vm-data.js";
import { createNodeVm, realmEvaluator } from "./node-vm.ts";
import { createNodeWatchers } from "./node-watch.ts";
import { createNodeZlib } from "./node-zlib-stream.ts";
import { createNodeBrotli } from "./node-brotli.ts";
import { ProcessScheduler } from "./process-scheduler.js";
import { createHttpServers } from "./node-http-server.ts";
import { createHttpValidators } from "./node-http-validators.ts";
import { createNodeHttp2 } from "./node-http2.js";
import { createNodeTls } from "./node-tls.ts";
import { createHttpClients } from "./node-http-client.ts";
import { createNodeReport } from "./node-report.js";
import { createNodeV8 } from "./node-memory.ts";
import { nodeSqlite } from "./node-sqlite.js";
import { createNodeWasi } from "./node-wasi.ts";
import type { WasiHost } from "../../../wasm/kit/wasi/host.js";
import { clearRefusedNodeApi, refusedNodeApi, unavailableNodeApi } from "./node-capability.ts";
import { nodeAssert } from "./node-assert.ts";
import { createWarningPrinter } from "./node-warnings.ts";
import { NEXT_MEMORY_EXCEPTION } from "./next-memory.ts";
import { createNodeNet } from "./node-net.ts";
import { Buffer } from "buffer";
import { createProcessDirectory } from "./node-process-directory.ts";
import { nodeQuerystring } from "./node-querystring.ts";
import { createProcessKill, deliverProcessSignal, installProcessIpc, installSignalListeners, endNodeProcess, NodeProcess, validateNodeEnvironment, type ProcessBuildMetadata } from "./node-process.ts";
import { createForkedChildren } from "./node-fork.ts";
import { deliverProcessException } from "./node-exceptions.js";
import { createIpcChannel } from "./node-ipc.ts";
import type { ModuleDependencyIdentity, ModulePathInfo } from "./module-files.js";
import type { AssistanceCompiler } from "./compiler.js";
import type { ProcessRuntimeIO } from "./process-io.js";
import { createAsyncContext } from "./async-context.js";
import { installPromiseContext } from "./promise-context.js";
import { installSchedulingContext } from "./scheduling-context.js";
import { installCallSites } from "./call-sites.ts";
import { installExecutableStacks } from "./executable-stacks.js";
import { installFunctionSources } from "./function-sources.js";
import { createGetBuiltinModule } from "./node-builtin-module.js";
import { createNodeStatfs } from "./node-statfs.js";
import type { FileSystemStats } from "../../js-process/filesystem-stat.js";
import { createProcessBinding } from "./node-process-binding.js";
import { installNodeFetch } from "./node-fetch.js";
import { installNodeBodies } from "./node-web-bodies.js";
import { installGeneratedFunctions } from "./generated-functions.js";
import { Console, context as consoleContext, createNodeConsole, createTask } from "./node-console.ts";
import { createProcessTimers } from "./process-timers.js";
import { createSyncFiles, createAsyncFiles } from "./node-files.ts";
import { createGuestModules } from "./guest-modules.js";
import { createNativeChildren } from "./node-children.ts";
import { createNodePath } from "./node-path.ts";
import { createNodeOs, createProcessIdentity } from "./node-os.ts";
import { createNodeUrl } from "./node-url.ts";
import { createNodeDns } from "./node-dns.ts";
import { createNodeCrypto } from "./node-crypto.ts";
import { createNodeUtil, nodeUtil } from "./node-util.ts";
import { Stats } from "./node-stats.ts";
import { NEXT_COMPILER_BUILTIN, NEXT_COMPILER_DIRECTORY, nextCompilerEnvironment, verifyNextCompilerFacade, type NextCompilerBindings } from "./next-compiler.js";
import { createInputStream, createOutputStream, createNodeStreamModule, EventEmitter, sendBufferedOutput } from "./node-streams.ts";
import { createLocalModuleLoader } from "./module-loader.js";
import { observeRefusals } from "../../errors.js";
import { lateFailureOf, lateFailureReporter, type LateFailure, type TrialFailure } from "../../js-process/late-failure.js";
import { probeAddon } from "./trial-load.js";
import { installProxyRegistry } from "../../proxy-brand.js";
import { guardMissingExports } from "./builtin-guard.ts";
import { BUN_BUILTIN_EXPORTS, NODE_BUILTIN_EXPORTS } from "./builtin-exports.generated.ts";

export interface LocalProcessStart {
  /** `probe`: an ADR 0026 trial load, which requires one add-on and runs no application code. */
  readonly entry: { readonly kind: "file" | "probe"; readonly path: string } | { readonly kind: "eval"; readonly code: string };
  readonly cwd: string;
  readonly args: readonly string[];
  readonly argvEntry?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly dependencies?: ModuleDependencyIdentity;
  readonly ipc?: MessagePort;
  readonly execArgv?: readonly string[];
}

export interface ProcessRuntime {
  readonly socketRuntime?: SocketRuntime;
  readonly umask?: (mask?: unknown) => number;
  readonly modulePathInfo?: (path: string) => ModulePathInfo;
  /** The Linux ports `node:wasi` runs on. Without them the built-in is not provided. */
  readonly wasiHost?: WasiHost;
  /** Filesystem statistics from Linux, for `fs.statfs`. */
  readonly fileSystems?: FileSystemStats;
  /** Linux changes a file's owner through its own operations; a process without this port has no `fs.chown`. */
  readonly ownership?: Pick<ChownPorts, "callSync" | "call">;
  /** The VM sockets the resolver queries through; without them `dns.resolve*` finds no server. */
  readonly dnsSockets?: DnsSockets;
  /** Linux's UDP sockets for `node:dgram`; a process without them has no datagram sockets. */
  readonly dgramSockets?: DgramSockets;
  readonly compiler: AssistanceCompiler;
  readonly systemSource: string;
  readonly httpParser: WebAssembly.Module;
  readonly metadata: {
    readonly nodeVersion: string;
    readonly execPath: string;
    readonly argv0: string;
    readonly isMainThread?: boolean;
    readonly versions?: Readonly<Record<string, string>>;
    readonly processBuild?: ProcessBuildMetadata;
  };
  readonly nextCompiler?: NextCompilerBindings;
  readonly contextScripts?: "data";
  readonly unhandledException?: (error: unknown) => void;
  /** Receives an uncaught fast-path limitation before the process exits, so Rust can remember the
   * program and its next run uses Linux (ADR 0026). */
  readonly lateFailure?: (failure: LateFailure) => void;
  /** Receives why a trial load's add-on failed to load, before the trial exits. */
  readonly trialFailure?: (failure: TrialFailure) => void;
  readonly loadNative?: (path: string) => unknown;
  readonly exactPromiseQueries?: boolean;
  readonly workerThreads?: WorkerThreadFactory;
  readonly tty?: Readonly<Record<string, unknown>>;
}

/** The shared Node runtime uses Linux services supplied by its admitted process owner. */
/** Node gives its constant tables no prototype. */
function withoutPrototype<T extends object>(value: T): T { Object.setPrototypeOf(value, null); return value; }

export async function runLocalProcess(start: LocalProcessStart, io: ProcessRuntimeIO, runtime: ProcessRuntime): Promise<void> {
  const { compiler, systemSource, httpParser } = runtime;
  const entry = start.entry.kind === "eval" ? "[worker eval]" : start.entry.path;
  const executionOptions = validateNodeEnvironment(start.env, entry, start.execArgv, runtime.socketRuntime?.runtime ?? "node");
  if ((start.env["EXPERIMENTAL_DEBUG_MEMORY_USAGE"] ?? "") !== "") unavailableNodeApi("Next memory debugging");
  const context = createAsyncContext();
  const scheduler = new ProcessScheduler(context, error => io.fail(error), () => input.hasReferences || timers.hasReferences || io.hasPending || children.hasPending || forked.hasPending || ipcReferenced() || (threads?.hasPending ?? false) || stdout.writableLength !== 0 || stderr.writableLength !== 0);
  io.setCallbackScheduler(callback => scheduler.enqueue(callback));
  const restore: (() => void)[] = [];
  const nativeTimeout = globalThis.setTimeout.bind(globalThis);
  const directory = createProcessDirectory(operation => io.callSync(operation), start.cwd, runtime.metadata.isMainThread ?? true);
  const dependencyWrites = keepingDependencyWrites();
  const inspectArgument = (value: unknown, options: { readonly depth: -1 }): string => nodeUtil.inspect(value, options);
  const files = createSyncFiles(dependencyWrites.sync(operation => io.callSync(operation)), directory.cwd, io.copyOpenMode, inspectArgument);
  const asynchronous = createAsyncFiles(dependencyWrites.asynchronous(operation => io.call(operation)), directory.cwd, context, () => io.retain(), callback => scheduler.enqueue(callback), { ...(io.copyOpenMode === undefined ? {} : { copyOpenMode: io.copyOpenMode }), inspect: inspectArgument });
  const addons = runtime.loadNative === undefined ? undefined : refusingAddonLoader(runtime.loadNative);
  const admitted = refusingModules(createGuestModules(files, start.dependencies, addons === undefined ? undefined : (...input) => addons.load(...input), runtime.modulePathInfo, executionOptions.conditions)), modules = admitted.modules;
  const input = createInputStream(context);
  io.setInput(bytes => input.receive(bytes).catch((error: unknown) => { io.applicationException(error); }));
  const children = createNativeChildren(io, context, start.env, scheduler);
  const execArgv = [...(start.execArgv ?? [])];
  const forked = createForkedChildren(io, context, start.env, () => directory.cwd(), execArgv, { scheduler, execPath: runtime.metadata.execPath });
  let ipcReferenced = (): boolean => false;
  const stdout = createOutputStream(bytes => io.output("stdout", bytes), context);
  const stderr = createOutputStream(bytes => io.output("stderr", bytes), context);
  // An exiting process still owes the output it has written: what waits behind an unacknowledged write is sent
  // ahead of the exit. Traffic beyond the pending window is dropped; the window bounds it.
  const flushOutput = (): void => {
    for (const [name, stream] of [["stdout", stdout], ["stderr", stderr]] as const) {
      // `output` posts its event before its first await, so the event precedes the exit request.
      sendBufferedOutput(stream, bytes => {
        try { const sent = io.output(name, bytes); if (sent !== undefined) sent.catch(() => undefined); }
        catch { /* Beyond the pending window: dropped. */ }
      });
    }
  };
  stdout.on("error", error => io.fail(error));
  stderr.on("error", error => io.fail(error));
  const execPath = runtime.metadata.execPath;
  const process = Object.assign(new NodeProcess(code => { lateFailures.exited(code); flushOutput(); return io.terminate(code); }, runtime.metadata.nodeVersion, undefined, scheduler.nextTick, runtime.metadata.processBuild), {
    stdin: input.stream, stdout, stderr, nextTick: scheduler.nextTick,
    execPath,
    platform: "linux", arch: "x64",
    kill: createProcessKill(io.signalProcess?.bind(io)),
    argv: [execPath, start.argvEntry ?? entry, ...start.args],
    ...(runtime.loadNative === undefined ? {} : { report: createNodeReport(files, runtime.metadata.nodeVersion) }),
    execArgv, argv0: runtime.metadata.argv0,
    // Node's own component versions; what the image recorded about its runtime wins. Bun reports only its own.
    ...(runtime.socketRuntime?.runtime === "bun" ? (runtime.metadata.versions === undefined ? {} : { versions: Object.freeze({ ...runtime.metadata.versions }) })
      : { versions: Object.freeze({ ...NODE_24_VERSIONS, node: runtime.metadata.nodeVersion, ...runtime.metadata.versions }) }),
    env: runtime.nextCompiler === undefined ? { ...start.env } : nextCompilerEnvironment(start.env),
    ...directory,
    ...(runtime.umask === undefined ? {} : { umask: runtime.umask }),
  });
  const processIdentity = createProcessIdentity(files);
  Object.defineProperties(process, Object.getOwnPropertyDescriptors(processIdentity));
  // Node's read-only aliases of the execution options, each defined when truthy (ADR 0026, 1.11).
  for (const [name, value] of [["_preload_modules", [...executionOptions.require]], ["noDeprecation", !executionOptions.deprecation], ["noProcessWarnings", !executionOptions.warnings]] as const) {
    if (value !== false) Object.defineProperty(process, name, { value, writable: false, enumerable: true, configurable: true });
  }
  let threads: WorkerThreadRuntime | undefined;
  if (start.ipc !== undefined) {
    // A forked child: its parent's private channel, never the broker's port.
    const channel = createIpcChannel(start.ipc, { context, deliver: callback => scheduler.enqueue(callback),
      onMessage: value => { process.emit("message", value); }, onDisconnect: () => { process.emit("disconnect"); } });
    installProcessIpc(process, channel);
    ipcReferenced = () => channel.hasReferences;
  }
  io.setSignals(signal => scheduler.run(() => { lateFailures.signalled(); deliverProcessSignal(process, signal, ended => { io.signalExit(ended); return io.halt(); }); }));
  if (io.watchSignal !== undefined) installSignalListeners(process, (signal, watching) => { io.watchSignal?.(signal, watching); });
  if (executionOptions.warnings && start.env["NODE_NO_WARNINGS"] !== "1") {
    process.on("warning", createWarningPrinter(process, text => { stderr.write(text); }, () => processIdentity.pid));
  }
  const writeConsole = (stream: "stdout" | "stderr", values: readonly unknown[]): void => {
    const text = nodeUtil.format(...values);
    (stream === "stdout" ? stdout : stderr).write(`${text}\n`);
  };
  clearRefusedNodeApi();
  // The built-ins, created below, name the first missing export a process touched (ADR 0026).
  let touched: () => LateFailure | undefined = () => undefined;
  // The first refusal the process met, also one the program caught and answered with its own failure.
  let refusal: LateFailure | undefined;
  observeRefusals(error => { refusal ??= lateFailureOf(error); });
  const lateFailures = lateFailureReporter(error => { writeConsole("stderr", [error]); }, runtime.lateFailure, () => addons?.refused() ?? admitted.refused() ?? dependencyWrites.refused() ?? refusedNodeApi() ?? touched() ?? refusal);
  const printException = (error: unknown): void => { lateFailures.uncaught(error); };
  // process.setUncaughtExceptionCaptureCallback's callback, once the process object has it.
  let captureCallback: () => ((error: unknown) => void) | undefined = () => undefined;
  const exception: Parameters<ProcessRuntimeIO["setExceptionHandler"]>[0] = (error, origin, promise) => deliverProcessException(process, error, origin, printException, runtime.unhandledException, promise, () => captureCallback());
  scheduler.setExceptionHandler(error => exception(error, "uncaughtException"));
  io.setExceptionHandler(exception);
  function install(name: string, value: unknown): void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, previous);
    });
  }
  restore.push(installPromiseContext(context, globalThis));
  restore.push(installSchedulingContext(context, globalThis));
  const timers = createProcessTimers(globalThis, context, callback => scheduler.enqueue(callback));
  const watchers = createNodeWatchers(io, context, scheduler);
  let streams: ReturnType<typeof createNodeStreamModule> | undefined;
  try {
    threads = runtime.workerThreads?.(context, scheduler, process);
    streams = createNodeStreamModule(context, () => io.retain(), scheduler.nextTick, { stdout, stderr });
    const timerExports = { setTimeout: timers.setTimeout, setInterval: timers.setInterval,
      clearTimeout: timers.clear, clearInterval: timers.clear, setImmediate: scheduler.setImmediate, clearImmediate: scheduler.clearImmediate };
    const console = Object.assign(createNodeConsole((stream, text) => { (stream === "stdout" ? stdout : stderr).write(`${text}\n`); }, nodeUtil.format),
      { Console: class BoundConsole extends Console { constructor(options: unknown) { super(options, nodeUtil.format); } }, context: consoleContext, createTask });
    const crypto = createNodeCrypto(() => io.retain(), scheduler);
    restore.push(crypto.restore);
    const linuxText = (path: string): string | undefined => { try { return String(files.readFileSync(path, "utf8")); } catch { return undefined; } };
    const dns = createNodeDns(children, context, stderr, callback => scheduler.enqueue(callback), {
      retain: () => io.retain(),
      ...(runtime.dnsSockets === undefined ? {} : { transport: createDnsTransport(runtime.dnsSockets, linuxText) }),
      // Lookups are answered in the process, from the hosts file and the VM's resolver: compared with the guest's
      // own Node in a VM with a network, and falling back to that Node when the resolver configuration is unreadable.
      fastLookup: true,
    });
    const net = createNodeNet(io, context, scheduler, runtime.socketRuntime === undefined ? undefined : { defaults: runtime.socketRuntime, lookup: dns.lookup });
    const tls = createNodeTls(children, context, () => io.retain(), scheduler, { readFile: path => String(files.readFileSync(path, "utf8")), env: () => process.env });
    // A TLS server runs in a helper in the guest, as HTTP/2 servers do: the engine's TLS is a client only.
    const tlsServers = createTlsServers({ children, context, retain: () => io.retain(), scheduler, tls, net });
    // Assigned, not spread: reading `rootCertificates` would load the CA bundle at start.
    Object.assign(tls, tlsServers);
    const webSocket = createNodeWebSocket({ net, tls, retain: () => io.retain(), dispatch: callback => { scheduler.enqueue(callback); }, context, unsupported: feature => unavailableNodeApi(feature) });
    const buffer = createNodeBuffer(globalThis, Buffer, runtime.socketRuntime?.runtime ?? "node");
    const nodePath = createNodePath(directory.cwd, (value, options) => nodeUtil.inspect(value, options));
    const fsConstants = Object.freeze(withoutPrototype({ ...files.constants, ...fsModeConstants }));
    const filesMore = createNodeFilesMore(asynchronous.promises);
    // Linux answers statfs through its own operation; a process without that port has no fs.statfs.
    const statfs = runtime.fileSystems === undefined ? undefined : createNodeStatfs(runtime.fileSystems, { retain: () => io.retain(), dispatch: callback => { scheduler.enqueue(callback); }, context });
    const readStreams = createNodeReadStreams((path, flags) => asynchronous.promises.open(path, flags), context);
    const writeStreams = createNodeWriteStreams((path, flags, mode) => asynchronous.promises.open(path, flags, mode), context);
    const fileGaps = createNodeFilesGaps({
      files, asynchronous, ReadStream: readStreams.ReadStream, WriteStream: writeStreams.WriteStream, watch: watchers.watch,
      timers: { setInterval: timers.setInterval, clearInterval: timers.clear }, retain: () => io.retain(), dispatch: callback => { scheduler.enqueue(callback); },
      nextTick: callback => { scheduler.nextTick(callback); }, context, cwd: directory.cwd, warn: (message, type) => { process.emitWarning(message, type); },
    });
    const chown = runtime.ownership === undefined ? undefined : createNodeChown({ ...runtime.ownership, failed: (code, path) => { dependencyWrites.path(code, path); } }, { retain: () => io.retain(), dispatch: callback => { scheduler.enqueue(callback); }, context });
    // A FileHandle changes its own file's owner; a closed one answers as Node's does, before any argument is read.
    const openFile: typeof fileGaps.promises.open = chown === undefined ? fileGaps.promises.open : async (...input) => {
      const handle = await fileGaps.promises.open(...input);
      Object.defineProperty(handle, "chown", { configurable: true, writable: true, enumerable: false, value: (uid: unknown, gid: unknown): Promise<void> =>
        handle.fd === -1 ? Promise.reject(Object.assign(new Error("file closed"), { code: "EBADF", syscall: "fchown" })) : chown.handleChown(handle.fd, uid, gid) });
      return handle;
    };
    const filePromises = { ...filesMore.promises, ...fileGaps.promises, open: openFile, ...chown?.promises, constants: fsConstants, ...(statfs === undefined ? {} : { statfs: statfs.promises.statfs }) };
    const util = createNodeUtil(process, line => { stderr.write(`${line}\n`); }, runtime.exactPromiseQueries === true);
    const asyncHooks = createNodeAsyncHooks(context, util);
    const events = createNodeEvents(EventEmitter, asyncHooks, scheduler.nextTick);
    restore.push(events.restore);
    // Before the guard below, which reports a real export this process object lacks. The loader exists after it.
    let builtinModule: (id: string) => unknown = () => undefined;
    const linuxOs = createNodeOs(files, process.env, io.networkInterfaces?.bind(io));
    // Node's key order; a fresh object so `dlopen` and `priority` stay assignable as in Node.
    const os = { ...linuxOs, constants: withoutPrototype({ UV_UDP_REUSEADDR: osExtraConstants.UV_UDP_REUSEADDR, dlopen: { ...osExtraConstants.dlopen }, errno: linuxOs.constants.errno, signals: linuxOs.constants.signals, priority: { ...osExtraConstants.priority } }) };
    // Node keeps a fixed pool of HTTP parsers; this runtime has none to size.
    const setMaxIdleHTTPParsers = (max: unknown): void => {
      if (typeof max !== "number") throw invalidArgType("max", "number", max, inspectArgument);
      const range = (rule: string): RangeError => Object.assign(new RangeError(`The value of "max" is out of range. It must be ${rule}. Received ${String(max)}`), { code: "ERR_OUT_OF_RANGE" });
      if (!Number.isInteger(max)) throw range("an integer");
      if (max < 1 || max > Number.MAX_SAFE_INTEGER) throw range(">= 1 && <= 9007199254740991");
    };
    const extras = createProcessExtras({
      process, now: () => performance.now(), memory: () => ({ total: os.totalmem(), free: os.freemem() }), mainModule: () => { const cache: unknown = Reflect.get(Object(builtinModule("module")), "_cache"); if (typeof cache !== "object" || cache === null) return undefined; const main: unknown = Reflect.get(cache, entry); return main; },
      readFile: path => String(files.readFileSync(path, "utf8")), format: (...values) => nodeUtil.format(...values), writeError: text => { stderr.write(text); },
      fatal: error => exception(error, "uncaughtException"), inspect: inspectArgument,
      ...(io.signalProcess === undefined ? {} : { kill: (pid: number, signal: number) => { io.signalProcess?.(pid, signal); return 0; } }),
    });
    Object.defineProperties(process, extras.descriptors);
    // rss is the Linux task's; the JavaScript heap is the browser's and has no measurement here, so memoryUsage() itself refuses.
    Object.defineProperty(process, "memoryUsage", { value: createProcessMemory({ readProc: path => { const text: unknown = files.readFileSync(path, "utf8"); return typeof text === "string" ? text : undefined; } }).memoryUsage, writable: true, enumerable: true, configurable: true });
    captureCallback = () => extras.captureCallback();
    const readline = createNodeReadline({ nextTick: scheduler.nextTick });
    const vm = createNodeVm(realmEvaluator(), runtime.contextScripts === "data" ? (source, context, filename): unknown => evaluateContextData(source, context, filename, loader.sources) : undefined);
    const repl = createNodeRepl({
      readline, runInThisContext: (code, options) => vm.runInThisContext(code, options), inspect: util.inspect, deprecate: (fn, message, code) => util.deprecate(fn, message, code),
      isProxy: value => util.types.isProxy(value), files, process, nextTick: callback => { scheduler.nextTick(callback); },
      // The loader that knows the list exists after this table.
      builtinModules: () => { const names: unknown = Reflect.get(Object(builtinModule("module")), "builtinModules"); return Array.isArray(names) ? names.map(String) : []; },
      require: id => builtinModule(id), pendingDeprecation: execArgv.includes("--pending-deprecation"),
    });
    restore.push(repl.restore);
    const dgram = runtime.dgramSockets === undefined ? undefined : createNodeDgram({
      sockets: runtime.dgramSockets, retain: () => io.retain(), dispatch: callback => { scheduler.enqueue(callback); }, nextTick: callback => { scheduler.nextTick(callback); },
      lookup: dns.lookup, warn: (message, type, code) => { process.emitWarning(message, type, code); },
    });
    Object.assign(process, { getBuiltinModule: createGetBuiltinModule(id => builtinModule(id), inspectArgument), binding: createProcessBinding({ fs: fsConstants, os: os.constants }) });
    const timersPromises = createNodeTimersPromises(timerExports);
    const http = { maxHeaderSize: 16_384, OutgoingMessage: HttpOutgoing, setMaxIdleHTTPParsers, ...createHttpValidators(nodeUtil.format), ...createHttpServers(net, httpParser, context), ...createHttpClients(net, httpParser, context, scheduler.nextTick, () => io.retain()), ...createHttpExtras(() => process.env), WebSocket: webSocket.WebSocket, CloseEvent: webSocket.CloseEvent, MessageEvent: webSocket.MessageEvent };
    const httpsServers = createHttpsServers(tlsServers, http);
    const inspector = createNodeInspector({ emitWarning: message => { process.emitWarning(message); } });
    const fileModule = withNativeRealpath({ ...files, ...asynchronous, constants: fsConstants, Stats: util.deprecate(Stats, "fs.Stats constructor is deprecated.", "DEP0180"), promises: filePromises, ...(statfs === undefined ? {} : { statfs: statfs.statfs, statfsSync: statfs.statfsSync }), watch: watchers.watch, ...readStreams, ...writeStreams, ...fileGaps.fs, ...chown?.fs });
    // Node's port of SonicBoom writes through the module's own calls, so it is built on the assembled module.
    Object.defineProperty(fileModule, "Utf8Stream", { configurable: true, enumerable: true, writable: true, value: createNodeUtf8Stream({
      fs: fileModule, timers: { setTimeout: timers.setTimeout, setInterval: timers.setInterval, clearInterval: timers.clear }, nextTick: callback => { scheduler.nextTick(callback); },
      retain: () => io.retain(), dirname: nodePath.dirname, EventEmitter: events.module,
    }).Utf8Stream });
    const builtins = {
      fs: fileModule, "fs/promises": filePromises,
      tls, https: { ...createHttpClients({ createConnection: tls.connect }, httpParser, context, scheduler.nextTick, () => io.retain(), "https:"), Server: httpsServers.Server, createServer: httpsServers.createServer },
      _tls_wrap: { TLSSocket: tls.TLSSocket, Server: tlsServers.Server, createServer: tlsServers.createServer, connect: tls.connect },
      _tls_common: { SecureContext: tls.SecureContext, createSecureContext: tls.createSecureContext, translatePeerCertificate },
      http2: createNodeHttp2(children, context, () => io.retain(), scheduler, message => { process.emitWarning(message); }),
      assert: nodeAssert, "assert/strict": nodeAssert.strict, constants: nodeConstantsModule, punycode: nodePunycode,
      dns, "dns/promises": dns.promises, buffer, async_hooks: asyncHooks,
      path: nodePath, process, console, timers: { ...timerExports, promises: timersPromises }, child_process: { ChildProcess: children.ChildProcess, spawn: children.spawn, fork: forked.fork, ...createNodeExec(children.spawn, io.captureSync?.bind(io), process.env, bytes => { stderr.write(bytes); }, runtime.socketRuntime?.runtime ?? "node") },
      events: events.module, stream: streams.module, "stream/promises": streams.module.promises, "stream/web": createNodeStreamWeb(globalThis),
      "timers/promises": timersPromises, "path/posix": nodePath.posix, "path/win32": nodePath.win32, readline, "readline/promises": createNodeReadlinePromises(readline),
      "stream/consumers": nodeStreamConsumers, _stream_readable: streams.module.Readable, _stream_writable: streams.module.Writable, _stream_duplex: streams.module.Duplex,
      _stream_transform: streams.module.Transform, _stream_passthrough: streams.module.PassThrough, sys: util,
      vm, repl: repl.module, trace_events: createNodeTraceEvents({ emitWarning: message => { process.emitWarning(message); } }),
      // Loaded on first use: the module changes how every emitter is created and how uncaught errors are routed.
      domain: deferNodeDomain({ events: events.module, createHook: (callbacks: unknown) => asyncHooks.createHook(callbacks), process, install: (reset: () => void) => { restore.push(reset); } }),
      ...(dgram === undefined ? {} : { dgram }),
      "util/types": runtime.exactPromiseQueries === true ? exactPromiseUtilTypes : nodeUtilTypes, perf_hooks: createNodePerfHooks(globalThis, { timers: { setInterval: (callback, delay) => timers.setInterval(callback, delay), clearInterval: handle => { timers.clear(handle); } }, install: reset => { restore.push(reset); } }), diagnostics_channel: createNodeDiagnosticsChannel(),
      string_decoder: nodeStringDecoder, worker_threads: threads?.module ?? createNodeWorkerThreads(globalThis, { clientId: () => `node-${String(processIdentity.pid)}-0` }), inspector: inspector.module, "inspector/promises": inspector.promises,
      os, net, http, ...createLegacyHttpModules(http),
      zlib: { ...createNodeZlib(context, scheduler), ...createNodeBrotli(children, context, () => io.retain(), scheduler) },
      querystring: nodeQuerystring, url: createNodeUrl(directory.cwd), util, crypto: createNodeCryptoModule(crypto.module, { retain: () => io.retain(), dispatch: callback => { scheduler.enqueue(callback); } }, (fn, message, code) => util.deprecate(fn, message, code), (message, type, code) => { process.emitWarning(message, type, code); }), v8: createNodeV8({ promises: context.resources }), sqlite: nodeSqlite,
      ...(runtime.wasiHost === undefined ? {} : { wasi: createNodeWasi({ host: runtime.wasiHost, exit: code => process.exit(code) }) }),
      ...(runtime.tty === undefined ? {} : { tty: runtime.tty }),
      ...(runtime.nextCompiler === undefined ? {} : { [NEXT_COMPILER_BUILTIN]: runtime.nextCompiler }),
    };
    const realExports = (runtime.socketRuntime?.runtime ?? "node") === "bun" ? BUN_BUILTIN_EXPORTS : NODE_BUILTIN_EXPORTS;
    touched = guardMissingExports(builtins, realExports);
    const loader: ReturnType<typeof createLocalModuleLoader> = createLocalModuleLoader(compiler, systemSource, modules, builtins, directory.cwd, { realExports, readSource: path => String(files.readFileSync(path, "utf8")), process: { get env() { return process.env; }, execPath, get argv() { return process.argv; }, emitWarning: (message, type) => { process.emitWarning(message, type); } }, onNextMemoryException: path => writeConsole("stderr", [
      `[oxidevm experimental ${NEXT_MEMORY_EXCEPTION}] Applied to ${path}; memory tracing, automatic heap overrides and proactive heap-threshold restart are unavailable. Dependency generation: ${start.dependencies?.generation ?? "none"}.`,
    ]) });
    builtinModule = id => loader.require(id);
    const setSourceMapsEnabled = (enabled: unknown): void => {
      loader.sources.setSourceMapsSupport(enabled, { nodeModules: enabled, generatedCode: enabled });
    };
    setSourceMapsEnabled(executionOptions.sourceMaps);
    Object.assign(process, { setSourceMapsEnabled });
    Object.defineProperty(process, "sourceMapsEnabled", { configurable: true, enumerable: true,
      get: () => loader.sources.getSourceMapsSupport().enabled });
    // The formatter owns Error.prepareStackTrace; outside V8 the call-site module is what calls it.
    const stacks = installExecutableStacks(loader.sources, globalThis);
    restore.push(stacks.restore);
    restore.push(installCallSites(globalThis));
    // Before application code: V8 can tell a Proxy apart and Node-API add-ons rely on it.
    restore.push(installProxyRegistry(globalThis));
    install("process", process);
    install("global", globalThis);
    install("Buffer", Buffer);
    install("atob", buffer.atob);
    install("btoa", buffer.btoa);
    install("console", console);
    for (const [name, value] of Object.entries(timerExports)) install(name, value);
    // An installed task runs the Next profile, whose webpack development
    // output evaluates module sources through direct eval; local scripts keep
    // refusing eval so every generated source crosses the compiler boundary.
    restore.push(installGeneratedFunctions(compiler, globalThis, loader.sources, { eval: start.dependencies === undefined ? "refuse" : "native",
      importModule: (specifier, options) => loader.import(specifier, undefined, options) }));
    restore.push(installFunctionSources(globalThis, loader.functionSources));
    // Node's Request and Response read a Node stream given as a body; the browser's would stringify it.
    restore.push(installNodeBodies(globalThis));
    // Node's fetch goes through the process's own HTTP clients, so it reaches what the VM reaches; the worker's does not.
    // Node's WebSocket goes through the process's own sockets; the worker's would connect from the page's network.
    restore.push(webSocket.install(globalThis));
    restore.push(installNodeFetch(globalThis, { http: (options, callback) => builtins.http.request(options, callback), https: (options, callback) => builtins.https.request(options, callback),
      decoders: { gzip: () => builtins.zlib.createGunzip(), deflate: () => builtins.zlib.createInflate(), br: () => builtins.zlib.createBrotliDecompress() } }));
    io.ready(input.readRequested, input.closed);
    // Older guest dialects retain local-script execution without this image
    // asset. Installed tasks require the version-matched compiler handoff.
    if (runtime.nextCompiler !== undefined && start.dependencies !== undefined) verifyNextCompilerFacade(files.readFileSync(`${NEXT_COMPILER_DIRECTORY}/wasm.js`, "utf8"));
    try {
      const source = start.entry;
      // A trial load requires its add-on like an application would, so the initializer sees an
      // installed runtime, then exits at once.
      if (source.kind === "probe") io.terminate(probeAddon(path => scheduler.run(() => loader.require(path)), source.path, runtime.trialFailure ?? (() => undefined)));
      // --require modules run first, in the entry's own turn as in Node (ADR 0026, 1.11).
      const preload = () => { if (executionOptions.require.length !== 0) loader.preload(executionOptions.require); };
      if (source.kind === "eval") scheduler.run(() => { preload(); loader.evaluateScript(source.code, install); });
      else if (modules.read(source.path).format === "module") { scheduler.run(preload); await loader.import(source.path); }
      else scheduler.run(() => { preload(); loader.require(source.path); });
    } catch (error) { if (!scheduler.handleException(error)) throw error; }
    const hasWork = () => scheduler.hasPending || input.hasReferences || timers.hasReferences || io.hasPending || children.hasPending || forked.hasPending || ipcReferenced() || (threads?.hasPending ?? false) || stdout.writableLength !== 0 || stderr.writableLength !== 0;
    do {
      await scheduler.idle();
      await timers.idle();
      await io.drain();
      await children.idle();
      await forked.idle();
      await threads?.idle();
      await input.idle();
      // Let application promise continuations settle before the next idle check.
      await new Promise<void>(resolve => { nativeTimeout(resolve, 0); });
      if (!hasWork()) {
        scheduler.run(() => process.emit("beforeExit", process.exitCode ?? 0));
        // Re-enter the idle wait before a short timer can complete and hide
        // the work admitted by this listener (including browser timer clamping).
        if (hasWork()) continue;
        await new Promise<void>(resolve => { nativeTimeout(resolve, 0); });
      }
    } while (hasWork());
    endNodeProcess(process, "drained");
  } finally {
    // Destroying standard streams schedules close notifications. At this point
    // process I/O may already be closed; teardown must not admit new activity.
    watchers.dispose();
    threads?.dispose();
    streams?.restore();
    context.resources.dispose();
    timers.dispose();
    scheduler.dispose();
    input.stream.destroy(); stdout.destroy(); stderr.destroy();
    for (const reset of restore.reverse()) reset();
  }
}
