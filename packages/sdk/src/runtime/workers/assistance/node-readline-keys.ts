/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/readline/utils.js (emitKeys) and lib/internal/readline/emitKeypressEvents.js; modified for OxVM's process owner.
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { StringDecoder } from "./node-string-decoder.ts";
import { named, primitiveText } from "./node-util-validators.ts";

const ESCAPE = "\x1b";
const KEYPRESS_DECODER = Symbol("keypress-decoder"), ESCAPE_DECODER = Symbol("escape-decoder");
/** GNU readline's default keyseq-timeout. */
const ESCAPE_CODE_TIMEOUT = 500;

/** The second argument of a `keypress` event. `code` is present only for an escape sequence. */
export interface ReadlineKey {
  sequence: string | null;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code?: string;
}

const KEY_NAMES: Readonly<Record<string, readonly [name: string, modifier?: "shift" | "ctrl"]>> = {
  // xterm/gnome ESC [ letter (with modifier) and ESC O letter (without)
  "[P": ["f1"], "[Q": ["f2"], "[R": ["f3"], "[S": ["f4"], "OP": ["f1"], "OQ": ["f2"], "OR": ["f3"], "OS": ["f4"],
  // xterm/rxvt ESC [ number ~
  "[11~": ["f1"], "[12~": ["f2"], "[13~": ["f3"], "[14~": ["f4"],
  // paste bracket mode
  "[200~": ["paste-start"], "[201~": ["paste-end"],
  // from Cygwin and used in libuv
  "[[A": ["f1"], "[[B": ["f2"], "[[C": ["f3"], "[[D": ["f4"], "[[E": ["f5"],
  // common
  "[15~": ["f5"], "[17~": ["f6"], "[18~": ["f7"], "[19~": ["f8"], "[20~": ["f9"], "[21~": ["f10"], "[23~": ["f11"], "[24~": ["f12"],
  // xterm ESC [ letter
  "[A": ["up"], "[B": ["down"], "[C": ["right"], "[D": ["left"], "[E": ["clear"], "[F": ["end"], "[H": ["home"],
  // xterm/gnome ESC O letter
  "OA": ["up"], "OB": ["down"], "OC": ["right"], "OD": ["left"], "OE": ["clear"], "OF": ["end"], "OH": ["home"],
  // xterm/rxvt ESC [ number ~
  "[1~": ["home"], "[2~": ["insert"], "[3~": ["delete"], "[4~": ["end"], "[5~": ["pageup"], "[6~": ["pagedown"],
  // putty
  "[[5~": ["pageup"], "[[6~": ["pagedown"],
  // rxvt
  "[7~": ["home"], "[8~": ["end"],
  // rxvt keys with modifiers
  "[a": ["up", "shift"], "[b": ["down", "shift"], "[c": ["right", "shift"], "[d": ["left", "shift"], "[e": ["clear", "shift"],
  "[2$": ["insert", "shift"], "[3$": ["delete", "shift"], "[5$": ["pageup", "shift"], "[6$": ["pagedown", "shift"], "[7$": ["home", "shift"], "[8$": ["end", "shift"],
  "Oa": ["up", "ctrl"], "Ob": ["down", "ctrl"], "Oc": ["right", "ctrl"], "Od": ["left", "ctrl"], "Oe": ["clear", "ctrl"],
  "[2^": ["insert", "ctrl"], "[3^": ["delete", "ctrl"], "[5^": ["pageup", "ctrl"], "[6^": ["pagedown", "ctrl"], "[7^": ["home", "ctrl"], "[8^": ["end", "ctrl"],
  // misc.
  "[Z": ["tab", "shift"],
};

function digit(char: string): boolean { return char >= "0" && char <= "9"; }
/** Node's `charLengthAt(text, 0)`: two code units for an astral character. */
function firstCharLength(text: string): number { return (text.codePointAt(0) ?? 0) >= 0x1_0000 ? 2 : 1; }

type Emit = (sequence: string | undefined, key: ReadlineKey) => void;

