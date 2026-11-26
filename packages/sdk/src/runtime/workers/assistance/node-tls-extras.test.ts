import { once } from "node:events";
import { createServer } from "node:tls";
import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { VMError } from "../../errors.ts";
import { nativeServiceFixture } from "./native-service.test-support.js";
import { controls, decoded, list, outcome, rows } from "./node-controls.test-support.ts";
import { createNodeTls } from "./node-tls.ts";
import { createTlsCertificates } from "./node-tls-certificates.ts";
import { secureContextOptions } from "./node-tls-context.ts";
import { createTLSTestIdentity } from "./tls-test-identity.test-support.js";

// Recorded from `require("tls")` of node:24.18.1-alpine (OpenSSL 3.5.7); the recorder is embedded in the control file.
const control = controls("node-tls-extras.controls.json");
const U = { $: "undefined" };
const sample = list(control["rootsSample"]).map(String);
const [r0 = "", r1 = "", r2 = "", r3 = ""] = sample;
function assisted(files: Readonly<Record<string, string>> = {}, env: Readonly<Record<string, string>> = {}) {
  const fixture = nativeServiceFixture(), reads: string[] = [];
  const tls = createNodeTls(fixture.native, fixture.context, fixture.retain, undefined, { readFile: path => { reads.push(path); return files[path]; }, env: () => env });
  return { ...fixture, tls, reads };
}
const expected = (row: Record<string, unknown>): unknown => row["error"] === undefined ? { value: row["value"] } : { error: row["error"] };
/** Errors only OpenSSL can raise, by parsing what the options hold. Nothing parses them in this process. */
const fromOpenSSL = (row: Record<string, unknown>): boolean => /^ERR_(?:OSSL_|SSL_|CRYPTO_OPERATION_FAILED)/u.test(String(record(row["error"] ?? {}, "error")["code"]));
const shape = (value: unknown): unknown => {
  const certs = list(value).map(String);
  return { isArray: Array.isArray(value), frozen: Object.isFrozen(value), length: certs.length, allStrings: true };
};
const base64 = (pem: string): string => pem.replace(/-----[A-Z ]+-----|\s/gu, "");

it("was recorded from pinned Node", () => { expect(record(control["node"], "node")["version"]).toBe("v24.18.1"); });

it("exports Node's client-side names with its descriptors, function names and writable defaults", () => {
  const { tls } = assisted();
  const served = Object.keys(tls), recorded = list(control["keys"]).map(String);
  // The server side stays with Linux.
  expect(recorded.filter(key => !served.includes(key))).toEqual(["Server", "createServer"]);
  expect(served.filter(key => !recorded.includes(key))).toEqual([]);
  const descriptors = record(control["descriptors"], "descriptors");
  for (const key of served) {
    const found = Object.getOwnPropertyDescriptor(tls, key);
    expect({ e: found?.enumerable, w: found?.writable ?? null, c: found?.configurable, get: typeof found?.get, set: typeof found?.set }, key).toEqual(descriptors[key]);
  }
  for (const row of list(control["functions"])) {
    const [key, name, length] = list(row), callee: unknown = Reflect.get(tls, String(key));
    expect([typeof callee === "function" ? callee.name : null, typeof callee === "function" ? callee.length : null], String(key)).toEqual([name, length]);
  }
  for (const [key, value] of Object.entries(record(control["constants"], "constants"))) expect(Reflect.get(tls, key), key).toBe(value);
  tls.DEFAULT_MIN_VERSION = "TLSv1.3"; tls.CLIENT_RENEG_LIMIT = 9;
  expect([tls.DEFAULT_MIN_VERSION, tls.CLIENT_RENEG_LIMIT, assisted().tls.DEFAULT_MIN_VERSION]).toEqual(["TLSv1.3", 9, "TLSv1.2"]);
  const ciphers = record(control["ciphers"], "ciphers");
  expect(tls.getCiphers()).toEqual(ciphers["list"]);
  expect([tls.getCiphers() === tls.getCiphers(), Object.isFrozen(tls.getCiphers())]).toEqual([ciphers["same"], ciphers["frozen"]]);
});

