import { expect, it } from "vitest";
import { ExecutableSources } from "./executable-sources.ts";
import { SourceMap } from "./node-source-map.ts";

function failure(run: () => unknown): unknown { try { run(); } catch (error) { return error; } throw new Error("Expected failure"); }

it("identifies the executable when source-map admission exceeds its bounds", () => {
  let map: unknown = { version: 3, sources: [], names: [], mappings: "" };
  for (let index = 0; index < 18; index++) map = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map }] };
  const sources = new ExecutableSources();
  expect(failure(() => sources.emit({ code: "", map: JSON.stringify(map) }, "/workspace/dependency.js", "commonjs")))
    .toMatchObject({ code: "QUOTA_EXCEEDED", detail: { api: "module.SourceMap", path: "/workspace/dependency.js", role: "commonjs" } });
});

it("publishes distinct body identities and wrapper-adjusted inline maps atomically", () => {
  const sources = new ExecutableSources();
  const map = JSON.stringify({ version: 3, sources: ["/a.js"], names: [], mappings: "AAAA;" });
  expect(() => sources.emit({ code: "", map: "invalid" }, "/a.js", "commonjs")).toThrow(SyntaxError);
  const body = sources.emit({ code: "#!/usr/bin/node\nthrow 1;", map }, "/a.js", "commonjs");
  expect(body.startsWith("///usr/bin/node")).toBe(true);
  expect(body).toContain("sourceURL=oxidevm:compiled/1/%2Fa.js");
  const url = "oxidevm:compiled/1/%2Fa.js";
  expect(sources.find(url, 3, 1)?.origin.originalLine).toBe(0);
  expect(sources.find(url, 2, 1)?.origin).toEqual({});
  expect(sources.find("unknown", 3, 1)).toBeUndefined();
  const encoded = body.split("charset=utf-8,")[1];
  if (encoded === undefined) throw new Error("Missing inline map");
  const payload: unknown = JSON.parse(decodeURIComponent(encoded));
  const inline = new SourceMap(payload);
  expect(inline.findEntry(2, 0).originalLine).toBe(0);
  expect(inline.findEntry(1, 0)).toEqual({});
  const next = sources.emit({ code: "throw 2;", map }, "/a.js", "module-registration");
  expect(next).toContain("sourceURL=oxidevm:compiled/2/%2Fa.js");
  expect(sources.find(url, 3, 1)?.role).toBe("commonjs");
});

it("maps eval scripts from their first line without a Function wrapper offset", () => {
  const sources = new ExecutableSources();
  const body = sources.emit({ code: "throw 1;", map: JSON.stringify({ version: 3, sources: ["[worker eval]"], names: [], mappings: "AAAA;" }) }, "[worker eval]", "script");
  expect(sources.find("oxidevm:compiled/1/%5Bworker%20eval%5D", 1, 1)?.origin.originalLine).toBe(0);
  const encoded = body.split("charset=utf-8,")[1];
  if (encoded === undefined) throw new Error("Missing inline map");
  const payload: unknown = JSON.parse(decodeURIComponent(encoded));
  expect(new SourceMap(payload).findEntry(0, 0).originalLine).toBe(0);
  const raw = sources.emitScript("'\u0000\ud800';\nthrow 1;", "[worker eval]");
  expect(raw.startsWith("'\u0000\ud800';\nthrow 1;")).toBe(true);
  expect(sources.find("oxidevm:compiled/2/%5Bworker%20eval%5D", 2, 7)?.origin)
    .toMatchObject({ originalSource: "[worker eval]", originalLine: 1, originalColumn: 6 });
});

it("keeps application maps separate, enabled explicitly, and attached to each compilation", () => {
  const payload = { version: 3, sources: ["original.ts"], names: [], mappings: "AACA;" };
  const source = `throw 1;\n//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify(payload))}`;
  const sources = new ExecutableSources();
  sources.registerApplication("/app.js", source);
  expect(sources.findSourceMap("/app.js")).toBeUndefined();
  sources.setSourceMapsSupport(true);
  sources.registerApplication("/app.js", source);
  const application = sources.findSourceMap("/app.js");
  expect(application).toBe(sources.findSourceMap("file:///app.js"));
  expect(application?.findEntry(0, 0).originalLine).toBe(1);
  const runtimeMap = JSON.stringify({ version: 3, sources: ["/app.js"], names: [], mappings: "AAAA;" });
  sources.emit({ code: "throw 1;", map: runtimeMap }, "/app.js", "commonjs");
  sources.registerApplication("/app.js", "throw 2;");
  expect(sources.findSourceMap("/app.js")).toBeUndefined();
  expect(sources.find("oxidevm:compiled/1/%2Fapp.js", 3, 1)?.origin.originalLine).toBe(1);
  sources.setSourceMapsSupport(false);
  expect(sources.find("oxidevm:compiled/1/%2Fapp.js", 3, 1)?.origin.originalLine).toBe(0);
});