/** Node's key decoder: fed one character at a time, it reports each completed key. The escape forms are
 *   ESC letter, ESC [ letter, ESC [ modifier letter, ESC [ 1 ; modifier letter, ESC [ num char,
 *   ESC [ num ; modifier char, ESC O letter, ESC O modifier letter, ESC [ [ num ; modifier char, ESC ESC ...
 * where modifier is 1 + shift*1 + left_alt*2 + ctrl*4 + right_alt*8. An empty string stands for the escape timeout. */
function* emitKeys(emit: Emit): Generator<undefined, never, string> {
  for (;;) {
    let ch = yield;
    let s = ch;
    let escaped = false;
    const key: ReadlineKey = { sequence: null, name: undefined, ctrl: false, meta: false, shift: false };
    if (ch === ESCAPE) {
      escaped = true;
      s += (ch = yield);
      if (ch === ESCAPE) s += (ch = yield);
    }
    if (escaped && (ch === "O" || ch === "[")) {
      let code = ch;
      let modifier = 0;
      if (ch === "O") {
        // ESC O letter, ESC O modifier letter
        s += (ch = yield);
        if (digit(ch)) { modifier = Number(ch) - 1; s += (ch = yield); }
        code += ch;
      } else {
        // ESC [ letter, ESC [ modifier letter, ESC [ [ modifier letter, ESC [ [ num char
        s += (ch = yield);
        if (ch === "[") { code += ch; s += (ch = yield); }
        // Buffer just enough for `\x1b[24;5~` ({ code: "[24~", modifier: 5 }) or `\x1b[1;5H` ({ code: "[H", modifier: 5 }).
        const commandStart = s.length - 1;
        if (digit(ch)) {
          s += (ch = yield);
          if (digit(ch)) {
            s += (ch = yield);
            if (digit(ch)) s += (ch = yield);
          }
        }
        if (ch === ";") {
          s += (ch = yield);
          if (digit(ch)) s += yield;
        }
        const command = s.slice(commandStart);
        const numbered = /^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/u.exec(command);
        const lettered = numbered === null ? /^((\d;)?(\d))?([A-Za-z])$/u.exec(command) : null;
        if (numbered !== null) {
          if (numbered[4] !== undefined && numbered[4] !== "") code += numbered[4];
          else { code += `${numbered[1] ?? ""}${numbered[3] ?? ""}`; modifier = Number(numbered[2] ?? 1) - 1; }
        } else if (lettered !== null) { code += lettered[4] ?? ""; modifier = Number(lettered[3] ?? 1) - 1; }
        else code += command;
      }
      key.ctrl = (modifier & 4) !== 0;
      key.meta = (modifier & 10) !== 0;
      key.shift = (modifier & 1) !== 0;
      key.code = code;
      const known = Object.hasOwn(KEY_NAMES, code) ? KEY_NAMES[code] : undefined;
      if (known === undefined) key.name = "undefined";
      else { key.name = known[0]; if (known[1] !== undefined) key[known[1]] = true; }
    } else if (ch === "\r") { key.name = "return"; key.meta = escaped; }
    else if (ch === "\n") { key.name = "enter"; key.meta = escaped; }
    else if (ch === "\t") { key.name = "tab"; key.meta = escaped; }
    else if (ch === "\b" || ch === "\x7f") { key.name = "backspace"; key.meta = escaped; }
    else if (ch === ESCAPE) { key.name = "escape"; key.meta = escaped; }
    else if (ch === " ") { key.name = "space"; key.meta = escaped; }
    else if (!escaped && ch <= "\x1a") {
      // ctrl+letter
      key.name = String.fromCharCode(ch.charCodeAt(0) + "a".charCodeAt(0) - 1);
      key.ctrl = true;
    } else if (/^[0-9A-Za-z]$/u.test(ch)) {
      // letter, number, shift+letter
      key.name = ch.toLowerCase();
      key.shift = /^[A-Z]$/u.test(ch);
      key.meta = escaped;
    } else if (escaped) {
      // escape sequence timeout
      key.name = ch.length > 0 ? undefined : "escape";
      key.meta = true;
    }
    key.sequence = s;
    if (s.length !== 0 && (key.name !== undefined || escaped)) emit(escaped ? undefined : s, key);
    else if (firstCharLength(s) === s.length) emit(s, key);
    // An unrecognised or broken escape sequence emits nothing.
  }
}

