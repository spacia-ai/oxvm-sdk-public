/**
 * Node's `Request` and `Response` (undici) take any async iterable of bytes as a body, such as a Node stream. A
 * browser's take a fixed set of types and turn any other object into the text "[object Object]". Server frameworks rely
 * on Node's behavior: Next.js builds the request of a route handler from the incoming Node stream, so with the
 * browser's class every POST or PUT body read as "[object Object]".
 *
 * The realm keeps the browser's classes. Only the body argument is adapted on the way in: an async iterable that is not
 * already a body type becomes a `ReadableStream` of its chunks. Prototypes, statics, subclasses and `instanceof` are
 * the browser's own, because the replacement is a proxy over the same constructor.
 *
 * Firefox and Safari have no stream request bodies at all: a stream given to `Request` becomes the text
 * "[object ReadableStream]". There the stream is kept beside a body-less request, and the request's own body members
 * (`body`, `bodyUsed`, `arrayBuffer`, `blob`, `bytes`, `formData`, `json`, `text`, `clone`) read it. Not covered: a
 * `fetch` of such a request sends no body.
 */
type Realm = Record<string, unknown>;

function asyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, Symbol.asyncIterator) === "function";
}

/** Whether a browser reads this body itself. */
function nativeBody(value: unknown, realm: Realm): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  for (const name of ["ReadableStream", "Blob", "FormData", "URLSearchParams", "SharedArrayBuffer"]) {
    const constructor: unknown = Reflect.get(realm, name) ?? Reflect.get(globalThis, name);
    if (typeof constructor === "function" && value instanceof constructor) return true;
  }
  return false;
}

function streamSource(source: AsyncIterable<unknown>): UnderlyingDefaultSource<Uint8Array> {
  let iterator: AsyncIterator<unknown> | undefined;
  return {
    async pull(controller) {
      iterator ??= source[Symbol.asyncIterator]();
      const next = await iterator.next();
      if (next.done === true) { controller.close(); return; }
      // undici's message for the same mistake.
      if (!(next.value instanceof Uint8Array)) throw new TypeError("Received non-Uint8Array chunk");
      controller.enqueue(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength));
    },
    async cancel(reason) {
      iterator ??= source[Symbol.asyncIterator]();
      await iterator.return?.(reason);
    },
  };
}

/** Whether the realm's `Request` takes a stream as its body. One that does asks for `duplex`. */
function streamsRequests(request: unknown, stream: unknown): boolean {
  if (typeof request !== "function" || typeof stream !== "function") return false;
  let asked = false;
  try {
    const body: unknown = Reflect.construct(stream, []);
    Reflect.construct(request, ["http://localhost/", Object.defineProperty({ method: "POST", body }, "duplex", { enumerable: true, get: () => { asked = true; return "half"; } })]);
  } catch { return false; }
  return asked;
}

const member = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, name) : undefined;

interface Carried { stream: ReadableStream<Uint8Array>; used: boolean }
const READERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;
const spent = (state: Carried): boolean => state.used || state.stream.locked;

/** Gives a body-less request the body members that read `stream`. `response` is the realm's `Response`, which reads
 * a stream in every browser; `clone` is the realm's own `Request.prototype.clone`. */
function carry(carried: WeakMap<object, Carried>, request: object, stream: ReadableStream<Uint8Array>, response: unknown, clone: unknown): void {
  const state: Carried = { stream, used: false };
  carried.set(request, state);
  const read = async (kind: typeof READERS[number]): Promise<unknown> => {
    if (spent(state)) throw new TypeError("Body has already been consumed");
    if (typeof response !== "function") throw new TypeError("The realm has no Response");
    state.used = true;
    const holder: unknown = Reflect.construct(response, [state.stream, { headers: member(request, "headers") }]);
    const reader: unknown = member(holder, kind);
    if (typeof reader === "function") { const value: unknown = await Reflect.apply(reader, holder, []); return value; }
    // `bytes()` is newer than the other readers.
    const fallback: unknown = member(holder, "arrayBuffer");
    const whole: unknown = typeof fallback === "function" ? await Reflect.apply(fallback, holder, []) : undefined;
    if (!(whole instanceof ArrayBuffer)) throw new TypeError("The body could not be read");
    return new Uint8Array(whole);
  };
  const members: PropertyDescriptorMap = {
    body: { configurable: true, get: () => state.stream },
    bodyUsed: { configurable: true, get: () => spent(state) },
    clone: { configurable: true, writable: true, value: (): object => {
      if (spent(state)) throw new TypeError("Request.clone: Body has already been consumed");
      if (typeof clone !== "function") throw new TypeError("The realm's Request cannot be cloned");
      const [kept, given] = state.stream.tee();
      state.stream = kept;
      const copy: unknown = Reflect.apply(clone, request, []);
      if (typeof copy !== "object" || copy === null) throw new TypeError("Request.clone returned no object");
      carry(carried, copy, given, response, clone);
      return copy;
    } },
  };
  for (const kind of READERS) members[kind] = { configurable: true, writable: true, value: () => read(kind) };
  Object.defineProperties(request, members);
}

