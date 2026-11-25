/**
 * Node's global `fetch` for a fast-path process.
 *
 * The worker's own `fetch` is the browser's: it has no route to the VM's network, so every call a program made failed.
 * This one sends the request through the process's `http` and `https` clients, which use the process's Linux sockets,
 * so a request reaches what the VM can reach, under the VM's network policy, and nothing else.
 *
 * The realm's `Request`, `Response` and `Headers` do the parsing and hold the result, so a program sees the classes it
 * would see in Node. Followed here, as undici does them: default headers, redirects, `AbortSignal`, and gzip, deflate
 * and Brotli response bodies.
 *
 * A `data:` URL is decoded here, since the worker's `fetch` is closed to it too.
 *
 * Not covered: a request body is read whole before it is sent (no streamed upload); a `blob:` URL goes to the
 * browser's `fetch`; a `Request` the program built itself has already lost the header names a browser forbids
 * (`cookie`, `host`), while headers given in `init` are sent as written; no HTTP cache, cookies jar or proxy.
 */
type Requester = (options: Record<string, unknown>, callback: (response: unknown) => void) => unknown;
/** What `fetch` uses of the process: `http.request`, `https.request` and the response-body decoders of `zlib`. */
export interface FetchPorts {
  readonly http: Requester;
  readonly https: Requester;
  readonly decoders: { readonly gzip?: () => unknown; readonly deflate?: () => unknown; readonly br?: () => unknown };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]), NULL_BODY = new Set([101, 204, 205, 304]), MAX_REDIRECTS = 20;
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];
const CROSS_ORIGIN_HEADERS = ["authorization", "cookie", "proxy-authorization", "host"];

const member = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, name) : undefined;
function invoke(target: unknown, name: string, ...args: unknown[]): unknown {
  const method = member(target, name);
  if (typeof method !== "function") throw new TypeError(`fetch: the HTTP client has no ${name}()`);
  const result: unknown = Reflect.apply(method, target, args);
  return result;
}
/** undici's rejection for every failure below the request itself. */
const failed = (cause: unknown): TypeError => new TypeError("fetch failed", { cause });
const abortedBy = (signal: unknown): signal is AbortSignal => signal instanceof AbortSignal && signal.aborted;

/** The media type and bytes of a `data:` URL (RFC 2397), as the Fetch standard reads one. */
function dataUrl(url: URL): { readonly type: string; readonly bytes: Uint8Array<ArrayBuffer> } | undefined {
  const text = url.href.slice("data:".length, url.hash === "" ? undefined : -url.hash.length), comma = text.indexOf(",");
  if (comma < 0) return undefined;
  const head = text.slice(0, comma).trim(), base64 = /;\s*base64$/iu.exec(head), media = (base64 === null ? head : head.slice(0, base64.index)).trim();
  const payload = text.slice(comma + 1), bytes: number[] = [];
  try {
    if (base64 === null) {
      // Percent-decoding works on bytes: the text's UTF-8, with each %XX replaced by its byte.
      const encoded = new TextEncoder().encode(payload);
      for (let index = 0; index < encoded.length; index++) {
        const hex = encoded[index] === 0x25 ? /^[0-9a-f]{2}$/iu.exec(String.fromCharCode(...encoded.subarray(index + 1, index + 3))) : null;
        if (hex === null) bytes.push(encoded[index] ?? 0); else { bytes.push(Number.parseInt(hex[0], 16)); index += 2; }
      }
    } else for (const character of atob(decodeURIComponent(payload).replace(/[\t\n\f\r ]/gu, ""))) bytes.push(character.charCodeAt(0));
  } catch { return undefined; }
  return { type: media === "" || media.startsWith(";") ? `text/plain${media === "" ? ";charset=US-ASCII" : media}` : media, bytes: Uint8Array.from(bytes) };
}

interface Head { readonly status: number; readonly statusText: string; readonly headers: Headers; readonly stream: unknown }

