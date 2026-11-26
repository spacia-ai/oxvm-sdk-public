import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeAssistanceSocketAddress } from "../../protocol/assistance.js";
import type { TlsSecureInfo } from "./node-tls-wire.js";

/** A failure as the guest's Node raised it: the fields a program reads from a listen or handshake error. */
export type TlsServerFailure = {
  readonly code: string; readonly message: string; readonly errno?: number; readonly port?: number;
  readonly syscall?: string; readonly address?: string; readonly library?: string; readonly reason?: string;
};
/** `getPeerCertificate()` of the guest's socket; binary fields are Buffers again. */
export type TlsPeerCertificate = Readonly<Record<string, string | number | boolean | Buffer | undefined | readonly string[] | Readonly<Record<string, string | readonly string[]>>>>;
export type TlsServerEvent =
  | { readonly kind: "listening"; readonly address: string; readonly port: number; readonly family: "IPv4" | "IPv6" }
  | { readonly kind: "error"; readonly error: TlsServerFailure }
  | { readonly kind: "fatal"; readonly error: TlsServerFailure }
  | { readonly kind: "open"; readonly id: number; readonly secure: TlsSecureInfo; readonly peer: TlsPeerCertificate | null }
  | { readonly kind: "client-error"; readonly error: TlsServerFailure; readonly remoteAddress: string | null; readonly remotePort: number | null }
  | { readonly kind: "written"; readonly id: number; readonly count: number }
  | { readonly kind: "finished" | "timeout"; readonly id: number }
  | { readonly kind: "conn-error"; readonly id: number; readonly error: TlsServerFailure }
  | { readonly kind: "conn-close"; readonly id: number; readonly hadError: boolean }
  | { readonly kind: "applied"; readonly request: number; readonly error: TlsServerFailure | null }
  | { readonly kind: "closed" }
  | { readonly kind: "done" };
export type TlsServerCommand =
  | { readonly kind: "start" | "close" }
  | { readonly kind: "accept" | "end" | "destroy"; readonly id: number }
  | { readonly kind: "ack"; readonly id: number; readonly count: number }
  | { readonly kind: "timeout"; readonly id: number; readonly duration: number }
  | { readonly kind: "no-delay"; readonly id: number; readonly enabled: boolean }
  | { readonly kind: "keep-alive"; readonly id: number; readonly enabled: boolean; readonly delay: number }
  | { readonly kind: "secure-context"; readonly request: number }
  | { readonly kind: "add-context"; readonly request: number; readonly hostname: string }
  | { readonly kind: "ticket-keys"; readonly keys: string };

/** The error a program receives, with the guest's own fields. */
export function tlsServerError(failure: TlsServerFailure): Error {
  const { message, ...fields } = failure;
  return Object.assign(new Error(message), fields);
}

