/*!
 * Adapted from Node.js v24.18.1 lib/path.js (the `win32` object and its helpers).
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

import { invalidArgType, type Inspect } from "./node-arg-type.ts";
import { matchGlob } from "./node-path-glob.ts";

export interface ParsedPath { root: string; dir: string; base: string; ext: string; name: string }

const CHAR_UPPERCASE_A = 65, CHAR_LOWERCASE_A = 97, CHAR_UPPERCASE_Z = 90, CHAR_LOWERCASE_Z = 122, CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47, CHAR_BACKWARD_SLASH = 92, CHAR_COLON = 58, CHAR_QUESTION_MARK = 63;

// Node's primordials, kept under their upstream names so the port reads against lib/path.js line by line.
const StringPrototypeCharCodeAt = (text: string, index: number): number => text.charCodeAt(index);
const StringPrototypeIncludes = (text: string, part: string): boolean => text.includes(part);
const StringPrototypeIndexOf = (text: string, part: string, from?: number): number => text.indexOf(part, from);
const StringPrototypeLastIndexOf = (text: string, part: string, from?: number): number => from === undefined ? text.lastIndexOf(part) : text.lastIndexOf(part, from);
const StringPrototypeRepeat = (text: string, count: number): string => text.repeat(count);
const StringPrototypeReplace = (text: string, pattern: RegExp, replacement: string): string => text.replace(pattern, replacement);
const StringPrototypeSlice = (text: string, start?: number, end?: number): string => text.slice(start, end);
const StringPrototypeSplit = (text: string, separator: string): string[] => text.split(separator);
const StringPrototypeToLowerCase = (text: string): string => text.toLowerCase();
const StringPrototypeToUpperCase = (text: string): string => text.toUpperCase();
const ArrayPrototypeIncludes = (list: readonly string[], item: string): boolean => list.includes(item);
const ArrayPrototypeJoin = (list: readonly string[], separator: string): string => list.join(separator);
const ArrayPrototypePush = (list: string[], item: string): number => list.push(item);
const ArrayPrototypeSlice = (list: readonly string[], start?: number, end?: number): string[] => list.slice(start, end);

function isPathSeparator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}
function isPosixPathSeparator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH;
}

const WINDOWS_RESERVED_NAMES = [
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  "COM\xb9", "COM\xb2", "COM\xb3",
  "LPT\xb9", "LPT\xb2", "LPT\xb3",
];

function isWindowsReservedName(path: string, colonIndex: number): boolean {
  const devicePart = StringPrototypeToUpperCase(StringPrototypeSlice(path, 0, colonIndex));
  return ArrayPrototypeIncludes(WINDOWS_RESERVED_NAMES, devicePart);
}

function isWindowsDeviceRoot(code: number): boolean {
  return (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
         (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z);
}

// Resolves . and .. elements in a path with directory names
function normalizeString(path: string, allowAboveRoot: boolean, separator: string, isPathSeparator: (code: number) => boolean): string {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length)
      code = StringPrototypeCharCodeAt(path, i);
    else if (isPathSeparator(code))
      break;
    else
      code = CHAR_FORWARD_SLASH;

    if (isPathSeparator(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 ||
            StringPrototypeCharCodeAt(res, res.length - 1) !== CHAR_DOT ||
            StringPrototypeCharCodeAt(res, res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.length - lastSegmentLength - 1;
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = StringPrototypeSlice(res, 0, lastSlashIndex);
              lastSegmentLength =
                res.length - 1 - StringPrototypeLastIndexOf(res, separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0)
          res += `${separator}${StringPrototypeSlice(path, lastSlash + 1, i)}`;
        else
          res = StringPrototypeSlice(path, lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

/** A path object's field as text. Node concatenates whatever it is given; only strings and numbers are worded exactly here. */
function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" ? String(value) : Object.prototype.toString.call(value);
}
function truthy(value: unknown): boolean { return Boolean(value); }
function formatExt(ext: unknown): string {
  if (typeof ext === "string") return ext === "" ? "" : `${ext.startsWith(".") ? "" : "."}${ext}`;
  return truthy(ext) ? `.${text(ext)}` : "";
}

