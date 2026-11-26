/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/process/per_thread.js (buildAllowedFlags, NodeEnvironmentFlagsSet).
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

/** The options Node.js 24.18.1 accepts in NODE_OPTIONS, in the order `process.allowedNodeEnvironmentFlags.forEach` visits them
 * (three aliases repeat an option). `node-process-extras.test.ts` keeps this list equal to the recorded controls. */
export const NODE_24_ENVIRONMENT_FLAGS: readonly string[] = Object.freeze([
  "--tls-max-v1.3", "--no-tls-max-v1.3", "--test-skip-pattern", "--use-env-proxy", "--no-use-env-proxy", "--experimental-report",
  "--experimental-modules", "--experimental-addon-modules", "--no-experimental-addon-modules", "--test-coverage-functions", "--heapsnapshot-signal",
  "--test-coverage-exclude", "--trace-env", "--no-trace-env", "--test-rerun-failures", "--experimental-detect-module",
  "--no-experimental-detect-module", "--allow-addons", "--no-allow-addons", "--experimental-abortcontroller", "--trace-promises",
  "--no-trace-promises", "--force-context-aware", "--no-force-context-aware", "--max-semi-space-size", "--perf-prof-unwinding-info", "--http-parser",
  "--experimental-fetch", "--experimental-quic", "--disable-sigusr1", "--no-disable-sigusr1", "--allow-wasi", "--no-allow-wasi",
  "--experimental-loader", "--trace-tls", "--no-trace-tls", "--permission", "--no-permission", "--expose-gc", "--diagnostic-dir",
  "--force-async-hooks-checks", "--no-force-async-hooks-checks", "--strip-types", "--no-strip-types", "--experimental-sqlite",
  "--no-experimental-sqlite", "--require-module", "--no-require-module", "--allow-inspector", "--no-allow-inspector", "--allow-fs-read",
  "--preserve-symlinks-main", "--no-preserve-symlinks-main", "--allow-fs-write", "--allow-child-process", "--no-allow-child-process",
  "--allow-worker", "--no-allow-worker", "--experimental-vm-modules", "--no-experimental-vm-modules", "--experimental-wasi-unstable-preview1",
  "--inspect-publish-uid", "--inspect-brk", "--no-inspect-brk", "--inspect-port", "--experimental-top-level-await", "--report-on-signal",
  "--no-report-on-signal", "--cpu-prof-dir", "--experimental-json-modules", "--enable-etw-stack-walking", "--max-old-space-size",
  "--perf-basic-prof", "--inspect-wait", "--no-inspect-wait", "--experimental-transform-types", "--no-experimental-transform-types", "--perf-prof",
  "--track-heap-objects", "--no-track-heap-objects", "--max-heap-size", "--jitless", "--input-type", "--enable-source-maps",
  "--no-enable-source-maps", "--max-old-space-size-percentage", "--test-only", "--no-test-only", "--dns-result-order",
  "--network-family-autoselection", "--no-network-family-autoselection", "--report-signal", "--abort-on-uncaught-exception", "--deprecation",
  "--no-deprecation", "--tls-min-v1.0", "--no-tls-min-v1.0", "--test-coverage-lines", "--test-randomize", "--no-test-randomize",
  "--trace-env-native-stack", "--no-trace-env-native-stack", "--report-exclude-network", "--no-report-exclude-network", "--throw-deprecation",
  "--no-throw-deprecation", "--trace-deprecation", "--no-trace-deprecation", "--heap-prof-dir", "--disable-wasm-trap-handler",
  "--no-disable-wasm-trap-handler", "--snapshot-blob", "--unhandled-rejections", "--watch", "--no-watch", "--test-isolation", "--entry-url",
  "--no-entry-url", "--openssl-shared-config", "--no-openssl-shared-config", "--conditions", "--heap-prof-interval", "--cpu-prof-interval",
  "--disable-proto", "--test-coverage-include", "--localstorage-file", "--trace-sigint", "--no-trace-sigint", "--import", "--cpu-prof",
  "--no-cpu-prof", "--zero-fill-buffers", "--no-zero-fill-buffers", "--experimental-webstorage", "--no-experimental-webstorage",
  "--openssl-legacy-provider", "--no-openssl-legacy-provider", "--v8-pool-size", "--force-fips", "--no-force-fips", "--experimental-shadow-realm",
  "--no-experimental-shadow-realm", "--async-context-frame", "--no-async-context-frame", "--preserve-symlinks", "--no-preserve-symlinks",
  "--experimental-global-webcrypto", "--test-reporter-destination", "--trace-env-js-stack", "--no-trace-env-js-stack", "--trace-event-file-pattern",
  "--secure-heap-min", "--trace-event-categories", "--addons", "--no-addons", "--node-memory-debug", "--experimental-specifier-resolution",
  "--network-family-autoselection-attempt-timeout", "--report-dir", "--global-search-paths", "--no-global-search-paths",
  "--experimental-global-customevent", "--trace-sync-io", "--no-trace-sync-io", "--debug-arraybuffer-allocations",
  "--no-debug-arraybuffer-allocations", "--report-compact", "--no-report-compact", "--experimental-repl-await", "--no-experimental-repl-await",
  "--tls-min-v1.3", "--no-tls-min-v1.3", "--experimental-websocket", "--no-experimental-websocket", "--enable-fips", "--no-enable-fips",
  "--test-global-setup", "--report-on-fatalerror", "--no-report-on-fatalerror", "--trace-uncaught", "--no-trace-uncaught", "--openssl-config",
  "--report-filename", "--interpreted-frames-native-stack", "--tls-cipher-list", "--watch-path", "--trace-require-module",
  "--experimental-import-meta-resolve", "--no-experimental-import-meta-resolve", "--perf-basic-prof-only-functions",
  "--experimental-print-required-tla", "--no-experimental-print-required-tla", "--experimental-worker", "--use-bundled-ca", "--no-use-bundled-ca",
  "--test-shard", "--experimental-global-navigator", "--no-experimental-global-navigator", "--tls-min-v1.1", "--no-tls-min-v1.1", "--use-system-ca",
  "--no-use-system-ca", "--warnings", "--no-warnings", "--test-name-pattern", "--verify-base-objects", "--no-verify-base-objects",
  "--use-largepages", "--experimental-eventsource", "--no-experimental-eventsource", "--test-reporter", "--secure-heap", "--trace-warnings",
  "--no-trace-warnings", "--watch-kill-signal", "--test-coverage-branches", "--test-random-seed", "--redirect-warnings", "--max-http-header-size",
  "--experimental-require-module", "--no-experimental-require-module", "--inspect", "--no-inspect", "--use-openssl-ca", "--no-use-openssl-ca",
  "--experimental-wasm-modules", "--heap-prof", "--no-heap-prof", "--trace-exit", "--no-trace-exit", "--node-snapshot", "--no-node-snapshot",
  "--icu-data-dir", "--heap-prof-name", "--frozen-intrinsics", "--no-frozen-intrinsics", "--report-exclude-env", "--no-report-exclude-env",
  "--force-node-api-uncaught-exceptions-policy", "--no-force-node-api-uncaught-exceptions-policy", "--watch-preserve-output",
  "--no-watch-preserve-output", "--insecure-http-parser", "--no-insecure-http-parser", "--require", "--napi-modules", "--tls-max-v1.2",
  "--no-tls-max-v1.2", "--stack-trace-limit", "--extra-info-on-fatal-exception", "--no-extra-info-on-fatal-exception", "--disable-warning",
  "--heapsnapshot-near-heap-limit", "--title", "--disallow-code-generation-from-strings", "--tls-keylog", "--tls-min-v1.2", "--no-tls-min-v1.2",
  "--pending-deprecation", "--no-pending-deprecation", "--cpu-prof-name", "--report-uncaught-exception", "--no-report-uncaught-exception",
  "--experimental-test-isolation", "--prof-process", "--enable-network-family-autoselection", "--inspect-wait", "--inspect-brk", "--inspect",
  "--loader", "--debug-port", "--trace-events-enabled", "--es-module-specifier-resolution", "--report-directory", "-r", "--experimental-strip-types",
  "-C",
]);

