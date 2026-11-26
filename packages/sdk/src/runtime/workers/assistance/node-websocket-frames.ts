/*!
 * RFC 6455 framing for the fast path's `WebSocket`.
 *
 * The frame encoder follows this repository's module client, `packages/sdk/src/wasm/net/websocket.ts`. The receiving
 * state machine, the order of its checks and the close reasons it reports are adapted from undici v7.29.0
 * `lib/web/websocket/receiver.js` and `lib/web/websocket/util.js`, as bundled in Node.js v24.18.1.
 *
 * MIT License
 * Copyright (c) Matteo Collina and Undici contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;
/** undici's default bound of one message (`webSocketOptions.maxPayloadSize` of the global dispatcher). */
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

/** One frame as a client sends it: FIN set, masked with a fresh key. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = payload.length, extra = length < 126 ? 0 : length < 65536 ? 2 : 8, frame = new Uint8Array(2 + extra + 4 + length), view = new DataView(frame.buffer);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) view.setUint16(2, length); else if (extra === 8) view.setBigUint64(2, BigInt(length));
  const mask = crypto.getRandomValues(new Uint8Array(4)), start = 2 + extra + 4;
  frame.set(mask, 2 + extra);
  for (let index = 0; index < length; index++) frame[start + index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
  return frame;
}

/** The body of a close frame: nothing, or the code and the reason's UTF-8. */
export function closePayload(code: number | null, reason: string): Uint8Array {
  if (code === null) return new Uint8Array();
  const text = new TextEncoder().encode(reason), body = new Uint8Array(2 + text.length);
  body[0] = code >> 8; body[1] = code & 0xff;
  body.set(text, 2);
  return body;
}

/** The close codes a peer may send (RFC 6455 section 7.4). */
function validStatusCode(code: number): boolean {
  if (code >= 1000 && code < 1015) return code !== 1004 && code !== 1005 && code !== 1006;
  return code >= 3000 && code <= 4999;
}

/** What a close frame said. */
export interface CloseInfo { readonly code: number | undefined; readonly reason: string }
/** What the receiver reports. `fail` ends the connection with a close code and the reason sent to the peer. */
export interface FrameEvents {
  message(opcode: 1 | 2, payload: Uint8Array<ArrayBuffer>): void;
  ping(payload: Uint8Array): void;
  close(info: CloseInfo): void;
  fail(code: number, reason: string): void;
}

type State = "info" | "length16" | "length64" | "data";
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of a message or of a close reason; `undefined` when the bytes are not UTF-8. */
export function decodeText(bytes: Uint8Array): string | undefined {
  try { return utf8.decode(bytes); } catch { return undefined; }
}

/**
 * Reads the server's frames from whatever pieces the socket delivers. Frames are hostile input: a masked frame, a
 * reserved bit, an unknown opcode, a wrong fragment order and an oversized control frame fail the connection with
 * 1002, a message above the bound with 1009. Nothing is read after a close frame or a failure.
 */
export class FrameReceiver {
  readonly #events: FrameEvents;
  readonly #chunks: Uint8Array[] = [];
  #buffered = 0;
  #state: State = "info";
  #fin = false; #opcode = 0; #length = 0; #fragmented = false;
  #kind: 1 | 2 = 1;
  #fragments: Uint8Array[] = [];
  #fragmentBytes = 0;
  #stopped = false;

