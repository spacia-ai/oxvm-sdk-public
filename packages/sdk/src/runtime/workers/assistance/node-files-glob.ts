/*!
 * `fs.glob`, `fs.globSync` and `fs.promises.glob`, adapted from Node.js v24.18.1 lib/internal/fs/glob.js. Node keeps
 * two copies of the walk, one synchronous and one asynchronous; here one walk asks for each file system answer and is
 * driven either way, so the two forms visit and report in the same order, as Node's do.
 * Copyright Node.js contributors. All rights reserved. MIT License: see node-files-dir.ts for the full text.
 */
import { Dirent } from "./node-file-operations.js";
import type { FileScheduling } from "./node-files-args.ts";
import { compileGlob, GLOBSTAR, matchesGlob, type GlobPart } from "./node-files-glob-pattern.ts";
import { createNodePath } from "./node-path.js";
import { fileURLToPath } from "./node-url.js";
import { invalidInstance, invalidType, named, validateBoolean, validateFunction, validateObject, validateString } from "./node-util-validators.ts";

/** A `Stats` of either kind; the mode says what the path is. */
interface Status { readonly mode: number | bigint; isDirectory(): boolean }
/** The runtime's `lstat`, `stat`, `realpath` and `readdir` (with file types), in both forms. */
export interface GlobPorts extends FileScheduling {
  readonly lstatSync: (path: string) => Status;
  readonly statSync: (path: string) => Status;
  readonly realpathSync: (path: string) => string;
  readonly readdirSync: (path: string, options: { readonly withFileTypes: true }) => unknown;
  readonly lstat: (path: string) => Promise<Status>;
  readonly stat: (path: string) => Promise<Status>;
  readonly realpath: (path: string) => Promise<string>;
  readonly readdir: (path: string, options: { readonly withFileTypes: true }) => Promise<unknown>;
  readonly cwd: () => string;
  readonly context?: { capture(): <Result>(callback: () => Result) => Result };
}

type Request = { readonly kind: "lstat" | "stat" | "realpath" | "readdir"; readonly path: string };
/** What a request is answered with: a failed one is `null`, and a failed listing is empty. */
type Reply = Status | string | readonly Dirent[] | null;
type Walk<Result> = Generator<Request, Result, Reply>;

class Pattern {
  readonly last: number;
  constructor(private readonly parts: readonly GlobPart[], private readonly strings: readonly string[], readonly indexes: ReadonlySet<number>, readonly symlinks: ReadonlySet<number>,
    readonly realpaths: ReadonlySet<string> = new Set()) { this.last = parts.length - 1; }
  isLast(isDirectory: boolean): boolean {
    return this.indexes.has(this.last) || (this.at(-1) === "" && isDirectory && this.indexes.has(this.last - 1) && this.at(-2) === GLOBSTAR);
  }
  isFirst(): boolean { return this.indexes.has(0); }
  get hasSeenSymlinks(): boolean { return [...this.indexes].some(index => !this.symlinks.has(index)); }
  at(index: number): GlobPart | undefined { return this.parts.at(index); }
  child(indexes: ReadonlySet<number>, symlinks: ReadonlySet<number> = new Set(), realpaths: ReadonlySet<string> = this.realpaths): Pattern {
    return new Pattern(this.parts, this.strings, indexes, symlinks, realpaths);
  }
  test(index: number, name: string): boolean {
    const part = this.parts[index];
    if (part === GLOBSTAR) return true;
    if (typeof part === "string") return part === name;
    return part !== undefined && part.test(name);
  }
  cacheKey(index: number): string { return this.strings.slice(index).join("/"); }
}
const only = (index: number): Set<number> => new Set([index]);

interface Found { readonly path: string; readonly entry: Dirent | null }
interface GlobOptions {
  readonly root: unknown; readonly followSymlinks: boolean; readonly withFileTypes: boolean;
  readonly excluded: (path: string) => boolean; readonly exclude: ((value: unknown) => boolean) | undefined; readonly patterns: readonly Pattern[];
}

