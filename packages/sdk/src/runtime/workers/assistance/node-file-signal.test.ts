import { expect, it } from "vitest";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";
import { createAsyncContext } from "./async-context.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

/** A file of two 3-byte reads; `onRead` runs before each read is answered. */
function replies(operations: AssistanceOperation[], onRead: (count: number) => void = () => {}) {
  let reads = 0;
  return (operation: AssistanceOperation): AssistanceResult => {
    operations.push(operation);
    if (operation.kind === "open") return { kind: "opened", fd: 7 };
    if (operation.kind === "read") { onRead(++reads); return { kind: "data", bytes: reads % 3 === 0 ? new Uint8Array() : new TextEncoder().encode("abc") }; }
    if (operation.kind === "write") return { kind: "written", count: operation.bytes.length };
    return { kind: "unit" };
  };
}
function asynchronous(onRead?: (count: number) => void) {
  const operations: AssistanceOperation[] = [], reply = replies(operations, onRead);
  return { operations, fs: createAsyncFiles(operation => Promise.resolve(reply(operation)), () => "/workspace", createAsyncContext(), () => () => {}) };
}
const kinds = (operations: readonly AssistanceOperation[]) => operations.map(operation => operation.kind);

it("reads and writes with a signal that never aborts", async () => {
  const { fs, operations } = asynchronous(), { signal } = new AbortController();
  await expect(fs.promises.readFile("file", { encoding: "utf8", signal })).resolves.toBe("abcabc");
  await expect(fs.promises.writeFile("file", "xy", { signal })).resolves.toBeUndefined();
  await expect(fs.promises.appendFile("file", "z", { signal })).resolves.toBeUndefined();
  await expect(fs.promises.readFile("file", { signal: undefined })).resolves.toBeInstanceOf(Uint8Array);
  expect(kinds(operations).filter(kind => kind === "close")).toHaveLength(4);
});

it("rejects with Node's AbortError before touching the file when the signal is already aborted", async () => {
  const { fs, operations } = asynchronous(), reason = new Error("stop");
  for (const work of [() => fs.promises.readFile("file", { signal: AbortSignal.abort(reason) }), () => fs.promises.writeFile("file", "x", { signal: AbortSignal.abort(reason) }),
    () => fs.promises.appendFile("file", "x", { signal: AbortSignal.abort(reason) })]) {
    await expect(work()).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR", message: "The operation was aborted", cause: reason });
  }
  expect(operations).toEqual([]);
  const completion = Promise.withResolvers<unknown>();
  fs.readFile("file", { signal: AbortSignal.abort() }, (error: unknown) => { completion.resolve(error); });
  expect(await completion.promise).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
});

it("stops between reads when the signal aborts meanwhile, and still closes the file", async () => {
  const controller = new AbortController();
  const { fs, operations } = asynchronous(count => { if (count === 1) controller.abort(); });
  await expect(fs.promises.readFile("file", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  expect(kinds(operations)).toEqual(["open", "read", "close"]);
});

it("refuses a signal that is not an AbortSignal, and still refuses unknown options", async () => {
  const { fs, operations } = asynchronous();
  for (const signal of [null, 1, "x", {}]) {
    await expect(fs.promises.readFile("file", { signal })).rejects.toThrow(/"options\.signal" property must be an instance of AbortSignal/u);
    await expect(fs.promises.readFile("file", { signal })).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  }
  await expect(Reflect.apply(Reflect.get(fs.promises, "readFile"), fs.promises, ["file", { unknown: true }])).rejects.toThrow("Unsupported filesystem options");
  expect(operations).toEqual([]);
});

it("ignores the option in the synchronous calls, as Node does", () => {
  const operations: AssistanceOperation[] = [], fs = createSyncFiles(replies(operations), () => "/workspace");
  expect(Reflect.apply(fs.readFileSync, fs, ["file", { encoding: "utf8", signal: AbortSignal.abort() }])).toBe("abcabc");
  expect(() => { Reflect.apply(fs.writeFileSync, fs, ["file", "x", { signal: "not a signal" }]); }).not.toThrow();
});
