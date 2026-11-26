import { expect, it } from "vitest";
import { createMemoryFiles } from "./node-files-gaps.test-support.ts";

it("writes text when the position slot holds an encoding, as sonic-boom calls it", async () => {
  // Recorded from Node.js v24.18.1: fs.writeSync(fd, string, position, encoding). A position that is not a number
  // means "the current position", so writeSync(fd, text, "utf8") writes at the cursor, and a third argument of
  // "hex" does NOT decode the text: the encoding is the fourth argument.
  const { files, asynchronous } = createMemoryFiles();
  const fd = files.openSync("/work/w.txt", "w+");
  const counts = [files.writeSync(fd, "héllo", "utf8"), files.writeSync(fd, "ab", null, "utf8"), files.writeSync(fd, "6869", "hex"), files.writeSync(fd, "X", 0, "utf8"), files.writeSync(fd, "z", undefined, "latin1")];
  files.closeSync(fd);
  expect(counts).toEqual([6, 2, 4, 1, 1]);
  expect(files.readFileSync("/work/w.txt", "utf8")).toBe("Xélloab6869z");
  // The callback form pino's file destination uses: fs.write(fd, text, "utf8", callback).
  const second = files.openSync("/work/w.txt", "w");
  const written = await new Promise<unknown[]>((resolve, reject) => {
    asynchronous.write(second, "cb", "utf8", (error: unknown, count: unknown, text: unknown) => { if (error === null) resolve([count, text]); else reject(error instanceof Error ? error : new Error("write failed")); });
  });
  files.closeSync(second);
  expect(written).toEqual([2, "cb"]);
  expect(files.readFileSync("/work/w.txt", "utf8")).toBe("cb");
});