/** Node's `fetch` over `ports`, with the classes of `realmValue`. */
export function createNodeFetch(realmValue: unknown, ports: FetchPorts): (input: unknown, init?: unknown) => Promise<unknown> {
  const browserFetch = member(realmValue, "fetch");
  const make = (name: string, args: unknown[]): unknown => {
    const constructor = member(realmValue, name);
    if (typeof constructor !== "function") throw new TypeError(`fetch: the realm has no ${name}`);
    const made: unknown = Reflect.construct(constructor, args);
    return made;
  };
  const headerList = (source?: unknown): Headers => {
    const headers = make("Headers", source === undefined || source === null ? [] : [source]);
    if (!(headers instanceof Headers)) throw new TypeError("fetch: the realm's Headers is not the platform's");
    return headers;
  };

  /** Resolves either way: a rejection reason must be the signal's own, which need not be an Error. */
  const send = (url: URL, method: string, headers: Headers, body: Uint8Array | undefined, signal: unknown): Promise<Head | { readonly failure: unknown }> => new Promise(resolve => {
    const fields: Record<string, string> = {};
    headers.forEach((value, name) => { fields[name] = value; });
    if (body !== undefined) fields["content-length"] = String(body.byteLength);
    else if (method === "POST" || method === "PUT") fields["content-length"] = "0";
    const stop = (cause: unknown): void => { resolve({ failure: abortedBy(signal) ? signal.reason : failed(cause) }); };
    try {
      const client = (url.protocol === "https:" ? ports.https : ports.http)({
        protocol: url.protocol, hostname: url.hostname, ...(url.port === "" ? {} : { port: Number(url.port) }), path: `${url.pathname}${url.search}`, method, headers: fields,
        ...(signal instanceof AbortSignal ? { signal } : {}),
      }, response => {
        const raw = member(response, "rawHeaders"), pairs: [string, string][] = [];
        if (Array.isArray(raw)) for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([String(raw[index]), String(raw[index + 1])]);
        const status = member(response, "statusCode"), text = member(response, "statusMessage");
        try { resolve({ status: typeof status === "number" ? status : 0, statusText: typeof text === "string" ? text : "", headers: headerList(pairs), stream: response }); }
        catch (cause) { stop(cause); }
      });
      invoke(client, "on", "error", stop);
      invoke(client, "end", ...(body === undefined ? [] : [body]));
    } catch (cause) { stop(cause); }
  });

  /** The response body as the program reads it: decoded as `content-encoding` says, unless the answer has no body. */
  const decoded = (head: Head, method: string): unknown => {
    if (method === "HEAD" || NULL_BODY.has(head.status)) { invoke(head.stream, "resume"); return null; }
    let stream = head.stream;
    const codings = (head.headers.get("content-encoding") ?? "").toLowerCase().split(",").map(coding => coding.trim()).filter(coding => coding !== "");
    const makers = codings.map(coding => coding === "gzip" || coding === "x-gzip" ? ports.decoders.gzip : coding === "deflate" ? ports.decoders.deflate : coding === "br" ? ports.decoders.br : undefined);
    // A coding with no decoder leaves the body as it arrived, as undici does.
    if (makers.includes(undefined)) return stream;
    for (const maker of makers.reverse()) {
      const decoder: unknown = maker?.(), source = stream;
      invoke(source, "on", "error", (cause: unknown) => { invoke(decoder, "destroy", cause); });
      invoke(source, "pipe", decoder);
      stream = decoder;
    }
    return stream;
  };

  /** A browser's own `Response` has no URL and hides `set-cookie`; Node's has both. */
  const dress = (response: unknown, values: { readonly url: string; readonly redirected: boolean; readonly headers: Headers }): unknown => {
    if (typeof response !== "object" || response === null) throw new TypeError("fetch: the realm's Response returned no object");
    const clone = member(response, "clone");
    Object.defineProperties(response, {
      url: { configurable: true, get: () => values.url }, redirected: { configurable: true, get: () => values.redirected },
      type: { configurable: true, get: () => "basic" }, headers: { configurable: true, get: () => values.headers },
      clone: { configurable: true, writable: true, value: (): unknown => dress(typeof clone === "function" ? Reflect.apply(clone, response, []) : undefined, { ...values, headers: headerList(values.headers) }) },
    });
    return response;
  };

  return async function fetch(input: unknown, init?: unknown): Promise<unknown> {
    // Node has no page to resolve a relative address against.
    if (typeof input === "string" && !URL.canParse(input)) throw new TypeError(`Failed to parse URL from ${input}`, { cause: Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input }) });
    const request = make("Request", init === undefined ? [input] : [input, init]), signal = member(request, "signal");
    if (abortedBy(signal)) throw signal.reason;
    let url = new URL(String(member(request, "url")));
    if (url.protocol === "data:") {
      const data = dataUrl(url);
      if (data === undefined) throw failed(new Error("invalid data URL"));
      return dress(make("Response", [data.bytes, { status: 200, statusText: "OK", headers: { "content-type": data.type } }]), { url: url.href, redirected: false, headers: headerList({ "content-type": data.type }) });
    }
    if (url.protocol === "blob:") {
      if (typeof browserFetch !== "function") throw failed(new Error("unknown scheme"));
      const local: unknown = await Reflect.apply(browserFetch, realmValue, [request]);
      return local;
    }
    // The program's header list first: a browser's Request drops the names it forbids a page to set.
    const headers = headerList(member(init, "headers") ?? (typeof input === "object" && input !== null ? member(input, "headers") : undefined));
    headerList(member(request, "headers")).forEach((value, name) => { if (!headers.has(name)) headers.set(name, value); });
    const coding = [url.protocol === "https:" && ports.decoders.br !== undefined ? "br" : "", ports.decoders.gzip === undefined ? "" : "gzip", ports.decoders.deflate === undefined ? "" : "deflate"].filter(name => name !== "").join(", ");
    for (const [name, value] of [["accept", "*/*"], ["accept-language", "*"], ["sec-fetch-mode", "cors"], ["user-agent", "node"], ["accept-encoding", coding]] as const) if (value !== "" && !headers.has(name)) headers.set(name, value);
    let method = String(member(request, "method")), redirected = false, body: Uint8Array | undefined;
    // Firefox's Request has no `body` property, so only a null says there is none. GET and HEAD never have one.
    if (member(request, "body") !== null && method !== "GET" && method !== "HEAD") {
      const whole: unknown = await invoke(request, "arrayBuffer");
      if (!(whole instanceof ArrayBuffer)) throw failed(new Error("the request body could not be read"));
      if (whole.byteLength > 0 || member(request, "body") !== undefined) body = new Uint8Array(whole);
    }
    const mode = member(request, "redirect");
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw failed(new Error("unknown scheme"));
      const answer = await send(url, method, headers, body, signal);
      if ("failure" in answer) throw answer.failure;
      const head = answer, location = head.headers.get("location");
      if (REDIRECTS.has(head.status) && location !== null && mode !== "manual") {
        invoke(head.stream, "resume");
        if (mode === "error") throw failed(new Error("unexpected redirect"));
        if (hop >= MAX_REDIRECTS) throw failed(new Error("redirect count exceeded"));
        if (!URL.canParse(location, url)) throw failed(new Error("invalid redirect location"));
        const next = new URL(location, url);
        if ((head.status === 303 && method !== "GET" && method !== "HEAD") || ((head.status === 301 || head.status === 302) && method === "POST")) {
          method = "GET"; body = undefined;
          for (const name of BODY_HEADERS) headers.delete(name);
        }
        if (next.origin !== url.origin) for (const name of CROSS_ORIGIN_HEADERS) headers.delete(name);
        url = next; redirected = true;
        continue;
      }
      const stream = decoded(head, method);
      if (signal instanceof AbortSignal && stream !== null) signal.addEventListener("abort", () => { invoke(stream, "destroy", signal.reason); }, { once: true });
      try { return dress(make("Response", [stream, { status: head.status, statusText: head.statusText, headers: head.headers }]), { url: url.href, redirected, headers: head.headers }); }
      catch (cause) { if (stream !== null) invoke(stream, "destroy"); throw failed(cause); }
    }
  };
}

/** Replaces the realm's `fetch` with Node's; returns the undo. */
export function installNodeFetch(realmValue: unknown, ports: FetchPorts): () => void {
  if (typeof realmValue !== "object" || realmValue === null) throw new TypeError("Invalid realm");
  const previous = Object.getOwnPropertyDescriptor(realmValue, "fetch");
  if (previous?.configurable === false) return () => undefined;
  Object.defineProperty(realmValue, "fetch", { configurable: true, enumerable: previous?.enumerable ?? true, writable: true, value: createNodeFetch(realmValue, ports) });
  return () => { if (previous === undefined) Reflect.deleteProperty(realmValue, "fetch"); else Object.defineProperty(realmValue, "fetch", previous); };
}