it("checks a server's identity against its certificate like Node", () => {
  const { tls } = assisted(), cases = rows(control["identity"]);
  expect(cases.length).toBeGreaterThanOrEqual(30);
  for (const row of cases) {
    const cert: unknown = decoded(row["cert"]);
    expect(outcome(() => {
      const error = tls.checkServerIdentity(decoded(row["host"]), cert);
      if (error === undefined) return U;
      const code: unknown = Reflect.get(error, "code"), reason: unknown = Reflect.get(error, "reason"), host: unknown = Reflect.get(error, "host");
      return { isError: error instanceof Error, name: error.name, ctor: error.constructor.name, code, message: error.message, reason, host, certSame: Reflect.get(error, "cert") === cert, keys: Object.keys(error) };
    }), `${JSON.stringify(row["host"])} ${JSON.stringify(row["cert"])}`).toEqual(expected(row));
  }
  for (const row of rows(control["identityLoose"])) {
    const args = list(decoded(row["args"]));
    expect(outcome(() => { const error = tls.checkServerIdentity(args[0], args[1]); const code: unknown = error === undefined ? undefined : Reflect.get(error, "code"); return error === undefined ? U : { code, message: error.message }; }), JSON.stringify(row["args"])).toEqual(expected(row));
  }
});

it("converts ALPN protocols to the wire form", () => {
  const { tls } = assisted();
  const view = (value: unknown): unknown => {
    const kind: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "$") : undefined;
    if (kind === "u16") return new Uint16Array(list(Reflect.get(Object(value), "v")).map(Number));
    if (kind === "dataview") return new DataView(Uint8Array.from(Buffer.from(String(Reflect.get(Object(value), "hex")), "hex")).buffer);
    return decoded(value);
  };
  for (const row of rows(control["alpn"])) {
    expect(outcome(() => {
      const out: { ALPNProtocols?: unknown } = {};
      tls.convertALPNProtocols(view(list(row["args"])[0]), out);
      const wire = out.ALPNProtocols;
      return { returned: U, keys: Object.keys(out), isBuffer: Buffer.isBuffer(wire), hex: Buffer.isBuffer(wire) ? wire.toString("hex") : null };
    }), JSON.stringify(row["args"]).slice(0, 80)).toEqual(expected(row));
  }
  const frozen = Object.freeze({});
  expect([outcome(() => { tls.convertALPNProtocols(["a"], undefined); return undefined; }), outcome(() => { tls.convertALPNProtocols(["a"], null); return undefined; }), outcome(() => { tls.convertALPNProtocols("x", null); return undefined; }),
    outcome(() => { tls.convertALPNProtocols(["a"], frozen); return Object.keys(frozen); })].map(result => result["error"] === undefined ? {} : result)).toEqual(control["alpnLoose"]);
});

