import { bootUserspaceRuntimeVM, createUserspaceRuntimeVM, decodeUserspaceProfileOptions, type BootedUserspaceRuntimeVM } from "./userspace-vm.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { BrowserAssistance } from "./browser-assistance.js";
import { validateRuntimeVMOptions } from "./vm-options.js";
import { decodeJitInstallOption } from "./jit-install-option.js";
import { decodeJitTierOption } from "./jit-tier-option.js";
import { VMError } from "./errors.js";
import { ORIGIN_STORAGE } from "./storage-scope.js";
import { openDurableOrTemporary } from "./workspace-lease.js";
import { newEphemeralWorkspaceId } from "./workspace-path.js";
import type { ManagedImageBootOptions, RuntimeVMOptions, RuntimeVM } from "./vm-types.js";
export type { NetworkState, RelayConnectionOptions, RelayFailureReason, VMNetwork } from "./network-types.js";
export { VMError } from "./errors.js";
export { acquireLocalDataLease } from "./local-data.js";
export { detectBrowserSupport, MINIMUM_BROWSERS } from "./browser-support.js";
export type { BrowserFeature, BrowserSupport, MinimumBrowser } from "./browser-support.js";
export { decodeSystemTraceSnapshot } from "./protocol.js";
export type { VMErrorCode } from "./errors.js";
export type {
  CoreCpuState,
  CoreException,
  CoreProbeExit,
  CoreProbeResult,
  SystemExecutionEvent,
  SystemProbeResult,
  SystemRuntimeStats,
  SystemSliceResult,
  SystemTraceCpu,
  SystemTraceEvent,
  SystemTraceInstruction,
  SystemTraceProfile,
  SystemTraceRegisters,
  SystemTraceSnapshot,
  RuntimeVMCapabilities,
  WorkspaceEntry,
  PreparedManagedImage,
  SnapshotRef,
} from "./protocol.js";
export type {
  ManagedImageArtifact,
  ManagedImageChunk,
  ManagedImageManifest,
} from "./managed-image.js";
export type { SystemExecution } from "./system-execution.js";
export type { Workspace } from "./workspace.js";
export type {
  WorkspaceFileEntry, WorkspaceFile, WorkspaceChange, WorkspaceWatch, WorkspaceReadOptions, WorkspaceWriteOptions, WorkspaceOperationOptions, WorkspaceWatchOptions,
} from "./workspace-files.js";
export { requestWorkspaceHandoff } from "./workspace-handoff.js";
export { describeSnapshotError } from "./snapshot-errors.js";
export { backupFileName } from "./backup-file-name.js";
export type { WorkspaceHandoffOptions, WorkspaceHandoffResult, WorkspaceMovedAway } from "./workspace-handoff.js";
export type {
  AutoSaveHint,
  AutoSavePolicy,
  BackupExportResult,
  BackupInspection,
  BackupOptions,
  BackupProgress,
  SnapshotCompatibility,
  ManagedBootReason,
  ManagedResume,
  ManagedStart,
  ResumedTerminal,
  ResumedWorkspaceState,
  SnapshotEvent,
  SnapshotInfo,
  SnapshotKind,
  SnapshotRestoreOptions,
  SnapshotRestoreResult,
  SnapshotResumability,
  ShippedSkipReason,
  SnapshotUsage,
  StartProgress,
  RuntimeVMAutoSave,
  RuntimeVMSnapshots,
} from "./snapshot-types.js";

export type { AssistanceOptions, BuildScriptApprovalRequest, DependencyInstallHandle, DependencyPreparationOptions, ProcessExecution, RuntimeMode, NetworkMode, UserspaceLimitsOptions, RuntimeVMOptions, SpawnSpec, ProcessHandle, PreviewHandle, PreviewIsolation, ListeningPort, ManagedImageInfo, ManagedImageBootOptions, SystemBootSpec, RuntimeVMDiagnostics, RuntimeVM } from "./vm-types.js";
export { validateRuntimeVMOptions } from "./vm-options.js";
export { isPreviewSessionOrigin } from "./preview-session.js";

