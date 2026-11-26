import { unavailableNodeApi } from "./node-capability.ts";
import { named } from "./node-util-validators.ts";

/** The size of this process's JavaScript heap as its engine measures it, in bytes. */
export interface ProcessHeap {
  readonly used: number;
  readonly total: number;
}

/** What `process.memoryUsage` takes from its process. Each port answers a measurement or nothing; no number is made up here. */
export interface ProcessMemoryPorts {
  /**
   * The text of a `/proc` file of the process's own Linux task, or undefined when Linux has none. A failure of the
   * read itself is thrown by the port and is not caught here.
   */
  readonly readProc: (path: string) => string | undefined;
  /**
   * The engine's measurement of this worker's heap. Measured in Chromium 156, Firefox 157 and WebKit 27.2: none of
   * them gives a dedicated worker one (`performance.memory` is a property of a window's `Performance` only, and
   * describes the page's heap, not a worker's), so a process is started without this port and `memoryUsage()` refuses.
   */
  readonly heap?: () => ProcessHeap | undefined;
}

function bytes(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

/**
 * Node's `process.memoryUsage` and `process.memoryUsage.rss`.
 *
 * `rss` is `VmRSS` of `/proc/self/status`: the resident set of the process's Linux task, the same quantity Node reads
 * from Linux. That task holds little of the program's JavaScript, whose heap is the browser's.
 *
 * `memoryUsage()` needs the heap as well and is refused (FEATURE_NOT_AVAILABLE, a late failure: the program's next
 * run uses Linux) when no heap source exists, which is every browser today. With one, `heapTotal` and `heapUsed` are
 * its measurements; `external` and `arrayBuffers` are 0 because nothing measures them, and these are the only two
 * fields that may hold a number nobody measured.
 */
export function createProcessMemory(ports: ProcessMemoryPorts) {
  function rss(): number {
    const lines = (ports.readProc("/proc/self/status") ?? "").split("\n").filter(line => line.startsWith("VmRSS:"));
    const kib = lines.length === 1 ? /^VmRSS:\s+(\d+) kB$/u.exec(lines[0] ?? "")?.[1] : undefined;
    const value = kib === undefined ? Number.NaN : Number(kib) * 1024;
    // A zombie or a kernel thread has no VmRSS line; an answer of 0 would be a claim Linux did not make.
    return bytes(value) ? value : unavailableNodeApi("process.memoryUsage.rss");
  }
  function memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number } {
    const heap = ports.heap?.();
    if (heap === undefined || !bytes(heap.used) || !bytes(heap.total) || heap.used > heap.total) return unavailableNodeApi("process.memoryUsage");
    // Node's key order. external and arrayBuffers: not measurable here (see above).
    return { rss: rss(), heapTotal: heap.total, heapUsed: heap.used, external: 0, arrayBuffers: 0 };
  }
  return { memoryUsage: Object.assign(named(memoryUsage, "memoryUsage"), { rss: named(rss, "rss") }) };
}
