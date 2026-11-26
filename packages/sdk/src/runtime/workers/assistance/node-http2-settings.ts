/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/http2/core.js (getPackedSettings, getUnpackedSettings,
 * validateSettings) and lib/internal/http2/util.js (updateSettingsBuffer, assertIsObject, assertWithinRange), and
 * from nghttp2's setting checks (nghttp2_iv_check).
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
import { Buffer } from "buffer";
import { unavailableNodeApi } from "./node-capability.ts";
import { invalidInstance, invalidType, named, primitiveText } from "./node-util-validators.ts";

/** The symbol under which a headers object lists the names HPACK must never index. */
export const sensitiveHeaders = Symbol("sensitiveHeaders");

const MAX_ADDITIONAL_SETTINGS = 10, MAX_INT = 2 ** 32 - 1;
/** nghttp2's identifiers. */
const ID = { headerTableSize: 1, enablePush: 2, maxConcurrentStreams: 3, initialWindowSize: 4, maxFrameSize: 5, maxHeaderListSize: 6, enableConnectProtocol: 8 } as const;
type Name = keyof typeof ID;
/** Node keeps the known settings in a buffer in this order; a custom setting whose number is below seven lands on the slot of that index. */
const SLOTS: readonly Name[] = ["headerTableSize", "enablePush", "initialWindowSize", "maxFrameSize", "maxConcurrentStreams", "maxHeaderListSize", "enableConnectProtocol"];
/** The order in which the known settings are written. */
const PACKED: readonly Name[] = ["headerTableSize", "enablePush", "maxConcurrentStreams", "initialWindowSize", "maxFrameSize", "maxHeaderListSize", "enableConnectProtocol"];

function settingError(kind: "range" | "type", name: string, actual: unknown, min?: number, max?: number): Error {
  const message = `Invalid value for setting "${name}": ${primitiveText(actual)}`;
  const error = kind === "range" ? new RangeError(message) : new TypeError(message);
  return Object.assign(error, { code: "ERR_HTTP2_INVALID_SETTING_VALUE", actual, ...(min === undefined ? {} : { min, max }) });
}
function tooMany(): Error { return Object.assign(new Error("Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS"), { code: "ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS" }); }
function withinRange(name: string, value: unknown, min: number, max: number): void {
  if (value !== undefined && (typeof value !== "number" || value < min || value > max)) throw settingError("range", name, value, min, max);
}
function isPlainObject(value: unknown): value is object { return value !== null && typeof value === "object" && !Array.isArray(value); }
const read = (settings: object, name: string): unknown => Reflect.get(settings, name);

function validateSettings(settings: object): void {
  const custom = read(settings, "customSettings");
  if (custom !== undefined && !isPlainObject(custom)) throw invalidInstance("customSettings", "Number", custom);
  if (custom !== undefined) {
    const entries: [string, unknown][] = Object.entries(custom);
    if (entries.length > MAX_ADDITIONAL_SETTINGS) throw tooMany();
    for (const [key, value] of entries) {
      withinRange("customSettings:id", Number(key), 0, 0xffff);
      withinRange("customSettings:value", Number(value), 0, MAX_INT);
    }
  }
  withinRange("headerTableSize", read(settings, "headerTableSize"), 0, MAX_INT);
  withinRange("initialWindowSize", read(settings, "initialWindowSize"), 0, 2 ** 31 - 1);
  withinRange("maxFrameSize", read(settings, "maxFrameSize"), 16384, 2 ** 24 - 1);
  withinRange("maxConcurrentStreams", read(settings, "maxConcurrentStreams"), 0, MAX_INT);
  withinRange("maxHeaderListSize", read(settings, "maxHeaderListSize"), 0, MAX_INT);
  withinRange("maxHeaderSize", read(settings, "maxHeaderSize"), 0, MAX_INT);
  for (const name of ["enablePush", "enableConnectProtocol"] as const) {
    const value = read(settings, name);
    if (value !== undefined && typeof value !== "boolean") throw settingError("type", name, value);
  }
}

/** A number as a Uint32Array element holds it. */
const word = (value: number): number => new Uint32Array([value])[0] ?? 0;
/** nghttp2 refuses to pack a value its setting cannot take. */
function packable(id: number, value: number): boolean {
  if (id === 2 || id === 8 || id === 9) return value === 0 || value === 1;
  if (id === 4) return value <= 2 ** 31 - 1;
  if (id === 5) return value >= 16384 && value <= 2 ** 24 - 1;
  return true;
}

/** The settings as Node's shared buffer would hold them: the known slots that were set, then the custom entries. */
function collect(settings: object, warn: (message: string) => void): { known: Map<Name, number>; custom: [number, number][] } {
  const known = new Map<Name, number>(), custom: [number, number][] = [], extra = read(settings, "customSettings");
  if (typeof extra === "object" && extra !== null) {
    for (const key in extra) {
      const value: unknown = Reflect.get(extra, key);
      if (typeof value !== "number") continue;
      const id = Number(key);
      if (Number.isNaN(id) || id <= 0 || id > 0xffff) throw settingError("range", "Range Error", id, 0, 0xffff);
      if (Number.isNaN(value) || value <= 0 || value > 0xffff_ffff) throw settingError("range", "Range Error", value, 0, 0xffff_ffff);
      const slot = id < SLOTS.length ? SLOTS[id] : undefined;
      if (slot !== undefined) { known.set(slot, word(value)); continue; }
      const stored = word(id), existing = custom.find(entry => entry[0] === stored);
      if (existing !== undefined) existing[1] = word(value);
      else if (custom.length === MAX_ADDITIONAL_SETTINGS) throw tooMany();
      else custom.push([stored, word(value)]);
    }
  }
  for (const name of ["headerTableSize", "maxConcurrentStreams", "initialWindowSize", "maxFrameSize"] as const) {
    const value = read(settings, name);
    if (typeof value === "number") known.set(name, word(value));
  }
  const list = read(settings, "maxHeaderListSize"), size = read(settings, "maxHeaderSize");
  if (typeof list === "number" || typeof size === "number") {
    if (size !== undefined && size !== list) warn("settings.maxHeaderSize overwrite settings.maxHeaderListSize");
    const chosen = size !== undefined && size !== list ? size : list;
    known.set("maxHeaderListSize", typeof chosen === "number" ? word(chosen) : 0);
  }
  for (const name of ["enablePush", "enableConnectProtocol"] as const) {
    const value = read(settings, name);
    if (typeof value === "boolean") known.set(name, Number(value));
  }
  return { known, custom };
}