interface Prepared { readonly args: unknown[]; readonly carry?: ReadableStream<Uint8Array> }
/** A copy of `init` with the same own properties except the named ones: the caller's object is not changed. */
function without(init: object, names: readonly string[], more: PropertyDescriptorMap = {}): object {
  const descriptors: PropertyDescriptorMap = { ...Object.getOwnPropertyDescriptors(init), ...more };
  for (const name of names) Reflect.deleteProperty(descriptors, name);
  return Object.defineProperties({}, descriptors);
}

/** Makes the realm's `Request` and `Response` accept async iterable bodies; returns the undo. */
export function installNodeBodies(realmValue: unknown): () => void {
  if (typeof realmValue !== "object" || realmValue === null) throw new TypeError("Invalid realm");
  const realm: Realm = Object.fromEntries([]), target = realmValue;
  for (const name of ["Request", "Response", "ReadableStream", "Blob", "FormData", "URLSearchParams", "SharedArrayBuffer"]) realm[name] = Reflect.get(target, name);
  const Stream = realm["ReadableStream"];
  if (typeof Stream !== "function") return () => undefined;
  const isStream = (value: unknown): value is ReadableStream<Uint8Array> => value instanceof Stream;
  const adapt = (body: unknown): unknown => {
    if (!asyncIterable(body) || nativeBody(body, realm)) return body;
    // The realm's own stream class, so that the realm's Request recognizes it.
    const stream: unknown = Reflect.construct(Stream, [streamSource(body)]);
    return stream;
  };
  const streaming = streamsRequests(realm["Request"], Stream), carried = new WeakMap<object, Carried>();
  const nativeRequest = realm["Request"], nativeClone: unknown = member(member(nativeRequest, "prototype"), "clone");
  const restore: (() => void)[] = [];
  const replace = (name: "Request" | "Response", prepare: (args: unknown[]) => Prepared): void => {
    const native = realm[name], previous = Object.getOwnPropertyDescriptor(target, name);
    if (typeof native !== "function" || previous === undefined || previous.configurable !== true) return;
    const proxy: unknown = new Proxy(native, {
      construct(constructor, args: unknown[], newTarget) {
        const prepared = prepare(args);
        const made: unknown = Reflect.construct(constructor, prepared.args, newTarget === proxy ? constructor : newTarget);
        if ((typeof made !== "object" && typeof made !== "function") || made === null) throw new TypeError(`${name} constructor returned no object`);
        if (prepared.carry !== undefined) carry(carried, made, prepared.carry, realm["Response"], nativeClone);
        return made;
      },
    });
    Object.defineProperty(target, name, { ...previous, value: proxy });
    restore.push(() => { Object.defineProperty(target, name, previous); });
  };
  replace("Request", args => {
    const input = args[0], init = args[1], options = typeof init === "object" && init !== null ? init : undefined;
    const body: unknown = options === undefined ? undefined : Reflect.get(options, "body"), adapted = adapt(body);
    if (!streaming) {
      if (options !== undefined && isStream(adapted)) return { args: [input, without(options, ["body", "duplex"]), ...args.slice(2)], carry: adapted };
      // A request made from a carried one takes its body over, as the browser does for its own bodies.
      const source = body === undefined && typeof input === "object" && input !== null ? carried.get(input) : undefined;
      if (source !== undefined) {
        if (spent(source)) throw new TypeError("Cannot construct a Request with a Request object that has already been used.");
        source.used = true;
        return { args, carry: source.stream };
      }
    }
    if (options === undefined || adapted === body) return { args };
    return { args: [input, without(options, [], { body: { value: adapted, enumerable: true, configurable: true, writable: true } }), ...args.slice(2)] };
  });
  replace("Response", args => { const adapted = adapt(args[0]); return { args: adapted === args[0] ? args : [adapted, ...args.slice(1)] }; });
  return () => { for (const reset of restore.reverse()) reset(); restore.length = 0; };
}
