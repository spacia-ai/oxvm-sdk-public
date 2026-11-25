import { expect, it, vi } from "vitest";
import { ModuleExecution, type ModuleFrameSources } from "./module-execution.js";
import { VMError } from "./runtime/errors.js";

it("retries with fresh sources while a cancelled frame's download settles", async () => {
  const first = Promise.withResolvers<ModuleFrameSources>();
  const files = { broker: new Blob(), runner: new Blob() };
  const sources = vi.fn<() => Promise<ModuleFrameSources>>()
    .mockReturnValueOnce(first.promise).mockResolvedValue(files);
  const channel = new MessageChannel();
  const execution = new ModuleExecution({
    sources,
    open: async (scripts, signal) => {
      if (signal !== undefined) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => { reject(new VMError("ABORTED", "Frame open cancelled")); }, { once: true });
        });
      }
      await scripts;
      return { port: channel.port1, dispose: () => { channel.port1.close(); channel.port2.close(); } };
    },
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: () => () => undefined,
  });
  const abort = new AbortController(), initial = execution.ensure(abort.signal);
  abort.abort();
  await expect(initial).rejects.toMatchObject({ code: "ABORTED" });

  const retry = execution.ensure();
  first.reject(new VMError("ABORTED", "Script download cancelled"));
  await expect(retry).resolves.toBeUndefined();
  expect(sources).toHaveBeenCalledTimes(2);
  await execution.dispose();
});
