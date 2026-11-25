import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { installNodeBodies } from "./node-web-bodies.js";

/** A browser's Request and Response take a fixed set of body types and turn any other object into text. */
function browserRealm() {
  const seen: unknown[] = [];
  const text = async (body: unknown): Promise<string> => {
    if (body instanceof ReadableStream) return new globalThis.Response(body).text();
    return body === undefined || body === null ? "" : typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : Object.prototype.toString.call(body);
  };
  class Request {
    readonly body: unknown; readonly method: string; readonly duplex: unknown;
    constructor(readonly url: string, init: { readonly body?: unknown; readonly method?: string; readonly duplex?: unknown } = {}) { this.body = init.body; this.method = init.method ?? "GET"; this.duplex = init.duplex; seen.push(init.body); }
    text(): Promise<string> { return text(this.body); }
  }
  class Response {
    constructor(readonly body?: unknown, readonly init?: unknown) { seen.push(body); }
    text(): Promise<string> { return text(this.body); }
    static json(value: unknown): Response { return new Response(JSON.stringify(value)); }
  }
  return { realm: { Request, Response, ReadableStream }, seen };
}
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
const construct = (target: unknown, ...args: unknown[]): { text(): Promise<string> } => {
  if (typeof target !== "function") throw new TypeError("not a constructor");
  const made: unknown = Reflect.construct(target, args);
  if (typeof made !== "object" || made === null || !("text" in made) || typeof made.text !== "function") throw new TypeError("no text()");
  const read: unknown = made.text;
  return { text: async () => { const value: unknown = typeof read === "function" ? await Reflect.apply(read, made, []) : undefined; return typeof value === "string" ? value : ""; } };
};

it("reads a Node stream given as a request or response body, as Node's own classes do", async () => {
  // Next.js builds its request from the incoming Node stream: new Request(url, { body: stream, duplex: "half" }).
  const { realm, seen } = browserRealm();
  const before = construct(realm.Request, "http://n/", { method: "POST", body: Readable.from([Buffer.from('{"a":')]), duplex: "half" });
  expect(await before.text()).toBe("[object Object]");
  restore = installNodeBodies(realm);
  const request = construct(realm.Request, "http://n/", { method: "POST", body: Readable.from([Buffer.from('{"a":'), Buffer.from("1}")]), duplex: "half" });
  expect(seen.at(-1)).toBeInstanceOf(ReadableStream);
  expect(await request.text()).toBe('{"a":1}');
  async function* chunks() { await Promise.resolve(); yield new TextEncoder().encode("one "); yield new TextEncoder().encode("two"); }
  expect(await construct(realm.Response, chunks()).text()).toBe("one two");
});

it("leaves every body a browser already understands exactly as it was given", () => {
  const { realm, seen } = browserRealm();
  restore = installNodeBodies(realm);
  const stream = new ReadableStream<Uint8Array>(), bytes = new Uint8Array([1, 2]), form = new FormData(), params = new URLSearchParams("a=1"), blob = new Blob(["x"]);
  for (const [index, body] of ["text", bytes, bytes.buffer, new DataView(bytes.buffer), stream, form, params, blob, null, undefined].entries()) {
    construct(realm.Request, "http://n/", { method: "POST", body, duplex: "half" });
    expect(seen.at(-1), `request body ${String(index)}`).toBe(body);
    construct(realm.Response, body);
    expect(seen.at(-1), `response body ${String(index)}`).toBe(body);
  }
  construct(realm.Request, "http://n/");
  expect(seen.at(-1)).toBeUndefined();
});

it("keeps the classes themselves: identity of the prototype, subclasses, statics and instanceof", async () => {
  const { realm } = browserRealm(), NativeRequest = realm.Request, NativeResponse = realm.Response;
  restore = installNodeBodies(realm);
  expect(realm.Request.prototype).toBe(NativeRequest.prototype);
  expect(realm.Request.name).toBe("Request");
  class NextRequest extends realm.Request { readonly extra = true; }
  const made = new NextRequest("http://n/", { method: "PUT", body: Readable.from([Buffer.from("sub")]), duplex: "half" });
  expect([made instanceof NextRequest, made instanceof realm.Request, made instanceof NativeRequest, made.extra, made.method, made.duplex]).toEqual([true, true, true, true, "PUT", "half"]);
  expect(await made.text()).toBe("sub");
  expect(realm.Response.json({ ok: true })).toBeInstanceOf(NativeResponse);
  restore(); restore = undefined;
  expect(realm.Request).toBe(NativeRequest);
  expect(realm.Response).toBe(NativeResponse);
});

it("fails the read when a chunk is not bytes, and returns the stream's iterator when the body is cancelled", async () => {
  const { realm, seen } = browserRealm();
  restore = installNodeBodies(realm);
  async function* wrong() { await Promise.resolve(); yield "text"; }
  await expect(construct(realm.Request, "http://n/", { method: "POST", body: wrong(), duplex: "half" }).text()).rejects.toThrow("Received non-Uint8Array chunk");
  let returned = false;
  const source = { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: false, value: new Uint8Array(1) }), return: () => { returned = true; return Promise.resolve({ done: true, value: undefined }); } }) };
  construct(realm.Request, "http://n/", { method: "POST", body: source, duplex: "half" });
  const body = seen.at(-1);
  if (!(body instanceof ReadableStream)) throw new TypeError("not a stream");
  await body.cancel("stop");
  expect(returned).toBe(true);
});

