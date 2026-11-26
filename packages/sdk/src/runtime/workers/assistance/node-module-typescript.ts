import { parse } from "@babel/parser";
import { invalidType, invalidValue, validateBoolean, validateString } from "./node-util-validators.ts";

/**
 * Node's `module.stripTypeScriptTypes(code, options)`. Node erases types with SWC's strip-only pass, which keeps
 * every remaining character at its position; this is the same erasure over Babel's TypeScript syntax tree. The
 * `transform` mode needs a TypeScript compiler and takes it as a port.
 */
export interface TypeScriptPorts {
  /** `process.emitWarning`, for Node's one ExperimentalWarning. */
  readonly warn?: (message: string, type: string) => void;
  /** The pinned SWC `transformSync`: TypeScript to JavaScript with a source map (JSON text). */
  readonly transform?: (source: string, options: Readonly<Record<string, unknown>>) => { readonly code: string; readonly map: string };
}

interface Node { readonly type: string; readonly start: number; readonly end: number }
interface Token { readonly label: string; readonly value: unknown; readonly start: number; readonly end: number }

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" &&
    "start" in value && typeof value.start === "number" && "end" in value && typeof value.end === "number";
}
function child(node: Node, key: string): Node | undefined { const value: unknown = Reflect.get(node, key); return isNode(value) ? value : undefined; }
function children(node: Node, key: string): Node[] { const value: unknown = Reflect.get(node, key); return Array.isArray(value) ? value.filter(isNode) : []; }
function flag(node: Node, key: string): boolean { return Reflect.get(node, key) === true; }
function text(node: Node, key: string): unknown { const value: unknown = Reflect.get(node, key); return value; }

function syntaxError(code: "ERR_INVALID_TYPESCRIPT_SYNTAX" | "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", message: string): SyntaxError {
  return Object.assign(new SyntaxError(message), { code });
}
const unsupported = (message: string): SyntaxError => syntaxError("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", message);

const WHOLE = new Set(["TSTypeAnnotation", "TSTypeParameterDeclaration", "TSTypeParameterInstantiation"]);
const TYPE_STATEMENTS = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSDeclareFunction", "TSNamespaceExportDeclaration"]);
const MODIFIERS = new Set(["public", "private", "protected", "readonly", "override", "abstract", "declare"]);
const HAZARDS = new Set(["(", "[", "`", "+/-", "/"]);
const SKIPPED = new Set(["loc", "leadingComments", "trailingComments", "innerComments", "extra", "range"]);
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/** A namespace holding only types leaves nothing to run, so strip mode erases it. */
function typeOnly(node: Node): boolean {
  if (TYPE_STATEMENTS.has(node.type) || node.type === "EmptyStatement" || flag(node, "declare")) return true;
  if (node.type === "ImportDeclaration") return text(node, "importKind") === "type";
  if (node.type === "ExportNamedDeclaration") {
    const declaration = child(node, "declaration");
    return text(node, "exportKind") === "type" || (declaration !== undefined && typeOnly(declaration));
  }
  if (node.type !== "TSModuleDeclaration") return false;
  const body = child(node, "body");
  if (body === undefined) return true;
  return body.type === "TSModuleBlock" ? children(body, "body").every(typeOnly) : typeOnly(body);
}

