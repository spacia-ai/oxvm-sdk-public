import { Buffer } from "buffer";
import { copyOptions, present, truthy, unsupportedOption, type SetTests } from "./node-connect-options.js";
import { isEventListener } from "./node-streams.js";
import { convertALPNProtocols, createSecureContext, secureContextOptions } from "./node-tls-context.ts";
import { invalidType, invalidValue, validateNumber, validateObject, validateString } from "./node-util-validators.ts";

type Wire = Record<string, unknown>;
type Material = { readonly t: "s" | "b"; readonly v: string; readonly passphrase?: string };
/** A server's options as the guest helper takes them: `context` is what `setSecureContext` replaces as a whole. */
export type TlsServerOptions = { readonly context: Wire; readonly rest: Wire; readonly allowHalfOpen: boolean; readonly requestCert: boolean; readonly rejectUnauthorized: boolean };
export type TlsListen = { readonly port: number; readonly host?: string; readonly backlog?: number; readonly ipv6Only?: boolean };

const KEY_MATERIAL = "string or an instance of Buffer, TypedArray, or DataView";
function coded<Failure extends Error>(error: Failure, code: string): Failure { return Object.assign(error, { code }); }

function single(name: string, value: unknown): Material {
  if (typeof value === "string") return { t: "s", v: value };
  if (ArrayBuffer.isView(value)) return { t: "b", v: Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).toString("base64") };
  if (typeof value === "object" && value !== null) {
    // `{ pem, passphrase }` for a key and `{ buf, passphrase }` for a PFX archive.
    const inner: unknown = Reflect.get(value, "pem") ?? Reflect.get(value, "buf"), passphrase: unknown = Reflect.get(value, "passphrase");
    if (typeof inner === "string" || ArrayBuffer.isView(inner)) {
      if (present(passphrase)) validateString(passphrase, "options.passphrase");
      return typeof passphrase === "string" ? { ...single(name, inner), passphrase } : single(name, inner);
    }
  }
  throw invalidType(`options.${name}`, KEY_MATERIAL, value);
}
function material(name: string, value: unknown): Material | Material[] {
  return Array.isArray(value) ? value.map((entry: unknown) => single(name, entry)) : single(name, value);
}
/** ALPN protocol names from any form Node takes, after Node's own checks. */
function protocols(value: unknown): string[] {
  const holder: { ALPNProtocols?: unknown } = {};
  convertALPNProtocols(value, holder);
  const wire = holder.ALPNProtocols, names: string[] = [];
  if (!(wire instanceof Uint8Array)) return names;
  for (let offset = 0; offset < wire.length;) {
    const length = wire[offset] ?? 0;
    names.push(Buffer.from(wire.subarray(offset + 1, offset + 1 + length)).toString("utf8")); offset += 1 + length;
  }
  return names;
}

const MATERIAL_SET: SetTests = { key: truthy, cert: truthy, ca: truthy, pfx: present, crl: present, dhparam: present };
const TEXT = ["passphrase", "minVersion", "maxVersion", "ciphers", "ecdhCurve", "sigalgs", "secureProtocol", "sessionIdContext"] as const;
/**
 * The secure-context part of a server's options: what Node's `Server.prototype.setSecureContext` copies and
 * `tls.createSecureContext` checks. A context made by `tls.createSecureContext` stands for the options it holds.
 * OpenSSL parses nothing here, so a bad key or certificate is reported by the guest once the server listens.
 */
export function tlsContextOptions(value: unknown, call: string, builtin: string): Wire {
  const source: Readonly<Record<string, unknown>> = secureContextOptions(value) ?? (typeof value === "object" && value !== null ? copyOptions(value) : {});
  createSecureContext({ ...source });
  if (truthy(source["allowPartialTrustChain"])) throw unsupportedOption("allowPartialTrustChain", call, builtin);
  const wire: Wire = {};
  for (const [name, set] of Object.entries(MATERIAL_SET)) if (set(source[name])) wire[name] = material(name, source[name]);
  for (const name of TEXT) {
    const item = source[name]; if (!present(item)) continue;
    validateString(item, `options.${name}`); wire[name] = item;
  }
  if (source["honorCipherOrder"] !== undefined) wire["honorCipherOrder"] = Boolean(source["honorCipherOrder"]);
  for (const name of ["secureOptions", "sessionTimeout"] as const) {
    const item = source[name]; if (!truthy(item)) continue;
    validateNumber(item, `options.${name}`); wire[name] = item;
  }
  const ticketKeys = source["ticketKeys"];
  if (ArrayBuffer.isView(ticketKeys)) wire["ticketKeys"] = Buffer.from(new Uint8Array(ticketKeys.buffer, ticketKeys.byteOffset, ticketKeys.byteLength)).toString("base64");
  return wire;
}

