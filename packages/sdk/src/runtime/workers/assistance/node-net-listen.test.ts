import { expect, it } from "vitest";
import { listenArguments } from "./node-net.ts";

it("ignores trailing undefined arguments, as the ws package passes them", () => {
  // Recorded from Node.js v24.18.1: server.listen(0, "127.0.0.1", undefined, callback) and the same call with an
  // undefined callback both listen. ws calls listen(port, host, backlog, callback) with whatever it was given.
  const callback = (): void => undefined;
  expect(listenArguments([0, "127.0.0.1", undefined, undefined])).toMatchObject({ address: { address: "127.0.0.1", port: 0 }, backlog: 511, callback: undefined });
  expect(listenArguments([0, "127.0.0.1", undefined, callback])).toMatchObject({ address: { address: "127.0.0.1", port: 0 }, backlog: 511, callback });
  expect(listenArguments([0, undefined, undefined, callback])).toMatchObject({ address: { address: "::", port: 0 }, callback });
  expect(listenArguments([0, "127.0.0.1", 5])).toMatchObject({ backlog: 5 });
  // ws passes null for a backlog it was not given.
  expect(listenArguments([0, "127.0.0.1", null, callback])).toMatchObject({ address: { address: "127.0.0.1", port: 0 }, backlog: 511, callback });
  expect(listenArguments([0, null, null, undefined])).toMatchObject({ address: { address: "::", port: 0 }, backlog: 511 });
  expect(() => listenArguments([0, "127.0.0.1", 5, "extra"])).toThrow("Unsupported net.Server.listen arguments");
});
