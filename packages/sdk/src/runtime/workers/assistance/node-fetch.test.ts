import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { brotliCompressSync, createBrotliDecompress, createGunzip, createInflate, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { createNodeFetch, installNodeFetch, type FetchPorts } from "./node-fetch.js";

interface Sent { readonly options: Record<string, unknown>; readonly body: Buffer }
interface Reply { readonly status?: number; readonly message?: string; readonly headers?: readonly string[]; readonly body?: Uint8Array | string; readonly error?: Error }

/** An `http.request` that records what was sent and answers from a script, one reply per request. */
function transport(replies: readonly Reply[]) {
  const sent: Sent[] = [], responses: Readable[] = [];
  const request = (options: Record<string, unknown>, callback: (response: unknown) => void): unknown => {
    const reply = replies[sent.length] ?? {}, client = new EventEmitter(), signal = options["signal"];
    const fail = (error: unknown): void => { queueMicrotask(() => { client.emit("error", error); }); };
    if (signal instanceof AbortSignal) signal.addEventListener("abort", () => { fail(signal.reason); }, { once: true });
    return Object.assign(client, {
      end(chunk?: Uint8Array): void {
        sent.push({ options, body: Buffer.from(chunk ?? new Uint8Array()) });
        if (reply.error !== undefined) { fail(reply.error); return; }
        if (signal instanceof AbortSignal && signal.aborted) return;
        const response = Object.assign(Readable.from(reply.body === undefined ? [] : [Buffer.from(reply.body)]), { statusCode: reply.status ?? 200, statusMessage: reply.message ?? "OK", rawHeaders: [...(reply.headers ?? [])] });
        responses.push(response);
        queueMicrotask(() => { callback(response); });
      },
    });
  };
  const ports: FetchPorts = { http: request, https: request, decoders: { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress } };
  return { sent, responses, ports };
}
const realm = (): Record<string, unknown> => ({ Request, Response, Headers, fetch: () => Promise.resolve(new Response("from the browser")) });
function isResponse(value: unknown): Response { if (!(value instanceof Response)) throw new TypeError("not a Response"); return value; }
const run = async (replies: readonly Reply[], input: unknown, init?: unknown) => {
  const wire = transport(replies);
  return { ...wire, response: isResponse(await createNodeFetch(realm(), wire.ports)(input, init)) };
};

it("sends a GET through the process's HTTP client and answers with the realm's Response", async () => {
  const { sent, response } = await run([{ status: 201, message: "Created", headers: ["Content-Type", "application/json", "Set-Cookie", "a=1", "Set-Cookie", "b=2"], body: '{"ok":true}' }], "http://127.0.0.1:3000/api/items?page=2");
  expect(sent[0]?.options).toMatchObject({ protocol: "http:", hostname: "127.0.0.1", port: 3000, path: "/api/items?page=2", method: "GET" });
  expect(sent[0]?.options["headers"]).toEqual({ accept: "*/*", "accept-language": "*", "sec-fetch-mode": "cors", "user-agent": "node", "accept-encoding": "gzip, deflate" });
  expect([response.status, response.statusText, response.ok, response.url, response.redirected, response.type]).toEqual([201, "Created", true, "http://127.0.0.1:3000/api/items?page=2", false, "basic"]);
  // Node keeps the cookies a browser's Response hides.
  expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  const copy = response.clone();
  expect([copy.url, copy.headers.get("content-type")]).toEqual([response.url, "application/json"]);
  expect([await response.json(), await copy.json()]).toEqual([{ ok: true }, { ok: true }]);
});

it("sends the body whole with its length, and the program's own headers as written", async () => {
  const text = await run([{}], "https://example.test/upload", { method: "POST", body: "hello", headers: { Cookie: "session=1", Authorization: "Bearer t" } });
  expect(text.sent[0]?.options).toMatchObject({ protocol: "https:", hostname: "example.test", path: "/upload", method: "POST" });
  expect(text.sent[0]?.options).not.toHaveProperty("port");
  expect(text.sent[0]?.options["headers"]).toMatchObject({ cookie: "session=1", authorization: "Bearer t", "content-type": "text/plain;charset=UTF-8", "content-length": "5", "accept-encoding": "br, gzip, deflate" });
  expect(text.sent[0]?.body.toString()).toBe("hello");
  const built: unknown = Reflect.construct(Request, ["http://h/", { method: "PUT", duplex: "half", headers: { "content-type": "image/jpeg" }, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); } }) }]);
  const stream = await run([{}], built);
  expect([...stream.sent[0]?.body ?? []]).toEqual([1, 2, 3]);
  expect(stream.sent[0]?.options["headers"]).toMatchObject({ "content-type": "image/jpeg", "content-length": "3" });
  expect((await run([{}], "http://h/", { method: "POST" })).sent[0]?.options["headers"]).toMatchObject({ "content-length": "0" });
});

it("sends a body where the browser's Request has no body property (Firefox)", async () => {
  class FirefoxRequest extends Request {}
  Object.defineProperty(FirefoxRequest.prototype, "body", { configurable: true, get: () => undefined });
  const wire = transport([{}, {}, {}]), fetch = createNodeFetch({ ...realm(), Request: FirefoxRequest }, wire.ports);
  await fetch("http://h/", { method: "POST", body: "hello" });
  await fetch("http://h/", { method: "PATCH", body: new Uint8Array([1, 2, 3]) });
  await fetch("http://h/");
  const length = (one: Sent): unknown => { const headers = one.options["headers"]; return typeof headers === "object" && headers !== null ? Reflect.get(headers, "content-length") : undefined; };
  expect(wire.sent.map(one => [one.options["method"], [...one.body], length(one)])).toEqual([["POST", [104, 101, 108, 108, 111], "5"], ["PATCH", [1, 2, 3], "3"], ["GET", [], undefined]]);
});

