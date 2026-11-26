/*!
 * Portions adapted from Node.js v24.18.1 lib/tls.js (rootCertificates, getCACertificates, setDefaultCACertificates).
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
import { invalidInstance, invalidType, invalidValue, named, validateString } from "./node-util-validators.ts";

/** What the certificate lists read: a file of the image through Linux, and the process's environment. */
export interface TlsCertificatePorts {
  /** The text of a file of the image. A file that cannot be read is `undefined` or a throw; both mean "not there". */
  readonly readFile: (path: string) => string | undefined;
  readonly env: () => Readonly<Record<string, string | undefined>>;
}
/** Where Linux distributions keep the CA bundle OpenSSL trusts. */
const BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"];
const BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)(-----END CERTIFICATE-----|$)/gu;

/** The DER certificates of a PEM text, as base64 without line breaks. A block without its end line is an error. */
function certificates(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(BLOCK)) {
    if (match[2] === "") throw Object.assign(new Error("error:04800066:PEM routines::bad end line"), { code: "ERR_OSSL_PEM_BAD_END_LINE" });
    const body = (match[1] ?? "").replace(/\s+/gu, "");
    // A certificate is a DER SEQUENCE; anything else between the lines is not one.
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(body) && body.length % 4 === 0 && Buffer.from(body, "base64")[0] === 0x30) found.push(body);
  }
  return found;
}
function pem(body: string, trailingNewline: boolean): string {
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/gu)?.join("\n") ?? ""}\n-----END CERTIFICATE-----${trailingNewline ? "\n" : ""}`;
}
function distinct(bodies: readonly string[]): string[] { return [...new Set(bodies)]; }

/**
 * Node's CA certificate lists. Node carries Mozilla's store in its binary; here every list comes from the image:
 * `bundled` (and `tls.rootCertificates`) and `system` are the image's CA bundle, read lazily through Linux, `extra`
 * is the file NODE_EXTRA_CA_CERTS names, and `default` is the bundle plus the extra certificates until
 * `setDefaultCACertificates` replaces it. Each list is frozen and built once.
 */
export function createTlsCertificates(ports: TlsCertificatePorts): {
  rootCertificates: () => readonly string[];
  getCACertificates: (type?: unknown) => readonly string[];
  setDefaultCACertificates: (certs: unknown) => void;
  /** The list a program installed, or `undefined` while the image's own trust is in force. */
  userCertificates: () => readonly string[] | undefined;
} {
  let bundled: readonly string[] | undefined, system: readonly string[] | undefined, extra: readonly string[] | undefined, fallback: readonly string[] | undefined, user: readonly string[] | undefined;
  const read = (path: string): string | undefined => { try { return ports.readFile(path); } catch { return undefined; } };
  const imageBundle = (): string[] => {
    for (const path of BUNDLES) { const text = read(path); if (text !== undefined) return distinct(certificates(text)); }
    return [];
  };
  const bundledList = (): readonly string[] => bundled ??= Object.freeze(imageBundle().map(body => pem(body, false)));
  const systemList = (): readonly string[] => system ??= Object.freeze(imageBundle().map(body => pem(body, true)));
  const extraList = (): readonly string[] => {
    if (extra !== undefined) return extra;
    const path = ports.env()["NODE_EXTRA_CA_CERTS"], text = path === undefined || path === "" ? undefined : read(path);
    let bodies: string[];
    // Node warns about an extra file it cannot load and goes on without it.
    try { bodies = text === undefined ? [] : distinct(certificates(text)); } catch { bodies = []; }
    return extra = Object.freeze(bodies.map(body => pem(body, true)));
  };
  const defaultList = (): readonly string[] => {
    if (user !== undefined) return user;
    const path = ports.env()["NODE_EXTRA_CA_CERTS"];
    return fallback ??= Object.freeze([...bundledList(), ...(path === undefined || path === "" ? [] : extraList())]);
  };
  const getCACertificates = named(function (...args: unknown[]): readonly string[] {
    const type = args[0] === undefined ? "default" : args[0];
    validateString(type, "type");
    if (type === "default") return defaultList();
    if (type === "bundled") return bundledList();
    if (type === "system") return systemList();
    if (type === "extra") return extraList();
    throw invalidValue("type", type);
  }, "getCACertificates");
  const setDefaultCACertificates = named(function (certs: unknown): void {
    if (!Array.isArray(certs)) throw invalidInstance("certs", "Array", certs);
    const items: unknown[] = certs, texts: string[] = [];
    for (const [index, item] of items.entries()) {
      if (typeof item === "string") texts.push(item);
      else if (ArrayBuffer.isView(item)) texts.push(Buffer.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)).toString("latin1"));
      else throw invalidType(`certs[${String(index)}]`, "string or an instance of ArrayBufferView", item);
    }
    const bodies = distinct(texts.flatMap(certificates));
    if (items.length > 0 && bodies.length === 0) throw Object.assign(new Error("No valid certificates found in the provided array"), { code: "ERR_CRYPTO_OPERATION_FAILED" });
    user = Object.freeze(bodies.map(body => pem(body, true)));
  }, "setDefaultCACertificates");
  return { rootCertificates: bundledList, getCACertificates, setDefaultCACertificates, userCertificates: () => user };
}
