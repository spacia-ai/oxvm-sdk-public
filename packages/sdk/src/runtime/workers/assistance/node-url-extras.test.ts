import { Buffer } from "buffer";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { controls, decoded, list, outcome, plain, rows } from "./node-controls.test-support.ts";
import { createNodeUrl } from "./node-url.ts";
import { createNodeUrlExtras } from "./node-url-extras.ts";

// Recorded from `require("url")` of node:24.18.1-alpine; the recorder is embedded in the control file.
const control = controls("node-url-extras.controls.json");
const url = createNodeUrlExtras();
const show = (value: unknown): unknown => {
  const object = record(value, "options");
  return plain({ proto: Object.getPrototypeOf(value) === null ? null : "object", keys: Reflect.ownKeys(object).map(String), value: object });
};
const hex = (value: unknown): unknown => ({ isBuffer: Buffer.isBuffer(value), hex: Buffer.isBuffer(value) ? value.toString("hex") : null });

it("was recorded from pinned Node", () => { expect(record(control["node"], "node")["version"]).toBe("v24.18.1"); });

it("has Node's function names and lengths and is served by createNodeUrl", () => {
  for (const row of list(control["functions"])) {
    const [key, name, length] = list(row);
    const callee: unknown = Reflect.get(url, String(key));
    expect(typeof callee).toBe("function");
    expect([Reflect.get(Object(callee), "name"), Reflect.get(Object(callee), "length")]).toEqual([name, length]);
  }
  const module = createNodeUrl(() => "/");
  expect(module.domainToASCII).toBe(url.domainToASCII);
  expect(module.urlToHttpOptions).toBe(url.urlToHttpOptions);
  expect(module.fileURLToPathBuffer).toBe(url.fileURLToPathBuffer);
});

it("converts domains like Node's ada, through the URL host parser", () => {
  const domains = rows(control["domains"]);
  expect(domains.length).toBeGreaterThanOrEqual(40);
  for (const row of domains) {
    // Node 24.18.1 (ada 2) does not apply the Bidi rule; newer URL parsers (Node 26, Chromium, Firefox) refuse this host.
    if (row["input"] === "a\u05d0.com" && url.domainToASCII(row["input"]) === "") continue;
    expect(url.domainToASCII(row["input"]), JSON.stringify(row["input"])).toBe(row["ascii"]);
    expect(url.domainToUnicode(row["input"]), JSON.stringify(row["input"])).toBe(row["unicode"]);
  }
  for (const row of rows(control["domainLoose"])) {
    expect(outcome(() => url.domainToASCII(decoded(row["arg"])))).toEqual(row["ascii"]);
    expect(outcome(() => url.domainToUnicode(decoded(row["arg"])))).toEqual(row["unicode"]);
  }
  const none = record(control["domainNoArg"], "no argument");
  expect(outcome(() => url.domainToASCII())).toEqual(none["ascii"]);
  expect(outcome(() => url.domainToUnicode())).toEqual(none["unicode"]);
});

it("builds HTTP options from URLs and URL-like objects", () => {
  for (const row of rows(control["httpOptions"])) expect(outcome(() => url.urlToHttpOptions(new URL(String(row["url"]))), show), String(row["url"])).toEqual({ value: row["value"] });
  const extended = Object.assign(new URL("http://a.b:81/c?d#e"), { custom: 1, headers: { x: "y" }, port2: "z" });
  Object.defineProperty(extended, "hidden", { value: 1, enumerable: false });
  expect(outcome(() => url.urlToHttpOptions(extended), show)).toEqual(control["httpOptionsExtended"]);
  for (const row of rows(control["httpOptionsPlain"])) {
    const expected = row["error"] === undefined ? { value: row["value"] } : { error: row["error"] };
    expect(outcome(() => url.urlToHttpOptions(row["input"]), show), JSON.stringify(row["input"])).toEqual(expected);
  }
  expect(outcome(() => url.urlToHttpOptions(Object.assign(function f() { return undefined; }, { pathname: "/x" })), show)).toEqual(control["httpOptionsFunction"]);
  for (const row of rows(control["httpOptionsLoose"])) expect(outcome(() => url.urlToHttpOptions(decoded(row["arg"])))).toEqual({ error: row["error"] });
});

it("decodes a file URL's path to bytes, valid UTF-8 or not", () => {
  const files = rows(control["fileBuffer"]);
  expect(files.length).toBeGreaterThanOrEqual(20);
  for (const row of files) {
    const input = String(row["input"]);
    expect(outcome(() => url.fileURLToPathBuffer(input), hex, ["input"]), input).toEqual(row["string"]);
    // A URL object that cannot be built is the recorder's own failure, not the function's.
    if (URL.canParse(input)) expect(outcome(() => url.fileURLToPathBuffer(new URL(input)), hex, ["input"]), input).toEqual(row["object"]);
  }
  for (const row of rows(control["fileBufferLoose"])) {
    const args = list(decoded(row["args"]));
    const expected = row["error"] === undefined ? { value: row["value"] } : { error: row["error"] };
    expect(outcome(() => url.fileURLToPathBuffer(args[0], args[1]), hex, ["input"]), JSON.stringify(row["args"])).toEqual(expected);
  }
  expect(() => url.fileURLToPathBuffer("file:///C:/a", { windows: true })).toThrow(expect.objectContaining({ code: "FEATURE_NOT_AVAILABLE" }));
});

it("exposes the browser's URLPattern only where there is one", () => {
  class Pattern { readonly kind = "pattern"; }
  expect(createNodeUrlExtras({ URLPattern: Pattern }).URLPattern).toBe(Pattern);
  expect("URLPattern" in createNodeUrlExtras({})).toBe(false);
});