export function decodeTlsServerEvent(bytes: Uint8Array): TlsServerEvent {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  const input = record(value, "TLS server event"), kind = input["kind"];
  if (kind === "closed" || kind === "done") { exactKeys(input, ["kind"]); return { kind }; }
  if (kind === "error" || kind === "fatal") { exactKeys(input, ["kind", "error"]); return { kind, error: failure(input["error"]) }; }
  if (kind === "listening") {
    exactKeys(input, ["kind", "address", "port", "family"]);
    const bound = address(input["address"], input["port"], input["family"]);
    return { kind, address: bound.address, port: bound.port, family: bound.family };
  }
  if (kind === "client-error") {
    exactKeys(input, ["kind", "error", "remoteAddress", "remotePort"]);
    return { kind, error: failure(input["error"]), remoteAddress: input["remoteAddress"] === null ? null : text(input["remoteAddress"], 64),
      remotePort: input["remotePort"] === null ? null : integer(input["remotePort"], "TLS remote port", 0, 65535) };
  }
  if (kind === "applied") {
    exactKeys(input, ["kind", "request", "error"]);
    return { kind, request: connection(input["request"]), error: input["error"] === null ? null : failure(input["error"]) };
  }
  if (kind === "written") { exactKeys(input, ["kind", "id", "count"]); return { kind, id: connection(input["id"]), count: integer(input["count"], "TLS write size", 1, 65532) }; }
  if (kind === "finished" || kind === "timeout") { exactKeys(input, ["kind", "id"]); return { kind, id: connection(input["id"]) }; }
  if (kind === "conn-error") { exactKeys(input, ["kind", "id", "error"]); return { kind, id: connection(input["id"]), error: failure(input["error"]) }; }
  if (kind === "conn-close") { exactKeys(input, ["kind", "id", "hadError"]); return { kind, id: connection(input["id"]), hadError: flag(input["hadError"]) }; }
  if (kind !== "open") throw invalid();
  exactKeys(input, ["kind", "id", "localAddress", "localPort", "localFamily", "remoteAddress", "remotePort", "remoteFamily", "authorized", "authorizationError", "alpnProtocol", "servername", "protocol", "cipher", "peer"]);
  const local = address(input["localAddress"], input["localPort"], input["localFamily"]), remote = address(input["remoteAddress"], input["remotePort"], input["remoteFamily"]);
  const protocol = input["protocol"];
  if (protocol !== "TLSv1" && protocol !== "TLSv1.1" && protocol !== "TLSv1.2" && protocol !== "TLSv1.3") throw invalid();
  const cipher = record(input["cipher"], "TLS cipher"); exactKeys(cipher, ["name", "standardName", "version"]);
  // A server socket is unauthorized without an error when it asked for no certificate.
  const authorized = flag(input["authorized"]), authorizationError = input["authorizationError"] === null ? null : text(input["authorizationError"], 8192);
  if (authorized && authorizationError !== null) throw invalid();
  return { kind, id: connection(input["id"]), peer: input["peer"] === null ? null : certificate(input["peer"]),
    secure: { kind: "secure", authorized, authorizationError,
      servername: input["servername"] === false ? false : text(input["servername"], 4096), alpnProtocol: input["alpnProtocol"] === false ? false : text(input["alpnProtocol"], 255), protocol,
      cipher: { name: text(cipher["name"], 128), standardName: text(cipher["standardName"], 128), version: text(cipher["version"], 32) },
      localAddress: local.address, localPort: local.port, localFamily: local.family, remoteAddress: remote.address, remotePort: remote.port, remoteFamily: remote.family } };
}
function failure(value: unknown): TlsServerFailure {
  const input = record(value, "TLS server failure");
  exactKeys(input, ["code", "message"], ["errno", "port", "syscall", "address", "library", "reason"]);
  const optional = (name: "syscall" | "address" | "library" | "reason") => input[name] === undefined ? {} : { [name]: text(input[name], 256) };
  return { code: text(input["code"], 128), message: text(input["message"], 4096),
    ...(input["errno"] === undefined ? {} : { errno: integer(input["errno"], "TLS errno", -4096, 4096) }),
    ...(input["port"] === undefined ? {} : { port: integer(input["port"], "TLS port", 0, 65535) }),
    ...optional("syscall"), ...optional("address"), ...optional("library"), ...optional("reason") };
}
function certificate(value: unknown): TlsPeerCertificate {
  const result: Record<string, string | number | boolean | Buffer | undefined | readonly string[] | Readonly<Record<string, string | readonly string[]>>> = {};
  for (const [name, item] of Object.entries(record(value, "TLS peer certificate"))) {
    // A field Node lists without a value (an EC key has no modulus) is listed here too.
    if (item === null) result[name] = undefined;
    else if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[name] = item;
    else if (Array.isArray(item)) result[name] = strings(item);
    else {
      const fields = record(item, "TLS certificate field"), encoded = fields["base64"];
      if (typeof encoded === "string" && Object.keys(fields).length === 1) { result[name] = Buffer.from(encoded, "base64"); continue; }
      const names: Record<string, string | readonly string[]> = {}; Object.setPrototypeOf(names, null);
      for (const [key, entry] of Object.entries(fields)) names[key] = Array.isArray(entry) ? strings(entry) : string(entry, "TLS certificate name");
      result[name] = names;
    }
  }
  return result;
}
function strings(value: readonly unknown[]): string[] { return value.map(entry => string(entry, "TLS certificate entry")); }
function address(value: unknown, port: unknown, family: unknown): { address: string; port: number; family: "IPv4" | "IPv6" } {
  const decoded = decodeAssistanceSocketAddress({ address: value, port }, true);
  if (family !== "IPv4" && family !== "IPv6") throw invalid();
  if (decoded.address.includes(":") !== (family === "IPv6")) throw invalid();
  return { ...decoded, family };
}
function connection(value: unknown): number { return integer(value, "TLS connection", 1, 0xffff_ffff); }
function flag(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function text(value: unknown, maximum: number): string { const result = string(value, "TLS text"); if (Buffer.byteLength(result) > maximum || result.includes("\0")) throw invalid(); return result; }
function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native TLS server frame"); }
