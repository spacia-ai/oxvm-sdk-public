/**
 * How the generating half of `node:crypto` (generateKeyPair, generateKey, generatePrime, checkPrime) runs its
 * work: as a generator that yields about every ten milliseconds. The synchronous forms run it to its end on the
 * calling turn; the callback forms run one slice a turn on the process's own dispatch, holding the process open
 * until the callback has been handed its result.
 */
import type { Entropy } from "./node-crypto-bigint.ts";
import type { CryptoPorts } from "./node-crypto-ports.ts";
import { invalidType, outOfRange } from "./node-util-validators.ts";

// The browser's entropy source, taken before a program can replace it.
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
/** `getRandomValues` fills at most this many bytes a call. */
const ENTROPY_CHUNK = 65_536;

/** Fills bytes of any length with entropy. */
export const entropy: Entropy = (bytes: Uint8Array): void => {
  for (let offset = 0; offset < bytes.length; offset += ENTROPY_CHUNK) {
    bytes.set(getRandomValues(new Uint8Array(Math.min(ENTROPY_CHUNK, bytes.length - offset))), offset);
  }
};
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  entropy(bytes);
  return bytes;
}

/** Work a callback form does in one turn before it gives the process its turn back. */
export const TURN_BUDGET_MS = 10;
/** The budget of a synchronous form: never yield. */
export const NO_BUDGET = Number.POSITIVE_INFINITY;

export type Steps<Result> = Generator<undefined, Result, undefined>;
export type Outcome<Result> = { readonly ok: true; readonly value: Result } | { readonly ok: false; readonly error: unknown };

/** Runs the work to its end on the calling turn. */
export function runSteps<Result>(steps: Steps<Result>): Result {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

/**
 * Runs the work one slice a turn. The process is held for the whole job; `done` runs on the dispatch of the last
 * slice, after the hold is released, as `later()` of node-crypto-ports.ts does.
 */
export function driveSteps<Result>(ports: CryptoPorts, steps: Steps<Result>, done: (outcome: Outcome<Result>) => void): void {
  const release = ports.retain();
  const turn = (): void => {
    let step: IteratorResult<undefined, Result>;
    try { step = steps.next(); }
    catch (error) { release(); done({ ok: false, error }); return; }
    if (step.done !== true) { ports.dispatch(turn); return; }
    release();
    done({ ok: true, value: step.value });
  };
  ports.dispatch(turn);
}

/** True once per `budgetMs` of work: the generator yields at that point. */
export function pacer(budgetMs: number): () => boolean {
  if (!(budgetMs > 0) || budgetMs === Number.POSITIVE_INFINITY) return () => false;
  let deadline = globalThis.performance.now() + budgetMs;
  return () => {
    const now = globalThis.performance.now();
    if (now < deadline) return false;
    deadline = now + budgetMs;
    return true;
  };
}

const INT32_MIN = -2_147_483_648, INT32_MAX = 2_147_483_647, UINT32_MAX = 4_294_967_295;
function validateRange(value: unknown, name: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== "number") throw invalidType(name, "number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < minimum || value > maximum) throw outOfRange(name, `>= ${String(minimum)} && <= ${String(maximum)}`, value);
}
/** Node's `validateInt32`. */
export function validateInt32(value: unknown, name: string, minimum = INT32_MIN, maximum = INT32_MAX): asserts value is number {
  validateRange(value, name, minimum, maximum);
}
/** Node's `validateUint32` (zero allowed). */
export function validateUint32(value: unknown, name: string): asserts value is number {
  validateRange(value, name, 0, UINT32_MAX);
}