it("generated maps resolve against their own URL without replacing a module's map", () => {
  const sources = new ExecutableSources();
  sources.setSourceMapsSupport(true, { generatedCode: true });
  const map = (name: string) => `//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify({ version: 3, sources: [name], names: [], mappings: "AAAA;" }))}`;
  sources.registerApplication("/workspace/app.js", map("module.ts"));
  sources.registerApplication("/generated/function-1.js", `//# sourceURL=file:///workspace/app.js\n${map("generated.ts")}`, true);
  expect(sources.findSourceMap("/workspace/app.js")?.payload["sources"]).toEqual(["file:///workspace/module.ts"]);
  expect(sources.findSourceMap("/generated/function-1.js")?.payload["sources"]).toEqual(["file:///workspace/generated.ts"]);
  expect(() => sources.setSourceMapsSupport(true, { nodeModules: null })).toThrow(TypeError);
});

it("preserves CommonJS identity coordinates after the Function wrapper", () => {
  const sources = new ExecutableSources();
  const body = sources.emitScript("const value = 17;\nthrow value;", "/identity.cjs", "commonjs");
  expect(body).toContain("sourceURL=oxidevm:compiled/1/%2Fidentity.cjs");
  expect(sources.find("oxidevm:compiled/1/%2Fidentity.cjs", 3, 7)).toMatchObject({
    path: "/identity.cjs", role: "commonjs", origin: {originalLine:0,originalColumn:6},
  });
  expect(sources.find("oxidevm:compiled/1/%2Fidentity.cjs", 2, 1)?.origin).toEqual({});
});

it("retains application maps for each unchanged CommonJS compilation", () => {
  const sources = new ExecutableSources();
  sources.setSourceMapsSupport(true);
  const payload = {version:3,sources:["original.ts"],names:[],mappings:"AACA;"};
  const source = "throw 17;\n//# sourceMappingURL=data:application/json;base64," + btoa(JSON.stringify(payload));
  sources.registerApplication("/app.js", source);
  sources.emitScript(source, "/app.js", "commonjs");
  sources.registerApplication("/app.js", "throw 19;");
  expect(sources.find("oxidevm:compiled/1/%2Fapp.js", 3, 1)?.origin.originalLine).toBe(1);
  sources.setSourceMapsSupport(false);
  expect(sources.find("oxidevm:compiled/1/%2Fapp.js", 3, 1)?.origin.originalLine).toBe(0);
});

it("normalizes CommonJS hashbangs without application string or regexp callbacks", () => {
  const sources = new ExecutableSources(), originalSlice: unknown = Reflect.get(String.prototype, "slice");
  const originalReplace = RegExp.prototype[Symbol.replace];
  let effects = 0, body: string;
  try {
    String.prototype.slice = () => { effects++; return "changed"; };
    RegExp.prototype[Symbol.replace] = () => { effects++; return "changed"; };
    body = sources.emitScript("#!/usr/bin/node\nmodule.exports = 17;", "/hashbang.cjs", "commonjs");
  } finally { Reflect.set(String.prototype, "slice", originalSlice); RegExp.prototype[Symbol.replace] = originalReplace; }
  expect(effects).toBe(0);
  expect(body.startsWith("///usr/bin/node\nmodule.exports = 17;")).toBe(true);
});

it("rejects oversized unchanged source before publishing its executable identity", () => {
  for (const role of ["script", "commonjs"] as const) {
    const sources = new ExecutableSources();
    expect(failure(() => sources.emitScript(" ".repeat(64 * 1024 * 1024 + 1), "/large.cjs", role)))
      .toMatchObject({ code: "QUOTA_EXCEEDED", detail: { path: "/large.cjs", role } });
    expect(sources.emitScript("", "/valid.cjs", role)).toContain("sourceURL=oxidevm:compiled/1/%2Fvalid.cjs");
  }
});