function element(buffer: ArrayLike<unknown>, index: number): number { return Number(buffer[index]); }
function isTypedArray(value: unknown): value is ArrayBufferView & ArrayLike<unknown> { return ArrayBuffer.isView(value) && !(value instanceof DataView); }

/**
 * `http2.getPackedSettings`, `getUnpackedSettings`, `sensitiveHeaders` and `performServerHandshake`. The first two
 * are pure functions over the SETTINGS payload (six bytes per setting). `warn` is the process's `emitWarning`.
 */
export function createNodeHttp2Settings(warn: (message: string) => void = () => undefined): {
  getPackedSettings: (settings?: unknown) => Buffer | undefined;
  getUnpackedSettings: (buffer?: unknown, options?: unknown) => Record<string, unknown>;
  sensitiveHeaders: typeof sensitiveHeaders;
  performServerHandshake: (socket?: unknown, options?: unknown) => never;
} {
  const getPackedSettings = named(function (settings: unknown): Buffer | undefined {
    if (settings !== undefined && !isPlainObject(settings)) throw invalidType("settings", "object", settings);
    if (settings !== undefined) validateSettings(settings);
    const { known, custom } = collect({ ...settings }, warn);
    const entries: [number, number][] = [...PACKED.flatMap((name): [number, number][] => { const value = known.get(name); return value === undefined ? [] : [[ID[name], value]]; }), ...custom];
    // Node returns nothing when nghttp2 refuses an entry.
    if (!entries.every(([id, value]) => packable(id, value))) return undefined;
    const packed = Buffer.alloc(entries.length * 6);
    for (const [index, [id, value]] of entries.entries()) { packed.writeUInt16BE(id, index * 6); packed.writeUInt32BE(value, index * 6 + 2); }
    return packed;
  }, "getPackedSettings");

  const getUnpackedSettings = named(function (...args: unknown[]): Record<string, unknown> {
    const [buffer, options] = args;
    if (!isTypedArray(buffer)) throw invalidInstance("buf", "Buffer or TypedArray", buffer);
    if (buffer.length % 6 !== 0) throw Object.assign(new RangeError("Packed settings length must be a multiple of six"), { code: "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH" });
    const settings: Record<string, unknown> = {};
    let custom: Record<string, unknown> | undefined;
    for (let offset = 0; offset < buffer.length; offset += 6) {
      // Buffer's readers over whatever the elements are, as Node applies them to any typed array.
      const id = element(buffer, offset) * 2 ** 8 + element(buffer, offset + 1);
      const value = element(buffer, offset + 2) * 2 ** 24 + element(buffer, offset + 3) * 2 ** 16 + element(buffer, offset + 4) * 2 ** 8 + element(buffer, offset + 5);
      if (id === ID.headerTableSize) settings["headerTableSize"] = value;
      else if (id === ID.enablePush) settings["enablePush"] = value !== 0;
      else if (id === ID.maxConcurrentStreams) settings["maxConcurrentStreams"] = value;
      else if (id === ID.initialWindowSize) settings["initialWindowSize"] = value;
      else if (id === ID.maxFrameSize) settings["maxFrameSize"] = value;
      else if (id === ID.maxHeaderListSize) { settings["maxHeaderSize"] = value; settings["maxHeaderListSize"] = value; }
      else if (id === ID.enableConnectProtocol) settings["enableConnectProtocol"] = value !== 0;
      else { custom ??= {}; settings["customSettings"] = custom; custom[String(id)] = value; }
    }
    const validate: unknown = options === null || options === undefined ? undefined : Reflect.get(Object(options), "validate");
    if (validate !== undefined && validate !== null && validate !== false && validate !== 0 && validate !== "") validateSettings(settings);
    return settings;
  }, "getUnpackedSettings");
  Object.defineProperty(getUnpackedSettings, "length", { value: 1, configurable: true });

  /**
   * Node builds a server session on a socket the program already holds. Here HTTP/2 runs in the guest's own Node,
   * which owns its sockets; a session cannot be laid over a socket of this process, so the call is refused.
   */
  const performServerHandshake = named(function (...args: unknown[]): never {
    const options = args[1];
    if (options !== undefined && !isPlainObject(options)) throw invalidType("options", "object", options);
    return unavailableNodeApi("http2.performServerHandshake");
  }, "performServerHandshake");
  Object.defineProperty(performServerHandshake, "length", { value: 1, configurable: true });
  return { getPackedSettings, getUnpackedSettings, sensitiveHeaders, performServerHandshake };
}