/** Options Node's TLS server reads that need the program's code or raw socket inside the guest's handshake. */
const UNSUPPORTED_SERVER_OPTIONS: SetTests = {
  SNICallback: truthy, ALPNCallback: truthy, pskCallback: truthy, pskIdentityHint: truthy, enableTrace: truthy,
  pauseOnConnect: truthy, highWaterMark: present, blockList: truthy,
};
/** `new tls.Server(options)`: Node's checks in its order, then the refusal of what the helper cannot serve. */
export function tlsServerOptions(value: unknown, call: string, builtin: string): TlsServerOptions {
  const source: Readonly<Record<string, unknown>> = typeof value === "object" && value !== null ? copyOptions(value) : {};
  if (truthy(source["ALPNCallback"]) && truthy(source["ALPNProtocols"])) throw coded(new TypeError("The ALPNCallback and ALPNProtocols TLS options are mutually exclusive"), "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS");
  const rest: Wire = {};
  if (truthy(source["ALPNProtocols"])) { const names = protocols(source["ALPNProtocols"]); if (names.length !== 0) rest["ALPNProtocols"] = names; }
  const context = tlsContextOptions(source, call, builtin);
  const handshakeTimeout = truthy(source["handshakeTimeout"]) ? source["handshakeTimeout"] : 120_000;
  validateNumber(handshakeTimeout, "options.handshakeTimeout");
  for (const name of ["SNICallback", "pskCallback"] as const) if (truthy(source[name]) && typeof source[name] !== "function") throw invalidType(`options.${name}`, "function", source[name]);
  if (truthy(source["pskIdentityHint"])) validateString(source["pskIdentityHint"], "options.pskIdentityHint");
  const refused = Object.keys(UNSUPPORTED_SERVER_OPTIONS).find(name => UNSUPPORTED_SERVER_OPTIONS[name]?.(source[name]) === true);
  if (refused !== undefined) throw unsupportedOption(refused, call, builtin);
  if (Number.isFinite(handshakeTimeout) && handshakeTimeout >= 0) rest["handshakeTimeout"] = handshakeTimeout;
  const requestCert = source["requestCert"] === true, rejectUnauthorized = source["rejectUnauthorized"] !== false;
  Object.assign(rest, { requestCert, rejectUnauthorized });
  for (const name of ["noDelay", "keepAlive"] as const) if (source[name] !== undefined) rest[name] = Boolean(source[name]);
  const delay = source["keepAliveInitialDelay"];
  if (typeof delay === "number" && Number.isFinite(delay) && delay >= 0) rest["keepAliveInitialDelay"] = delay;
  return { context, rest, allowHalfOpen: Boolean(source["allowHalfOpen"]), requestCert, rejectUnauthorized };
}

/** Listen targets that are not a TCP port in the guest: an inherited handle or descriptor, a pipe, an abort signal, a shared port. */
const UNSUPPORTED_LISTEN_OPTIONS: SetTests = { _handle: truthy, handle: truthy, fd: present, path: truthy, signal: present, reusePort: value => value === true };
function badPort(value: unknown): RangeError {
  const prefix = "The \"v\" argument must be of type t. ";
  return coded(new RangeError(`options.port should be >= 0 and < 65536. ${invalidType("v", "t", value).message.slice(prefix.length)}.`), "ERR_SOCKET_BAD_PORT");
}
function count(value: unknown): number | false { const number = Number(value); return number >= 0 ? number : false; }
/** `server.listen(...)` as net.Server reads its arguments: a port with an optional host and backlog, or one options object. */
export function tlsListenArguments(args: readonly unknown[], call: string, builtin: string): { readonly listen: TlsListen; readonly callback: ((...args: unknown[]) => void) | undefined } {
  const last = args.at(-1), callback = isEventListener(last) ? last : undefined, first = args[0];
  let options: Record<string, unknown>, shown: unknown;
  if (args.length === 0 || typeof first === "function") { options = { port: 0 }; shown = options; }
  else if (typeof first === "object" && first !== null) { options = copyOptions(first); shown = first; }
  else if (typeof first === "string" && count(first) === false) throw unsupportedOption("path", call, builtin, "a pipe path");
  else { options = typeof args[1] === "string" ? { port: first, host: args[1] } : { port: first }; shown = options; }
  const refused = Object.keys(UNSUPPORTED_LISTEN_OPTIONS).find(name => UNSUPPORTED_LISTEN_OPTIONS[name]?.(options[name]) === true);
  if (refused !== undefined) throw unsupportedOption(refused, call, builtin);
  if ((options["port"] === undefined && "port" in options) || options["port"] === null) options["port"] = 0;
  const port = options["port"];
  if (typeof port !== "number" && typeof port !== "string") {
    throw "port" in options ? invalidValue("options", shown) : invalidValue("options", shown, "must have the property \"port\" or \"path\"");
  }
  const numeric = Number(port);
  if ((typeof port === "string" && port.trim().length === 0) || numeric !== (numeric >>> 0) || numeric > 0xffff) throw badPort(port);
  const second = count(args.length > 1 && args[1]), fromArguments = second !== false && second !== 0 ? second : count(args.length > 2 && args[2]), backlog = truthy(options["backlog"]) ? options["backlog"] : fromArguments;
  const host = options["host"];
  if (truthy(host)) validateString(host, "hostname");
  return { callback, listen: { port: numeric, ...(typeof host === "string" && host !== "" ? { host } : {}),
    ...(typeof backlog === "number" && Number.isInteger(backlog) && backlog >= 1 && backlog <= 0x7fff_ffff ? { backlog } : {}), ...(options["ipv6Only"] === true ? { ipv6Only: true } : {}) } };
}

/** `server.setSecureContext(options)` and the `context` of `server.addContext(hostname, context)`. */
export function tlsReplacementContext(value: unknown, call: string, builtin: string): Wire {
  if (secureContextOptions(value) === undefined) validateObject(value, "options");
  return tlsContextOptions(value, call, builtin);
}
