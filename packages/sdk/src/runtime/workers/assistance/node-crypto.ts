import type { ProcessScheduler } from "./process-scheduler.js";
import { equalBytes } from '@noble/curves/utils.js';
import { Buffer } from 'buffer/';
import scheduling from 'process/';

function timingSafeEqual(left: unknown, right: unknown): boolean {
  const view = (input: unknown): Uint8Array => {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw Object.assign(new TypeError('crypto.timingSafeEqual requires ArrayBuffer, Buffer, TypedArray or DataView inputs'), { code: 'ERR_INVALID_ARG_TYPE' });
  };
  const a = view(left), b = view(right);
  if (a.length !== b.length) throw Object.assign(new RangeError('Input buffers must have the same byte length'), { code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' });
  // Noble scans every byte; browser JIT/GC cannot guarantee wall-clock constant time.
  return equalBytes(a, b);
}
function boundedNumber(value: unknown, name: string, minimum: number, integral: boolean): number {
  if (typeof value !== 'number') throw Object.assign(new TypeError(`${name} must be a number`), { code: 'ERR_INVALID_ARG_TYPE' });
  if (!Number.isFinite(value) || value < minimum || value > 0x7fffffff || (integral && !Number.isInteger(value))) throw Object.assign(new RangeError(`${name} out of range`), { code: 'ERR_OUT_OF_RANGE' });
  return Math.trunc(value);
}
// Preserve the browser entropy provider before application code decorates the
// public WebCrypto methods (Next instruments random operations during rendering).
const entropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const uuid = globalThis.crypto.randomUUID.bind(globalThis.crypto);
function randomBytes(size: unknown, callback?: unknown): Buffer | undefined {
  const length = boundedNumber(size, 'crypto.randomBytes size', 0, false);
  if (callback !== undefined && typeof callback !== 'function') throw new TypeError('crypto.randomBytes callback must be a function');
  const result = Buffer.alloc(length);
  const fill = () => {
    for (let offset = 0; offset < result.length; offset += 65536) entropy(result.subarray(offset, offset + 65536));
    return result;
  };
  if (typeof callback !== 'function') return fill();
  // The existing process shim owns scheduling, async context and activity.
  scheduling.nextTick(() => {
    try { fill(); }
    catch (error) { Reflect.apply(callback, undefined, [error]); return; }
    Reflect.apply(callback, undefined, [null, result]);
  });
  return undefined;
}
function randomUUID(options?: unknown): string {
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new TypeError('crypto.randomUUID options must be an object');
    if ('disableEntropyCache' in options && options.disableEntropyCache !== undefined && typeof options.disableEntropyCache !== 'boolean') throw new TypeError('crypto.randomUUID disableEntropyCache must be a boolean');
  }
  return uuid();
}
/** Random values and constant-time comparison; hashing, keys, ciphers and signatures have their own modules. */
export const nodeCrypto = { timingSafeEqual, randomBytes, randomUUID,
  getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
};

/** Pending browser crypto work retains the existing process activity owner.
 * Keep native receivers, keys and brands; restore methods with the process. */
export function createNodeCrypto(retain: () => () => void, scheduler?: ProcessScheduler) {
  const provider = globalThis.crypto;
  const restore: (() => void)[] = [];
  for (const name of ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'generateKey',
    'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey'] as const) {
    const original = Object.getOwnPropertyDescriptor(provider.subtle, name);
    const operation: unknown = Reflect.get(provider.subtle, name);
    if (typeof operation !== "function") throw new TypeError(`Missing crypto.subtle.${name}`);
    const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const release = retain();
      try {
        const result: unknown = Reflect.apply(operation, this, args);
        if (!(result instanceof Promise)) throw new TypeError(`crypto.subtle.${name} did not return a Promise`);
        const completion = scheduler === undefined ? result : result.then(
          (value: unknown) => scheduler.execute(() => value),
          (error: unknown) => scheduler.execute(() => { throw error; }),
        );
        return completion.finally(release);
      } catch (error) { release(); throw error; }
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(operation));
    Object.defineProperty(provider.subtle, name, { configurable: true, writable: true, value: wrapped });
    restore.push(() => {
      if (original === undefined) Reflect.deleteProperty(provider.subtle, name);
      else Object.defineProperty(provider.subtle, name, original);
    });
  }
  return { module: { ...nodeCrypto, subtle: provider.subtle, webcrypto: provider },
    restore: () => { for (const reset of restore.splice(0).reverse()) reset(); } };
}