it("forgets its oldest bodies when the budget fills, so a long-running program keeps loading code", () => {
  // A development server recompiles and reloads its bundles for as long as it runs (Next.js does on every changed route).
  const sources = new ExecutableSources(undefined, undefined, 100);
  const first = sources.emitScript("a".repeat(40), "/one.cjs", "commonjs"), second = sources.emitScript("b".repeat(40), "/two.cjs", "commonjs");
  const url = (body: string): string => /sourceURL=(\S+)/u.exec(body)?.[1] ?? "";
  expect([url(first), url(second)]).toEqual(["oxidevm:compiled/1/%2Fone.cjs", "oxidevm:compiled/2/%2Ftwo.cjs"]);
  expect(sources.find(url(first), 3, 1)?.path).toBe("/one.cjs");
  // The third does not fit beside both: the oldest goes, and its frames are then reported unmapped.
  const third = sources.emitScript("c".repeat(40), "/three.cjs", "commonjs");
  expect(url(third)).toBe("oxidevm:compiled/3/%2Fthree.cjs");
  expect(sources.find(url(first), 3, 1)).toBeUndefined();
  expect([sources.find(url(second), 3, 1)?.path, sources.find(url(third), 3, 1)?.path]).toEqual(["/two.cjs", "/three.cjs"]);
  // Mapped bodies take part in the same accounting.
  const map = JSON.stringify({ version: 3, sources: ["/m.js"], names: [], mappings: "AAAA" });
  const mapped = sources.emit({ code: "x", map: map.padEnd(90, " ") }, "/mapped.cjs", "commonjs");
  expect(sources.find(url(mapped), 3, 1)?.path).toBe("/mapped.cjs");
  expect([sources.find(url(second), 3, 1), sources.find(url(third), 3, 1)]).toEqual([undefined, undefined]);
  // One body larger than the whole budget is still refused, and forgets nothing.
  expect(failure(() => sources.emitScript("d".repeat(101), "/large.cjs", "commonjs"))).toMatchObject({ code: "QUOTA_EXCEEDED", detail: { path: "/large.cjs" } });
  expect(sources.find(url(mapped), 3, 1)?.path).toBe("/mapped.cjs");
  expect(url(sources.emitScript("", "/after.cjs", "commonjs"))).toBe("oxidevm:compiled/5/%2Fafter.cjs");
});

it("does not count a program's own source map again each time the same file is reloaded", () => {
  // Next.js's development server reloads its route bundles; each reload registers the bundle's map under the same path.
  const payload = { version: 3, sources: ["route.ts"], names: [], mappings: "AAAA;", sourcesContent: ["x".repeat(4000)] };
  const source = (text: string): string => `${text}\n//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify(payload))}`;
  const size = JSON.stringify(payload).length, sources = new ExecutableSources(undefined, undefined, size * 2 + 800);
  sources.setSourceMapsSupport(true);
  for (let reload = 0; reload < 50; reload++) sources.registerApplication("/app/route.js", source(`// ${String(reload)}`));
  expect(sources.findSourceMap("/app/route.js")).toBeDefined();
  // A second file fits beside it; a third pushes the oldest out instead of failing the load.
  sources.registerApplication("/app/two.js", source("two"));
  sources.registerApplication("/app/three.js", source("three"));
  expect([sources.findSourceMap("/app/route.js"), sources.findSourceMap("/app/two.js") !== undefined, sources.findSourceMap("/app/three.js") !== undefined]).toEqual([undefined, true, true]);
  // Loaded code gives way before a source map does.
  const url = (body: string): string => /sourceURL=(\S+)/u.exec(body)?.[1] ?? "";
  const body = url(sources.emitScript("y".repeat(500), "/body.cjs", "commonjs"));
  expect(sources.find(body, 3, 1)?.path).toBe("/body.cjs");
  sources.registerApplication("/app/four.js", source("four"));
  expect([sources.find(body, 3, 1), sources.findSourceMap("/app/two.js"), sources.findSourceMap("/app/three.js") !== undefined, sources.findSourceMap("/app/four.js") !== undefined]).toEqual([undefined, undefined, true, true]);
  // A file that lost its map gives its share back.
  sources.registerApplication("/app/three.js", "no map");
  expect(sources.findSourceMap("/app/three.js")).toBeUndefined();
  const kept = url(sources.emitScript("z".repeat(size), "/kept.cjs", "commonjs"));
  expect([sources.find(kept, 3, 1)?.path, sources.findSourceMap("/app/four.js") !== undefined]).toEqual(["/kept.cjs", true]);
});