export interface NodeGlob {
  readonly glob: (pattern: unknown, options: unknown, callback: unknown) => void;
  readonly globSync: (pattern: unknown, options: unknown) => unknown[];
  readonly promises: { readonly glob: (pattern: unknown, options: unknown) => AsyncGenerator<unknown, void, undefined> };
}

export function createNodeGlob(ports: GlobPorts): NodeGlob {
  const path = createNodePath(ports.cwd);
  /** `path.resolve(root, value)`, where Node first meets a `cwd` that is not a string. */
  const resolve = (root: unknown, value: string): string => {
    if (typeof root !== "string") throw invalidType("paths[0]", "string", root);
    return path.resolve(root, value);
  };
  const direntOf = (status: Status, at: string): Dirent => new Dirent(path.basename(at), (Number(status.mode) & 0o170000) >>> 12, path.dirname(at));

  /** Node's `Glob` constructor: the options, then the exclusions, then the patterns. */
  function settings(pattern: unknown, input: unknown): GlobOptions {
    const options = input === undefined ? {} : input;
    validateObject(options, "options");
    const exclude: unknown = Reflect.get(options, "exclude"), cwd: unknown = Reflect.get(options, "cwd"), follow: unknown = Reflect.get(options, "followSymlinks");
    const root: unknown = (cwd instanceof URL ? fileURLToPath(cwd) : cwd) ?? ".";
    if (follow !== null && follow !== undefined) validateBoolean(follow, "options.followSymlinks");
    let excluded: GlobOptions["excluded"] = () => false, test: GlobOptions["exclude"];
    if (exclude !== null && exclude !== undefined) {
      if (Array.isArray(exclude)) {
        const list = exclude.map((item: unknown, index) => { if (typeof item !== "string") throw invalidType(`options.exclude[${String(index)}]`, "string", item); return item; });
        const absolute = list.map(item => resolve(root, item));
        excluded = value => absolute.some(item => matchesGlob(value, item));
      } else if (typeof exclude === "function") test = value => Boolean(Reflect.apply(exclude, undefined, [value]));
      else throw invalidType("options.exclude", "function or string[]", exclude);
    }
    let globs: string[];
    if (typeof pattern === "object") {
      if (!Array.isArray(pattern)) throw invalidInstance("patterns", "Array", pattern);
      globs = pattern.map((item: unknown, index) => { if (typeof item !== "string") throw invalidType(`patterns[${String(index)}]`, "string", item); return item; });
    } else { validateString(pattern, "patterns"); globs = [pattern]; }
    const patterns = globs.flatMap(glob => compileGlob(glob).map(set => new Pattern(set.parts, set.strings, only(0), new Set())));
    return { root, followSymlinks: follow === true, withFileTypes: Boolean(Reflect.get(options, "withFileTypes")), excluded, exclude: test, patterns };
  }

  /** One glob. `entries` says whether each result carries the entry it was found as (the asynchronous form with file
   * types); the walk reports through `found` and asks the file system through its requests. */
  function walker(options: GlobOptions, entries: boolean) {
    const { root, followSymlinks, withFileTypes, excluded, exclude } = options;
    const seenKeys = new Map<string, Set<string>>(), stats = new Map<string, Dirent | null>(), followed = new Map<string, Status | null>();
    const listings = new Map<string, readonly Dirent[]>(), reals = new Map<string, string | null>();
    const results = new Set<string>(), found: Found[] = [];
    let subpatterns = new Map<string, Pattern[]>();

    function* lstat(at: string): Walk<Dirent | null> {
      const cached = stats.get(at);
      if (cached !== undefined) return cached;
      const reply = yield { kind: "lstat", path: at };
      const entry = reply !== null && typeof reply === "object" && "mode" in reply ? direntOf(reply, at) : null;
      stats.set(at, entry);
      return entry;
    }
    function* followStat(at: string): Walk<Status | null> {
      const cached = followed.get(at);
      if (cached !== undefined) return cached;
      const reply = yield { kind: "stat", path: at };
      const status = reply !== null && typeof reply === "object" && "mode" in reply ? reply : null;
      followed.set(at, status);
      return status;
    }
    function* realpath(at: string): Walk<string | null> {
      const cached = reals.get(at);
      if (cached !== undefined) return cached;
      const reply = yield { kind: "realpath", path: at };
      const real = typeof reply === "string" ? reply : null;
      reals.set(at, real);
      return real;
    }
    function* readdir(at: string): Walk<readonly Dirent[]> {
      const cached = listings.get(at);
      if (cached !== undefined) return cached;
      const reply = yield { kind: "readdir", path: at };
      const listed = typeof reply === "object" && reply !== null && !("mode" in reply) ? reply : [];
      listings.set(at, listed);
      return listed;
    }
    /** Node's `Cache.add`: true when the path has already been walked for every position of the pattern. */
    function visited(at: string, pattern: Pattern): boolean {
      let keys = seenKeys.get(at);
      if (keys === undefined) { keys = new Set(); seenKeys.set(at, keys); }
      const before = keys.size;
      for (const index of pattern.indexes) keys.add(pattern.cacheKey(index));
      return keys.size !== before + pattern.indexes.size;
    }
    const seen = (at: string, pattern: Pattern, index: number): boolean => seenKeys.get(at)?.has(pattern.cacheKey(index)) === true;
    /** Adds a result once, unless the exclusion list matches it. */
    function report(at: string, entry: Dirent | null): void {
      if (results.has(at) || excluded(resolve(root, at))) return;
      results.add(at); found.push({ path: at, entry });
    }

    function* isDirectory(at: string, status: Dirent | null, pattern: Pattern): Walk<boolean> {
      if (status?.isDirectory() === true) return true;
      if (status?.isSymbolicLink() !== true) return false;
      if (followSymlinks) return (yield* followStat(at))?.isDirectory() === true;
      return pattern.hasSeenSymlinks;
    }
    function* addSubpattern(at: string, pattern: Pattern): Walk<void> {
      if (excluded(at)) return;
      const full = resolve(root, at);
      // A directory is also tested with a trailing slash.
      if (excluded(`${full}/`) && (yield* lstat(full))?.isDirectory() === true) return;
      if (exclude !== undefined) {
        if (withFileTypes) {
          const status = yield* lstat(at);
          if (status !== null && exclude(status)) return;
        } else if (exclude(at)) return;
      }
      const waiting = subpatterns.get(at);
      if (waiting === undefined) subpatterns.set(at, [pattern]); else waiting.push(pattern);
    }

    function* addSubpatterns(at: string, pattern: Pattern): Walk<void> {
      if (visited(at, pattern)) return;
      const full = resolve(root, at), status = yield* lstat(full), last = pattern.last;
      const directory = yield* isDirectory(full, status, pattern), isLast = pattern.isLast(directory), isFirst = pattern.isFirst();
      if (excluded(full)) return;
      const first = pattern.at(0);
      // An absolute pattern starts at the root, `..` at the parent and `.` here.
      if (isFirst && first === "") { yield* addSubpattern("/", pattern.child(only(1))); return; }
      if (isFirst && first === "..") { yield* addSubpattern("../", pattern.child(only(1))); return; }
      if (isFirst && first === ".") { yield* addSubpattern(".", pattern.child(only(1))); return; }
      const final = pattern.at(-1);
      if (isLast && typeof final === "string") {
        const target = yield* lstat(path.join(full, final));
        if (target !== null && (final !== "" || directory)) report(path.join(at, final), target);
        if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
      } else if (isLast && final === GLOBSTAR && (at !== "." || first === "." || (last === 0 && status !== null))) {
        // A pattern ending in `**` matches the directory itself; `.` only for `**` alone or a pattern starting with `.`.
        report(at, status);
      }
      if (!directory) return;
      const real = followSymlinks ? yield* realpath(full) : null;
      if (real !== null && pattern.realpaths.has(real)) return;
      const nextRealpaths = real === null ? pattern.realpaths : new Set([...pattern.realpaths, real]);
      let children: readonly Dirent[];
      const single = pattern.indexes.size === 1 ? pattern.at([...pattern.indexes][0] ?? 0) : undefined;
      if (typeof single === "string") {
        // A literal name is looked up directly instead of listing the directory.
        const child = yield* lstat(path.join(full, single));
        if (child === null) return;
        Reflect.set(child, "name", single);
        children = [child];
      } else children = yield* readdir(full);
      for (const entry of children) {
        const entryPath = path.join(at, entry.name), entryFull = path.join(full, entry.name);
        stats.set(entryFull, entry);
        const entryIsDirectory = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink() && (yield* followStat(entryFull))?.isDirectory() === true);
        const next = new Set<number>(), nextSymlinks = new Set<number>();
        for (const index of pattern.indexes) {
          if (seen(entryPath, pattern, index) || seen(entryPath, pattern, index + 1)) return;
          const current = pattern.at(index), nextIndex = index + 1, following = pattern.at(nextIndex);
          const fromSymlink = !followSymlinks && pattern.symlinks.has(index);
          if (current === GLOBSTAR) {
            const isDot = entry.name.startsWith("."), nextMatches = pattern.test(nextIndex, entry.name);
            let afterGlobstars = nextIndex;
            while (pattern.at(afterGlobstars) === GLOBSTAR) afterGlobstars++;
            if ((isDot && !pattern.test(afterGlobstars, entry.name)) || (exclude !== undefined && exclude(withFileTypes ? entry : entry.name))) continue;
            if (!fromSymlink && entryIsDirectory) next.add(index);
            else if (!fromSymlink && index === last) report(entryPath, entry);
            // What follows `**` may match this entry already.
            if (nextMatches && nextIndex === last && !isLast) report(entryPath, entry);
            else if (nextMatches && entryIsDirectory) next.add(index + 2);
            if ((nextMatches || first === ".") && (entryIsDirectory || entry.isSymbolicLink()) && !fromSymlink) next.add(nextIndex);
            if (!followSymlinks && entry.isSymbolicLink()) nextSymlinks.add(index);
            if (following === ".." && entryIsDirectory) {
              // `**/..`: this directory and its parent both continue, or are results when `..` ends the pattern.
              const above = path.join(at, "..");
              if (nextIndex < last) {
                if (!subpatterns.has(at) && !seen(at, pattern, nextIndex + 1)) subpatterns.set(at, [pattern.child(only(nextIndex + 1))]);
                if (!subpatterns.has(above) && !seen(above, pattern, nextIndex + 1)) subpatterns.set(above, [pattern.child(only(nextIndex + 1))]);
              } else {
                if (!seen(at, pattern, nextIndex)) {
                  visited(at, pattern.child(only(nextIndex)));
                  if (!results.has(at)) report(at, entries && withFileTypes ? yield* lstat(full) : null);
                }
                if (!seen(at, pattern, nextIndex) || !seen(above, pattern, nextIndex)) {
                  visited(above, pattern.child(only(nextIndex)));
                  if (!results.has(above)) report(above, entries && withFileTypes ? yield* lstat(path.join(typeof root === "string" ? root : ".", above)) : null);
                }
              }
            }
          }
          if (typeof current === "string") {
            if (pattern.test(index, entry.name) && index !== last) next.add(nextIndex);
            else if (current === "." && pattern.test(nextIndex, entry.name)) {
              if (nextIndex === last) report(entryPath, entry); else next.add(nextIndex + 1);
            }
          }
          if (typeof current === "object" && pattern.test(index, entry.name)) {
            if (index === last) report(entryPath, entry);
            else if (entryIsDirectory) next.add(nextIndex);
          }
        }
        if (next.size > 0) yield* addSubpattern(entryPath, pattern.child(next, nextSymlinks, nextRealpaths));
      }
    }
    function* run(): Walk<void> {
      const queue: { readonly path: string; readonly patterns: readonly Pattern[] }[] = [{ path: ".", patterns: options.patterns }];
      for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
        for (const pattern of item.patterns) yield* addSubpatterns(item.path, pattern);
        for (const [at, patterns] of subpatterns) queue.push({ path: at, patterns });
        subpatterns = new Map();
      }
    }
    /** The synchronous form's entries: each result is examined again by its path under the root, as Node does. */
    function* typed(): Walk<(Dirent | null)[]> {
      const list: (Dirent | null)[] = [];
      for (const item of found) list.push(yield* lstat(path.isAbsolute(item.path) ? item.path : path.join(typeof root === "string" ? root : ".", item.path)));
      return list;
    }
    return { run, typed, found };
  }

  const listed = (value: unknown): readonly Dirent[] => Array.isArray(value) ? value.filter((entry: unknown): entry is Dirent => entry instanceof Dirent) : [];
  function answerSync(request: Request): Reply {
    try {
      switch (request.kind) {
        case "lstat": return ports.lstatSync(request.path);
        case "stat": return ports.statSync(request.path);
        case "realpath": return ports.realpathSync(request.path);
        case "readdir": return listed(ports.readdirSync(request.path, { withFileTypes: true }));
      }
    } catch { return request.kind === "readdir" ? [] : null; }
  }
  async function answer(request: Request): Promise<Reply> {
    try {
      switch (request.kind) {
        case "lstat": return await ports.lstat(request.path);
        case "stat": return await ports.stat(request.path);
        case "realpath": return await ports.realpath(request.path);
        case "readdir": return listed(await ports.readdir(request.path, { withFileTypes: true }));
      }
    } catch { return request.kind === "readdir" ? [] : null; }
  }
  function drive<Result>(walk: Walk<Result>): Result {
    let step = walk.next();
    while (step.done !== true) step = walk.next(answerSync(step.value));
    return step.value;
  }
  async function* iterate(options: GlobOptions): AsyncGenerator<unknown, void, undefined> {
    const walk = walker(options, true), run = walk.run();
    let step = run.next();
    for (;;) {
      for (let item = walk.found.shift(); item !== undefined; item = walk.found.shift()) yield options.withFileTypes ? item.entry : item.path;
      if (step.done === true) return;
      step = run.next(await answer(step.value));
    }
  }

  const globSync = named(function (pattern: unknown, options: unknown): unknown[] {
    const selected = settings(pattern, options), walk = walker(selected, false);
    drive(walk.run());
    return selected.withFileTypes ? drive(walk.typed()) : walk.found.map(item => item.path);
  }, "globSync");
  const promised = named(async function* (pattern: unknown, options: unknown): AsyncGenerator<unknown, void, undefined> {
    yield* iterate(settings(pattern, options));
  }, "glob");
  const glob = named(function (pattern: unknown, options: unknown, callback: unknown): void {
    const done = typeof options === "function" ? options : callback;
    validateFunction(done, "cb");
    const selected = settings(pattern, typeof options === "function" ? undefined : options);
    const release = ports.retain(), run = ports.context?.capture() ?? (<Result>(inner: () => Result): Result => inner());
    const finish = (args: unknown[]): void => { ports.dispatch(() => { release(); run(() => { Reflect.apply(done, undefined, args); }); }); };
    const collect = async (): Promise<unknown[]> => { const list: unknown[] = []; for await (const item of iterate(selected)) list.push(item); return list; };
    collect().then(list => { finish([null, list]); }, (error: unknown) => { finish([error]); });
  }, "glob");
  return { glob, globSync, promises: { glob: promised } };
}