it("serves the CA lists from the image's bundle, read lazily through Linux", () => {
  const bundle = `# a comment\n${r0}\n\n${r1}\n${r0}\nnoise\n`;
  const { tls, reads } = assisted({ "/etc/ssl/cert.pem": bundle, "/extra.pem": `${r2}\n` }, { NODE_EXTRA_CA_CERTS: "/extra.pem" });
  expect(reads).toEqual([]);
  const roots = tls.rootCertificates, recordedRoots = record(control["roots"], "roots"), ca = record(control["ca"], "ca");
  expect(reads).toEqual(["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"]);
  expect(roots.map(base64)).toEqual([r0, r1].map(base64));
  // The bundled form has no final newline; the lists OpenSSL writes (system, extra, installed) have one.
  expect(roots.every(pem => /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/]{64}\n)*[A-Za-z0-9+/=]{1,64}\n-----END CERTIFICATE-----$/u.test(pem))).toBe(true);
  expect({ ...record(shape(roots), "shape"), length: 120, allPem: false }).toEqual(recordedRoots["shape"]);
  expect([tls.rootCertificates === roots, outcome(() => { "use strict"; Reflect.set(tls, "rootCertificates", []); return tls.rootCertificates === roots; })["value"], outcome(() => Reflect.apply(Array.prototype.push, roots, ["x"]))["error"]]).toEqual([recordedRoots["same"], true, { ...record(record(recordedRoots["push"], "push")["error"], "error"), message: "Cannot add property 2, object is not extensible" }]);
  expect(() => { Object.assign(tls, { rootCertificates: [] }); }).toThrow(TypeError);
  expect([tls.getCACertificates() === tls.getCACertificates("default"), tls.getCACertificates() === roots, tls.getCACertificates("bundled") === roots, tls.getCACertificates("system") === tls.getCACertificates("system"), tls.getCACertificates("extra") === tls.getCACertificates("extra")])
    .toEqual([ca["defaultSameObject"], ca["defaultIsRoots"], ca["bundledIsRoots"], ca["systemSame"], ca["extraSame"]]);
  expect(tls.getCACertificates("default").map(base64)).toEqual([r0, r1, r2].map(base64));
  expect(tls.getCACertificates("extra").map(base64)).toEqual([base64(r2)]);
  expect(tls.getCACertificates("system").map(base64)).toEqual([r0, r1].map(base64));
  expect(tls.getCACertificates("extra")[0]?.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
  for (const name of ["default", "bundled", "system", "extra"]) expect(Object.isFrozen(tls.getCACertificates(name)), name).toBe(true);
  for (const row of rows(ca["loose"])) {
    expect(outcome(() => tls.getCACertificates(decoded(row["arg"])).length), JSON.stringify(row["arg"])).toEqual(row["error"] === undefined ? { value: 2 + 1 } : { error: row["error"] });
  }
  // Without NODE_EXTRA_CA_CERTS the default list holds the bundle's certificates only; without a bundle it is empty.
  expect(assisted({ "/etc/ssl/certs/ca-certificates.crt": bundle }).tls.getCACertificates().map(base64)).toEqual([r0, r1].map(base64));
  expect([assisted().tls.rootCertificates, assisted({}, { NODE_EXTRA_CA_CERTS: "/missing" }).tls.getCACertificates("extra")]).toEqual([[], []]);
  // A port that throws for a missing file (as the process's own readFileSync does) reads as no file.
  expect(createTlsCertificates({ readFile: () => { throw new Error("ENOENT"); }, env: () => ({ NODE_EXTRA_CA_CERTS: "/x" }) }).getCACertificates()).toEqual([]);
});

it("replaces the default CA list as Node does: validated, deduplicated, in the order given", () => {
  const lists = createTlsCertificates({ readFile: () => `${r0}\n${r1}\n${r2}\n${r3}\n`, env: () => ({}) }), roots = lists.rootCertificates();
  const named = (text: unknown): unknown => typeof text !== "string" ? text : text.replace("<R2CRLF>", r2.replace(/\n/gu, "\r\n")).replace("<R0>", r0).replace("<R1CUT>", r1.slice(0, 200)).replace("<R1>", r1).replace("<R2>", r2);
  for (const row of rows(control["setDefault"])) {
    const args = list(row["args"]).map(value => Array.isArray(value) ? value.map((item: unknown) => {
      const kind: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "$") : undefined;
      return kind === "pem-buffer" ? Buffer.from(r3) : kind === "pem-u8" ? new Uint8Array(Buffer.from(r3)) : named(item);
    }) : decoded(value));
    expect(outcome(() => {
      lists.setDefaultCACertificates(args[0]);
      const now = lists.getCACertificates("default");
      return { returned: U, shape: { ...record(shape(now), "shape"), allPem: now.length === 0 }, indexes: now.map(() => -1), same: lists.getCACertificates("default") === now, bundledUnchanged: lists.getCACertificates("bundled") === roots && lists.rootCertificates() === roots };
    }), JSON.stringify(row["args"]).slice(0, 60)).toEqual(expected(row));
  }
  lists.setDefaultCACertificates([r1, `${r0}\n${r3}`, r1]);
  expect(lists.getCACertificates().map(base64)).toEqual([r1, r0, r3].map(base64));
  expect(lists.getCACertificates().every(pem => pem.endsWith("-----END CERTIFICATE-----\n") && pem.split("\n")[1]?.length === 64)).toBe(true);
});

