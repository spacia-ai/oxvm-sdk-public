import { expect, it } from "vitest";
import { string } from "../../decode.js";
import { nodeUtil } from "./node-util.js";
import { MIMEParams, MIMEType } from "./node-util-mime.js";
import { decodeValue, encodeValue, errorRow, list, loadControls, outcome, recorded, row } from "./node-util-node24.test-support.js";

const control = loadControls("./node-util-node24.controls.json");

function parsed(input: unknown): Record<string, unknown> {
  const mime = new MIMEType(input);
  return { type: mime.type, subtype: mime.subtype, essence: mime.essence, str: mime.toString(), json: JSON.stringify(mime), tpl: String(mime), params: [...mime.params], keys: [...mime.params.keys()],
    values: [...mime.params.values()], paramsStr: mime.params.toString(), paramsJson: JSON.stringify(mime.params), entries: [...mime.params.entries()] };
}

it("parses and serializes MIME types as pinned Node does, including its syntax errors", () => {
  const cases = list(control["mimeParse"]);
  expect(cases.length).toBeGreaterThan(25);
  for (const value of cases) { const c = row(value); expect(outcome(() => parsed(c["input"])), JSON.stringify(c["input"])).toEqual(recorded(c)); }
  for (const value of list(control["mimeNonString"])) {
    const c = row(value), arg = c["arg"];
    const input = typeof arg === "object" && arg !== null && Reflect.get(arg, "$") === "obj" ? { toString: () => "a/b" } : decodeValue(arg);
    expect(outcome(() => new MIMEType(input).toString()), JSON.stringify(arg)).toEqual(recorded(c));
  }
});

it("applies type, subtype and parameter changes with Node's validation", () => {
  for (const value of list(control["mimeOps"])) {
    const c = row(value), mime = new MIMEType("text/plain;base=1");
    const steps = list(c["seq"]).map(step => {
      const [operation, first, second] = list(step);
      return outcome(() => {
        switch (operation) {
          case "type": mime.type = decodeValue(first); return mime.type;
          case "subtype": mime.subtype = decodeValue(first); return mime.subtype;
          case "set": mime.params.set(decodeValue(first), decodeValue(second)); return undefined;
          case "get": return mime.params.get(string(first, "name"));
          case "has": return mime.params.has(string(first, "name"));
          case "delete": mime.params.delete(string(first, "name")); return undefined;
          default: throw new TypeError("unknown operation");
        }
      });
    });
    expect({ steps, final: mime.toString(), essence: mime.essence }, JSON.stringify(c["seq"])).toEqual({ steps: c["steps"], final: c["final"], essence: c["essence"] });
  }
});

it("exposes the MIMEParams and MIMEType shapes of pinned Node", () => {
  const expected = row(control["mimeParams"]), params = new MIMEParams();
  const actual: Record<string, unknown> = { empty: params.toString() };
  params.set("a", "1"); params.set("b", "x y");
  const mime = new MIMEType("a/b");
  let noNew: unknown;
  const ignored: unknown = Reflect.construct(MIMEParams, ["a=1"]);
  try { Reflect.apply(MIMEType, undefined, ["a/b"]); } catch (error) { noNew = { ...errorRow(error), code: encodeValue(undefined) }; }
  Object.assign(actual, { str: params.toString(), json: JSON.stringify(params), iterSame: params[Symbol.iterator] === params.entries, entries: [...params], getMissing: params.get("zz"),
    ignoredCtorArg: String(ignored), protoKeys: Object.getOwnPropertyNames(MIMEParams.prototype), typeProtoKeys: Object.getOwnPropertyNames(MIMEType.prototype),
    staticKeys: Object.getOwnPropertyNames(MIMEParams), paramsSame: mime.params === mime.params, paramsInstance: mime.params instanceof MIMEParams, noNew,
    entriesTag: Object.prototype.toString.call(params.entries()), inspect: nodeUtil.inspect(new MIMEType("a/b;c=d")), inspectParams: nodeUtil.inspect(params),
    setLen: MIMEParams.prototype.set.length, typeLen: MIMEType.length });
  expect(actual).toEqual(expected);
  expect([MIMEType.name, MIMEParams.name, MIMEParams.length]).toEqual(["MIMEType", "MIMEParams", 0]);
});
