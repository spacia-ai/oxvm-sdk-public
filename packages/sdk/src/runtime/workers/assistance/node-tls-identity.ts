/*!
 * Portions adapted from Node.js v24.18.1 lib/tls.js (checkServerIdentity and its helpers).
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
import { canonicalIp, ipVersion } from "./node-net-address.ts";
import { domainToASCII } from "./node-url-extras.ts";
import { named, templateText } from "./node-util-validators.ts";

function member(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
  const boxed: unknown = Object(value);
  return (typeof boxed === "object" || typeof boxed === "function") && boxed !== null ? Reflect.get(boxed, key) : undefined;
}
const unfqdn = (host: string): string => host.replace(/[.]$/u, "");
/** Only A to Z are lowercased: `toLowerCase` depends on the locale. */
const splitHost = (host: string): string[] => unfqdn(host).replace(/[A-Z]/gu, letter => String.fromCharCode(32 + letter.charCodeAt(0))).split(".");

function check(hostParts: readonly string[], pattern: unknown, wildcards: boolean): boolean {
  if (pattern === undefined || pattern === null || pattern === "" || pattern === false || pattern === 0) return false;
  if (typeof pattern !== "string") throw new TypeError("host.replace is not a function");
  const patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length || patternParts.includes("")) return false;
  // U-labels, control characters and blanks are refused: nothing here can normalize them.
  if (patternParts.some(part => /[^!-\u007F]/u.test(part))) return false;
  for (let index = hostParts.length - 1; index > 0; index -= 1) if (hostParts[index] !== patternParts[index]) return false;
  const hostSubdomain = hostParts[0] ?? "", patternSubdomain = patternParts[0] ?? "", pieces = patternSubdomain.split("*", 3);
  // RFC 6125 allows no wildcard in a label that holds an A-label.
  if (pieces.length === 1 || patternSubdomain.includes("xn--")) return hostSubdomain === patternSubdomain;
  if (!wildcards || pieces.length > 2 || patternParts.length <= 2) return false;
  const [prefix = "", suffix = ""] = pieces;
  return prefix.length + suffix.length <= hostSubdomain.length && hostSubdomain.startsWith(prefix) && hostSubdomain.endsWith(suffix);
}

/** A JSON string literal at the start of the text, exactly as ECMA-404 defines one. */
const jsonStringPattern = /^"(?:[\u0020\u0021\u0023-\u005b\u005d-\u{10ffff}]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/u;
function splitEscapedAltNames(altNames: string): string[] {
  const result: string[] = [];
  let currentToken = "", offset = 0;
  while (offset !== altNames.length) {
    const nextSep = altNames.indexOf(",", offset), nextQuote = altNames.indexOf("\"", offset);
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      currentToken += altNames.substring(offset, nextQuote);
      const match = jsonStringPattern.exec(altNames.substring(nextQuote));
      if (match === null) throw Object.assign(new SyntaxError("Invalid subject alternative name string"), { code: "ERR_TLS_CERT_ALTNAME_FORMAT" });
      const text: unknown = JSON.parse(match[0]);
      currentToken += String(text);
      offset = nextQuote + match[0].length;
    } else if (nextSep !== -1) {
      currentToken += altNames.substring(offset, nextSep);
      result.push(currentToken);
      currentToken = "";
      offset = nextSep + 2;
    } else {
      currentToken += altNames.substring(offset);
      offset = altNames.length;
    }
  }
  result.push(currentToken);
  return result;
}
const truthy = (value: unknown): boolean => Boolean(value);

/**
 * Node's `tls.checkServerIdentity`: `undefined` when the certificate names the host, else the error Node returns
 * (it is returned, not thrown), with `reason`, `host` and `cert`.
 */
export const checkServerIdentity = named(function (host: unknown, cert: unknown): Error | undefined {
  const subject = member(cert, "subject"), altNames = member(cert, "subjectaltname");
  const dnsNames: string[] = [], ips: (string | undefined)[] = [];
  const given = templateText(host), hostnameASCII = domainToASCII(given);
  const hostname = unfqdn(given), ascii = unfqdn(hostnameASCII);
  if (truthy(altNames)) {
    if (typeof altNames !== "string") throw new TypeError("altNames.includes is not a function");
    for (const name of altNames.includes("\"") ? splitEscapedAltNames(altNames) : altNames.split(", ")) {
      if (name.startsWith("DNS:")) dnsNames.push(name.slice(4));
      else if (name.startsWith("IP Address:")) ips.push(canonicalIp(name.slice(11)));
    }
  }
  let valid = false, reason = "Unknown reason";
  const commonName: unknown = subject === undefined || subject === null ? undefined : member(subject, "CN");
  if (ipVersion(ascii) !== 0) {
    valid = ips.includes(canonicalIp(ascii));
    if (!valid) reason = `IP: ${hostname} is not in the cert's list: ${ips.join(", ")}`;
  } else if (dnsNames.length > 0 || truthy(commonName)) {
    const hostParts = splitHost(ascii), wildcard = (pattern: unknown): boolean => check(hostParts, pattern, true);
    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) reason = `Host: ${hostname}. is not in the cert's altnames: ${String(altNames)}`;
    } else {
      const names: readonly unknown[] | undefined = Array.isArray(commonName) ? commonName : undefined;
      valid = names === undefined ? wildcard(commonName) : names.some(wildcard);
      if (!valid) reason = `Host: ${hostname}. is not cert's CN: ${templateText(commonName)}`;
    }
  } else reason = "Cert does not contain a DNS name";
  if (valid) return undefined;
  const error = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`);
  for (const [key, value] of [["code", "ERR_TLS_CERT_ALTNAME_INVALID"], ["reason", reason], ["host", hostname], ["cert", cert]] as const) {
    Object.defineProperty(error, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return error;
}, "checkServerIdentity");