export interface KeypressTimers {
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

function method(target: object, name: string, args: unknown[]): unknown {
  const value: unknown = Reflect.get(target, name);
  if (typeof value !== "function") throw new TypeError(`stream.${name} is not a function`);
  return Reflect.apply(value, target, args);
}
function decoderOf(stream: object): StringDecoder | undefined {
  const value: unknown = Reflect.get(stream, KEYPRESS_DECODER);
  return value instanceof StringDecoder ? value : undefined;
}

/** `readline.emitKeypressEvents(stream, interface?)`: while the stream has a `keypress` listener, its `data` chunks are
 * decoded as UTF-8 and reported key by key as `keypress(sequence, key)`. A lone ESC is reported after
 * `escapeCodeTimeout` (500 ms) unless more input follows. */
export function createEmitKeypressEvents(timers: () => KeypressTimers): (stream: unknown, iface?: unknown) => void {
  function emitKeypressEvents(stream: unknown, iface: unknown = {}): void {
    if (stream === null || stream === undefined) throw new TypeError(`Cannot read properties of ${String(stream)} (reading 'Symbol(keypress-decoder)')`);
    if (typeof stream !== "object" && typeof stream !== "function") throw new TypeError(`Cannot create property 'Symbol(keypress-decoder)' on ${typeof stream} '${primitiveText(stream)}'`);
    const source: object = stream;
    if (decoderOf(source) !== undefined) return;
    Reflect.set(source, KEYPRESS_DECODER, new StringDecoder("utf8"));
    const emit: Emit = (sequence, key) => { method(source, "emit", ["keypress", sequence, key]); };
    let keys = emitKeys(emit);
    const restart = (): void => { keys = emitKeys(emit); Reflect.set(source, ESCAPE_DECODER, keys); keys.next(""); };
    restart();
    const owner: object | undefined = typeof iface === "object" && iface !== null || typeof iface === "function" ? iface : undefined;
    const configured: unknown = owner === undefined ? undefined : Reflect.get(owner, "escapeCodeTimeout");
    const escapeCodeTimeout = configured === undefined ? ESCAPE_CODE_TIMEOUT : typeof configured === "number" ? configured : Number(configured);
    let timeout: unknown;
    const triggerEscape = (): void => { keys.next(""); };
    function onData(input: unknown): void {
      if (Number(method(source, "listenerCount", ["keypress"])) > 0) {
        const text = decoderOf(source)?.write(input) ?? "";
        if (text === "") return;
        timers().clearTimeout(timeout);
        if (owner !== undefined) Reflect.set(owner, "isCompletionEnabled", false);
        let length = 0;
        for (const character of text) {
          length += character.length;
          if (length === text.length && owner !== undefined) Reflect.set(owner, "isCompletionEnabled", true);
          try {
            keys.next(character);
            // An escape at the tail may be a key of its own: wait for more input before deciding.
            if (length === text.length && character === ESCAPE) timeout = timers().setTimeout(triggerEscape, escapeCodeTimeout);
          } catch (error) {
            // A throwing `keypress` listener ends the generator; start a new one.
            restart();
            throw error;
          }
        }
      } else {
        // Nobody is watching.
        method(source, "removeListener", ["data", onData]);
        method(source, "on", ["newListener", onNewListener]);
      }
    }
    function onNewListener(event: unknown): void {
      if (event !== "keypress") return;
      method(source, "on", ["data", onData]);
      method(source, "removeListener", ["newListener", onNewListener]);
    }
    if (Number(method(source, "listenerCount", ["keypress"])) > 0) method(source, "on", ["data", onData]);
    else method(source, "on", ["newListener", onNewListener]);
  }
  return named(emitKeypressEvents, "emitKeypressEvents");
}