/** The JavaScript left when every type is replaced by blanks of the same extent. */
export function eraseTypes(code: string): string {
  let file: unknown;
  try {
    file = parse(code, {
      sourceType: "unambiguous", plugins: ["typescript", "decorators", "decoratorAutoAccessors"], tokens: true, allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true, allowUndeclaredExports: true, allowSuperOutsideMethod: true, allowNewTargetOutsideFunction: true,
    });
  } catch (error) {
    throw syntaxError("ERR_INVALID_TYPESCRIPT_SYNTAX", error instanceof Error ? error.message.replace(/ \(\d+:\d+\)$/u, "") : String(error));
  }
  const program: unknown = typeof file === "object" && file !== null ? Reflect.get(file, "program") : undefined;
  const rawTokens: unknown = typeof file === "object" && file !== null ? Reflect.get(file, "tokens") : undefined;
  const tokens: Token[] = [];
  for (const token of Array.isArray(rawTokens) ? rawTokens : []) {
    if (typeof token !== "object" || token === null) continue;
    const kind: unknown = Reflect.get(token, "type"), start: unknown = Reflect.get(token, "start"), end: unknown = Reflect.get(token, "end");
    // Comments carry a string type and are not syntax.
    const label: unknown = typeof kind === "object" && kind !== null ? Reflect.get(kind, "label") : undefined;
    if (typeof label === "string" && label !== "eof" && typeof start === "number" && typeof end === "number") tokens.push({ label, value: Reflect.get(token, "value"), start, end });
  }
  const blanked = new Uint8Array(code.length);
  const overwrites = new Map<number, string>();
  const blank = (start: number, end: number): void => { blanked.fill(1, start, end); };
  /** The index of the first token starting at or after `position`. */
  function tokenIndex(position: number): number {
    let low = 0, high = tokens.length;
    while (low < high) { const middle = (low + high) >> 1; if ((tokens[middle]?.start ?? 0) < position) low = middle + 1; else high = middle; }
    return low;
  }
  const tokenFrom = (position: number): Token | undefined => tokens[tokenIndex(position)];
  const tokenBefore = (position: number): Token | undefined => tokens[tokenIndex(position) - 1];
  function tokensIn(start: number, end: number): Token[] {
    const found: Token[] = [];
    for (let index = tokenIndex(start); index < tokens.length; index++) {
      const token = tokens[index];
      if (token === undefined || token.start >= end) break;
      found.push(token);
    }
    return found;
  }
  /** Without the erased text the next line could continue this statement: SWC puts a semicolon in its place. */
  function guard(start: number, end: number, sameLine: boolean): void {
    const next = tokenFrom(end);
    if (next === undefined || !HAZARDS.has(next.label)) return;
    if (!sameLine && !LINE_BREAK.test(code.slice(end, next.start))) return;
    let at = start;
    while (at < end && /\s/u.test(code[at] ?? "")) at++;
    overwrites.set(at, ";");
  }
  function statement(node: Node): void {
    blank(node.start, node.end);
    if (code[node.end - 1] !== ";") guard(node.start, node.end, true);
  }
  function marker(position: number, limit: number): void {
    for (const token of tokensIn(position, limit)) {
      if (token.label === "(" || token.label === "=" || token.label === ":") break;
      if (token.label === "?" || token.label === "!") blank(token.start, token.end);
    }
  }
  function modifiers(node: Node, key: Node): void {
    const decorators = children(node, "decorators");
    const from = decorators.at(-1)?.end ?? node.start;
    for (const token of tokensIn(from, key.start)) if (typeof token.value === "string" && MODIFIERS.has(token.value)) blank(token.start, token.end);
  }
  function specifiers(node: Node, kindKey: string): void {
    for (const specifier of children(node, "specifiers")) {
      if (text(specifier, kindKey) !== "type") continue;
      const next = tokenFrom(specifier.end);
      blank(specifier.start, next?.label === "," ? next.end : specifier.end);
    }
  }
  function parameters(node: Node): void {
    const first = children(node, "params")[0];
    if (first?.type === "Identifier" && text(first, "name") === "this") {
      const next = tokenFrom(first.end);
      blank(first.start, next?.label === "," ? next.end : first.end);
    }
    const returns = child(node, "returnType");
    if (node.type === "ArrowFunctionExpression" && returns !== undefined && LINE_BREAK.test(code.slice(returns.start, returns.end))) {
      // `=>` may not start a line: the closing parenthesis moves to where the return type ended.
      const close = tokenBefore(returns.start);
      if (close?.label === ")") { blank(close.start, close.end); overwrites.set(returns.end - 1, ")"); }
    }
  }
  function classHead(node: Node): void {
    const body = child(node, "body");
    if (body === undefined) return;
    const decorators = children(node, "decorators");
    for (const token of tokensIn(decorators.at(-1)?.end ?? node.start, body.start)) {
      if (token.label === "class") break;
      if (token.value === "abstract") blank(token.start, token.end);
    }
    const implemented = children(node, "implements"), last = implemented.at(-1), first = implemented[0];
    if (first === undefined || last === undefined) return;
    const keyword = tokenBefore(first.start);
    if (keyword?.value === "implements") blank(keyword.start, last.end);
  }
  function descend(node: Node): void {
    for (const key of Object.keys(node)) {
      if (SKIPPED.has(key)) continue;
      const value: unknown = Reflect.get(node, key);
      if (isNode(value)) visit(value);
      else if (Array.isArray(value)) for (const entry of value) if (isNode(entry)) visit(entry);
    }
  }
  function member(node: Node): void {
    const key = child(node, "key");
    if (key === undefined) { descend(node); return; }
    modifiers(node, key);
    const after = flag(node, "computed") ? (tokenFrom(key.end)?.end ?? key.end) : key.end;
    marker(after, node.end);
    descend(node);
  }
  function visit(node: Node): void {
    if (WHOLE.has(node.type)) { blank(node.start, node.end); return; }
    if (TYPE_STATEMENTS.has(node.type)) { statement(node); return; }
    switch (node.type) {
      case "TSEnumDeclaration":
        if (flag(node, "declare")) { statement(node); return; }
        throw unsupported("TypeScript enum is not supported in strip-only mode");
      case "TSModuleDeclaration":
        if (flag(node, "declare")) { statement(node); return; }
        if (text(node, "kind") === "module" && child(node, "id")?.type === "Identifier") throw unsupported("`module` keyword is not supported. Use `namespace` instead.");
        if (typeOnly(node)) { statement(node); return; }
        throw unsupported("TypeScript namespace declaration is not supported in strip-only mode");
      case "TSImportEqualsDeclaration": throw unsupported("TypeScript import equals declaration is not supported in strip-only mode");
      case "TSExportAssignment": throw unsupported("TypeScript export assignment is not supported in strip-only mode");
      case "TSParameterProperty": throw unsupported("TypeScript parameter property is not supported in strip-only mode");
      case "TSTypeAssertion": throw unsupported("The angle-bracket syntax for type assertions, `<T>expr`, is not supported in type strip mode. Instead, use the 'as' syntax: `expr as T`.");
      case "VariableDeclaration": case "FunctionDeclaration":
        if (flag(node, "declare")) { statement(node); return; }
        break;
      case "ImportDeclaration":
        if (text(node, "importKind") === "type") { statement(node); return; }
        specifiers(node, "importKind");
        return;
      case "ExportAllDeclaration":
        if (text(node, "exportKind") === "type") statement(node);
        return;
      case "ExportNamedDeclaration": {
        const declaration = child(node, "declaration");
        if (text(node, "exportKind") === "type" || (declaration !== undefined && typeOnly(declaration) && declaration.type !== "TSModuleDeclaration")) { statement(node); return; }
        specifiers(node, "exportKind");
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = child(node, "declaration");
        if (declaration !== undefined && TYPE_STATEMENTS.has(declaration.type)) { statement(node); return; }
        break;
      }
      case "TSAsExpression": case "TSSatisfiesExpression": case "TSNonNullExpression": {
        const expression = child(node, "expression");
        if (expression === undefined) break;
        visit(expression);
        blank(expression.end, node.end);
        if (node.type !== "TSNonNullExpression") guard(expression.end, node.end, false);
        return;
      }
      case "ClassDeclaration": case "ClassExpression":
        if (flag(node, "declare")) { statement(node); return; }
        classHead(node);
        break;
      case "TSDeclareMethod": case "TSIndexSignature":
        blank(node.start, node.end);
        return;
      case "ClassProperty": case "ClassPrivateProperty": case "ClassAccessorProperty":
        if (flag(node, "declare") || flag(node, "abstract")) { blank(node.start, node.end); return; }
        member(node);
        return;
      case "ClassMethod": case "ClassPrivateMethod":
        parameters(node);
        member(node);
        return;
      case "FunctionExpression": case "ArrowFunctionExpression": case "ObjectMethod":
        parameters(node);
        break;
      case "VariableDeclarator": {
        const id = child(node, "id");
        if (flag(node, "definite") && id !== undefined) marker(id.start, id.end);
        break;
      }
      case "Identifier": case "ObjectPattern": case "ArrayPattern": case "RestElement": case "AssignmentPattern":
        if (flag(node, "optional")) {
          const annotation = child(node, "typeAnnotation");
          const mark = tokenBefore(annotation?.start ?? node.end);
          if (mark?.label === "?" && mark.start >= node.start) blank(mark.start, mark.end);
        }
        break;
      default:
    }
    if (node.type === "FunctionDeclaration") parameters(node);
    descend(node);
  }
  if (isNode(program)) visit(program);

  let result = "";
  for (let index = 0; index < code.length;) {
    const replacement = overwrites.get(index);
    if (replacement !== undefined) { result += replacement; index++; continue; }
    const point = code.codePointAt(index) ?? 0, width = point > 0xFFFF ? 2 : 1;
    const character = code.slice(index, index + width);
    index += width;
    if (blanked[index - width] !== 1 || LINE_BREAK.test(character)) result += character;
    // SWC erases bytes of UTF-8: a wider character becomes blank characters of the same byte length.
    else result += point < 0x80 ? " " : point < 0x800 ? "\u00A0" : point < 0x10000 ? "\u2002" : " \uFEFF";
  }
  return result;
}

