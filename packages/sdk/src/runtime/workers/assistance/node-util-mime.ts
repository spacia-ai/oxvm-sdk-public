/*!
 * Portions adapted from Node.js v24.18.1 lib/internal/mime.js; modified for OxVM's process owner.
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
import { named, templateText } from "./node-util-validators.ts";

const NOT_HTTP_TOKEN_CODE_POINT = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/u;
const NOT_HTTP_QUOTED_STRING_CODE_POINT = /[^\t -~\u0080-ÿ]/u;
const END_BEGINNING_WHITESPACE = /[^\r\n\t ]|$/u;
const START_ENDING_WHITESPACE = /[\r\n\t ]*$/u;
const EQUALS_SEMICOLON_OR_END = /[;=]|$/u;
const QUOTED_VALUE_PATTERN = /^(?:(\\$)|\\[\s\S]|[^"])*(?:(")|$)/u;
const NON_ASCII = /[^\0-\x7f]/u;

function invalidSyntax(production: string, text: string, index: number): TypeError {
  return Object.assign(new TypeError(`The MIME syntax for a ${production} in "${text}" is invalid${index === -1 ? "" : ` at ${String(index)}`}`), { code: "ERR_INVALID_MIME_SYNTAX" });
}

function toASCIILower(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase();
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    result += char >= "A" && char <= "Z" ? char.toLowerCase() : char;
  }
  return result;
}

function parseTypeAndSubtype(text: string): [type: string, subtype: string, position: number] {
  let position = text.search(END_BEGINNING_WHITESPACE);
  const typeEnd = text.indexOf("/", position);
  const trimmedType = typeEnd === -1 ? text.slice(position) : text.slice(position, typeEnd);
  const invalidTypeIndex = trimmedType.search(NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedType === "" || invalidTypeIndex !== -1 || typeEnd === -1) throw invalidSyntax("type", text, invalidTypeIndex);
  position = typeEnd + 1;
  const type = toASCIILower(trimmedType);
  const subtypeEnd = text.indexOf(";", position);
  const rawSubtype = subtypeEnd === -1 ? text.slice(position) : text.slice(position, subtypeEnd);
  position += rawSubtype.length;
  if (subtypeEnd !== -1) position += 1;
  const trimmedSubtype = rawSubtype.slice(0, rawSubtype.search(START_ENDING_WHITESPACE));
  const invalidSubtypeIndex = trimmedSubtype.search(NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedSubtype === "" || invalidSubtypeIndex !== -1) throw invalidSyntax("subtype", text, invalidSubtypeIndex);
  return [type, toASCIILower(trimmedSubtype), position];
}

function removeBackslashes(text: string): string {
  let result = "", index = 0;
  for (; index < text.length - 1; index++) {
    const char = text.charAt(index);
    if (char === "\\") { index++; result += text.charAt(index); } else result += char;
  }
  if (index === text.length - 1) result += text.charAt(index);
  return result;
}

function encode(value: string): string {
  if (value.length === 0) return "\"\"";
  if (value.search(NOT_HTTP_TOKEN_CODE_POINT) === -1) return value;
  let escaped = "";
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    escaped += char === "\"" || char === "\\" ? `\\${char}` : char;
  }
  return `"${escaped}"`;
}

/** The parameters after a MIME type's `;`, parsed on first use. */
function parseParameters(text: string, parameters: Map<string, string>): void {
  let position = 0;
  const endOfSource = text.search(START_ENDING_WHITESPACE);
  while (position < endOfSource) {
    position += text.slice(position).search(END_BEGINNING_WHITESPACE);
    const afterName = text.slice(position).search(EQUALS_SEMICOLON_OR_END) + position;
    const name = toASCIILower(text.slice(position, afterName));
    position = afterName;
    if (position < endOfSource) {
      const terminator = text.charAt(position);
      position += 1;
      // A parameter without a value is ignored.
      if (terminator === ";") continue;
    }
    if (position >= endOfSource) break;
    let value: string;
    if (text.charAt(position) === "\"") {
      position += 1;
      const inside = QUOTED_VALUE_PATTERN.exec(text.slice(position));
      const matched = inside?.[0] ?? "", unmatchedBackslash = inside?.[1] !== undefined && inside[1] !== "", closed = inside?.[2] !== undefined && inside[2] !== "";
      position += matched.length;
      value = removeBackslashes(unmatchedBackslash || closed ? matched.slice(0, -1) : matched);
      if (unmatchedBackslash) value += "\\";
    } else {
      const valueEnd = text.indexOf(";", position);
      const rawValue = valueEnd === -1 ? text.slice(position) : text.slice(position, valueEnd);
      position += rawValue.length;
      const trimmedValue = rawValue.slice(0, rawValue.search(START_ENDING_WHITESPACE));
      if (trimmedValue === "") continue;
      value = trimmedValue;
    }
    if (name !== "" && name.search(NOT_HTTP_TOKEN_CODE_POINT) === -1 && value.search(NOT_HTTP_QUOTED_STRING_CODE_POINT) === -1 && !parameters.has(name)) {
      parameters.set(name, value);
    }
    position++;
  }
}