const leadingDashes = /^--?/u, underscores = /_/gu, trailingValue = /=.*$/u;

/** Node's read-only `Set` of those options. `has` also accepts an option without its dashes, with underscores for
 * dashes, or with a value after `=`; `size` and `forEach` count the repeated aliases, the iterators do not. */
class NodeEnvironmentFlagsSet extends Set<string> {
  readonly #flags: readonly string[];
  readonly #bare: readonly string[];
  #unique: Set<string> | undefined;
  constructor(flags: readonly string[]) {
    super();
    this.#flags = flags;
    this.#bare = flags.map(flag => flag.replace(leadingDashes, ""));
  }
  override add(): this { return this; }
  override delete(): boolean { return false; }
  override clear(): void { /* Read-only. */ }
  override has(key: unknown): boolean {
    if (typeof key !== "string") return false;
    const dashed = key.replace(underscores, "-");
    if (leadingDashes.test(dashed)) return this.#flags.includes(dashed.replace(trailingValue, ""));
    return this.#bare.includes(dashed);
  }
  override entries(): SetIterator<[string, string]> { return (this.#unique ??= new Set(this.#flags)).entries(); }
  override forEach(callback: (value: string, key: string, set: Set<string>) => void, thisArg?: unknown): void {
    this.#flags.forEach(flag => { Reflect.apply(callback, thisArg, [flag, flag, this]); });
  }
  override get size(): number { return this.#flags.length; }
  override values(): SetIterator<string> { return (this.#unique ??= new Set(this.#flags)).values(); }
}
// The bundle renames classes; programs and util.inspect read this one's name.
Object.defineProperty(NodeEnvironmentFlagsSet, "name", { value: "NodeEnvironmentFlagsSet" });
const values: unknown = Reflect.get(NodeEnvironmentFlagsSet.prototype, "values");
const iterate = { value: values };
Object.defineProperty(NodeEnvironmentFlagsSet.prototype, Symbol.iterator, iterate);
Object.defineProperty(NodeEnvironmentFlagsSet.prototype, "keys", iterate);
Object.freeze(NodeEnvironmentFlagsSet);
Object.freeze(NodeEnvironmentFlagsSet.prototype);

/** `process.allowedNodeEnvironmentFlags`: frozen, as Node's. */
export function createEnvironmentFlags(): Set<string> {
  return Object.freeze(new NodeEnvironmentFlagsSet(NODE_24_ENVIRONMENT_FLAGS));
}