function base64(textValue: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", bytes = new TextEncoder().encode(textValue);
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0, second = bytes[index + 1], third = bytes[index + 2];
    const word = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += (alphabet[word >> 18] ?? "") + (alphabet[(word >> 12) & 63] ?? "") + (second === undefined ? "=" : alphabet[(word >> 6) & 63] ?? "") + (third === undefined ? "=" : alphabet[word & 63] ?? "");
  }
  return result;
}

/** Node's maps name no identifiers: a segment's fifth field, the index of a name, is dropped. */
function withoutNames(mappings: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return mappings.replace(/[^,;]+/gu, segment => {
    let fields = 0;
    for (let index = 0; index < segment.length; index++) {
      // A base64 digit without the continuation bit ends a field.
      if ((alphabet.indexOf(segment[index] ?? "") & 32) === 0 && ++fields === 4) return segment.slice(0, index + 1);
    }
    return segment;
  });
}

export function createStripTypeScriptTypes(ports: TypeScriptPorts = {}): (code: unknown, options?: unknown) => string {
  let warned = false;
  function compile(code: string, sourceUrl: string | undefined): { readonly code: string; readonly map: string } {
    if (ports.transform === undefined) {
      throw syntaxError("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", "TypeScript transform mode is not available in browser-assisted processes");
    }
    try {
      return ports.transform(code, {
        filename: sourceUrl ?? "", sourceMaps: true, swcrc: false, configFile: false,
        jsc: { parser: { syntax: "typescript", decorators: true }, target: "esnext", transform: { verbatimModuleSyntax: true, useDefineForClassFields: true }, preserveAllComments: true },
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n").map(line => line.trim()).find(line => line.startsWith("x "))?.slice(2);
      throw syntaxError("ERR_INVALID_TYPESCRIPT_SYNTAX", message ?? "Invalid TypeScript syntax");
    }
  }
  /** Strip mode's text is Babel's work, but Node's wording of a syntax error is SWC's: the compiler is asked for it. */
  function erase(code: string): string {
    try { return eraseTypes(code); }
    catch (error) {
      if (ports.transform === undefined || !(error instanceof SyntaxError) || !("code" in error) || error.code !== "ERR_INVALID_TYPESCRIPT_SYNTAX") throw error;
      compile(code, undefined);
      throw error;
    }
  }
  function transform(code: string, sourceMap: boolean, sourceUrl: string | undefined): string {
    const output = compile(code, sourceUrl);
    if (!sourceMap) return output.code;
    const map: unknown = JSON.parse(output.map);
    const field = (key: string): unknown => typeof map === "object" && map !== null ? Reflect.get(map, key) : undefined;
    const mappings: unknown = field("mappings");
    const encoded = JSON.stringify({ version: 3, sources: [sourceUrl ?? ""], names: [], mappings: typeof mappings === "string" ? withoutNames(mappings) : "" });
    return `${output.code}\n\n//# sourceMappingURL=data:application/json;base64,${base64(encoded)}`;
  }
  return function stripTypeScriptTypes(code: unknown, options: unknown = {}): string {
    if (!warned) { warned = true; ports.warn?.("stripTypeScriptTypes is an experimental feature and might change at any time", "ExperimentalWarning"); }
    validateString(code, "code");
    if (typeof options !== "object" || options === null || Array.isArray(options)) throw invalidType("options", "object", options);
    const mode: unknown = Reflect.get(options, "mode") ?? "strip", sourceMap: unknown = Reflect.get(options, "sourceMap") ?? false, sourceUrl: unknown = Reflect.get(options, "sourceUrl");
    if (mode !== "strip" && mode !== "transform") throw invalidValue("options.mode", mode, "must be one of: 'strip', 'transform'");
    validateBoolean(sourceMap, "options.sourceMap");
    if (sourceUrl !== undefined) validateString(sourceUrl, "options.sourceUrl");
    let result: string;
    if (mode === "strip") {
      if (sourceMap) throw invalidValue("options.sourceMap", sourceMap, "must be one of: false, undefined");
      result = erase(code);
    } else result = transform(code, sourceMap, sourceUrl);
    return sourceUrl === undefined || (mode === "transform" && sourceMap) ? result : `${result}\n\n//# sourceURL=${sourceUrl}`;
  };
}
