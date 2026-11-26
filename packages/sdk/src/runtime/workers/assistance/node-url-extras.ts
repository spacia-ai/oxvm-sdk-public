/*!
 * Portions adapted from Node.js v24.18.1 lib/url.js and lib/internal/url.js
 * (domainToASCII, domainToUnicode, urlToHttpOptions, fileURLToPathBuffer, isURL).
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
import { VMError } from "../../errors.ts";
import { nodePunycode } from "./node-punycode.ts";
import { invalidType, templateText } from "./node-util-validators.ts";

const NativeURL = URL;
const get = Reflect.get;

function pinned<Target extends object>(target: Target, name: string, length: number): Target {
  Object.defineProperty(target, "name", { value: name, configurable: true });
  Object.defineProperty(target, "length", { value: length, configurable: true });
  return target;
}
function missing(name: string): TypeError {
  return Object.assign(new TypeError(`The "${name}" argument must be specified`), { code: "ERR_MISSING_ARGS" });
}

/**
 * The host of a special URL as its `hostname` setter would take it (Node sets it on `ws://x`): tabs and newlines
 * are dropped, the host ends at the first `/`, `?`, `#` or `\`, and a port separator is a failure. What is left has
 * no character the URL constructor would read as anything but a host, so the browser's own host parser (WHATWG
 * "domain to ASCII", IPv4 and IPv6 parsing) decides the rest. Empty means refused.
 */
function hostToAscii(input: string): string {
  let host = "", bracketed = false;
  for (const character of input.replace(/[\t\n\r]/gu, "")) {
    if (character === "/" || character === "?" || character === "#" || character === "\\") break;
    if (character === ":" && !bracketed) return "";
    if (character === "[") bracketed = true;
    else if (character === "]") bracketed = false;
    host += character;
  }
  // Before a host these would start credentials; in a host they are forbidden.
  if (host === "" || host.includes("@")) return "";
  const ascii = literal(nativeHost(host));
  return ascii.split(".").every(validLabel) ? ascii : "";
}
function nativeHost(host: string): string {
  try { return new NativeURL(`ws://${host}/`).hostname; }
  catch { return ""; }
}
const FORBIDDEN = /[\0-\x20#/:<>?@[\\\]^|%\x7f]/u;
/**
 * A host in ASCII never holds an escape. Chromium writes one for a few characters instead of keeping them (`*`)
 * or refusing them (a space); this puts the first kind back and refuses the second.
 */
function literal(host: string): string {
  if (!host.includes("%")) return host;
  const plain = host.replace(/%([0-9a-f]{2})/giu, (_match, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)));
  return FORBIDDEN.test(plain) ? "" : plain;
}
/**
 * UTS 46 validity of an `xn--` label, which some URL parsers skip for a host that is already ASCII: it has to
 * decode, and what it decodes to has to be the text that encodes back to it.
 */
function validLabel(label: string): boolean {
  if (!label.startsWith("xn--")) return true;
  let decoded: string;
  try { decoded = nodePunycode.decode(label.slice(4)); }
  catch { return false; }
  return decoded !== "" && !FORBIDDEN.test(decoded) && !decoded.includes(".") && nativeHost(decoded) === label;
}

/** UTS 46 ToUnicode as ada does it: each `xn--` label is decoded, and a label that does not decode stays as it is. */
function hostToUnicode(host: string): string {
  return host.split(".").map(label => {
    if (!label.startsWith("xn--")) return label;
    try { return nodePunycode.decode(label.slice(4)); }
    catch { return label; }
  }).join(".");
}

export const domainToASCII = pinned((...args: unknown[]): string => {
  if (args.length < 1) throw missing("domain");
  return hostToAscii(templateText(args[0]));
}, "domainToASCII", 1);
const domainToUnicode = pinned((...args: unknown[]): string => {
  if (args.length < 1) throw missing("domain");
  return hostToUnicode(hostToAscii(templateText(args[0])));
}, "domainToUnicode", 1);

