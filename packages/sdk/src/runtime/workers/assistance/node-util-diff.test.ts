import { expect, it } from "vitest";
import { diff } from "./node-util-diff.js";
import { decodeValue, list, loadControls, outcome, recorded, row } from "./node-util-node24.test-support.js";

const control = loadControls("./node-util-node24.controls.json");

it("diffs strings and string arrays exactly as pinned Node's util.diff", () => {
  const cases = list(control["diff"]);
  expect(cases.length).toBeGreaterThan(20);
  for (const value of cases) {
    const c = row(value), args = list(c["args"]).map(decodeValue);
    expect(outcome(() => diff(args[0], args[1])), JSON.stringify(c["args"])).toEqual(recorded(c));
  }
  expect([diff.name, diff.length]).toEqual(["diff", 2]);
});
