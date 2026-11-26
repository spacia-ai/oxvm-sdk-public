import { Buffer } from 'buffer/';
import { timingSafeEqual } from 'node:crypto';
import { expect, it } from 'vitest';
import { createNodeCrypto, nodeCrypto } from './node-crypto.ts';

it('compares equal-length buffer sources as bytes for authenticated connections', () => {
  for (const length of [0, 1, 32, 513]) {
    const left = Uint8Array.from({ length: length + 4 }, (_, index) => index & 255).subarray(2, length + 2);
    const right = left.slice();
    expect(nodeCrypto.timingSafeEqual(left, right.buffer)).toBe(Reflect.apply(timingSafeEqual, undefined, [left, right.buffer]));
    for (let index = 0; index < length; index++) {
      right[index] = (left[index] ?? 0) ^ 1;
      expect(nodeCrypto.timingSafeEqual(left, new DataView(right.buffer))).toBe(timingSafeEqual(left, right));
      right[index] = left[index] ?? 0;
    }
  }
  expect(nodeCrypto.timingSafeEqual(new Uint16Array([1, 2]), new Uint16Array([1, 2]))).toBe(true);
  for (const [left, right, code, constructor] of [
    [new Uint8Array(1), new Uint8Array(2), 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', RangeError],
    ['token', Buffer.from('token'), 'ERR_INVALID_ARG_TYPE', TypeError],
  ] as const) {
    let thrown: unknown;
    try { nodeCrypto.timingSafeEqual(left, right); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code }); expect(thrown).toBeInstanceOf(constructor);
  }
});

it('uses browser entropy across its chunk limit and schedules callbacks in their process context', async () => {
  const { createAsyncContext } = await import('./async-context.ts');
  const { createNodeStreamModule } = await import('./node-streams.ts');
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  let pending = 0;
  const streams = createNodeStreamModule(context, () => { pending++; return () => { pending--; }; });
  try {
    const bytes = nodeCrypto.randomBytes(65537);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes?.length).toBe(65537);
    expect(nodeCrypto.randomUUID({ disableEntropyCache: true })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    const values = ['one', 'two'].map(label => storage.run(label, () => new Promise<void>((resolve, reject) => {
      const returned = nodeCrypto.randomBytes(32, (error: unknown, value: unknown) => {
        try {
          expect(error).toBeNull();
          expect(Buffer.isBuffer(value)).toBe(true);
          expect(storage.getStore()).toBe(label);
          resolve();
        } catch (failure) { reject(failure instanceof Error ? failure : new Error(String(failure))); }
      });
      expect(returned).toBeUndefined();
    })));
    expect(pending).toBe(2);
    await Promise.all(values);
    expect(pending).toBe(0);
    expect(nodeCrypto.randomBytes(1.9)?.length).toBe(1);
    expect(() => nodeCrypto.randomBytes(-1)).toThrow();
    expect(() => nodeCrypto.randomBytes(1, 2)).toThrow();
  } finally { streams.restore(); }
});

it('retains pending WebCrypto operations through success and rejection', async () => {
  let pending = 0;
  const original: unknown = Reflect.get(globalThis.crypto.subtle, "digest");
  const owner = createNodeCrypto(() => { pending++; return () => { pending--; }; });
  const crypto = owner.module;
  try {
    expect(crypto.webcrypto).toBe(globalThis.crypto);
    const digest = crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    expect(pending).toBe(1);
    const result = await digest;
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(pending).toBe(0);
    const failure = crypto.webcrypto.subtle.digest('unsupported', new Uint8Array());
    expect(pending).toBe(1);
    await expect(failure).rejects.toThrow();
    expect(pending).toBe(0);
    expect(crypto.webcrypto.subtle).toBe(crypto.subtle);
  } finally { owner.restore(); }
  const restored: unknown = Reflect.get(globalThis.crypto.subtle, "digest");
  expect(restored).toBe(original);
});