export async function createRuntimeVM(options: RuntimeVMOptions): Promise<RuntimeVM> {
  const profileOptions = decodeUserspaceProfileOptions(options);
  const jitInstall = decodeJitInstallOption(options);
  const jitTier = decodeJitTierOption(options);
  const validated = validateRuntimeVMOptions(options);
  const create = (selected: RuntimeVMOptions) => createValidatedRuntimeVM(selected, profileOptions, jitInstall, jitTier);
  if (validated.ephemeral === true || validated.workspaceInUse !== "temporary") return create(validated);
  return openDurableOrTemporary(validated.storage ?? ORIGIN_STORAGE, validated.workspaceId, temporary => create(temporary ? onTemporaryRuntimeWorkspace(validated) : validated));
}

/** Starts a managed Userspace image on a new VM. The callback receives the initialized VM before guest execution. */
export async function createManagedUserspaceRuntimeVM(
  options: Extract<RuntimeVMOptions, { mode: "userspace" }>,
  manifestUrl: string | URL,
  bootOptions: ManagedImageBootOptions,
  onCreated?: (vm: RuntimeVM) => void,
): Promise<BootedUserspaceRuntimeVM> {
  const profile = decodeUserspaceProfileOptions(options);
  const jitInstall = decodeJitInstallOption(options);
  const jitTier = decodeJitTierOption(options);
  const validated = validateRuntimeVMOptions(options);
  if (validated.mode !== "userspace") throw new VMError("INVALID_ARGUMENT", "Managed Userspace startup requires Userspace mode");
  const create = (selected: typeof validated) => bootUserspaceRuntimeVM(selected, {
    manifestUrl, options: bootOptions, ...(onCreated === undefined ? {} : { onCreated }),
    closeFailure: (_failure, cleanup) => cleanup,
  }, profile, jitInstall, jitTier);
  if (validated.ephemeral === true || validated.workspaceInUse !== "temporary") return create(validated);
  return openDurableOrTemporary(validated.storage ?? ORIGIN_STORAGE, validated.workspaceId,
    temporary => create(temporary ? onTemporaryRuntimeWorkspace(validated) : validated));
}

/** The same VM on a new temporary workspace that saves nothing, because another VM holds the durable one. */
function onTemporaryRuntimeWorkspace(options: Extract<RuntimeVMOptions, { mode: "userspace" }>): Extract<RuntimeVMOptions, { mode: "userspace" }>;
function onTemporaryRuntimeWorkspace(options: RuntimeVMOptions): RuntimeVMOptions;
function onTemporaryRuntimeWorkspace(options: RuntimeVMOptions): RuntimeVMOptions {
  const temporary = { workspaceId: newEphemeralWorkspaceId(), ephemeral: true } as const;
  if (options.mode === "system") return { ...options, ...temporary };
  return { ...options, ...temporary, ...(options.rootPersistence === undefined ? {} : { rootPersistence: "ephemeral" }) };
}

async function createValidatedRuntimeVM(
  validated: RuntimeVMOptions,
  profileOptions: ReturnType<typeof decodeUserspaceProfileOptions>,
  jitInstall: ReturnType<typeof decodeJitInstallOption>,
  jitTier: ReturnType<typeof decodeJitTierOption>,
): Promise<RuntimeVM> {
  if (validated.mode === "userspace") {
    return createUserspaceRuntimeVM(validated, profileOptions, jitInstall, jitTier);
  }
  if (profileOptions !== undefined) {
    throw new VMError("INVALID_ARGUMENT", "Userspace profile options require Userspace mode");
  }
  if (jitTier !== undefined) throw new VMError("INVALID_ARGUMENT", "The JIT tier option requires Userspace mode");

  return createSystemRuntimeVM(validated, jitInstall, (control, options) => new BrowserAssistance(control, options));
}
