// translatePeerCertificate is ported from Node.js v24.18.1 lib/_tls_common.js.
// Copyright Joyent, Inc. and other Node contributors. MIT License:
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of
// the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { named } from "./node-util-validators.ts";

/**
 * Node's `_tls_common.translatePeerCertificate(c)`: turns a legacy certificate object's `infoAccess` text into a
 * null-prototype map of lists, in place, for the certificate and the issuers it links to.
 */
export const translatePeerCertificate: (certificate?: unknown) => unknown = named(function (certificate?: unknown): unknown {
  if (certificate === undefined || certificate === null || certificate === false || certificate === 0 || certificate === "" || certificate === 0n || (typeof certificate === "number" && Number.isNaN(certificate))) return null;
  if (typeof certificate !== "object" && typeof certificate !== "function") return certificate;
  const issuer: unknown = Reflect.get(certificate, "issuerCertificate");
  if (issuer !== null && issuer !== undefined && issuer !== certificate) Reflect.set(certificate, "issuerCertificate", translatePeerCertificate(issuer));
  const info: unknown = Reflect.get(certificate, "infoAccess");
  if (info !== null && info !== undefined) {
    const access: Record<string, unknown[]> = {}; Object.setPrototypeOf(access, null);
    Reflect.set(certificate, "infoAccess", access);
    if (typeof info !== "string") throw new TypeError("info.replace is not a function");
    for (const match of info.matchAll(/([^\n:]*):([^\n]*)(?:\n|$)/gu)) {
      const name = match[1] ?? "", text = match[2] ?? "";
      // A value with a quote is always a JSON string literal in the certificates Node builds.
      const value: unknown = text.charCodeAt(0) === 0x22 ? JSON.parse(text) : text;
      const held = access[name];
      if (held === undefined) access[name] = [value]; else held.push(value);
    }
  }
  return certificate;
}, "translatePeerCertificate");
Object.defineProperty(translatePeerCertificate, "length", { value: 1, configurable: true });
