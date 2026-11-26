import { afterAll, describe, expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { processTopLevelAwait } from "./node-repl-await.js";
import { trimReplStack, uncaughtText } from "./node-repl-eval.js";
import { isRecoverableSyntax } from "./node-repl-syntax.js";
import { createHarness, invoke, list, loadControls, openSession, settle } from "./node-repl.test-support.js";

// Recorded from the real binary by the scripts under "recorder" (docker run --rm node:24.18.1-alpine node rec-complete.cjs …).
const control = loadControls("./node-repl-complete.controls.json");
const recorded = record(control["complete"], "complete");
const globalsBefore = new Set(Reflect.ownKeys(globalThis));
afterAll(() => { for (const key of Reflect.ownKeys(globalThis)) if (!globalsBefore.has(key)) Reflect.deleteProperty(globalThis, key); });

const BUILTINS = ["_http_agent", "assert", "fs", "fs/promises", "http", "http2", "https", "util", "util/types", "node:sea", "node:sqlite"];
function completion(server: { complete: (...args: unknown[]) => void }, line: string): Promise<{ error: unknown; result: unknown; sync: boolean }> {
  return new Promise(resolve => {
    let sync = true;
    server.complete(line, (error: unknown, result: unknown) => { resolve({ error, result, sync }); });
    sync = false;
  });
}

describe("node repl completion (Node 24.18.1 controls)", () => {
  it("completes commands, built-in module names, globals and members as Node does", async () => {
    const harness = createHarness({ builtinModules: () => BUILTINS }), session = openSession(harness, { useGlobal: true });
    await settle();
    for (const line of list(recorded["setup"])) await session.type(string(line, "setup line"));
    const cases = list(recorded["cases"]);
    expect(cases.length).toBeGreaterThan(40);
    for (const entry of cases) {
      const [line, error, result, sync] = list(entry), text = string(line, "line");
      const actual = await completion(session.server, text);
      // JSON writes an undefined `completeOn` as null.
      expect([actual.error, JSON.parse(JSON.stringify(actual.result)), actual.sync], text).toEqual([error, result, sync]);
    }
    // A getter on the way to the completed object is never run.
    expect(Reflect.get(globalThis, "getterRan") === true).toBe(recorded["getterRan"]);
    const { server } = session;
    expect([server.complete.name, server.complete.length, typeof server.completer === "function" ? server.completer.name : "", typeof server.completer === "function" ? server.completer.length : -1, invoke(server, "complete", ".he", () => undefined) === undefined]).toEqual(recorded["completeShape"]);
    const editor = await new Promise(resolve => { server.completeOnEditorMode((_error: unknown, result: unknown) => { resolve(result); })(null, [["cobj.foo", "cobj.fn", ""], "cobj.f"]); });
    expect(editor).toEqual(recorded["editorMode"]);
    const failed = await new Promise(resolve => { server.completeOnEditorMode((error: unknown, result: unknown) => { resolve([String(error), result === undefined]); })(new Error("x")); });
    expect(failed).toEqual(recorded["editorModeErr"]);
    session.server.close();
    await settle();
    harness.restore();
  });

  it("uses a completer the caller supplies", async () => {
    const harness = createHarness();
    const mine = (line: unknown, callback: (error: unknown, result: unknown) => void): void => { callback(null, [["custom"], line]); };
    const session = openSession(harness, { useGlobal: true, completer: mine });
    expect([session.server.completer === mine, (await completion(session.server, "ab")).result]).toEqual(recorded["custom"]);
    session.server.close();
    await settle();
    harness.restore();
  });

  it("recognises unfinished input where a real REPL shows the continuation prompt", () => {
    const cases = list(control["recoverable"]);
    expect(cases.length).toBeGreaterThan(150);
    const differing: string[] = [];
    for (const entry of cases) {
      const [line, expected] = list(entry), text = string(line, "line");
      if (isRecoverableSyntax(`${text}\n`) !== expected) differing.push(text);
    }
    expect(differing).toEqual([]);
  });

  it("wraps top-level await like Node and leaves input without one alone", () => {
    expect(processTopLevelAwait("await 1\n")).toEqual({ kind: "wrapped", hoisted: "", code: "(async () => { return { value: (await 1) }\n })()" });
    expect(processTopLevelAwait("const a = await 1, { b, c: [d] } = await x\n")).toEqual({ kind: "wrapped", hoisted: "var a, b, d; ", code: "(async () => { void ( (a = await 1), ({ b, c: [d] } = await x))\n })()" });
    expect(processTopLevelAwait("function f() {}; class K {}; var v; await 0\n")).toEqual({ kind: "wrapped", hoisted: "var f; var K; var v; ",
      code: "(async () => { this.f = f; function f() {}; K=class K {}; void (v=undefined); return { value: (await 0) }\n })()" });
    expect(processTopLevelAwait("for (var i of await list) i\n")).toEqual({ kind: "wrapped", hoisted: "var i; ", code: "(async () => { for (i of await list) i\n })()" });
    expect(processTopLevelAwait("async function f() { await 1 }\n")).toEqual({ kind: "plain" });
    expect(processTopLevelAwait("return await 1\n")).toEqual({ kind: "plain" });
    expect(processTopLevelAwait("await 1 +\n").kind).toBe("recoverable");
    expect(processTopLevelAwait("await `open\n").kind).toBe("recoverable");
    expect(processTopLevelAwait("await 1 2\n")).toEqual({ kind: "plain" });
  });

  it("cuts a stack at the input's own frame and labels errors as Node's REPL does", () => {
    expect(trimReplStack("TypeError: deep\n    at thrower (REPL1:1:28)\n    at eval (REPL2:1:15)\n    at Array.map (<anonymous>)\n    at eval (REPL2:1:5)\n    at eval (<anonymous>)\n    at run (file.js:1:1)"))
      .toBe("TypeError: deep\n    at thrower (REPL1:1:28)\n    at REPL2:1:15\n    at Array.map (<anonymous>)");
    expect(trimReplStack("Error: later\n    at Timeout.tick (app.js:3:9)")).toBe("Error: later\n    at Timeout.tick (app.js:3:9)");
    expect(uncaughtText("Error: x\n    at f (REPL1:1:1)", 80)).toBe("Uncaught Error: x\n    at f (REPL1:1:1)\n");
    expect(uncaughtText(`SyntaxError: ${"x".repeat(80)}`, 80)).toBe(`Uncaught:\nSyntaxError: ${"x".repeat(80)}\n`);
    expect(uncaughtText("{ a: 1 }", 80)).toBe("Uncaught { a: 1 }\n");
    expect(uncaughtText("{\n  a: 1\n}", 80)).toBe("Uncaught:\n{\n  a: 1\n}\n");
  });
});