function _format(inspect: Inspect, sep: string, pathObject: unknown): string {
  if (pathObject === null || typeof pathObject !== "object" || Array.isArray(pathObject)) throw invalidArgType("pathObject", "object", pathObject, inspect);
  const field = (key: string): unknown => Reflect.get(pathObject, key);
  const or = (value: unknown, otherwise: unknown): unknown => truthy(value) ? value : otherwise;
  const root = field("root");
  const dir = or(field("dir"), root);
  const base = or(field("base"), `${text(or(field("name"), ""))}${formatExt(field("ext"))}`);
  if (!truthy(dir)) {
    return text(base);
  }
  return dir === root ? `${text(dir)}${text(base)}` : `${text(dir)}${sep}${text(base)}`;
}
Object.defineProperty(_format, "name", { value: "_format" });

const forwardSlashRegExp = /\//g;

/** `path.win32`: string operations only. On this POSIX host `resolve` reads the process directory with its slashes turned, as Node does off Windows. */
export function createNodeWin32Path(cwd: () => string, inspect: Inspect) {
  // This port keeps no dependency of its own: the caller supplies how a refused argument is described.
  const validateString: (value: unknown, name: string) => asserts value is string = (value, name) => {
    if (typeof value !== "string") throw invalidArgType(name, "string", value, inspect);
  };
  const format: (pathObject: unknown) => string = _format.bind(null, inspect, "\\");
  const win32 = {
    resolve(...args: unknown[]): string {
      let resolvedDevice = '';
      let resolvedTail = '';
      let resolvedAbsolute = false;
      for (let i = args.length - 1; i >= -1; i--) {
        let path: string;
        if (i >= 0) {
          const arg = args[i];
          validateString(arg, `paths[${i}]`);
          path = arg;
          if (path.length === 0) {
            continue;
          }
        } else if (resolvedDevice.length === 0) {
          path = cwd();
          if (args.length === 0 || ((args.length === 1 && (args[0] === '' || args[0] === '.')) &&
              isPathSeparator(StringPrototypeCharCodeAt(path, 0)))) {
            {
              path = StringPrototypeReplace(path, forwardSlashRegExp, '\\');
            }
            return path;
          }
        } else {
          path = cwd();
          if ((StringPrototypeToLowerCase(StringPrototypeSlice(path, 0, 2)) !==
              StringPrototypeToLowerCase(resolvedDevice) &&
              StringPrototypeCharCodeAt(path, 2) === CHAR_BACKWARD_SLASH)) {
            path = `${resolvedDevice}\\`;
          }
        }
        const len = path.length;
        let rootEnd = 0;
        let device = '';
        let isAbsolute = false;
        const code = StringPrototypeCharCodeAt(path, 0);
        if (len === 1) {
          if (isPathSeparator(code)) {
            rootEnd = 1;
            isAbsolute = true;
          }
        } else if (isPathSeparator(code)) {
          isAbsolute = true;
          if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
            let j = 2;
            let last = j;
            while (j < len &&
                   !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
              j++;
            }
            if (j < len && j !== last) {
              const firstPart = StringPrototypeSlice(path, last, j);
              last = j;
              while (j < len &&
                     isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
                j++;
              }
              if (j < len && j !== last) {
                last = j;
                while (j < len &&
                       !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
                  j++;
                }
                if (j === len || j !== last) {
                  if (firstPart !== '.' && firstPart !== '?') {
                    device =
                      `\\\\${firstPart}\\${StringPrototypeSlice(path, last, j)}`;
                    rootEnd = j;
                  } else {
                    device = `\\\\${firstPart}`;
                    rootEnd = 4;
                  }
                }
              }
            }
          } else {
            rootEnd = 1;
          }
        } else if (isWindowsDeviceRoot(code) &&
                    StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
          device = StringPrototypeSlice(path, 0, 2);
          rootEnd = 2;
          if (len > 2 && isPathSeparator(StringPrototypeCharCodeAt(path, 2))) {
            isAbsolute = true;
            rootEnd = 3;
          }
        }
        if (device.length > 0) {
          if (resolvedDevice.length > 0) {
            if (StringPrototypeToLowerCase(device) !==
                StringPrototypeToLowerCase(resolvedDevice))
              continue;
          } else {
            resolvedDevice = device;
          }
        }
        if (resolvedAbsolute) {
          if (resolvedDevice.length > 0)
            break;
        } else {
          resolvedTail =
            `${StringPrototypeSlice(path, rootEnd)}\\${resolvedTail}`;
          resolvedAbsolute = isAbsolute;
          if (isAbsolute && resolvedDevice.length > 0) {
            break;
          }
        }
      }
      resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, '\\',
                                     isPathSeparator);
      return resolvedAbsolute ?
        `${resolvedDevice}\\${resolvedTail}` :
        `${resolvedDevice}${resolvedTail}` || '.';
    },
    normalize(path: unknown): string {
      validateString(path, 'path');
      const len = path.length;
      if (len === 0)
        return '.';
      let rootEnd = 0;
      let device: string | undefined;
      let isAbsolute = false;
      const code = StringPrototypeCharCodeAt(path, 0);
      if (len === 1) {
        return isPosixPathSeparator(code) ? '\\' : path;
      }
      if (isPathSeparator(code)) {
        isAbsolute = true;
        if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
          let j = 2;
          let last = j;
          while (j < len &&
                 !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
            j++;
          }
          if (j < len && j !== last) {
            const firstPart = StringPrototypeSlice(path, last, j);
            last = j;
            while (j < len &&
                   isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
              j++;
            }
            if (j < len && j !== last) {
              last = j;
              while (j < len &&
                     !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
                j++;
              }
              if (j === len || j !== last) {
                if (firstPart === '.' || firstPart === '?') {
                  device = `\\\\${firstPart}`;
                  rootEnd = 4;
                  const colonIndex = StringPrototypeIndexOf(path, ':');
                  const possibleDevice = StringPrototypeSlice(path, 4, colonIndex + 1);
                  if (isWindowsReservedName(possibleDevice, possibleDevice.length - 1)) {
                    device = `\\\\?\\${possibleDevice}`;
                    rootEnd = 4 + possibleDevice.length;
                  }
                } else if (j === len) {
                  return `\\\\${firstPart}\\${StringPrototypeSlice(path, last)}\\`;
                } else {
                  device =
                    `\\\\${firstPart}\\${StringPrototypeSlice(path, last, j)}`;
                  rootEnd = j;
                }
              }
            }
          }
        } else {
          rootEnd = 1;
        }
      } else {
        const colonIndex = StringPrototypeIndexOf(path, ':');
        if (colonIndex > 0) {
          if (isWindowsDeviceRoot(code) && colonIndex === 1) {
            device = StringPrototypeSlice(path, 0, 2);
            rootEnd = 2;
            if (len > 2 && isPathSeparator(StringPrototypeCharCodeAt(path, 2))) {
              isAbsolute = true;
              rootEnd = 3;
            }
          } else if (isWindowsReservedName(path, colonIndex)) {
            device = StringPrototypeSlice(path, 0, colonIndex + 1);
            rootEnd = colonIndex + 1;
          }
        }
      }
      let tail = rootEnd < len ?
        normalizeString(StringPrototypeSlice(path, rootEnd),
                        !isAbsolute, '\\', isPathSeparator) :
        '';
      if (tail.length === 0 && !isAbsolute)
        tail = '.';
      if (tail.length > 0 &&
          isPathSeparator(StringPrototypeCharCodeAt(path, len - 1)))
        tail += '\\';
      if (!isAbsolute && device === undefined && StringPrototypeIncludes(path, ':')) {
        if (tail.length >= 2 &&
            isWindowsDeviceRoot(StringPrototypeCharCodeAt(tail, 0)) &&
            StringPrototypeCharCodeAt(tail, 1) === CHAR_COLON) {
          return `.\\${tail}`;
        }
        let index = StringPrototypeIndexOf(path, ':');
        do {
          if (index === len - 1 || isPathSeparator(StringPrototypeCharCodeAt(path, index + 1))) {
            return `.\\${tail}`;
          }
        } while ((index = StringPrototypeIndexOf(path, ':', index + 1)) !== -1);
      }
      const colonIndex = StringPrototypeIndexOf(path, ':');
      if (isWindowsReservedName(path, colonIndex)) {
        return `.\\${device ?? ''}${tail}`;
      }
      if (device === undefined) {
        return isAbsolute ? `\\${tail}` : tail;
      }
      return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
    },
    isAbsolute(path: unknown): boolean {
      validateString(path, 'path');
      const len = path.length;
      if (len === 0)
        return false;
      const code = StringPrototypeCharCodeAt(path, 0);
      return isPathSeparator(code) ||
        (len > 2 &&
        isWindowsDeviceRoot(code) &&
        StringPrototypeCharCodeAt(path, 1) === CHAR_COLON &&
        isPathSeparator(StringPrototypeCharCodeAt(path, 2)));
    },
    join(...args: unknown[]): string {
      if (args.length === 0)
        return '.';
      const path: string[] = [];
      for (let i = 0; i < args.length; ++i) {
        const arg = args[i];
        validateString(arg, 'path');
        if (arg.length > 0) {
          ArrayPrototypePush(path, arg);
        }
      }
      if (path.length === 0)
        return '.';
      const firstPart = path[0] ?? '';
      let joined = ArrayPrototypeJoin(path, '\\');
      let needsReplace = true;
      let slashCount = 0;
      if (isPathSeparator(StringPrototypeCharCodeAt(firstPart, 0))) {
        ++slashCount;
        const firstLen = firstPart.length;
        if (firstLen > 1 &&
            isPathSeparator(StringPrototypeCharCodeAt(firstPart, 1))) {
          ++slashCount;
          if (firstLen > 2) {
            if (isPathSeparator(StringPrototypeCharCodeAt(firstPart, 2)))
              ++slashCount;
            else {
              needsReplace = false;
            }
          }
        }
      }
      if (needsReplace) {
        while (slashCount < joined.length &&
               isPathSeparator(StringPrototypeCharCodeAt(joined, slashCount))) {
          slashCount++;
        }
        if (slashCount >= 2)
          joined = `\\${StringPrototypeSlice(joined, slashCount)}`;
      }
      const parts = [];
      let part = '';
      for (let i = 0; i < joined.length; i++) {
        if (joined.charAt(i) === '\\') {
          if (part) parts.push(part);
          part = '';
          while (i + 1 < joined.length && joined.charAt(i + 1) === '\\') i++;
        } else {
          part += joined.charAt(i);
        }
      }
      if (part) parts.push(part);
      if (parts.some((p) => {
        const colonIndex = StringPrototypeIndexOf(p, ':');
        return colonIndex !== -1 && isWindowsReservedName(p, colonIndex);
      })) {
        let result = '';
        for (let i = 0; i < joined.length; i++) {
          result += joined.charAt(i) === '/' ? '\\' : joined.charAt(i);
        }
        return result;
      }
      return win32.normalize(joined);
    },
    relative(fromInput: unknown, toInput: unknown): string {
      validateString(fromInput, 'from');
      validateString(toInput, 'to');
      let from: string = fromInput;
      let to: string = toInput;
      if (from === to)
        return '';
      const fromOrig = win32.resolve(from);
      const toOrig = win32.resolve(to);
      if (fromOrig === toOrig)
        return '';
      from = StringPrototypeToLowerCase(fromOrig);
      to = StringPrototypeToLowerCase(toOrig);
      if (from === to)
        return '';
      if (fromOrig.length !== from.length || toOrig.length !== to.length) {
        const fromSplit = StringPrototypeSplit(fromOrig, '\\');
        const toSplit = StringPrototypeSplit(toOrig, '\\');
        if (fromSplit[fromSplit.length - 1] === '') {
          fromSplit.pop();
        }
        if (toSplit[toSplit.length - 1] === '') {
          toSplit.pop();
        }
        const fromLen = fromSplit.length;
        const toLen = toSplit.length;
        const length = fromLen < toLen ? fromLen : toLen;
        let i: number;
        for (i = 0; i < length; i++) {
          if (StringPrototypeToLowerCase(fromSplit[i] ?? '') !== StringPrototypeToLowerCase(toSplit[i] ?? '')) {
            break;
          }
        }
        if (i === 0) {
          return toOrig;
        } else if (i === length) {
          if (toLen > length) {
            return ArrayPrototypeJoin(ArrayPrototypeSlice(toSplit, i), '\\');
          }
          if (fromLen > length) {
            return StringPrototypeRepeat('..\\', fromLen - 1 - i) + '..';
          }
          return '';
        }
        return StringPrototypeRepeat('..\\', fromLen - i) + ArrayPrototypeJoin(ArrayPrototypeSlice(toSplit, i), '\\');
      }
      let fromStart = 0;
      while (fromStart < from.length &&
             StringPrototypeCharCodeAt(from, fromStart) === CHAR_BACKWARD_SLASH) {
        fromStart++;
      }
      let fromEnd = from.length;
      while (
        fromEnd - 1 > fromStart &&
        StringPrototypeCharCodeAt(from, fromEnd - 1) === CHAR_BACKWARD_SLASH
      ) {
        fromEnd--;
      }
      const fromLen = fromEnd - fromStart;
      let toStart = 0;
      while (toStart < to.length &&
             StringPrototypeCharCodeAt(to, toStart) === CHAR_BACKWARD_SLASH) {
        toStart++;
      }
      let toEnd = to.length;
      while (toEnd - 1 > toStart &&
             StringPrototypeCharCodeAt(to, toEnd - 1) === CHAR_BACKWARD_SLASH) {
        toEnd--;
      }
      const toLen = toEnd - toStart;
      const length = fromLen < toLen ? fromLen : toLen;
      let lastCommonSep = -1;
      let i = 0;
      for (; i < length; i++) {
        const fromCode = StringPrototypeCharCodeAt(from, fromStart + i);
        if (fromCode !== StringPrototypeCharCodeAt(to, toStart + i))
          break;
        else if (fromCode === CHAR_BACKWARD_SLASH)
          lastCommonSep = i;
      }
      if (i !== length) {
        if (lastCommonSep === -1)
          return toOrig;
      } else {
        if (toLen > length) {
          if (StringPrototypeCharCodeAt(to, toStart + i) ===
              CHAR_BACKWARD_SLASH) {
            return StringPrototypeSlice(toOrig, toStart + i + 1);
          }
          if (i === 2) {
            return StringPrototypeSlice(toOrig, toStart + i);
          }
        }
        if (fromLen > length) {
          if (StringPrototypeCharCodeAt(from, fromStart + i) ===
              CHAR_BACKWARD_SLASH) {
            lastCommonSep = i;
          } else if (i === 2) {
            lastCommonSep = 3;
          }
        }
        if (lastCommonSep === -1)
          lastCommonSep = 0;
      }
      let out = '';
      for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
        if (i === fromEnd ||
            StringPrototypeCharCodeAt(from, i) === CHAR_BACKWARD_SLASH) {
          out += out.length === 0 ? '..' : '\\..';
        }
      }
      toStart += lastCommonSep;
      if (out.length > 0)
        return `${out}${StringPrototypeSlice(toOrig, toStart, toEnd)}`;
      if (StringPrototypeCharCodeAt(toOrig, toStart) === CHAR_BACKWARD_SLASH)
        ++toStart;
      return StringPrototypeSlice(toOrig, toStart, toEnd);
    },
    toNamespacedPath: (path: unknown): unknown => {
      if (typeof path !== 'string' || path.length === 0)
        return path;
      const resolvedPath = win32.resolve(path);
      if (resolvedPath.length <= 2)
        return path;
      if (StringPrototypeCharCodeAt(resolvedPath, 0) === CHAR_BACKWARD_SLASH) {
        if (StringPrototypeCharCodeAt(resolvedPath, 1) === CHAR_BACKWARD_SLASH) {
          const code = StringPrototypeCharCodeAt(resolvedPath, 2);
          if (code !== CHAR_QUESTION_MARK && code !== CHAR_DOT) {
            return `\\\\?\\UNC\\${StringPrototypeSlice(resolvedPath, 2)}`;
          }
        }
      } else if (
        isWindowsDeviceRoot(StringPrototypeCharCodeAt(resolvedPath, 0)) &&
        StringPrototypeCharCodeAt(resolvedPath, 1) === CHAR_COLON &&
        StringPrototypeCharCodeAt(resolvedPath, 2) === CHAR_BACKWARD_SLASH
      ) {
        return `\\\\?\\${resolvedPath}`;
      }
      return resolvedPath;
    },
    dirname(path: unknown): string {
      validateString(path, 'path');
      const len = path.length;
      if (len === 0)
        return '.';
      let rootEnd = -1;
      let offset = 0;
      const code = StringPrototypeCharCodeAt(path, 0);
      if (len === 1) {
        return isPathSeparator(code) ? path : '.';
      }
      if (isPathSeparator(code)) {
        rootEnd = offset = 1;
        if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
          let j = 2;
          let last = j;
          while (j < len &&
                 !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
            j++;
          }
          if (j < len && j !== last) {
            last = j;
            while (j < len &&
                   isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
              j++;
            }
            if (j < len && j !== last) {
              last = j;
              while (j < len &&
                     !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
                j++;
              }
              if (j === len) {
                return path;
              }
              if (j !== last) {
                rootEnd = offset = j + 1;
              }
            }
          }
        }
      } else if (isWindowsDeviceRoot(code) &&
                 StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
        rootEnd =
          len > 2 && isPathSeparator(StringPrototypeCharCodeAt(path, 2)) ? 3 : 2;
        offset = rootEnd;
      }
      let end = -1;
      let matchedSlash = true;
      for (let i = len - 1; i >= offset; --i) {
        if (isPathSeparator(StringPrototypeCharCodeAt(path, i))) {
          if (!matchedSlash) {
            end = i;
            break;
          }
        } else {
          matchedSlash = false;
        }
      }
      if (end === -1) {
        if (rootEnd === -1)
          return '.';
        end = rootEnd;
      }
      return StringPrototypeSlice(path, 0, end);
    },
    basename(path: unknown, suffix?: unknown): string {
      if (suffix !== undefined)
        validateString(suffix, 'suffix');
      validateString(path, 'path');
      let start = 0;
      let end = -1;
      let matchedSlash = true;
      if (path.length >= 2 &&
          isWindowsDeviceRoot(StringPrototypeCharCodeAt(path, 0)) &&
          StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
        start = 2;
      }
      if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
        if (suffix === path)
          return '';
        let extIdx = suffix.length - 1;
        let firstNonSlashEnd = -1;
        for (let i = path.length - 1; i >= start; --i) {
          const code = StringPrototypeCharCodeAt(path, i);
          if (isPathSeparator(code)) {
            if (!matchedSlash) {
              start = i + 1;
              break;
            }
          } else {
            if (firstNonSlashEnd === -1) {
              matchedSlash = false;
              firstNonSlashEnd = i + 1;
            }
            if (extIdx >= 0) {
              if (code === StringPrototypeCharCodeAt(suffix, extIdx)) {
                if (--extIdx === -1) {
                  end = i;
                }
              } else {
                extIdx = -1;
                end = firstNonSlashEnd;
              }
            }
          }
        }
        if (start === end)
          end = firstNonSlashEnd;
        else if (end === -1)
          end = path.length;
        return StringPrototypeSlice(path, start, end);
      }
      for (let i = path.length - 1; i >= start; --i) {
        if (isPathSeparator(StringPrototypeCharCodeAt(path, i))) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else if (end === -1) {
          matchedSlash = false;
          end = i + 1;
        }
      }
      if (end === -1)
        return '';
      return StringPrototypeSlice(path, start, end);
    },
    extname(path: unknown): string {
      validateString(path, 'path');
      let start = 0;
      let startDot = -1;
      let startPart = 0;
      let end = -1;
      let matchedSlash = true;
      let preDotState = 0;
      if (path.length >= 2 &&
          StringPrototypeCharCodeAt(path, 1) === CHAR_COLON &&
          isWindowsDeviceRoot(StringPrototypeCharCodeAt(path, 0))) {
        start = startPart = 2;
      }
      for (let i = path.length - 1; i >= start; --i) {
        const code = StringPrototypeCharCodeAt(path, i);
        if (isPathSeparator(code)) {
          if (!matchedSlash) {
            startPart = i + 1;
            break;
          }
          continue;
        }
        if (end === -1) {
          matchedSlash = false;
          end = i + 1;
        }
        if (code === CHAR_DOT) {
          if (startDot === -1)
            startDot = i;
          else if (preDotState !== 1)
            preDotState = 1;
        } else if (startDot !== -1) {
          preDotState = -1;
        }
      }
      if (startDot === -1 ||
          end === -1 ||
          preDotState === 0 ||
          (preDotState === 1 &&
           startDot === end - 1 &&
           startDot === startPart + 1)) {
        return '';
      }
      return StringPrototypeSlice(path, startDot, end);
    },
    format,
    parse(path: unknown): ParsedPath {
      validateString(path, 'path');
      const ret = { root: '', dir: '', base: '', ext: '', name: '' };
      if (path.length === 0)
        return ret;
      const len = path.length;
      let rootEnd = 0;
      let code = StringPrototypeCharCodeAt(path, 0);
      if (len === 1) {
        if (isPathSeparator(code)) {
          ret.root = ret.dir = path;
          return ret;
        }
        ret.base = ret.name = path;
        return ret;
      }
      if (isPathSeparator(code)) {
        rootEnd = 1;
        if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
          let j = 2;
          let last = j;
          while (j < len &&
                 !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
            j++;
          }
          if (j < len && j !== last) {
            last = j;
            while (j < len &&
                   isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
              j++;
            }
            if (j < len && j !== last) {
              last = j;
              while (j < len &&
                     !isPathSeparator(StringPrototypeCharCodeAt(path, j))) {
                j++;
              }
              if (j === len) {
                rootEnd = j;
              } else if (j !== last) {
                rootEnd = j + 1;
              }
            }
          }
        }
      } else if (isWindowsDeviceRoot(code) &&
                 StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
        if (len <= 2) {
          ret.root = ret.dir = path;
          return ret;
        }
        rootEnd = 2;
        if (isPathSeparator(StringPrototypeCharCodeAt(path, 2))) {
          if (len === 3) {
            ret.root = ret.dir = path;
            return ret;
          }
          rootEnd = 3;
        }
      }
      if (rootEnd > 0)
        ret.root = StringPrototypeSlice(path, 0, rootEnd);
      let startDot = -1;
      let startPart = rootEnd;
      let end = -1;
      let matchedSlash = true;
      let i = path.length - 1;
      let preDotState = 0;
      for (; i >= rootEnd; --i) {
        code = StringPrototypeCharCodeAt(path, i);
        if (isPathSeparator(code)) {
          if (!matchedSlash) {
            startPart = i + 1;
            break;
          }
          continue;
        }
        if (end === -1) {
          matchedSlash = false;
          end = i + 1;
        }
        if (code === CHAR_DOT) {
          if (startDot === -1)
            startDot = i;
          else if (preDotState !== 1)
            preDotState = 1;
        } else if (startDot !== -1) {
          preDotState = -1;
        }
      }
      if (end !== -1) {
        if (startDot === -1 ||
            preDotState === 0 ||
            (preDotState === 1 &&
             startDot === end - 1 &&
             startDot === startPart + 1)) {
          ret.base = ret.name = StringPrototypeSlice(path, startPart, end);
        } else {
          ret.name = StringPrototypeSlice(path, startPart, startDot);
          ret.base = StringPrototypeSlice(path, startPart, end);
          ret.ext = StringPrototypeSlice(path, startDot, end);
        }
      }
      if (startPart > 0 && startPart !== rootEnd)
        ret.dir = StringPrototypeSlice(path, 0, startPart - 1);
      else
        ret.dir = ret.root;
      return ret;
    },
    matchesGlob: (path: unknown, pattern: unknown): boolean => {
      return matchGlob(path, pattern, true, inspect);
    },
    sep: '\\',
    delimiter: ';',
  };
  return win32;
}