it("validates secure context options in Node's order and keeps them for tls.connect", () => {
  const { tls } = assisted();
  const named = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return decoded(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === "<R0>" ? r0 : Array.isArray(item) && item[0] === "<R0>" ? [r0, Buffer.from(r1)] : item]));
  };
  let compared = 0;
  for (const row of rows(control["secureContext"])) {
    const args = list(row["args"]).map(named);
    const actual = outcome(() => {
      const context = args.length === 0 ? tls.createSecureContext() : tls.createSecureContext(args[0]);
      return { instance: context instanceof tls.SecureContext, ctor: context.constructor.name, keys: Object.keys(context), contextType: typeof Reflect.get(context, "context") };
    });
    if (fromOpenSSL(row)) { expect(actual["error"], JSON.stringify(row["args"])).toBeUndefined(); continue; }
    expect(actual, JSON.stringify(row["args"]).slice(0, 80)).toEqual(expected(row));
    compared++;
  }
  expect(compared).toBeGreaterThanOrEqual(40);
  const recorded = record(control["secureContextClass"], "class");
  expect(outcome(() => Reflect.apply(tls.SecureContext, undefined, []) instanceof tls.SecureContext)).toEqual(recorded["viaCall"]);
  expect(outcome(() => { const made: unknown = Reflect.construct(tls.SecureContext, []); return Object.keys(record(made, "context")); })).toEqual(recorded["viaNew"]);
  expect(outcome(() => { const made: unknown = Reflect.construct(tls.SecureContext, ["TLSv1_2_method", 0, "TLSv1.2"]); return made; })).toEqual(recorded["conflict"]);
  expect(Object.getOwnPropertyNames(tls.SecureContext.prototype)).toEqual(recorded["protoKeys"]);
  expect(secureContextOptions(tls.createSecureContext({ ca: "PEM", minVersion: "TLSv1.3" }))).toEqual({ ca: "PEM", minVersion: "TLSv1.3" });
  expect(secureContextOptions({})).toBeUndefined();
});

it("connects with a secure context's ca and with an installed default CA list, and refuses what the guest's TLS cannot take", async () => {
  const { key, cert } = await createTLSTestIdentity();
  const server = createServer({ key, cert }, socket => socket.end("reached"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing port");
  const f = assisted();
  const read = (options: object): Promise<string> => new Promise((resolve, reject) => {
    const socket = f.tls.connect({ host: "127.0.0.1", port: address.port, servername: "localhost", ...options });
    let text = "";
    socket.on("data", bytes => { if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected TLS bytes"); text += Buffer.from(bytes).toString(); });
    socket.on("error", reject); socket.on("close", () => { resolve(text); });
  });
  try {
    // The context's ca is the trust of the connection; the connection's own ca is not read, as in Node.
    expect(await read({ secureContext: f.tls.createSecureContext({ ca: cert }) })).toBe("reached");
    expect(await read({ secureContext: f.tls.createSecureContext({ ca: [Buffer.from(cert)] }), ca: "ignored" })).toBe("reached");
    // A client certificate, or a context this module did not make, cannot be handed to the guest's TLS.
    expect(() => f.tls.connect({ host: "127.0.0.1", port: address.port, secureContext: f.tls.createSecureContext({ ca: cert, cert, key }) })).toThrow(VMError);
    expect(() => f.tls.connect({ host: "127.0.0.1", port: address.port, secureContext: { context: {} } })).toThrow(VMError);
    // An installed default list is the ca of a connection that names none; an empty one trusts nothing.
    f.tls.setDefaultCACertificates([cert]);
    expect(await read({})).toBe("reached");
    f.tls.setDefaultCACertificates([]);
    await expect(read({})).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(await read({ ca: cert })).toBe("reached");
    expect(f.references()).toBe(0); expect(f.native.hasPending).toBe(false);
  } finally { f.dispose(); server.close(); await once(server, "close"); }
}, 30000);