/** Node's `urlToHttpOptions`: the request options of a URL, after any own enumerable property a program added to it. */
const urlToHttpOptions = pinned((url: unknown): Record<string, unknown> => {
  if (url === null || (typeof url !== "object" && typeof url !== "function")) throw invalidType("url", "object", url);
  const read = (name: string): unknown => get(url, name);
  const hostname = read("hostname"), pathname = read("pathname"), port = read("port"), username = read("username"), password = read("password"), search = read("search");
  const options: Record<string, unknown> = {
    __proto__: null,
    ...url,
    protocol: read("protocol"),
    hostname: typeof hostname === "string" && hostname.startsWith("[") ? hostname.slice(1, -1) : hostname,
    hash: read("hash"),
    search,
    pathname,
    path: `${text(pathname)}${text(search)}`,
    href: read("href"),
  };
  if (port !== "") options["port"] = Number(port);
  if (truthy(username) || truthy(password)) options["auth"] = `${decodeURIComponent(templateText(username))}:${decodeURIComponent(templateText(password))}`;
  return options;
}, "urlToHttpOptions", 1);
function member(value: unknown, key: string): unknown {
  const boxed: unknown = Object(value);
  return (typeof boxed === "object" || typeof boxed === "function") && boxed !== null ? get(boxed, key) : undefined;
}
function truthy(value: unknown): boolean { return Boolean(value); }
/** `${value || ''}` */
function text(value: unknown): string { return truthy(value) ? templateText(value) : ""; }

/** Node's duck test for a URL object: the legacy `Url` has `auth` and `path`, a WHATWG one does not. */
function isUrl(value: unknown): value is object {
  if (value === null || value === undefined) return false;
  const boxed: unknown = Object(value);
  return typeof boxed === "object" && boxed !== null && truthy(get(boxed, "href")) && truthy(get(boxed, "protocol")) && get(boxed, "auth") === undefined && get(boxed, "path") === undefined;
}
const HEX = /^[0-9a-f]{2}$/iu;
/** Percent-decoding to bytes: a `%` that two hex digits do not follow stays, and nothing has to be UTF-8. */
function pathBytes(pathname: string): Buffer {
  const source = Buffer.from(pathname, "utf8"), bytes: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const byte = source[index] ?? 0, digits = source.toString("latin1", index + 1, index + 3);
    if (byte === 0x25 && HEX.test(digits)) { bytes.push(Number.parseInt(digits, 16)); index += 2; }
    else bytes.push(byte);
  }
  return Buffer.from(bytes);
}
const fileURLToPathBuffer = pinned((path: unknown, options?: unknown): Buffer => {
  const windows: unknown = options === null || options === undefined ? undefined : member(options, "windows");
  let url: unknown = path;
  if (typeof path === "string") {
    try { url = new NativeURL(path); }
    catch { throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: path }); }
  } else if (!isUrl(path)) throw invalidType("path", "string or an instance of URL", path);
  if (!isUrl(url)) throw invalidType("path", "string or an instance of URL", path);
  if (get(url, "protocol") !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
  if (truthy(windows)) throw new VMError("FEATURE_NOT_AVAILABLE", "Windows file URLs are not supported by the Linux profile", { api: "node:url" });
  // The standard empties a file URL's `localhost`; Chromium keeps it, and Firefox drops any host at all.
  const host: unknown = get(url, "hostname"), written = typeof path === "string" ? /^[\0-\x20]*file:[\\/]{2}([^\\/?#]*)/iu.exec(path.replace(/[\t\n\r]/gu, ""))?.[1] ?? "" : "";
  if ((host !== "" && host !== "localhost") || (written !== "" && written.toLowerCase() !== "localhost")) throw Object.assign(new TypeError("File URL host must be \"localhost\" or empty on linux"), { code: "ERR_INVALID_FILE_URL_HOST" });
  return pathBytes(templateText(get(url, "pathname")));
}, "fileURLToPathBuffer", 1);

/**
 * The additions of Node 24 to `url`. `URLPattern` is the browser's own class and is absent where the browser has
 * none; no pattern engine lives here.
 */
export function createNodeUrlExtras(globals: object = globalThis): {
  domainToASCII: typeof domainToASCII; domainToUnicode: typeof domainToUnicode; urlToHttpOptions: typeof urlToHttpOptions;
  fileURLToPathBuffer: typeof fileURLToPathBuffer; URLPattern?: (...args: never[]) => unknown;
} {
  const pattern: unknown = get(globals, "URLPattern");
  return { domainToASCII, domainToUnicode, urlToHttpOptions, fileURLToPathBuffer, ...(isCallable(pattern) ? { URLPattern: pattern } : {}) };
}
function isCallable(value: unknown): value is (...args: never[]) => unknown { return typeof value === "function"; }
