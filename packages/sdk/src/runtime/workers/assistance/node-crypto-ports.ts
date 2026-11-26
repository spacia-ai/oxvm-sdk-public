/**
 * What `node:crypto`'s asynchronous forms need from the process. A callback form does its work in a later turn:
 * `retain` keeps the process alive until then (its result releases), and `dispatch` runs the callback as the
 * process runs its own callbacks, so async context and uncaught errors behave as in Node.
 */
export interface CryptoPorts {
  readonly retain: () => () => void;
  readonly dispatch: (callback: () => void) => void;
}

/** Runs `work` in a later turn and hands its result, or what it threw, to a Node-style callback. */
export function later<T>(ports: CryptoPorts, work: () => T, callback: (error: unknown, value?: T) => void): void {
  const release = ports.retain();
  ports.dispatch(() => {
    let value: T;
    try { value = work(); }
    catch (error) { release(); callback(error); return; }
    release();
    callback(null, value);
  });
}