/** Firefox's Request: no stream bodies. It does not read `duplex`, and a stream given as the body becomes its text. */
function realmWithoutStreamRequests() {
  class Request extends globalThis.Request {
    constructor(input: string | URL | globalThis.Request, init: RequestInit = {}) {
      const { body, method, headers } = init;
      super(input, { ...(method === undefined ? {} : { method }), ...(headers === undefined ? {} : { headers }), ...(body === undefined || body === null ? {} : { body: body instanceof ReadableStream ? "[object ReadableStream]" : body }) });
    }
  }
  return { Request, Response: globalThis.Response, ReadableStream };
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);

it("carries a stream body itself where the browser's Request has no stream bodies", async () => {
  const realm = realmWithoutStreamRequests();
  const before = new realm.Request("http://n/", { method: "POST", body: new ReadableStream<Uint8Array>() });
  expect(await before.text()).toBe("[object ReadableStream]");
  restore = installNodeBodies(realm);
  // A Node stream, as Next.js passes it, and a web stream: both arrive as their bytes.
  const web = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(jpeg)); controller.close(); } });
  for (const body of [Readable.from([jpeg.subarray(0, 3), jpeg.subarray(3)]), web]) {
    const request: unknown = Reflect.construct(realm.Request, ["http://n/upload?name=a", { method: "POST", headers: { "content-type": "image/jpeg" }, body, duplex: "half" }]);
    if (!(request instanceof globalThis.Request)) throw new TypeError("not a Request");
    expect([request.method, request.url, request.headers.get("content-type"), request.bodyUsed]).toEqual(["POST", "http://n/upload?name=a", "image/jpeg", false]);
    expect(request.body).toBeInstanceOf(ReadableStream);
    expect(Buffer.from(await request.arrayBuffer()).equals(jpeg)).toBe(true);
    expect(request.bodyUsed).toBe(true);
    await expect(request.arrayBuffer()).rejects.toBeInstanceOf(TypeError);
  }
});

it("reads a carried body as text, JSON or a form, and gives a clone its own copy", async () => {
  const realm = realmWithoutStreamRequests();
  restore = installNodeBodies(realm);
  const make = (text: string, type: string): globalThis.Request => {
    const request: unknown = Reflect.construct(realm.Request, ["http://n/", { method: "PUT", headers: { "content-type": type }, body: Readable.from([Buffer.from(text)]), duplex: "half" }]);
    if (!(request instanceof globalThis.Request)) throw new TypeError("not a Request");
    return request;
  };
  expect(await make('{"done":true}', "application/json").json()).toEqual({ done: true });
  expect(await make("plain", "text/plain").text()).toBe("plain");
  expect((await make("a=1&b=two", "application/x-www-form-urlencoded").formData()).get("b")).toBe("two");
  expect((await make("blob", "text/plain").blob()).size).toBe(4);
  const original = make("twice", "text/plain"), copy = original.clone();
  expect([await copy.text(), await original.text()]).toEqual(["twice", "twice"]);
  expect(() => original.clone()).toThrow(TypeError);
});

it("keeps subclasses and bodies the browser understands in a realm without stream bodies", async () => {
  const realm = realmWithoutStreamRequests();
  restore = installNodeBodies(realm);
  const Base: unknown = Reflect.get(realm, "Request");
  if (typeof Base !== "function") throw new TypeError("no Request");
  const made: unknown = Reflect.construct(Base, ["http://n/", { method: "POST", body: "text" }]);
  if (!(made instanceof globalThis.Request)) throw new TypeError("not a Request");
  expect(Object.getOwnPropertyNames(made)).toEqual([]);
  expect(await made.text()).toBe("text");
  class NextRequest extends realm.Request { readonly next = true; }
  const sub: unknown = Reflect.construct(Base, ["http://n/", { method: "POST", body: Readable.from([jpeg]), duplex: "half" }], NextRequest);
  expect(sub).toBeInstanceOf(NextRequest);
  if (!(sub instanceof NextRequest)) throw new TypeError("not a NextRequest");
  expect(Buffer.from(await sub.arrayBuffer()).equals(jpeg)).toBe(true);
  // A request made from a carried one takes its body over.
  const first: unknown = Reflect.construct(Base, ["http://n/", { method: "POST", body: Readable.from([jpeg]), duplex: "half" }]);
  const second: unknown = Reflect.construct(Base, [first]);
  if (!(first instanceof globalThis.Request) || !(second instanceof globalThis.Request)) throw new TypeError("not a Request");
  expect(Buffer.from(await second.arrayBuffer()).equals(jpeg)).toBe(true);
  expect(first.bodyUsed).toBe(true);
});
