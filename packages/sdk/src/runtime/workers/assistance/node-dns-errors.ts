import { invalidType } from "./node-util-validators.ts";

/** `dns.NODATA` … `dns.CANCELLED`, in the order Node defines them. */
export const DNS_ERROR_CODES = {
  NODATA: "ENODATA", FORMERR: "EFORMERR", SERVFAIL: "ESERVFAIL", NOTFOUND: "ENOTFOUND", NOTIMP: "ENOTIMP", REFUSED: "EREFUSED",
  BADQUERY: "EBADQUERY", BADNAME: "EBADNAME", BADFAMILY: "EBADFAMILY", BADRESP: "EBADRESP", CONNREFUSED: "ECONNREFUSED",
  TIMEOUT: "ETIMEOUT", EOF: "EOF", FILE: "EFILE", NOMEM: "ENOMEM", DESTRUCTION: "EDESTRUCTION", BADSTR: "EBADSTR",
  BADFLAGS: "EBADFLAGS", NONAME: "ENONAME", BADHINTS: "EBADHINTS", NOTINITIALIZED: "ENOTINITIALIZED",
  LOADIPHLPAPI: "ELOADIPHLPAPI", ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS", CANCELLED: "ECANCELLED",
} as const;

/**
 * How a query ended without an answer: a c-ares status as Node names it. `UNKNOWN_ARES_ERROR` is what Node 24 reports
 * for a resolver whose server list is empty.
 */
export type DnsStatus = "ENODATA" | "EFORMERR" | "ESERVFAIL" | "ENOTFOUND" | "ENOTIMP" | "EREFUSED" | "EBADNAME" | "EBADRESP"
  | "ECONNREFUSED" | "ETIMEOUT" | "ECANCELLED" | "UNKNOWN_ARES_ERROR";

/** A failed query, before it is given the caller's syscall and hostname. */
export class DnsFailure extends Error {
  constructor(readonly status: DnsStatus) { super(status); }
}

/** libuv's errno values `dns` reports, with the names `util.getSystemErrorName` gives them. */
export const UV_ERRNO = { EINVAL: -22, EAI_AGAIN: -3001, EAI_FAIL: -3004, EAI_MEMORY: -3006, EAI_NODATA: -3007, EAI_NONAME: -3008 } as const;
const ERRNO_NAMES = new Map<number, string>(Object.entries(UV_ERRNO).map(([name, value]) => [value, name]));

/**
 * Node's `DNSException` (lib/internal/errors.js): a plain `Error` with `errno`, `code`, `syscall` and, for a
 * non-empty name, `hostname`. A numeric code is a libuv errno; the two "no such name" ones read `ENOTFOUND`.
 */
export function dnsException(code: string | number, syscall: string, hostname?: string): Error {
  const errno = typeof code === "number" ? code : undefined;
  const name = typeof code === "string" ? code : code === UV_ERRNO.EAI_NODATA || code === UV_ERRNO.EAI_NONAME ? "ENOTFOUND" : ERRNO_NAMES.get(code) ?? `Unknown system error ${String(code)}`;
  const named = hostname !== undefined && hostname !== "";
  const error = Object.assign(new Error(`${syscall} ${name}${named ? ` ${hostname}` : ""}`), { errno, code: name, syscall });
  return named ? Object.assign(error, { hostname }) : error;
}

/** Node's wording of a received value (`determineSpecificType`). */
function received(value: unknown): string {
  return invalidType("v", "t", value).message.slice("The \"v\" argument must be of type t. ".length);
}

export function invalidIpAddress(address: string): TypeError {
  return Object.assign(new TypeError(`Invalid IP address: ${address}`), { code: "ERR_INVALID_IP_ADDRESS" });
}
/** ERR_INVALID_ARG_VALUE as the native layer throws it: the message alone. */
export function invalidArgValue(message: string): TypeError {
  return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_VALUE" });
}
export function missingArgs(...names: readonly string[]): TypeError {
  const quoted = names.map(name => `"${name}"`), last = quoted.pop() ?? "";
  const list = quoted.length === 0 ? last : quoted.length === 1 ? `${quoted[0] ?? ""} and ${last}` : `${quoted.join(", ")}, and ${last}`;
  return Object.assign(new TypeError(`The ${list} argument${names.length > 1 ? "s" : ""} must be specified`), { code: "ERR_MISSING_ARGS" });
}
export function badPort(port: unknown): RangeError {
  return Object.assign(new RangeError(`Port should be >= 0 and < 65536. ${received(port)}.`), { code: "ERR_SOCKET_BAD_PORT" });
}
/** ERR_INVALID_ARG_TYPE for an argument that takes several types (`of type object or integer`). */
export function invalidTypes(name: string, expected: string, value: unknown): TypeError {
  return Object.assign(new TypeError(`The "${name}" argument must be ${expected}. ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
}