  constructor(events: FrameEvents) { this.#events = events; }

  /** Stops the receiver; later bytes are dropped. */
  stop(): void { this.#stopped = true; this.#chunks.length = 0; this.#buffered = 0; this.#fragments = []; }

  push(chunk: Uint8Array): void {
    if (this.#stopped || chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    while (this.#step()) { /* One state per step. */ }
  }

  #fail(code: number, reason: string): false {
    this.stop();
    this.#events.fail(code, reason);
    return false;
  }

  /** The next `count` buffered bytes as one array. */
  #take(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count);
    for (let offset = 0; offset < count;) {
      const first = this.#chunks[0];
      if (first === undefined) break;
      const part = first.subarray(0, count - offset);
      out.set(part, offset);
      offset += part.length;
      if (part.length === first.length) this.#chunks.shift(); else this.#chunks[0] = first.subarray(part.length);
    }
    this.#buffered -= count;
    return out;
  }

  #bounded(): boolean {
    if (this.#opcode < 8 && this.#length + this.#fragmentBytes > MAX_MESSAGE_BYTES) return this.#fail(1009, "Payload size exceeds maximum allowed size");
    return true;
  }

  /** Runs one state; false when more bytes are needed or the receiver stopped. */
  #step(): boolean {
    if (this.#stopped) return false;
    if (this.#state === "info") return this.#info();
    if (this.#state === "length16") {
      if (this.#buffered < 2) return false;
      const bytes = this.#take(2);
      this.#length = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
      this.#state = "data";
      return this.#bounded();
    }
    if (this.#state === "length64") {
      if (this.#buffered < 8) return false;
      const view = new DataView(this.#take(8).buffer), upper = view.getUint32(0), lower = view.getUint32(4);
      if (upper !== 0 || lower > 2 ** 31 - 1) return this.#fail(1009, "Received payload length > 2^31 bytes.");
      this.#length = lower;
      this.#state = "data";
      return this.#bounded();
    }
    if (this.#buffered < this.#length) return false;
    const body = this.#take(this.#length);
    this.#state = "info";
    if (this.#opcode >= 8) return this.#control(body);
    this.#fragmentBytes += body.length;
    this.#fragments.push(body);
    if (!this.#fragmented && this.#fin) this.#events.message(this.#kind, this.#whole());
    return true;
  }

  #info(): boolean {
    if (this.#buffered < 2) return false;
    const head = this.#take(2), first = head[0] ?? 0, second = head[1] ?? 0;
    const fin = (first & 0x80) !== 0, opcode = first & 0x0f, length = second & 0x7f, fragmented = !fin && opcode !== OPCODE.continuation;
    const data = opcode === OPCODE.text || opcode === OPCODE.binary, control = opcode === OPCODE.close || opcode === OPCODE.ping || opcode === OPCODE.pong;
    if (!data && !control && opcode !== OPCODE.continuation) return this.#fail(1002, "Invalid opcode received");
    if ((second & 0x80) !== 0) return this.#fail(1002, "Frame cannot be masked");
    // No extension is offered, so no frame may be compressed.
    if ((first & 0x40) !== 0) return this.#fail(1002, "Expected RSV1 to be clear.");
    if ((first & 0x30) !== 0) return this.#fail(1002, "RSV1, RSV2, RSV3 must be clear");
    if (fragmented && !data) return this.#fail(1002, "Invalid frame type was fragmented.");
    if (data && this.#fragments.length > 0) return this.#fail(1002, "Expected continuation frame");
    if (this.#fragmented && fragmented) return this.#fail(1002, "Fragmented frame exceeded 125 bytes.");
    if ((length > 125 || fragmented) && control) return this.#fail(1002, "Control frame either too large or fragmented");
    if (opcode === OPCODE.continuation && this.#fragments.length === 0) return this.#fail(1002, "Unexpected continuation frame");
    if (opcode === OPCODE.text || opcode === OPCODE.binary) this.#kind = opcode;
    this.#opcode = opcode; this.#fin = fin; this.#fragmented = fragmented;
    if (length === 126) { this.#state = "length16"; return true; }
    if (length === 127) { this.#state = "length64"; return true; }
    this.#length = length;
    this.#state = "data";
    return this.#bounded();
  }

  #whole(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.#fragmentBytes);
    let offset = 0;
    for (const fragment of this.#fragments) { out.set(fragment, offset); offset += fragment.length; }
    this.#fragments = [];
    this.#fragmentBytes = 0;
    return out;
  }

  #control(body: Uint8Array): boolean {
    if (this.#opcode === OPCODE.ping) { this.#events.ping(body); return true; }
    if (this.#opcode === OPCODE.pong) return true;
    if (body.length === 1) return this.#fail(1002, "Received close frame with a 1-byte body.");
    const code = body.length >= 2 ? ((body[0] ?? 0) << 8) | (body[1] ?? 0) : undefined;
    if (code !== undefined && !validStatusCode(code)) return this.#fail(1002, "Invalid status code");
    let text = body.subarray(2);
    if (text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) text = text.subarray(3);
    const reason = decodeText(text);
    if (reason === undefined) return this.#fail(1007, "Invalid UTF-8");
    this.stop();
    this.#events.close({ code, reason });
    return false;
  }
}