it("decodes gzip and Brotli bodies and gives no body where the answer has none", async () => {
  expect(await (await run([{ headers: ["content-encoding", "gzip"], body: gzipSync("zipped") }], "http://h/")).response.text()).toBe("zipped");
  expect(await (await run([{ headers: ["Content-Encoding", "BR"], body: brotliCompressSync("brotli") }], "https://h/")).response.text()).toBe("brotli");
  const unknown = await run([{ headers: ["content-encoding", "zstd"], body: "as it arrived" }], "http://h/");
  expect(await unknown.response.text()).toBe("as it arrived");
  for (const [reply, init] of [[{ status: 204 }, {}], [{ status: 304 }, {}], [{ headers: ["content-encoding", "gzip"] }, { method: "HEAD" }]] as const) {
    const { response } = await run([reply], "http://h/", init);
    expect([response.body, await response.text()]).toEqual([null, ""]);
  }
});

it("follows redirects as Node does", async () => {
  const moved = await run([{ status: 302, headers: ["Location", "/next?x=1"] }, { body: "there" }], "http://h:8080/start", { method: "POST", body: "data", headers: { authorization: "k" } });
  expect(moved.sent.map(one => [one.options["method"], one.options["path"], one.body.toString()])).toEqual([["POST", "/start", "data"], ["GET", "/next?x=1", ""]]);
  expect(moved.sent[1]?.options["headers"]).toMatchObject({ authorization: "k" });
  expect(moved.sent[1]?.options["headers"]).not.toHaveProperty("content-length");
  expect([moved.response.url, moved.response.redirected, await moved.response.text()]).toEqual(["http://h:8080/next?x=1", true, "there"]);
  const kept = await run([{ status: 307, headers: ["location", "https://other.test/again"] }, {}], "http://h/", { method: "PUT", body: "same", headers: { authorization: "k", cookie: "c=1" } });
  expect([kept.sent[1]?.options["method"], kept.sent[1]?.options["protocol"], kept.sent[1]?.options["hostname"], kept.sent[1]?.body.toString()]).toEqual(["PUT", "https:", "other.test", "same"]);
  // Another origin does not get the credentials.
  expect(kept.sent[1]?.options["headers"]).not.toHaveProperty("authorization");
  expect(kept.sent[1]?.options["headers"]).not.toHaveProperty("cookie");
  const manual = await run([{ status: 301, headers: ["location", "/elsewhere"] }], "http://h/", { redirect: "manual" });
  expect([manual.sent.length, manual.response.status, manual.response.headers.get("location")]).toEqual([1, 301, "/elsewhere"]);
  await expect(run([{ status: 302, headers: ["location", "/x"] }], "http://h/", { redirect: "error" })).rejects.toMatchObject({ message: "fetch failed", cause: { message: "unexpected redirect" } });
  await expect(run(Array.from({ length: 30 }, () => ({ status: 302, headers: ["location", "/loop"] })), "http://h/")).rejects.toMatchObject({ cause: { message: "redirect count exceeded" } });
});

it("rejects the way Node's fetch does", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
  await expect(run([{ error: refused }], "http://127.0.0.1:9/")).rejects.toMatchObject({ name: "TypeError", message: "fetch failed", cause: refused });
  await expect(run([], "/relative")).rejects.toMatchObject({ name: "TypeError", message: "Failed to parse URL from /relative" });
  await expect(run([], "ftp://h/file")).rejects.toMatchObject({ message: "fetch failed", cause: { message: "unknown scheme" } });
  const before = await run([], "http://h/", { signal: AbortSignal.abort(new Error("stopped early")) }).catch((error: unknown) => error);
  expect(before).toMatchObject({ message: "stopped early" });
  const controller = new AbortController(), wire = transport([{}]);
  const pending = createNodeFetch(realm(), { ...wire.ports, http: (options, callback) => { const client = wire.ports.http(options, callback); queueMicrotask(() => { controller.abort(); }); if (!(client instanceof EventEmitter)) throw new TypeError("no client"); return Object.assign(client, { end(): void { /* never answers */ } }); } })("http://h/", { signal: controller.signal });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("decodes data: URLs itself, leaves blob: URLs to the browser, and can be installed and removed", async () => {
  const wire = transport([{ body: "from the VM" }]), target = realm(), browser = target["fetch"];
  const restore = installNodeFetch(target, wire.ports), installed = target["fetch"];
  if (typeof installed !== "function") throw new TypeError("no fetch");
  expect(await isResponse(await Reflect.apply(installed, target, ["blob:nodedata:1"])).text()).toBe("from the browser");
  const plain = isResponse(await Reflect.apply(installed, target, ["data:text/plain,hi%20there#frag"]));
  expect([plain.status, plain.headers.get("content-type"), plain.url, await plain.text()]).toEqual([200, "text/plain", "data:text/plain,hi%20there#frag", "hi there"]);
  const binary = isResponse(await Reflect.apply(installed, target, ["data:application/octet-stream;base64,AAEC/w=="]));
  expect([binary.headers.get("content-type"), [...new Uint8Array(await binary.arrayBuffer())]]).toEqual(["application/octet-stream", [0, 1, 2, 255]]);
  expect(isResponse(await Reflect.apply(installed, target, ["data:,x"])).headers.get("content-type")).toBe("text/plain;charset=US-ASCII");
  await expect(Reflect.apply(installed, target, ["data:text/plain;base64,%%%"])).rejects.toMatchObject({ message: "fetch failed" });
  expect(await isResponse(await Reflect.apply(installed, target, ["http://h/"])).text()).toBe("from the VM");
  expect(wire.sent).toHaveLength(1);
  restore();
  expect(target["fetch"]).toBe(browser);
});
