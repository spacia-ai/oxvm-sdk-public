import { readFileSync } from "node:fs";
import { record } from "../../decode.js";
import type { DnsPorts } from "./node-dns-api.ts";
import type { DnsServer } from "./node-dns-config.ts";
import { DnsTransportError, type DnsExchange, type DnsTransport } from "./node-dns-resolver.ts";
import { peekQuestion } from "./node-dns-wire.ts";

/** Shared by the `node:dns` tests: the recorded controls, and a transport that replays a recorded exchange. */
export function controls(name: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(new URL(`./${name}.controls.json`, import.meta.url), "utf8")), `${name} controls`);
}
export const object = (value: unknown): Record<string, unknown> => record(value, "recorded object");
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected a recorded list");
  const items: unknown[] = value;
  return items;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected recorded text");
  return value;
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
export function unhex(digits: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(digits.match(/../gu) ?? [], pair => Number.parseInt(pair, 16));
}

/** One query the recorder's server saw, and what it answered (`reply` null: nothing). Hex strings omit the ID. */
export interface RecordedQuery { readonly port: number; readonly transport: string; readonly name: string; readonly type: number; readonly query: string; readonly reply: string | null; readonly sameId: boolean }
export function recordedQueries(value: unknown, port = 5353): RecordedQuery[] {
  return (value === undefined ? [] : list(value)).map(entry => {
    const item = object(entry), reply = item["reply"];
    return { port: typeof item["port"] === "number" ? item["port"] : port, transport: text(item["transport"]), name: text(item["name"]), type: Number(item["type"]), query: text(item["query"]), reply: typeof reply === "string" ? reply : null, sameId: item["sameId"] !== false };
  });
}

export interface ReplayTransport extends DnsTransport {
  /** `transport:port:name/type` for each exchange the resolver started, in order. */
  readonly asked: string[];
  /** The timeout of each exchange, in milliseconds. */
  readonly timeouts: number[];
  /** Replaces the exchanges still to replay and forgets what was asked. */
  feed(recorded: readonly RecordedQuery[]): void;
}
/**
 * Answers the resolver's exchanges from a recorded list, in order. A recorded silence, or a reply the resolver does not
 * accept, is a timeout at once; a server the recorder did not run refuses. The recorder's replies with a foreign ID
 * carried ID 1.
 */
export function replayTransport(recorded: readonly RecordedQuery[], files: Readonly<Record<string, string>> = {}, unrecorded?: (query: Uint8Array) => Uint8Array, servers: readonly number[] = [53, 5353, 5354]): ReplayTransport {
  const asked: string[] = [], timeouts: number[] = [], pending = [...recorded];
  const exchange = (transport: "udp" | "tcp") => (server: DnsServer, query: Uint8Array, wait: DnsExchange): Promise<Uint8Array> => {
    const question = peekQuestion(query)?.question;
    asked.push(`${transport}:${String(server.port)}:${question?.name ?? "?"}/${String(question?.type)}`); timeouts.push(wait.timeoutMs);
    if (!servers.includes(server.port)) return Promise.reject(new DnsTransportError("failed", "connection refused"));
    const index = pending.findIndex(entry => entry.transport === transport && entry.port === server.port && entry.query === hex(query).slice(4));
    const entry = index < 0 ? undefined : pending.splice(index, 1)[0];
    if (entry === undefined) return unrecorded === undefined ? Promise.reject(new Error(`No recorded ${transport} exchange for ${hex(query)}`)) : Promise.resolve(unrecorded(query));
    const reply = entry.reply === null ? undefined : unhex((entry.sameId ? hex(query).slice(0, 4) : "0001") + entry.reply);
    if (reply === undefined || !wait.accept(reply)) return Promise.reject(new DnsTransportError("timeout", "no reply"));
    return Promise.resolve(reply);
  };
  return { asked, timeouts, udp: exchange("udp"), tcp: exchange("tcp"), readFile: path => files[path], feed: next => { pending.splice(0, pending.length, ...next); asked.length = 0; } };
}
export const sequence = (recorded: readonly RecordedQuery[]): string[] => recorded.map(entry => `${entry.transport}:${String(entry.port)}:${entry.name.toLowerCase()}/${String(entry.type)}`);

/** The process side of a call: holds are counted, callbacks run in a later microtask. */
export function scheduling(): DnsPorts["scheduling"] & { readonly held: () => number } {
  let held = 0;
  return {
    held: () => held,
    retain: () => { held += 1; let released = false; return () => { if (released) throw new Error("released twice"); released = true; held -= 1; }; },
    dispatch: callback => { queueMicrotask(callback); },
    context: { capture: () => callback => callback() },
  };
}

/** A value as the recorder printed it: JSON, with an ArrayBuffer as `ArrayBuffer:<hex>` and a hole as null. */
export function printed(value: unknown): unknown {
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(JSON.stringify(value, (_key, item: unknown) => item instanceof ArrayBuffer ? `ArrayBuffer:${hex(new Uint8Array(item))}` : item));
  return parsed;
}
/** An error as the recorder printed it. */
export function errorShape(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return { message: error.message, keys: Object.keys(error), props: Object.fromEntries(Object.entries(error).map(([key, value]: [string, unknown]) => [key, value === undefined ? "<undefined>" : value])) };
}
/** What a throw looked like to the validation recorder. */
export function thrownShape(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code: unknown = Reflect.get(error, "code");
  return { name: error.name, code, message: error.message, ctor: error.constructor.name };
}

/** What a throw looked like to the lookup recorder. */
export function thrownBrief(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code: unknown = Reflect.get(error, "code");
  return { name: error.name, code, message: error.message };
}
/** Calls a method by name, as a program holding the object would. */
export function apply(target: object, method: string, args: readonly unknown[]): unknown {
  const fn: unknown = Reflect.get(target, method);
  if (typeof fn !== "function") throw new TypeError(`Missing method ${method}`);
  const result: unknown = Reflect.apply(fn, target, [...args]);
  return result;
}
export function prototypeOf(value: unknown): unknown {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype;
}
export function nameOf(value: unknown): unknown {
  const name: unknown = Reflect.get(Object(value), "name");
  return name;
}

/** Calls a callback-style method and resolves with what the recorder would have stored. */
export function call(target: object, method: string, args: readonly unknown[]): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    try { apply(target, method, [...args, (error: unknown, ...values: unknown[]) => { resolve(error === null ? { result: printed(values) } : { error: errorShape(error) }); }]); }
    catch (error) { resolve({ thrown: errorShape(error) }); }
  });
}
