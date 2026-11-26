import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { lateFailureDetail, type LateFailure } from "../../js-process/late-failure.js";

/**
 * Rust mounts a launch's dependency folders as one read-only capture (ADR 0026), so Linux answers
 * a write into them, such as a new folder directly inside `node_modules`, with `EROFS`. The
 * program sees that error as it would on a read-only disk. The first such path is kept here: a
 * process that then ends in failure is reported by it, and the program's next run uses full Linux,
 * where the folders are writable.
 */
export function keepingDependencyWrites(): {
  sync(call: (operation: AssistanceOperation) => AssistanceResult): (operation: AssistanceOperation) => AssistanceResult;
  asynchronous(call: (operation: AssistanceOperation) => Promise<AssistanceResult>): (operation: AssistanceOperation) => Promise<AssistanceResult>;
  /** A refusal Linux answered outside those calls, such as a change of owner. */
  path(code: string, path: string): void;
  refused(): LateFailure | undefined;
} {
  let refused: LateFailure | undefined;
  const keep = (code: string, path: string | null | undefined): void => {
    if (refused === undefined && code === "EROFS" && path?.split("/").includes("node_modules") === true) refused = { kind: "read-only-dependencies", detail: lateFailureDetail(path) };
  };
  const note = (operation: AssistanceOperation, result: AssistanceResult): AssistanceResult => {
    if (result.kind === "error") keep(result.code, "path" in operation && typeof operation.path === "string" ? operation.path : result.path);
    return result;
  };
  return {
    sync: call => operation => note(operation, call(operation)),
    asynchronous: call => async operation => note(operation, await call(operation)),
    path: keep,
    refused: () => refused,
  };
}
