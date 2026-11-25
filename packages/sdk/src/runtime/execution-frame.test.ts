import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openExecutionFrame } from "./execution-frame.js";

const EXECUTION_URL = new URL("https://js.test/v/1/oxidevm-native-process/index.html");

interface Posted { readonly message: unknown; readonly targetOrigin: string }

/** The iframe as `openExecutionFrame` uses it. `deliver` decides what the framed document does with the bootstrap. */
function fakeFrame(deliver: (posted: Posted) => void) {
  return {
    hidden: false, allow: "", src: "", sandbox: { add: vi.fn<(...tokens: string[]) => void>() },
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    contentWindow: { postMessage: (message: unknown, targetOrigin: string) => { deliver({ message, targetOrigin }); } },
    remove: vi.fn<() => void>(),
  };
}

function install(frame: ReturnType<typeof fakeFrame>, ancestorOrigins?: readonly string[]): void {
  vi.stubGlobal("location", { origin: "https://run.test", ...(ancestorOrigins === undefined ? {} : { ancestorOrigins }) });
  vi.stubGlobal("document", { createElement: () => frame, body: { append: vi.fn<(node: unknown) => void>() } });
}

function bootstrapOf(port: MessagePort, nonce: string): object { return { type: "bootstrap", nonce, port }; }

function portOf(message: unknown): MessagePort {
  if (typeof message !== "object" || message === null || !("port" in message) || !(message.port instanceof MessagePort)) throw new Error("bootstrap carried no port");
  return message.port;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("opens once the framed document answers its bootstrap", async () => {
  const frame = fakeFrame(posted => { portOf(posted.message).postMessage("ready"); });
  install(frame);

  const opening = openExecutionFrame(EXECUTION_URL, bootstrapOf, input => input);
  frame.onload?.();
  const connection = await opening;

  expect(connection.receipt).toBe("ready");
  connection.dispose();
  expect(frame.remove).toHaveBeenCalledOnce();
});

it("loads the document while the bootstrap assets are pending", async () => {
  const assets = Promise.withResolvers<undefined>(), posted: unknown[] = [];
  const frame = fakeFrame(({ message }) => { posted.push(message); });
  install(frame);
  const opening = openExecutionFrame(EXECUTION_URL, async (port, nonce) => {
    await assets.promise;
    return bootstrapOf(port, nonce);
  }, input => input);

  frame.onload?.();
  expect(posted).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10_001);
  assets.resolve(undefined);
  await vi.waitFor(() => { expect(posted).toHaveLength(1); });
  portOf(posted[0]).postMessage("ready");

  const connection = await opening;
  expect(connection.receipt).toBe("ready");
  connection.dispose();
});

it("removes an aborted frame without delivering its pending bootstrap", async () => {
  const assets = Promise.withResolvers<undefined>(), controller = new AbortController();
  const post = vi.fn();
  const frame = fakeFrame(post);
  install(frame);
  const opening = openExecutionFrame(EXECUTION_URL, async (port, nonce) => {
    await assets.promise;
    return bootstrapOf(port, nonce);
  }, input => input, controller.signal);
  frame.onload?.();
  controller.abort();
  await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  expect(frame.remove).toHaveBeenCalledOnce();
  assets.resolve(undefined);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(post).not.toHaveBeenCalled();
});

it("names the execution origin and this page's ancestors when a loaded document never answers", async () => {
  // A document refused by its own frame-ancestors policy still fires `load`, and its bootstrap message is dropped.
  const frame = fakeFrame(() => undefined);
  install(frame, ["https://app.example"]);

  const opening = openExecutionFrame(EXECUTION_URL, bootstrapOf, input => input);
  const failure = expect(opening).rejects.toMatchObject({
    code: "CORE_LOAD_FAILED",
    message: expect.stringMatching(/https:\/\/js\.test.*frame-ancestors/u) as unknown,
    detail: { reason: "execution-document-silent", origin: "https://js.test", ancestors: ["https://app.example"] },
  });
  frame.onload?.();
  await vi.advanceTimersByTimeAsync(10_000);

  await failure;
  expect(frame.remove).toHaveBeenCalledOnce();
});

it("reports a document that never loaded separately, and without ancestors where the browser exposes none", async () => {
  const frame = fakeFrame(() => undefined);
  install(frame);

  const opening = openExecutionFrame(EXECUTION_URL, bootstrapOf, input => input);
  const failure = expect(opening).rejects.toMatchObject({
    code: "CORE_LOAD_FAILED",
    detail: { reason: "execution-document-not-loaded", origin: "https://js.test" },
  });
  await vi.advanceTimersByTimeAsync(10_000);

  await failure;
  await expect(opening).rejects.not.toHaveProperty("detail.ancestors");
});
