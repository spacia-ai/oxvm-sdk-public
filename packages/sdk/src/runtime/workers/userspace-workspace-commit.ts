import { refusedForSpace } from "./browser-quota.js";

const QUOTA_RETRY_MS = 5_000;

/** One commit queue for guest turns, host writes and disposal. */
export async function flushUserspaceFiles(workspace: { flush(): Promise<void> }, root?: { flush(): Promise<void> }): Promise<void> {
  const outcomes = await Promise.allSettled([workspace.flush(), root?.flush() ?? Promise.resolve()]);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}

export function createUserspaceWorkspaceCommit(persist: () => Promise<void>, failed: (error: unknown) => void) {
  type Batch = ReturnType<typeof Promise.withResolvers<undefined>> & { ready: boolean; explicit: boolean; idle: boolean };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Batch | undefined, pending: Batch | undefined;
  let retryAfter = 0;
  function batch(): Batch {
    const value = { ...Promise.withResolvers<undefined>(), ready: false, explicit: false, idle: true };
    void value.promise.catch(() => undefined);
    return value;
  }
  function start(): void {
    if (active !== undefined || pending?.ready !== true) return;
    const delay = pending.explicit ? 0 : retryAfter - Date.now();
    if (delay > 0) {
      timer = setTimeout(ready, delay);
      return;
    }
    const current = pending; active = current; pending = undefined;
    const settled = (): void => { active = undefined; start(); };
    void Promise.resolve().then(persist).then(() => {
      retryAfter = 0;
      settled();
      current.resolve(undefined);
    }, (error: unknown) => {
      if (refusedForSpace(error)) retryAfter = Date.now() + QUOTA_RETRY_MS;
      current.reject(error);
      failed(error);
      settled();
    });
  }
  function ready(): void {
    clearTimeout(timer); timer = undefined;
    if (pending !== undefined) pending.ready = true;
    start();
  }
  return {
    schedule(mode: "required" | "idle" = "required"): Promise<void> {
      const current = pending ??= batch();
      if (mode === "required") current.idle = false;
      if (timer === undefined && !current.ready) timer = setTimeout(ready, 250);
      return current.promise;
    },
    pauseIdle(): void {
      // Keep the pending publication when the guest wakes before the quiet period ends.
      if (pending?.idle !== true) return;
      clearTimeout(timer); timer = undefined;
      pending.ready = false;
    },
    flush(): Promise<void> {
      pending ??= batch();
      pending.explicit = true;
      pending.idle = false;
      const promise = pending.promise;
      ready(); return promise;
    },
    reset(): void {
      if (active !== undefined) throw new Error("Cannot reset an active workspace publication");
      clearTimeout(timer); timer = undefined;
      retryAfter = 0;
      pending?.reject(new Error("Workspace publication was replaced")); pending = undefined;
    },
  };
}