let lazyParameters: (text: string) => MIMEParams;
let serialize: (parameters: MIMEParams) => string;

/** `util.MIMEParams`: the parameters of a MIME type, in insertion order. */
export class MIMEParams {
  readonly #data = new Map<string, string>();
  #source: string | null = null;
  static {
    lazyParameters = text => { const instance = new MIMEParams(); instance.#source = text; return instance; };
    serialize = parameters => parameters.#serialize();
  }
  #parse(): Map<string, string> {
    const source = this.#source;
    if (source !== null) { this.#source = null; parseParameters(source, this.#data); }
    return this.#data;
  }
  #serialize(): string {
    let result = "";
    for (const [key, value] of this.#parse()) {
      if (result.length > 0) result += ";";
      result += `${key}=${encode(value)}`;
    }
    return result;
  }
  delete(name: string): void { this.#parse().delete(name); }
  get(name: string): string | null { return this.#parse().get(name) ?? null; }
  has(name: string): boolean { return this.#parse().has(name); }
  set(name: unknown, value: unknown): void {
    const data = this.#parse(), key = templateText(name), text = templateText(value);
    const invalidNameIndex = key.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (key.length === 0 || invalidNameIndex !== -1) throw invalidSyntax("parameter name", key, invalidNameIndex);
    const invalidValueIndex = text.search(NOT_HTTP_QUOTED_STRING_CODE_POINT);
    if (invalidValueIndex !== -1) throw invalidSyntax("parameter value", text, invalidValueIndex);
    data.set(key, text);
  }
  *entries(): Generator<[string, string], void, undefined> { yield* this.#parse().entries(); }
  *keys(): Generator<string, void, undefined> { yield* this.#parse().keys(); }
  *values(): Generator<string, void, undefined> { yield* this.#parse().values(); }
  toString(): string { return this.#serialize(); }
  declare toJSON: () => string;
  declare [Symbol.iterator]: () => Generator<[string, string], void, undefined>;
}
named(MIMEParams, "MIMEParams");
// eslint-disable-next-line @typescript-eslint/unbound-method -- Node shares one function between the two names.
Object.defineProperty(MIMEParams.prototype, Symbol.iterator, { configurable: true, writable: true, value: MIMEParams.prototype.entries });
// eslint-disable-next-line @typescript-eslint/unbound-method -- Node shares one function between the two names.
Object.defineProperty(MIMEParams.prototype, "toJSON", { configurable: true, writable: true, value: MIMEParams.prototype.toString });

/** `util.MIMEType`: a parsed MIME type whose type, subtype and parameters can be changed and written back. */
export class MIMEType {
  #type: string;
  #subtype: string;
  readonly #parameters: MIMEParams;
  constructor(input: unknown) {
    const text = templateText(input);
    const [type, subtype, position] = parseTypeAndSubtype(text);
    this.#type = type;
    this.#subtype = subtype;
    this.#parameters = lazyParameters(text.slice(position));
  }
  get type(): string { return this.#type; }
  set type(value: unknown) {
    const text = templateText(value), invalidIndex = text.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (text.length === 0 || invalidIndex !== -1) throw invalidSyntax("type", text, invalidIndex);
    this.#type = toASCIILower(text);
  }
  get subtype(): string { return this.#subtype; }
  set subtype(value: unknown) {
    const text = templateText(value), invalidIndex = text.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (text.length === 0 || invalidIndex !== -1) throw invalidSyntax("subtype", text, invalidIndex);
    this.#subtype = toASCIILower(text);
  }
  get essence(): string { return `${this.#type}/${this.#subtype}`; }
  get params(): MIMEParams { return this.#parameters; }
  toString(): string {
    const parameters = serialize(this.#parameters);
    return `${this.#type}/${this.#subtype}${parameters.length > 0 ? `;${parameters}` : ""}`;
  }
  declare toJSON: () => string;
}
named(MIMEType, "MIMEType");
// eslint-disable-next-line @typescript-eslint/unbound-method -- Node shares one function between the two names.
Object.defineProperty(MIMEType.prototype, "toJSON", { configurable: true, writable: true, value: MIMEType.prototype.toString });
