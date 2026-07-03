#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import {
  BridgeCloudHttpError,
  BridgeCloudRequestTimeoutError,
  ConvexBridgeCloudClient,
  type BridgeHeartbeatInput,
  type BridgeQueueClaimInput,
  type BridgeQueueResult,
} from "./acp-bridge/convex-http";
import {
  AGENT_TOOL_GUIDE_RESOURCE,
  AGENT_TOOL_MCP_INPUT_SCHEMAS,
  AGENT_TOOL_MCP_TOOL_NAMES,
  AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
  buildAgentToolGuideText,
} from "./agent-tools-mcp";
import { ConvexBridgeHostAdapter } from "./acp-bridge/host-adapter";
import {
  openBridgeSupervisor,
  type BridgeSupervisor,
  type BridgeWatchdogResult,
} from "./acp-bridge/bridge-supervisor";
import {
  AcpBridgeProcessRegistry,
  type AcpBridgeProcessHealth,
} from "./acp-bridge/process-registry";
import {
  BridgeSingletonGuard,
  type BridgeSingletonStatus,
} from "./acp-bridge/local-singleton-guard";
import {
  createCompositeBridgeLogger,
  createWorkerBridgeLogger,
  type FlushableBridgeLogger,
  redactLogValue,
} from "./acp-bridge/bridge-log";
import { createLocalAuditBridgeLogger } from "./acp-bridge/local-audit-log";
import {
  DEFAULT_ACP_REQUEST_TIMEOUT_MS,
  HermesAcpSession,
  type HermesAcpMcpServer,
} from "./acp-bridge/acp-session";
import {
  buildBridgeLaunchSpec,
  type BridgeQueueAttachment,
  BridgeSessionManager,
  type BridgeSessionManagerStatus,
  type BridgeTerminalizationMetadata,
  DEFAULT_TOOL_RESULT_TIMEOUT_MS,
  type BridgeSessionQueueItem,
} from "./acp-bridge/session-manager";
import { codeAttributionFromUnknown } from "./acp-bridge/git-attribution";
import { discoverRuntimeProfiles as discoverBridgeRuntimeProfiles } from "./acp-bridge/runtime-discovery";
import {
  defaultAgentCommandForEnvironment,
  defaultProposedAgentName,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
  inferRuntimeId,
  inferRuntimeLabel,
} from "./acp-bridge/runtime-defaults";
import {
  synthesizeLegacyHermesProfile,
  type BridgeRuntimeProfile,
} from "./acp-bridge/runtime-profiles";
import { shouldRestartBridgeForDevHotReload } from "./acp-bridge/dev-hot-reload";
import { openBridgeJournal } from "./acp-bridge/sqlite-journal";
import { buildRestartCommandArgs } from "./bridge-updater";
import {
  deriveBridgeAvailability,
  classifyBridgeCloudFailure,
} from "./acp-bridge/bridge-availability";
import {
  DEFAULT_RUNTIME_CONFORMANCE_TTL_MS,
  runRuntimeConformance,
  shouldRefreshRuntimeConformanceProfile,
  summarizeRuntimeConformance,
  type RuntimeConformanceRecord,
  type RuntimeConformanceSummary,
} from "./acp-bridge/runtime-conformance";
import {
  DEFAULT_RUNTIME_CATALOG_CACHE_PATH,
  loadRuntimeCatalogCache,
  writeRuntimeCatalogCache,
} from "./acp-bridge/runtime-catalog-cache";
export {
  defaultAgentCommandForEnvironment,
  defaultProposedAgentName,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
  inferRuntimeId,
  inferRuntimeLabel,
} from "./acp-bridge/runtime-defaults";

const DEFAULT_CONFIG_PATH = join(homedir(), ".0000", "bridge.json");
const DEFAULT_STATUS_PATH = join(homedir(), ".0000", "bridge-status.json");
const DEFAULT_RESTART_HANDOFF_PATH = join(
  homedir(),
  ".0000",
  "restart-handoff.json",
);
const DEFAULT_JOURNAL_DIR = join(homedir(), ".0000", "bridge-journals");
const DEFAULT_PROCESS_REGISTRY_DIR = join(
  homedir(),
  ".0000",
  "bridge-processes",
);
const DEFAULT_PAIR_PATH = "/api/agent-bridge/pair";
const DEFAULT_CLAIM_PATH = "/api/agent-bridge/queue/claim";
const DEFAULT_CLEANUP_STALE_PATH = "/api/agent-bridge/queue/cleanup-stale";
const DEFAULT_RESULT_PATH = "/api/agent-bridge/queue/result";
const DEFAULT_HEARTBEAT_PATH = "/api/agent-bridge/heartbeat";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_IDLE_HEARTBEAT_MS = 5 * 60_000;
const DEFAULT_PROCESS_ORPHAN_CLEANUP_MS = 60_000;
const DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_RESTART_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_HERMES_PROFILE_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS = 2;
const DEFAULT_AGENT_COMMAND = "hermes acp";
const AGENT_TOOLS_MCP_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "agent-tools-mcp.ts",
);
const DEFAULT_ACP_RESUME_ENABLED = false;
const DEFAULT_ACP_IDLE_TTL_MS = 30 * 60_000;
const PROCESS_PRESSURE_TARGET_FREE_PROCESS_SLOTS = 2;
const DEFAULT_ALLOW_REMOTE_CWD = true;
const DEFAULT_AGENT_CONNECTION_REGISTER_PATH =
  "/api/agent-connections/register";
const DEFAULT_AGENT_SKILL_PATH = join(
  homedir(),
  ".claude",
  "skills",
  "0000",
  "SKILL.md",
);
export const BRIDGE_VERSION = "0.1.42";
const BRIDGE_LOCAL_STATE_MODE = 0o600;
const BRIDGE_MCP_SERVER_NAME = "0000-agent-tools";
const BRIDGE_MCP_SERVER_VERSION = "0.1.0";
const BRIDGE_RESTART_HANDOFF_SCHEMA_VERSION = 1;
const BRIDGE_RESTART_HANDOFF_TTL_MS = 10 * 60_000;
const BRIDGE_RESTART_HANDOFF_MAX_SESSIONS = 12;
const BRIDGE_RESTART_HANDOFF_MAX_PROFILES = 24;

export type BridgeRuntimeIdentity = {
  bridgeVersion: string;
  gitSha?: string;
  instanceId: string;
  mcpManifestHash: string;
  pid: number;
  processStartedAt: string;
  toolPolicyHash: string;
};

type BridgeProcessHealth = AcpBridgeProcessHealth & {
  registryPath?: string;
  singletonOwner?: {
    duplicateOwner?: {
      instanceId?: string;
      pid: number;
      processStartedAt?: string;
      updatedAt?: string;
    };
    lastReconciledAt?: string;
    ownerPath: string;
    status: BridgeSingletonStatus["status"];
  };
};

export type BridgeCommandName =
  | "connect"
  | "doctor"
  | "pair"
  | "start"
  | "status"
  | "help";

type FlagValue = string | true | string[];
type FlagMap = Record<string, FlagValue>;

export type ParsedBridgeArgs = {
  command: BridgeCommandName;
  positionals: string[];
  flags: FlagMap;
};

export type BridgeRegistration = {
  deviceId: string;
  bridgeToken: string;
  appUrl: string;
  deviceName: string;
  pairedAt: string;
  bridgeApiUrl?: string;
  enabledFeatureFlags?: string[];
  logIngestUrl?: string;
};

export type BridgeConfig = BridgeRegistration;

export type MultiBridgeConfig = {
  version: 2;
  registrations: BridgeRegistration[];
};

type BridgeConfigFile = BridgeConfig | MultiBridgeConfig;

type PairResponse = {
  deviceId?: unknown;
  bridgeToken?: unknown;
  token?: unknown;
  bridgeApiUrl?: unknown;
  enabledFeatureFlags?: unknown;
  endpoint?: unknown;
  logIngestUrl?: unknown;
  logUrl?: unknown;
};

export type PendingAgentConnectionRequest = {
  bridgeToken: string;
  createdAt: string;
  deviceId: string;
  path: string;
};

type QueueClaimResponse = {
  command?: unknown;
  commands?: unknown;
};

type QueueCleanupResponse = {
  inspected?: unknown;
  released?: unknown;
};

type ProposedAgentProfile = {
  agentCommand: string;
  bridgeVersion: string;
  defaultCwd: string;
  hostLabel: string;
  installMode: string;
  proposedAgentName: string;
  runtimeId: string;
  runtimeLabel: string;
  skillInstallPath?: string;
};

type BridgeQueueCommand = BridgeSessionQueueItem;

type BridgeWakeWaitResult = "signal" | "timeout";
export type BridgeLoopPollReason = "active" | "startup" | "timer" | "wake";

type BridgeWakeSignal = {
  wait(timeoutMs: number): Promise<BridgeWakeWaitResult>;
  close(): Promise<void>;
  isWakeSubscriptionActive?(): boolean;
  nextWakeTokenRefreshAt?(): number | undefined;
  updateWakeToken?(wake: BridgeWakeToken | undefined): void;
};

type BridgeWakeToken = {
  token: string;
  expiresAt: number;
  refreshAfterMs: number;
};

export type BridgeStatus = {
  deviceId?: string;
  appUrl?: string;
  connected: boolean;
  lifecycle?: BridgeLifecycleStatus;
  updateState?: BridgeUpdateState;
  devHotReload?: BridgeDevHotReloadStatus;
  pendingControlCommand?: BridgeControlCommandState;
  controlCommandStatus?: BridgeControlCommandStatus;
  restartHandoff?: BridgeRestartHandoffStatus;
  lastStartedAt?: string;
  lastHeartbeatAt?: string;
  lastHeartbeatSignature?: string;
  lastPollAt?: string;
  maxInFlight?: number;
  capacity?: {
    orgMaxInFlight?: number;
    bridgeConfiguredMaxInFlight?: number;
    bridgeMaxInFlight?: number;
    processSlotUsage?: number;
    retainedSessionCount?: number;
    totalInFlight?: number;
    localHardMaxInFlight?: number;
  };
  acpResumeEnabled?: boolean;
  acpIdleTtlMs?: number;
  runtimeIdentity?: BridgeRuntimeIdentity;
  hermesProfiles?: HermesProfileSummary[];
  runtimeProfiles?: BridgeRuntimeProfile[];
  lastHermesProfileRefreshAt?: string;
  lastRuntimeProfileRefreshAt?: string;
  activeSessions: string[];
  inFlightCommands?: Array<{
    id: string;
    type?: string;
    threadId?: string;
    sessionId?: string;
    agentSessionId?: string;
    bridgeProfileId?: string;
    startedAt: string;
  }>;
  retainedSessions?: BridgeSessionSummary[];
  sessionQueues?: BridgeSessionSummary[];
  processHealth?: BridgeProcessHealth;
  runtimeConformance?: RuntimeConformanceSummary;
  liveness?: {
    activeSessions: Array<{
      agentSessionId?: string;
      bridgeProfileId?: string;
      claimId?: string;
      currentState: string;
      lastMeaningfulEventAt?: number;
      processAlive?: boolean;
      providerActivitySeen?: boolean;
      queueItemId: string;
      quietSince?: number;
      reasonCode?: string;
      sessionKey?: string;
      silenceMs?: number;
      startedAt?: number;
      transportOpen?: boolean;
    }>;
  };
  availability?: ReturnType<typeof deriveBridgeAvailability>;
  lastStaleCleanupAt?: string;
  lastStaleCleanup?: {
    inspected?: number;
    released?: number;
  };
  setupSummary?: Record<string, unknown>;
  recentErrors: string[];
  registrationFailure?: BridgeRegistrationFailure;
  registrations?: BridgeRegistrationStatus[];
  localJournal?: {
    status: "healthy" | "hard_failed";
    reasonCode?: string;
    message?: string;
  };
};

export type BridgeRestartHandoffStatus = {
  consumedAt: string;
  createdAt: string;
  reason: BridgeRestartHandoffReason;
  status?: string;
  targetVersion?: string;
  runtimeProfileIds: string[];
  startupPriorityRuntimeProfileIds: string[];
  sessionWarmupHints: Array<{
    runtimeProfileId?: string;
    threadId: string;
  }>;
};

type BridgeSessionSummary = {
  sessionKey: string;
  threadId: string;
  agentSessionId?: string;
  bridgeProfileId?: string;
  claimId?: string;
  organizationId?: string;
  runtimeProfileId?: string;
  runtimeLabel?: string;
  runtimeKind?: string;
  hermesProfileName?: string;
  queueDepth: number;
  runningQueueItemId?: string;
  lastActivityAt?: number;
  lastUsedAt?: number;
};

export type BridgeDoctorReport = {
  bridgeVersion: string;
  config: {
    exists: boolean;
    path: string;
    registrations: Array<{
      appUrl: string;
      deviceId: string;
      deviceName?: string;
    }>;
    error?: string;
  };
  generatedAt: string;
  localJournal: {
    path?: string;
    reasonCode?: string;
    message?: string;
    status: "healthy" | "unavailable";
  };
  snapshot: {
    diagnostics: Array<Record<string, unknown>>;
    pendingOutbox: Array<Record<string, unknown>>;
  };
  statusFile: {
    exists: boolean;
    path: string;
  };
  traceId?: string;
};

export type BridgeRegistrationStatus = {
  deviceId: string;
  appUrl: string;
  deviceName?: string;
  connected: boolean;
  lifecycle?: BridgeLifecycleStatus;
  updateState?: BridgeUpdateState;
  devHotReload?: BridgeDevHotReloadStatus;
  pendingControlCommand?: BridgeControlCommandState;
  controlCommandStatus?: BridgeControlCommandStatus;
  restartHandoff?: BridgeRestartHandoffStatus;
  lastStartedAt?: string;
  lastHeartbeatAt?: string;
  lastPollAt?: string;
  maxInFlight?: number;
  capacity?: BridgeStatus["capacity"];
  runtimeIdentity?: BridgeStatus["runtimeIdentity"];
  activeSessions: string[];
  inFlightCommands?: BridgeStatus["inFlightCommands"];
  retainedSessions?: BridgeStatus["retainedSessions"];
  sessionQueues?: Array<{
    sessionKey: string;
    threadId: string;
    runtimeProfileId?: string;
    runtimeLabel?: string;
    runtimeKind?: string;
    hermesProfileName?: string;
    queueDepth: number;
    runningQueueItemId?: string;
    lastUsedAt?: number;
  }>;
  processHealth?: BridgeStatus["processHealth"];
  runtimeConformance?: BridgeStatus["runtimeConformance"];
  liveness?: BridgeStatus["liveness"];
  availability?: BridgeStatus["availability"];
  lastStaleCleanupAt?: string;
  lastStaleCleanup?: BridgeStatus["lastStaleCleanup"];
  recentErrors: string[];
  registrationFailure?: BridgeRegistrationFailure;
};

export type BridgeRestartHandoffReason =
  | "restartWhenIdle"
  | "updateWhenIdle"
  | "runtimeProfileRefresh";

export type BridgeRestartHandoffEntry = {
  appUrlHash: string;
  deviceId: string;
  runtimeProfileIds: string[];
  sessionWarmupHints: Array<{
    agentSessionId?: string;
    bridgeProfileId?: string;
    claimId?: string;
    hermesProfileName?: string;
    lastActivityAt?: number;
    lastUsedAt?: number;
    organizationId?: string;
    queueItemId?: string;
    runtimeProfileId?: string;
    sessionId?: string;
    sessionKey?: string;
    threadId: string;
  }>;
};

export type BridgeRestartHandoff = {
  schemaVersion: 1;
  bridgeVersion: string;
  createdAt: number;
  expiresAt: number;
  reason: BridgeRestartHandoffReason;
  status?: string;
  targetVersion?: string;
  entries: BridgeRestartHandoffEntry[];
};

export type BridgeRegistrationFailure = {
  kind: "auth_failed";
  reasonCode: "bridge_credentials_invalid" | "bridge_device_not_paired";
  message: string;
  detectedAt: string;
};

export type BridgeLifecycleStatus =
  | "running"
  | "draining"
  | "restartPending"
  | "updating"
  | "restarting"
  | "error";

export type BridgeUpdateStatus =
  | "upToDate"
  | "available"
  | "waitingForIdle"
  | "installing"
  | "restarting"
  | "updated"
  | "failed"
  | "unsupported";

export type BridgeUpdateState = {
  status: BridgeUpdateStatus;
  available: boolean;
  channel: string;
  currentVersion: string;
  latestVersion?: string;
  lastCheckedAt: number;
  lastUpdatedAt?: number;
  required: boolean;
  targetVersion?: string;
  requestedAt?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
};

export type BridgeDevHotReloadStatus = {
  enabled: boolean;
  lastRestartReason?: string;
  pendingRestart: boolean;
};

function buildBridgeUpdateState(
  status: BridgeUpdateStatus,
  now: number,
  patch: Partial<BridgeUpdateState> = {},
): BridgeUpdateState {
  return {
    available: false,
    channel: "stable",
    currentVersion: BRIDGE_VERSION,
    lastCheckedAt: now,
    latestVersion: BRIDGE_VERSION,
    required: false,
    status,
    ...patch,
  };
}

const BRIDGE_PROCESS_STARTED_AT = new Date().toISOString();
const BRIDGE_PROCESS_INSTANCE_ID = randomUUID();
const BRIDGE_PROCESS_START_TOKEN = readLinuxProcessStartToken(process.pid);
const BRIDGE_GIT_SHA = resolveGitSha();
const BRIDGE_RUNTIME_IDENTITY: BridgeRuntimeIdentity = {
  bridgeVersion: BRIDGE_VERSION,
  ...(BRIDGE_GIT_SHA ? { gitSha: BRIDGE_GIT_SHA } : {}),
  instanceId: BRIDGE_PROCESS_INSTANCE_ID,
  mcpManifestHash: hashStableBridgeValue(buildBridgeMcpManifestSummary()),
  pid: process.pid,
  processStartedAt: BRIDGE_PROCESS_STARTED_AT,
  toolPolicyHash: hashStableBridgeValue(buildBridgeToolPolicySummary()),
};

function getBridgeRuntimeIdentity(): BridgeRuntimeIdentity {
  return BRIDGE_RUNTIME_IDENTITY;
}

function buildBridgeMcpManifestSummary() {
  return {
    resources: [
      AGENT_TOOL_GUIDE_RESOURCE,
      AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
    ],
    serverName: BRIDGE_MCP_SERVER_NAME,
    serverVersion: BRIDGE_MCP_SERVER_VERSION,
    tools: AGENT_TOOL_MCP_TOOL_NAMES.map((toolName) => ({
      inputFields: Object.keys(AGENT_TOOL_MCP_INPUT_SCHEMAS[toolName].shape).sort(),
      name: toolName,
    })),
  };
}

function buildBridgeToolPolicySummary() {
  return {
    guideText: buildAgentToolGuideText(),
    toolNames: [...AGENT_TOOL_MCP_TOOL_NAMES],
  };
}

function hashStableBridgeValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resolveGitSha(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function readLinuxProcessStartToken(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      return undefined;
    }
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

export type BridgeControlCommandName = "updateWhenIdle" | "restartWhenIdle";

export type BridgeControlCommandState = {
  command: BridgeControlCommandName;
  requestedAt?: number;
};

export type BridgeControlCommandLifecycleStatus =
  | "accepted"
  | "waiting_for_idle"
  | "executing"
  | "succeeded"
  | "failed";

export type BridgeControlCommandStatus = {
  command: BridgeControlCommandName;
  status: BridgeControlCommandLifecycleStatus;
  requestedAt?: number;
  acceptedAt?: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  targetVersion?: string;
  instanceId?: string;
  error?: string;
};

export type HermesProfileSummary = {
  alias?: string;
  description?: string;
  gateway?: string;
  model?: string;
  name: string;
};

type AgentToolsMcpServerInput = {
  agentSessionId: string;
  appUrl: string;
  agentToolsUrl?: string;
  bridgeToken: string;
  deviceId: string;
  enabledFeatureFlags?: string[];
  threadId?: string;
};

type InFlightCommandMetadata = BridgeTerminalizationMetadata & {
  id: string;
  type?: string;
  threadId?: string;
  sessionId?: string;
  agentSessionId?: string;
  bridgeProfileId?: string;
  createdAt?: string;
  createdAtMs?: number;
  claimedAt?: string;
  claimedAtMs?: number;
  startedAt: string;
};

type BridgeLoopWatchdogResult =
  | (Extract<BridgeWatchdogResult, { checkpoint: "quiet" }> &
      BridgeTerminalizationMetadata)
  | (Omit<
      Extract<BridgeWatchdogResult, { checkpoint: "failed" }>,
      "reasonCode"
    > & {
      reasonCode: string;
    } & BridgeTerminalizationMetadata);

type BridgeLoopManager = Pick<
  BridgeSessionManager,
  "getStatus" | "handleQueueItem"
> & {
  closeIdleSessionsForProcessPressure?: BridgeSessionManager["closeIdleSessionsForProcessPressure"];
  seedWarmRuntimeSessions?: BridgeSessionManager["seedWarmRuntimeSessions"];
  warmRuntimeSessions?: BridgeSessionManager["warmRuntimeSessions"];
  failActiveQueueItem?: (
    queueItemId: string,
    reasonCode: string,
    metadata?: BridgeTerminalizationMetadata,
  ) => Promise<boolean>;
};

type BridgeClaimSlotReservation = {
  maxInFlight: number;
  release: () => void;
};

export type BridgeLoopIterationInput = {
  config: BridgeConfig;
  agentCommand?: string;
  runtimeCommands?: string[][];
  status: BridgeStatus;
  maxInFlight: number;
  statusMaxInFlight?: number;
  getStatusMaxInFlight?: () => number;
  applySettingsControl?: (settings: BridgeControlResponse["settings"]) => void;
  manager: BridgeLoopManager;
  inFlightCommands: Map<string, Promise<void>>;
  inFlightCommandMetadata: Map<string, InFlightCommandMetadata>;
  watchdogFailures?: BridgeLoopWatchdogResult[];
  lastStaleCleanupAt: number;
  setLastStaleCleanupAt: (value: number) => void;
  staleCleanupTimeoutMs?: number;
  cloudRequestTimeoutMs?: number;
  log: FlushableBridgeLogger;
  recordLoopError: (error: unknown) => Promise<void>;
  statusPath: string;
  now?: () => number;
  heartbeatIntervalMs?: number;
  sendHeartbeat?: typeof sendHeartbeat;
  discoverHermesProfiles?: typeof discoverHermesProfiles;
  discoverRuntimeProfiles?: typeof discoverBridgeRuntimeProfiles;
  cleanupStaleClaims?: typeof cleanupStaleClaims;
  claimCommands?: typeof claimCommands;
  markCommandResult?: typeof markCommandResult;
  canClaimWork?: () => boolean;
  getProcessHealth?: () => BridgeProcessHealth;
  getRuntimeConformance?: () => RuntimeConformanceSummary | undefined;
  isProcessIdleForRestart?: () => boolean;
  applyFeatureFlagsControl?: (
    enabledFeatureFlags: string[],
  ) => Promise<void> | void;
  pollReason?: BridgeLoopPollReason;
  reserveClaimSlots?: () => BridgeClaimSlotReservation;
  warmRuntimeProfileIds?: string[];
  writeStatus?: typeof writeStatus;
  launchUpdater?: typeof launchBridgeUpdater;
  restartHandoffPath?: string;
  wakeSignal?: BridgeWakeSignal;
};

export type BridgeLoopIterationResult = {
  restartRequested: boolean;
};

export type BridgeRegistrationSchedulerInput<TContext> = {
  context: TContext;
  isActive: (context: TContext) => boolean;
  onRestartRequested: (context: TContext) => Promise<void>;
  runContextPass: (
    context: TContext,
    pollReason: BridgeLoopPollReason,
  ) => Promise<BridgeLoopIterationResult>;
  totalInFlight: () => number;
  waitForWakeSignal: (
    context: TContext,
  ) => Promise<BridgeLoopPollReason>;
};

export async function runBridgeRegistrationScheduler<TContext>(
  input: BridgeRegistrationSchedulerInput<TContext>,
): Promise<void> {
  let nextPollReason: BridgeLoopPollReason = "startup";
  let processRestartPending = false;
  while (input.isActive(input.context)) {
    const pollReason =
      input.totalInFlight() > 0 ? "active" : nextPollReason;
    const result = await input.runContextPass(input.context, pollReason);
    if (result.restartRequested) {
      processRestartPending = true;
    }
    if (processRestartPending && input.totalInFlight() === 0) {
      await input.onRestartRequested(input.context);
      return;
    }
    if (!input.isActive(input.context)) {
      return;
    }
    nextPollReason = await input.waitForWakeSignal(input.context);
  }
}

export function shouldCleanupBridgeOrphanedProcesses(input: {
  inFlightCommandCount: number;
  managerStatus: Pick<
    BridgeSessionManagerStatus,
    "activeSessions" | "sessions"
  >;
  singletonCanClaim: boolean;
}): boolean {
  if (!input.singletonCanClaim) {
    return false;
  }
  if (input.inFlightCommandCount > 0) {
    return false;
  }
  if (input.managerStatus.activeSessions.length > 0) {
    return false;
  }
  return !input.managerStatus.sessions.some(
    (session) =>
      Boolean(session.runningQueueItemId) ||
      (typeof session.queueDepth === "number" && session.queueDepth > 0),
  );
}

function processPressureCleanupRequest(
  processHealth: BridgeStatus["processHealth"],
): { maxSessionsToClose: number; targetFreeProcessSlots: number } | undefined {
  if (
    !processHealth ||
    typeof processHealth.processCap !== "number" ||
    processHealth.processCap <= 0
  ) {
    return undefined;
  }
  const freeProcessSlots = processHealth.processCap - processHealth.childCount;
  if (freeProcessSlots > 1) {
    return undefined;
  }
  const maxSessionsToClose =
    PROCESS_PRESSURE_TARGET_FREE_PROCESS_SLOTS - freeProcessSlots;
  if (maxSessionsToClose <= 0) {
    return undefined;
  }
  return {
    maxSessionsToClose,
    targetFreeProcessSlots: PROCESS_PRESSURE_TARGET_FREE_PROCESS_SLOTS,
  };
}

export type BridgeUpdaterLaunchInput = {
  currentVersion: string;
  requestedAt?: number;
  restartHandoffPath: string;
  restartCommand: string[];
  statusPath: string;
};

const MAX_CONTROL_COMMAND_ERROR_LENGTH = 240;
const MAX_CONTROL_COMMAND_TARGET_VERSION_LENGTH = 64;

export function normalizeBridgeConfigFile(raw: unknown): MultiBridgeConfig {
  const record = recordFromUnknown(raw);
  if (!record) {
    throw new Error("Bridge config must be an object");
  }
  if (record.version === 2) {
    const registrations = Array.isArray(record.registrations)
      ? record.registrations.map(normalizeBridgeRegistration)
      : [];
    if (registrations.length === 0) {
      throw new Error("Bridge config has no registrations");
    }
    return { version: 2, registrations };
  }
  return { version: 2, registrations: [normalizeBridgeRegistration(record)] };
}

export function upsertBridgeRegistration(
  config: MultiBridgeConfig,
  registration: BridgeRegistration,
): MultiBridgeConfig {
  const registrations = [...config.registrations];
  const existingIndex = registrations.findIndex(
    (entry) => entry.deviceId === registration.deviceId,
  );
  if (existingIndex >= 0) {
    registrations[existingIndex] = registration;
  } else {
    registrations.push(registration);
  }
  return { version: 2, registrations };
}

function normalizeBridgeRegistration(raw: unknown): BridgeRegistration {
  const record = recordFromUnknown(raw);
  if (!record) {
    throw new Error("Bridge registration must be an object");
  }
  const deviceId = readString(record.deviceId, "deviceId");
  const bridgeToken = readString(record.bridgeToken, "bridgeToken");
  const appUrl = readString(record.appUrl, "appUrl");
  const deviceName = readString(record.deviceName, "deviceName");
  const pairedAt = readString(record.pairedAt, "pairedAt");
  return compact({
    appUrl,
    bridgeApiUrl: stringFromUnknown(record.bridgeApiUrl),
    bridgeToken,
    deviceId,
    deviceName,
    enabledFeatureFlags: stringArrayFromUnknown(record.enabledFeatureFlags),
    logIngestUrl: stringFromUnknown(record.logIngestUrl),
    pairedAt,
  });
}

export function parseBridgeArgs(argv: string[]): ParsedBridgeArgs {
  const [rawCommand, ...rest] = argv;
  const command = normalizeCommand(rawCommand);
  const flags: FlagMap = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--")) {
      const inlineValueIndex = value.indexOf("=");
      if (inlineValueIndex > 2) {
        addFlagValue(
          flags,
          value.slice(2, inlineValueIndex),
          value.slice(inlineValueIndex + 1),
        );
        continue;
      }

      const name = value.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        addFlagValue(flags, name, next);
        index += 1;
      } else {
        addFlagValue(flags, name, true);
      }
      continue;
    }

    positionals.push(value);
  }

  return { command, positionals, flags };
}

function addFlagValue(flags: FlagMap, name: string, value: FlagValue): void {
  const current = flags[name];
  if (current === undefined) {
    flags[name] = value;
    return;
  }
  if (Array.isArray(current)) {
    flags[name] = [
      ...current,
      ...(Array.isArray(value) ? value : [value].filter(isStringFlag)),
    ];
    return;
  }
  const currentValues = [current].filter(isStringFlag);
  const nextValues = Array.isArray(value)
    ? value
    : [value].filter(isStringFlag);
  flags[name] = [...currentValues, ...nextValues];
}

function isStringFlag(value: FlagValue): value is string {
  return typeof value === "string";
}

export function getFlag(
  flags: FlagMap,
  name: string,
  fallback?: string,
): string | undefined {
  const value = flags[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallback;
}

export function getRepeatedFlags(flags: FlagMap, name: string): string[] {
  const value = flags[name];
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

export function getConfigPath(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    getFlag(flags, "config", env.ZERO_CHAT_BRIDGE_CONFIG) ?? DEFAULT_CONFIG_PATH
  );
}

export function getAcpResumeEnabled(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const rawValue = getFlag(
    flags,
    "acp-resume",
    env.ZERO_CHAT_BRIDGE_ACP_RESUME,
  );
  if (rawValue === undefined) {
    return DEFAULT_ACP_RESUME_ENABLED;
  }
  return rawValue === "1" || rawValue === "true" || rawValue === "yes";
}

export function getAcpIdleTtlMs(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = getFlag(
    flags,
    "acp-idle-ttl-ms",
    env.ZERO_CHAT_BRIDGE_ACP_IDLE_TTL_MS,
  );
  if (rawValue === undefined) {
    return DEFAULT_ACP_IDLE_TTL_MS;
  }
  const ttlMs = Number(rawValue);
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(
      "acp-idle-ttl-ms must be a non-negative number of milliseconds",
    );
  }
  return ttlMs;
}

export function getRequestTimeoutMs(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = getFlag(
    flags,
    "request-timeout-ms",
    env.ZERO_CHAT_BRIDGE_REQUEST_TIMEOUT_MS,
  );
  if (rawValue === undefined) {
    return DEFAULT_ACP_REQUEST_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "request-timeout-ms must be a positive number of milliseconds",
    );
  }
  return timeoutMs;
}

export function getCloudRequestTimeoutMs(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = getFlag(
    flags,
    "cloud-request-timeout-ms",
    env.ZERO_CHAT_BRIDGE_CLOUD_REQUEST_TIMEOUT_MS,
  );
  if (rawValue === undefined) {
    return DEFAULT_CLOUD_REQUEST_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "cloud-request-timeout-ms must be a positive number of milliseconds",
    );
  }
  return timeoutMs;
}

export function getToolResultTimeoutMs(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    getExplicitToolResultTimeoutMs(flags, env) ?? DEFAULT_TOOL_RESULT_TIMEOUT_MS
  );
}

export function getExplicitToolResultTimeoutMs(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const rawValue = getFlag(
    flags,
    "tool-result-timeout-ms",
    env.ZERO_CHAT_BRIDGE_TOOL_RESULT_TIMEOUT_MS,
  );
  if (rawValue === undefined) {
    return undefined;
  }

  const timeoutMs = Number(rawValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "tool-result-timeout-ms must be a positive number of milliseconds",
    );
  }
  return timeoutMs;
}

export function getLocalHardMaxInFlight(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const rawValue = getFlag(
    flags,
    "max-in-flight",
    env.ZERO_CHAT_BRIDGE_MAX_IN_FLIGHT,
  );
  if (rawValue === undefined) {
    return undefined;
  }

  const maxInFlight = Number(rawValue);
  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
    throw new Error("max-in-flight must be a positive integer");
  }
  return maxInFlight;
}

export function getMaxInFlight(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    getLocalHardMaxInFlight(flags, env) ?? DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS
  );
}

export function getInitialOrgMaxInFlight(
  localHardMaxInFlight: number | undefined,
): number {
  return localHardMaxInFlight ?? DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS;
}

function normalizeControlMaxInFlight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeControlUpdatedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function buildBridgeCapacitySnapshot(
  contexts: Iterable<{
    inFlightCommands: Map<string, Promise<void>>;
    manager?: Pick<BridgeLoopManager, "getStatus">;
    orgMaxInFlight: number;
  }>,
  localHardMaxInFlight: number | undefined,
  pendingOrgMaxInFlight = 0,
): NonNullable<BridgeStatus["capacity"]> {
  const list = Array.from(contexts);
  const bridgeConfiguredMaxInFlight =
    list.reduce((sum, context) => sum + context.orgMaxInFlight, 0) +
    pendingOrgMaxInFlight;
  const bridgeMaxInFlight =
    localHardMaxInFlight === undefined
      ? bridgeConfiguredMaxInFlight
      : Math.min(bridgeConfiguredMaxInFlight, localHardMaxInFlight);
  const totalInFlight = list.reduce(
    (sum, context) => sum + context.inFlightCommands.size,
    0,
  );
  const retainedSessionCount = list.reduce(
    (sum, context) => sum + retainedBridgeSessionCount(context.manager),
    0,
  );
  const processSlotUsage = totalInFlight;
  return {
    bridgeConfiguredMaxInFlight,
    bridgeMaxInFlight,
    processSlotUsage,
    retainedSessionCount,
    totalInFlight,
    ...(localHardMaxInFlight === undefined
      ? {}
      : { localHardMaxInFlight }),
  };
}

function retainedBridgeSessionCount(
  manager: Pick<BridgeLoopManager, "getStatus"> | undefined,
): number {
  if (!manager) {
    return 0;
  }
  const status = manager.getStatus();
  const activeSessionKeys = new Set(status.activeSessions);
  return status.sessions.filter(
    (session) => !activeSessionKeys.has(session.sessionKey),
  ).length;
}

export function getAllowRemoteCwd(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const rawValue = getFlag(
    flags,
    "allow-remote-cwd",
    env.ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD,
  );
  if (rawValue === undefined) {
    return DEFAULT_ALLOW_REMOTE_CWD;
  }
  return rawValue === "1" || rawValue === "true" || rawValue === "yes";
}

export function getWarmRuntimeProfileIds(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const profileIds = [
    ...splitCommaSeparatedList(env.ZERO_CHAT_BRIDGE_WARM_RUNTIME_PROFILES),
    ...getRepeatedFlags(flags, "warm-runtime-profile").flatMap(
      splitCommaSeparatedList,
    ),
  ];
  return Array.from(new Set(profileIds));
}

export function deriveConvexCloudUrl(appUrl: string): string | undefined {
  const url = new URL(appUrl);
  if (url.hostname.endsWith(".convex.cloud")) {
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  if (!url.hostname.endsWith(".convex.site")) {
    return undefined;
  }
  url.hostname = `${url.hostname.slice(0, -".convex.site".length)}.convex.cloud`;
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function getConvexUrl(
  flags: FlagMap,
  config: Pick<BridgeConfig, "appUrl" | "bridgeApiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    getFlag(flags, "convex-url", env.ZERO_CHAT_BRIDGE_CONVEX_URL) ??
    (config.bridgeApiUrl
      ? deriveConvexCloudUrl(config.bridgeApiUrl)
      : undefined) ??
    deriveConvexCloudUrl(config.appUrl)
  );
}

export function buildAgentToolsMcpServers(
  input: AgentToolsMcpServerInput,
): HermesAcpMcpServer[] {
  assertRealAgentSessionId(input.agentSessionId);
  return [
    {
      args: [AGENT_TOOLS_MCP_SCRIPT_PATH],
      command: "bun",
      env: [
        { name: "ZERO_CHAT_AGENT_SESSION_ID", value: input.agentSessionId },
        { name: "ZERO_CHAT_APP_URL", value: input.appUrl },
        ...(input.agentToolsUrl
          ? [{ name: "ZERO_CHAT_AGENT_TOOLS_URL", value: input.agentToolsUrl }]
          : []),
        { name: "ZERO_CHAT_BRIDGE_DEVICE_ID", value: input.deviceId },
        ...(input.threadId
          ? [{ name: "ZERO_CHAT_THREAD_ID", value: input.threadId }]
          : []),
        ...(input.enabledFeatureFlags?.length
          ? [
              {
                name: "ZERO_CHAT_ENABLED_FEATURE_FLAGS",
                value: input.enabledFeatureFlags.join(","),
              },
            ]
          : []),
        { name: "ZERO_CHAT_BRIDGE_TOKEN", value: input.bridgeToken },
      ],
      name: "0000",
    },
  ];
}

function assertRealAgentSessionId(agentSessionId: string): void {
  if (!agentSessionId.trim()) {
    throw new Error(
      "agent tool MCP context is missing agentSessionId; reconnect the agent",
    );
  }
  if (
    agentSessionId.includes(":") ||
    agentSessionId.startsWith("unknown-org")
  ) {
    throw new Error(
      "agent tool MCP context received a bridge-scoped session key instead of a Convex agent session id; reconnect the agent",
    );
  }
}

export function describeStatus(
  status: BridgeStatus,
  configExists: boolean,
): string {
  const lines = ["0000 Chat ACP bridge status"];
  lines.push(`paired: ${configExists ? "yes" : "no"}`);
  if (status.registrations) {
    lines.push(`registered links: ${status.registrations.length}`);
    for (const registration of status.registrations) {
      lines.push(`  - ${registration.deviceName ?? registration.deviceId}`);
      lines.push(`    device: ${registration.deviceId}`);
      lines.push(`    app: ${registration.appUrl}`);
      lines.push(`    connected: ${registration.connected ? "yes" : "no"}`);
      if (registration.registrationFailure) {
        lines.push(
          `    registration failure: ${registration.registrationFailure.reasonCode} (${registration.registrationFailure.message})`,
        );
      }
      lines.push(`    active sessions: ${registration.activeSessions.length}`);
      lines.push(
        `    retained sessions: ${registration.retainedSessions?.length ?? registration.sessionQueues?.length ?? 0}`,
      );
      lines.push(
        `    in-flight commands: ${registration.inFlightCommands?.length ?? 0}`,
      );
      if (registration.processHealth) {
        lines.push(
          `    process health: ${registration.processHealth.status} (can claim: ${registration.processHealth.canClaim ? "yes" : "no"}, children: ${registration.processHealth.childCount})`,
        );
        appendStartupReconciliationLines(
          lines,
          registration.processHealth,
          "    ",
        );
      }
      if (registration.lastHeartbeatAt) {
        lines.push(`    last heartbeat: ${registration.lastHeartbeatAt}`);
      }
      if (registration.lastPollAt) {
        lines.push(`    last queue poll: ${registration.lastPollAt}`);
      }
      if (registration.restartHandoff) {
        lines.push(
          `    restart handoff: consumed ${registration.restartHandoff.sessionWarmupHints.length} session hint${registration.restartHandoff.sessionWarmupHints.length === 1 ? "" : "s"}${registration.restartHandoff.targetVersion ? ` target=${registration.restartHandoff.targetVersion}` : ""}`,
        );
      }
      if (registration.recentErrors.length > 0) {
        lines.push("    recent errors:");
        for (const error of registration.recentErrors.slice(-3)) {
          lines.push(`      - ${redactForOutput(error)}`);
        }
      }
    }
  }
  if (status.deviceId) {
    lines.push(`device: ${status.deviceId}`);
  }
  if (status.appUrl) {
    lines.push(`app: ${status.appUrl}`);
  }
  lines.push(`connected: ${status.connected ? "yes" : "no"}`);
  lines.push(`max in-flight commands: ${status.maxInFlight ?? 0}`);
  lines.push(`in-flight commands: ${status.inFlightCommands?.length ?? 0}`);
  if (status.processHealth) {
    lines.push(
      `process health: ${status.processHealth.status} (can claim: ${status.processHealth.canClaim ? "yes" : "no"}, children: ${status.processHealth.childCount})`,
    );
    appendStartupReconciliationLines(lines, status.processHealth);
    if (status.processHealth.ambiguousProcessCount > 0) {
      lines.push(
        `ambiguous ACP processes: ${status.processHealth.ambiguousProcessCount}`,
      );
    }
    if (status.processHealth.processCapExceeded) {
      lines.push(
        `process cap exceeded: ${status.processHealth.childCount}/${status.processHealth.processCap ?? "unknown"}`,
      );
    }
  }
  if (status.lastStaleCleanupAt) {
    lines.push(
      `last stale cleanup: ${status.lastStaleCleanupAt} (released ${status.lastStaleCleanup?.released ?? 0}, inspected ${status.lastStaleCleanup?.inspected ?? 0})`,
    );
  }
  if (status.controlCommandStatus) {
    lines.push(
      `control command: ${status.controlCommandStatus.command} (${status.controlCommandStatus.status})`,
    );
  }
  if (status.restartHandoff) {
    lines.push(
      `restart handoff: consumed ${status.restartHandoff.sessionWarmupHints.length} session hint${status.restartHandoff.sessionWarmupHints.length === 1 ? "" : "s"}${status.restartHandoff.targetVersion ? ` target=${status.restartHandoff.targetVersion}` : ""}`,
    );
  }
  for (const command of status.inFlightCommands ?? []) {
    lines.push(
      `  - ${command.id}${command.type ? ` (${command.type})` : ""}${command.threadId ? ` thread=${command.threadId}` : ""}`,
    );
  }
  lines.push(`active sessions: ${status.activeSessions.length}`);
  for (const sessionId of status.activeSessions) {
    const sessionQueue = status.sessionQueues?.find(
      (session) => session.sessionKey === sessionId,
    );
    lines.push(
      `  - ${sessionId}${sessionQueue ? ` queueDepth=${sessionQueue.queueDepth}` : ""}`,
    );
  }
  lines.push(
    `retained sessions: ${status.retainedSessions?.length ?? status.sessionQueues?.length ?? 0}`,
  );
  if (status.lastStartedAt) {
    lines.push(`last started: ${status.lastStartedAt}`);
  }
  if (status.lastHeartbeatAt) {
    lines.push(`last heartbeat: ${status.lastHeartbeatAt}`);
  }
  if (status.lastPollAt) {
    lines.push(`last queue poll: ${status.lastPollAt}`);
  }
  if (status.recentErrors.length > 0) {
    lines.push("recent errors:");
    for (const error of status.recentErrors.slice(-5)) {
      lines.push(`  - ${redactForOutput(error)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendStartupReconciliationLines(
  lines: string[],
  processHealth: BridgeStatus["processHealth"],
  prefix = "",
): void {
  const reconciliation = processHealth?.startupReconciliation;
  if (!reconciliation) {
    return;
  }
  const when = reconciliation.lastReconciledAt
    ? ` at ${reconciliation.lastReconciledAt}`
    : "";
  lines.push(
    `${prefix}startup reconciliation: ${reconciliation.status}${when}`,
  );
  if (reconciliation.status === "ambiguous") {
    lines.push(
      `${prefix}startup reconciliation recovery: stop verified bridge-owned ACP children or inspect the registry before deleting it`,
    );
  }
}

export function buildEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function splitCommaSeparatedList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

async function main() {
  const parsed = parseBridgeArgs(process.argv.slice(2));
  try {
    if (parsed.command === "connect") {
      await connectBridge(parsed);
    } else if (parsed.command === "pair") {
      await pairBridge(parsed);
    } else if (parsed.command === "start") {
      await startBridge(parsed);
    } else if (parsed.command === "status") {
      await showStatus(parsed);
    } else if (parsed.command === "doctor") {
      await showDoctor(parsed);
    } else {
      writeStdout(helpText());
    }
  } catch (error) {
    writeStderr(
      `${redactForOutput(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  }
}

async function connectBridge(parsed: ParsedBridgeArgs) {
  const code = getFlag(parsed.flags, "code") ?? parsed.positionals[0];
  if (!code) {
    throw new Error("connect requires a connection code");
  }

  const appUrl = getFlag(
    parsed.flags,
    "app-url",
    process.env.ZERO_CHAT_APP_URL,
  );
  if (!appUrl) {
    throw new Error("connect requires --app-url or ZERO_CHAT_APP_URL");
  }

  const agentCommand =
    getFlag(
      parsed.flags,
      "agent-command",
      process.env.ZERO_CHAT_AGENT_COMMAND,
    ) ?? defaultAgentCommandForEnvironment();
  const skillPath = getFlag(
    parsed.flags,
    "skill-path",
    process.env.ZERO_CHAT_SKILL_PATH,
  );
  const installMode =
    getFlag(
      parsed.flags,
      "install-mode",
      process.env.ZERO_CHAT_BRIDGE_INSTALL_MODE,
    ) ?? "unknown";
  const proposedProfile: ProposedAgentProfile = {
    agentCommand,
    bridgeVersion: BRIDGE_VERSION,
    defaultCwd:
      getFlag(parsed.flags, "default-cwd", process.cwd()) ?? process.cwd(),
    hostLabel: hostname(),
    installMode,
    proposedAgentName:
      getFlag(parsed.flags, "agent-name") ??
      defaultProposedAgentName(agentCommand, hostname()),
    runtimeId:
      getFlag(parsed.flags, "runtime-id") ?? inferRuntimeId(agentCommand),
    runtimeLabel:
      getFlag(parsed.flags, "runtime-label") ?? inferRuntimeLabel(agentCommand),
    skillInstallPath: skillPath,
  };

  if (skillPath) {
    await writeAgentConnectionSkill(skillPath, {
      appUrl,
      agentCommand,
      configPath: getConfigPath(parsed.flags),
      skillPath,
    });
  }

  const endpoint = buildEndpoint(
    appUrl,
    getFlag(
      parsed.flags,
      "register-path",
      DEFAULT_AGENT_CONNECTION_REGISTER_PATH,
    ) ?? DEFAULT_AGENT_CONNECTION_REGISTER_PATH,
  );
  const configPath = getConfigPath(parsed.flags);
  const pendingRequest = await preparePendingAgentConnectionRequest(
    configPath,
    code,
  );
  const response = await postJson<PairResponse>(endpoint, undefined, {
    code,
    deviceName: proposedProfile.proposedAgentName,
    host: hostname(),
    platform: process.platform,
    proposedProfile,
    requestedBridgeToken: pendingRequest.bridgeToken,
    requestedDeviceId: pendingRequest.deviceId,
  });

  const deviceId = readString(response.deviceId, "deviceId");
  const bridgeToken = readString(
    response.bridgeToken ?? response.token,
    "bridgeToken",
  );
  const config: BridgeConfig = {
    appUrl,
    bridgeToken,
    deviceId,
    deviceName: proposedProfile.proposedAgentName,
    enabledFeatureFlags: stringArrayFromUnknown(response.enabledFeatureFlags),
    pairedAt: new Date().toISOString(),
  };

  const bridgeApiUrl = stringFromUnknown(
    response.bridgeApiUrl ?? response.endpoint,
  );
  if (bridgeApiUrl) {
    config.bridgeApiUrl = bridgeApiUrl;
  }
  const logIngestUrl = getFlag(parsed.flags, "log-url");
  if (logIngestUrl) {
    config.logIngestUrl = logIngestUrl;
  }

  const updatedConfig = await appendBridgeRegistration(configPath, config);
  await writeStatus(getStatusPath(parsed.flags), {
    deviceId,
    appUrl,
    connected: false,
    activeSessions: [],
    recentErrors: [],
    registrations: updatedConfig.registrations.map((registration) => ({
      deviceId: registration.deviceId,
      appUrl: registration.appUrl,
      deviceName: registration.deviceName,
      connected: false,
      activeSessions: [],
      recentErrors: [],
    })),
    setupSummary: compact({
      agentCommand,
      bridgeVersion: BRIDGE_VERSION,
      configPath,
      defaultCwd: proposedProfile.defaultCwd,
      installMode,
      skillInstallPath: skillPath,
    }),
  });
  await clearPendingAgentConnectionRequest(pendingRequest);

  writeStdout(
    `Connected pending agent bridge ${deviceId}.\nConfig: ${configPath}\nOpen 0000 Chat to approve this agent before it can run work.\n`,
  );
}

async function pairBridge(parsed: ParsedBridgeArgs) {
  const code = getFlag(parsed.flags, "code") ?? parsed.positionals[0];
  if (!code) {
    throw new Error(
      "pair requires a pairing code: bun scripts/acp-bridge.ts pair <code> --app-url <url>",
    );
  }

  const appUrl = getFlag(
    parsed.flags,
    "app-url",
    process.env.ZERO_CHAT_APP_URL,
  );
  if (!appUrl) {
    throw new Error("pair requires --app-url or ZERO_CHAT_APP_URL");
  }

  const configPath = getConfigPath(parsed.flags);
  const deviceName =
    getFlag(parsed.flags, "device-name", `${hostname()} bridge`) ??
    `${hostname()} bridge`;
  const pairPath =
    getFlag(parsed.flags, "pair-path", DEFAULT_PAIR_PATH) ?? DEFAULT_PAIR_PATH;
  const endpoint = buildEndpoint(appUrl, pairPath);
  const response = await postJson<PairResponse>(endpoint, undefined, {
    code,
    deviceName,
    host: hostname(),
    runtime: "bun",
  });

  const deviceId = readString(response.deviceId, "deviceId");
  const bridgeToken = readString(
    response.bridgeToken ?? response.token,
    "bridgeToken",
  );
  const config: BridgeConfig = {
    deviceId,
    bridgeToken,
    appUrl,
    deviceName,
    enabledFeatureFlags: stringArrayFromUnknown(response.enabledFeatureFlags),
    pairedAt: new Date().toISOString(),
  };

  const bridgeApiUrl = stringFromUnknown(
    response.bridgeApiUrl ?? response.endpoint,
  );
  if (bridgeApiUrl) {
    config.bridgeApiUrl = bridgeApiUrl;
  }
  const logIngestUrl = getFlag(parsed.flags, "log-url");
  if (logIngestUrl) {
    config.logIngestUrl = logIngestUrl;
  }

  const updatedConfig = await appendBridgeRegistration(configPath, config);
  await writeStatus(getStatusPath(parsed.flags), {
    deviceId,
    appUrl,
    connected: false,
    activeSessions: [],
    recentErrors: [],
    registrations: updatedConfig.registrations.map((registration) => ({
      deviceId: registration.deviceId,
      appUrl: registration.appUrl,
      deviceName: registration.deviceName,
      connected: false,
      activeSessions: [],
      recentErrors: [],
    })),
  });
  writeStdout(`Paired bridge device ${deviceId}.\nConfig: ${configPath}\n`);
}

async function startBridge(parsed: ParsedBridgeArgs) {
  const configPath = getConfigPath(parsed.flags);
  const statusPath = getStatusPath(parsed.flags);
  const restartHandoffPath = getRestartHandoffPath(parsed.flags);
  await ensureSecureBridgeConfigFile(configPath);
  await readBridgeConfigFile(configPath);
  const pollMs = Number(
    getFlag(parsed.flags, "poll-ms", String(DEFAULT_POLL_MS)),
  );
  const localHardMaxInFlight = getLocalHardMaxInFlight(parsed.flags);
  const agentCommand =
    getFlag(parsed.flags, "agent-command", DEFAULT_AGENT_COMMAND) ??
    DEFAULT_AGENT_COMMAND;
  const customRuntimeCommands = getRepeatedFlags(
    parsed.flags,
    "runtime-command",
  ).map((command) => splitCommand(command));
  const requestTimeoutMs = getRequestTimeoutMs(parsed.flags);
  const cloudRequestTimeoutMs = getCloudRequestTimeoutMs(parsed.flags);
  const toolResultTimeoutMs = getExplicitToolResultTimeoutMs(parsed.flags);
  const resumeEnabled = getAcpResumeEnabled(parsed.flags);
  const idleSessionTtlMs = getAcpIdleTtlMs(parsed.flags);
  const allowRemoteCwd = getAllowRemoteCwd(parsed.flags);
  const warmRuntimeProfileIds = getWarmRuntimeProfileIds(
    parsed.flags,
    process.env,
  );
  const logUrl = getBridgeLogUrl(parsed.flags, process.env);
  const runtimeCatalogCachePath = getRuntimeCatalogCachePath(parsed.flags);
  const runtimeCommandKeys = runtimeCatalogCommandKeys({
    agentCommand,
    customRuntimeCommands,
  });
  const cachedRuntimeCatalog = await loadRuntimeCatalogCache({
    bridgeVersion: BRIDGE_VERSION,
    cachePath: runtimeCatalogCachePath,
    now: Date.now(),
    runtimeCommandKeys,
    ttlMs: DEFAULT_RUNTIME_CONFORMANCE_TTL_MS,
  }).catch(() => null);
  const hermesProfiles = await discoverHermesProfiles().catch(() => []);
  let runtimeProfiles =
    cachedRuntimeCatalog?.profiles ??
    (await discoverBridgeRuntimeProfiles({
      baseAgentCommand: agentCommand,
      customCommands: customRuntimeCommands,
    }).catch(() => []));
  runtimeProfiles = seedConfiguredHermesRuntimeProfile(
    runtimeProfiles,
    agentCommand,
  );
  let launchSpecRuntimeProfiles = buildHermesLaunchSpecRuntimeProfiles({
    hermesProfiles,
    runtimeProfiles,
  });
  let runtimeConformanceRecords: Record<string, RuntimeConformanceRecord> =
    cachedRuntimeCatalog?.conformanceRecords ?? {};
  const lastRuntimeConformanceProbeAtByProfile = new Map<string, number>(
    Object.entries(runtimeConformanceRecords).map(([profileId, record]) => [
      profileId,
      record.checkedAt,
    ]),
  );
  const conformanceProfiles = () => [
    ...runtimeProfiles,
    ...launchSpecRuntimeProfiles,
  ];
  const runtimeConformanceSummary = () => {
    const summary = summarizeRuntimeConformance({
      activeProfileIds: bridgeActiveRuntimeProfileIds(contexts.values()),
      now: Date.now(),
      profiles: runtimeProfiles,
      records: runtimeConformanceRecords,
      ttlMs: DEFAULT_RUNTIME_CONFORMANCE_TTL_MS,
    });
    const launchSpecs = summarizeRuntimeConformance({
      now: Date.now(),
      profiles: launchSpecRuntimeProfiles,
      records: runtimeConformanceRecords,
      ttlMs: DEFAULT_RUNTIME_CONFORMANCE_TTL_MS,
    }).profiles;
    return Object.keys(launchSpecs).length > 0
      ? { ...summary, launchSpecs }
      : summary;
  };

  type RuntimeContext = {
    closing: boolean;
    config: BridgeRegistration;
    inFlightCommands: Map<string, Promise<void>>;
    inFlightCommandMetadata: Map<string, InFlightCommandMetadata>;
    lastProcessOrphanCleanupAt: number;
    lastStaleCleanupAt: number;
    lastJournalHealthSignature: string;
    log: FlushableBridgeLogger;
    manager: BridgeSessionManager;
    processRegistry: AcpBridgeProcessRegistry;
    processRegistryPath: string;
    singletonGuard: BridgeSingletonGuard;
    status: BridgeStatus;
    supervisor: BridgeSupervisor;
    wakeSignal: BridgeWakeSignal;
    loopTask?: Promise<void>;
    orgMaxInFlight: number;
    orgMaxInFlightUpdatedAt?: number;
  };

  const contexts = new Map<string, RuntimeContext>();
  let stopping = false;
  let reservedClaimSlots = 0;
  let startupRuntimeCatalogRefreshScheduled = false;
  let consumedRestartHandoff: BridgeRestartHandoff | undefined;
  let restartHandoffConsumed = false;
  let startupRuntimeConformancePriorityProfileIds: string[] = [];

  const aggregateStatus = () =>
    buildAggregateBridgeStatus(
      Array.from(contexts.values()),
      buildBridgeCapacitySnapshot(contexts.values(), localHardMaxInFlight),
    );
  let aggregateStatusWrite: Promise<void> = Promise.resolve();
  const persistAggregateStatus = async () => {
    const write = aggregateStatusWrite
      .catch(() => undefined)
      .then(() => writeStatus(statusPath, aggregateStatus()));
    aggregateStatusWrite = write;
    await write;
  };
  const totalInFlight = () =>
    Array.from(contexts.values()).reduce(
      (count, context) => count + context.inFlightCommands.size,
      0,
    );
  const persistRuntimeCatalogCache = async () => {
    await writeRuntimeCatalogCache({
      bridgeVersion: BRIDGE_VERSION,
      cachePath: runtimeCatalogCachePath,
      conformanceRecords: runtimeConformanceRecords,
      now: Date.now(),
      profiles: runtimeProfiles,
      runtimeCommandKeys,
      ttlMs: DEFAULT_RUNTIME_CONFORMANCE_TTL_MS,
    }).catch(() => undefined);
  };
  const refreshRuntimeConformanceIfStale = async (
    options: { force?: boolean } = {},
  ) => {
    const ownerContext = contexts.values().next().value as
      | RuntimeContext
      | undefined;
    if (!ownerContext) {
      return;
    }
    const refreshed = await refreshRuntimeConformanceProfiles({
      force: options.force,
      getInFlightProfileIds: () =>
        bridgeInFlightRuntimeProfileIds(contexts.values()),
      getRunningSessionProfileIds: () =>
        bridgeRunningSessionRuntimeProfileIds(contexts.values()),
      lastProbeAtByProfile: lastRuntimeConformanceProbeAtByProfile,
      now: () => Date.now(),
      probeProfile: async (profile) =>
        runRuntimeConformance({
          createSession: () =>
            new HermesAcpSession({
              agentCommand: profile.command,
              processRegistry: ownerContext.processRegistry,
              processRegistryMetadata: {
                bridgeDeviceId: ownerContext.config.deviceId,
                runtimeProfileId: profile.id,
                sessionKey: `runtime-conformance:${profile.id}`,
              },
              requestTimeoutMs,
            }),
          profile,
        }),
      profiles: conformanceProfiles(),
      priorityProfileIds: startupRuntimeConformancePriorityProfileIds,
      records: runtimeConformanceRecords,
      ttlMs: DEFAULT_RUNTIME_CONFORMANCE_TTL_MS,
    });
    runtimeConformanceRecords = refreshed.records;
    await persistRuntimeCatalogCache();
    for (const context of contexts.values()) {
      context.status.runtimeConformance = runtimeConformanceSummary();
    }
  };
  const recordSuccessfulRuntimeConformance = (
    item: { bridgeProfileId?: string; hermesProfileName?: string; kind?: string; type?: string },
    result: Record<string, unknown>,
  ) => {
    if (result.ok !== true) {
      return;
    }
    const records = runtimeConformanceRecordsForSuccessfulCommand(item);
    if (Object.keys(records).length === 0) {
      return;
    }
    runtimeConformanceRecords = {
      ...runtimeConformanceRecords,
      ...records,
    };
    for (const [profileId, record] of Object.entries(records)) {
      lastRuntimeConformanceProbeAtByProfile.set(profileId, record.checkedAt);
    }
    for (const context of contexts.values()) {
      context.status.runtimeConformance = runtimeConformanceSummary();
    }
    void persistRuntimeCatalogCache();
  };
  const refreshRuntimeCatalogInBackground = () => {
    void (async () => {
      const nextHermesProfiles = await discoverHermesProfiles().catch(
        () => hermesProfiles,
      );
      const discoveredRuntimeProfiles = await discoverBridgeRuntimeProfiles({
        baseAgentCommand: agentCommand,
        customCommands: customRuntimeCommands,
      }).catch(() => runtimeProfiles);
      const nextRuntimeProfiles = seedConfiguredHermesRuntimeProfile(
        discoveredRuntimeProfiles,
        agentCommand,
      );
      const runtimeCatalogChanged = runtimeProfilesChanged(
        runtimeProfiles,
        nextRuntimeProfiles,
      );
      runtimeProfiles = nextRuntimeProfiles;
      launchSpecRuntimeProfiles = buildHermesLaunchSpecRuntimeProfiles({
        hermesProfiles: nextHermesProfiles,
        runtimeProfiles,
      });
      for (const context of contexts.values()) {
        context.status.hermesProfiles = nextHermesProfiles;
        context.status.runtimeProfiles = runtimeProfiles;
        context.status.lastHermesProfileRefreshAt = new Date().toISOString();
        context.status.lastRuntimeProfileRefreshAt = new Date().toISOString();
        if (runtimeCatalogChanged) {
          context.status.lifecycle = "restartPending";
          context.status.pendingControlCommand = {
            command: "restartWhenIdle",
            requestedAt: Date.now(),
          };
          context.status.updateState = buildBridgeUpdateState(
            "waitingForIdle",
            Date.now(),
            {
              requestedAt: context.status.pendingControlCommand.requestedAt,
              targetVersion: BRIDGE_VERSION,
            },
          );
        }
      }
      if (!runtimeCatalogChanged) {
        await refreshRuntimeConformanceIfStale({ force: true });
      }
    })().catch(() => undefined);
  };
  const ensureContexts = async () => {
    const latestConfig = await readBridgeConfigFile(configPath);
    if (!restartHandoffConsumed) {
      restartHandoffConsumed = true;
      consumedRestartHandoff = await consumeBridgeRestartHandoffFile({
        path: restartHandoffPath,
        registrations: latestConfig.registrations,
      });
      startupRuntimeConformancePriorityProfileIds =
        consumedRestartHandoffPriorityProfileIds(consumedRestartHandoff);
    }
    let previousAggregateStatus: BridgeStatus | undefined;
    if (existsSync(statusPath)) {
      try {
        previousAggregateStatus = await readJsonFile<BridgeStatus>(statusPath);
      } catch {}
    }
    const activeIds = new Set(
      latestConfig.registrations.map((registration) => registration.deviceId),
    );
    for (const registration of latestConfig.registrations) {
      if (contexts.has(registration.deviceId)) {
        contexts.get(registration.deviceId)!.config = registration;
        continue;
      }
      const workerLog = createWorkerBridgeLogger({
        bridgeToken: registration.bridgeToken,
        deviceId: registration.deviceId,
        logUrl,
      });
      const log = createCompositeBridgeLogger([
        workerLog,
        createLocalAuditBridgeLogger(),
      ]);
      const cloudClient = createCloudClient(registration, {
        requestTimeoutMs: cloudRequestTimeoutMs,
      });
      const hostAdapter = new ConvexBridgeHostAdapter(cloudClient);
      const processRegistryPath = getBridgeProcessRegistryPath(
        parsed.flags,
        registration.deviceId,
      );
      const singletonOwnerPath = getBridgeSingletonOwnerPath(
        parsed.flags,
        registration.deviceId,
      );
      const initialOrgMaxInFlight =
        getInitialOrgMaxInFlight(localHardMaxInFlight);
      const processRegistry = new AcpBridgeProcessRegistry({
        maxProcesses: initialOrgMaxInFlight,
        path: processRegistryPath,
      });
      const singletonGuard = new BridgeSingletonGuard({
        instanceId: getBridgeRuntimeIdentity().instanceId,
        path: singletonOwnerPath,
        processStartToken: BRIDGE_PROCESS_START_TOKEN,
        processStartedAt: getBridgeRuntimeIdentity().processStartedAt,
        registrationKey: registration.deviceId,
      });
      const supervisor = openBridgeSupervisor({
        bridgeDeviceId: registration.deviceId,
        host: hostAdapter,
        journalPath: getBridgeJournalPath(parsed.flags, registration.deviceId),
        processRegistry,
      });
      await supervisor.reconcileProcessesBeforeClaiming();
      await supervisor.publishHealthDiagnostic({
        bridgeDeviceId: registration.deviceId,
      });
      await supervisor.replayOutboxBeforeClaiming();
      let runtimeContext: RuntimeContext | undefined;
      const manager = new BridgeSessionManager({
        cloudClient,
        deviceId: registration.deviceId,
        agentCommand,
        runtimeProfiles,
        currentMcpManifestHash: () =>
          getBridgeRuntimeIdentity().mcpManifestHash,
        currentToolPolicyHash: () =>
          getBridgeRuntimeIdentity().toolPolicyHash,
        requestTimeoutMs,
        toolResultTimeoutMs,
        resumeEnabled,
        idleSessionTtlMs,
        requireScopedIdentity: true,
        createMcpServers: ({ agentSessionId, threadId }) => {
          const currentRegistration = runtimeContext?.config ?? registration;
          if (!agentSessionId) {
            throw new Error(
              "agent tool MCP context is missing agentSessionId; reconnect the agent",
            );
          }
          return buildAgentToolsMcpServers({
            agentSessionId,
            appUrl: currentRegistration.appUrl,
            agentToolsUrl: currentRegistration.appUrl,
            bridgeToken: currentRegistration.bridgeToken,
            deviceId: currentRegistration.deviceId,
            enabledFeatureFlags: currentRegistration.enabledFeatureFlags,
            threadId,
          });
        },
        log,
        allowRemoteCwd,
        processRegistry,
        supervisor,
        onQueueResultMarked: recordSuccessfulRuntimeConformance,
      });
      const wakeSignal = createBridgeWakeSignal({
        config: registration,
        convexUrl: getConvexUrl(parsed.flags, registration),
        limit: initialOrgMaxInFlight,
        log,
      });
      const initialCapacity = buildBridgeCapacitySnapshot(
        contexts.values(),
        localHardMaxInFlight,
        initialOrgMaxInFlight,
      );
      const previousStatus =
        previousAggregateStatus?.registrations?.find(
          (candidate) => candidate.deviceId === registration.deviceId,
        ) ??
        (previousAggregateStatus?.deviceId === registration.deviceId
          ? previousAggregateStatus
          : undefined);
      const handoffEntry = consumedRestartHandoff?.entries.find(
        (entry) => entry.deviceId === registration.deviceId,
      );
      const status: BridgeStatus = {
        deviceId: registration.deviceId,
        appUrl: registration.appUrl,
        connected: true,
        lifecycle: "running",
        updateState: buildBridgeUpdateState("upToDate", Date.now()),
        devHotReload: process.env.ZERO_CHAT_DEV_HOT_RELOAD
          ? {
              enabled: true,
              lastRestartReason: process.env.ZERO_CHAT_DEV_HOT_RELOAD_REASON,
              pendingRestart: false,
            }
          : {
              enabled: false,
              pendingRestart: false,
            },
        lastStartedAt: new Date().toISOString(),
        maxInFlight: initialOrgMaxInFlight,
        capacity: initialCapacity,
        acpResumeEnabled: resumeEnabled,
        acpIdleTtlMs: idleSessionTtlMs,
        runtimeIdentity: getBridgeRuntimeIdentity(),
        controlCommandStatus: reconcileBridgeStartupControlCommandStatus(
          previousStatus,
          getBridgeRuntimeIdentity(),
        ),
        restartHandoff:
          consumedRestartHandoff && handoffEntry
            ? buildRestartHandoffStatus(
                consumedRestartHandoff,
                handoffEntry,
                Date.now(),
              )
            : undefined,
        hermesProfiles,
        runtimeProfiles,
        activeSessions: [],
        inFlightCommands: [],
        sessionQueues: [],
        processHealth: mergeBridgeProcessHealth(
          supervisor.getProcessHealth(),
          singletonGuard.getStatus(),
          processRegistryPath,
        ),
        runtimeConformance: runtimeConformanceSummary(),
        recentErrors: [],
        localJournal: bridgeSupervisorHealthStatus(supervisor),
      };
      const context: RuntimeContext = {
        closing: false,
        config: registration,
        inFlightCommands: new Map(),
        inFlightCommandMetadata: new Map(),
        lastJournalHealthSignature: bridgeSupervisorHealthSignature(supervisor),
        lastProcessOrphanCleanupAt: 0,
        lastStaleCleanupAt: 0,
        log,
        manager,
        processRegistry,
        processRegistryPath,
        singletonGuard,
        status,
        supervisor,
        wakeSignal,
        orgMaxInFlight: initialOrgMaxInFlight,
      };
      runtimeContext = context;
      const restartHandoffSeededSessionCount =
        handoffEntry && manager.seedWarmRuntimeSessions
          ? manager.seedWarmRuntimeSessions({
              candidates: handoffEntry.sessionWarmupHints.map((hint) => ({
                ...hint,
                bridgeProfileId: hint.bridgeProfileId ?? hint.runtimeProfileId,
              })),
            })
          : 0;
      contexts.set(registration.deviceId, context);
      log({
        level: "info",
        event: "bridge.start",
        deviceId: registration.deviceId,
        activeSessionCount: 0,
        acpResumeEnabled: resumeEnabled,
        acpIdleTtlMs: idleSessionTtlMs,
        bridgeRuntimeIdentity: getBridgeRuntimeIdentity(),
        processStartToken: BRIDGE_PROCESS_START_TOKEN,
        runtimeConformance: runtimeConformanceSummary(),
        restartHandoffConsumed: Boolean(handoffEntry),
        restartHandoffSeededSessionCount,
        restartHandoffSessionHintCount:
          handoffEntry?.sessionWarmupHints.length,
      });
    }
    for (const [deviceId, context] of contexts) {
      if (activeIds.has(deviceId) || context.inFlightCommands.size > 0) {
        continue;
      }
      context.closing = true;
      context.status.connected = false;
      await context.wakeSignal.close();
      await context.loopTask?.catch(() => undefined);
      await context.manager.close();
      context.supervisor.close();
      await context.singletonGuard.release();
      await context.log.flush();
      contexts.delete(deviceId);
    }
    await persistAggregateStatus();
  };
  const idleWakeSignalTimeoutMs = (context: RuntimeContext) => {
    const fallbackMs = Math.max(pollMs, 30_000);
    if (!context.wakeSignal.isWakeSubscriptionActive?.()) {
      return fallbackMs;
    }
    const refreshAt = context.wakeSignal.nextWakeTokenRefreshAt?.();
    if (typeof refreshAt !== "number" || !Number.isFinite(refreshAt)) {
      return fallbackMs;
    }
    const refreshDelayMs = refreshAt - Date.now();
    return refreshDelayMs > 0
      ? Math.max(Math.min(refreshDelayMs, DEFAULT_IDLE_HEARTBEAT_MS), pollMs)
      : fallbackMs;
  };
  const waitForContextWakeSignal = async (
    context: RuntimeContext,
  ): Promise<BridgeLoopPollReason> => {
    const timeoutMs =
      totalInFlight() > 0 ? pollMs : idleWakeSignalTimeoutMs(context);
    const result = await context.wakeSignal.wait(timeoutMs);
    return result === "signal" ? "wake" : "timer";
  };

  await ensureContexts();
  await refreshRuntimeConformanceIfStale({ force: true });
  writeStdout(
    buildStartupSecuritySummary({ allowRemoteCwd, configPath, logUrl }),
  );
  writeStdout(
    `Started bridge for ${contexts.size} registered link${contexts.size === 1 ? "" : "s"}. Press Ctrl+C to stop.\n`,
  );

  const recordLoopError =
    (context: RuntimeContext) => async (error: unknown) => {
      const message = redactForOutput(
        error instanceof Error ? error.message : String(error),
      );
      context.status.recentErrors.push(message);
      context.status.recentErrors = context.status.recentErrors.slice(-10);
      context.log({
        level: "error",
        event: "bridge.loop.error",
        deviceId: context.config.deviceId,
        activeSessionCount: context.manager.getStatus().activeSessions.length,
        error: message,
      });
      syncBridgeRuntimeStatus(
        context.status,
        context.manager,
        context.orgMaxInFlight,
        context.inFlightCommandMetadata,
      );
      await persistAggregateStatus();
    };
  const stop = async (
    options: {
      forceRuntimeProcesses?: boolean;
      reason?: string;
      shutdownTimeoutMs?: number;
      signal?: NodeJS.Signals;
      skipLoopTask?: Promise<void>;
    } = {},
  ) => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const context of contexts.values()) {
      context.closing = true;
    }
    if (options.signal) {
      for (const context of contexts.values()) {
        syncBridgeRuntimeStatus(
          context.status,
          context.manager,
          context.orgMaxInFlight,
          context.inFlightCommandMetadata,
        );
      }
      await persistRestartHandoffForStatuses(restartHandoffPath, {
        reason: "restartWhenIdle",
        status: "processSignal",
        statuses: Array.from(contexts.values()).map(
          (context) => context.status,
        ),
        targetVersion: BRIDGE_VERSION,
      });
    }
    for (const context of contexts.values()) {
      if (options.signal) {
        context.log({
          level: "info",
          event: "bridge.signal.received",
          deviceId: context.config.deviceId,
          signal: options.signal,
          reason: options.reason,
        });
      }
      context.status.connected = false;
      syncBridgeRuntimeStatus(
        context.status,
        context.manager,
        context.orgMaxInFlight,
        context.inFlightCommandMetadata,
      );
      context.status.localJournal = bridgeSupervisorHealthStatus(
        context.supervisor,
      );
      context.log({
        level: "info",
        event: "bridge.stop",
        deviceId: context.config.deviceId,
        activeSessionCount: context.manager.getStatus().activeSessions.length,
        reason: options.reason,
        signal: options.signal,
      });
      const shutdownTask = (async () => {
        await context.wakeSignal.close();
        if (
          context.loopTask &&
          context.loopTask !== options.skipLoopTask
        ) {
          await context.loopTask.catch(() => undefined);
        }
        if (options.forceRuntimeProcesses) {
          context.supervisor.close();
        }
        await context.manager.close();
        if (!options.forceRuntimeProcesses) {
          context.supervisor.close();
        }
        await Promise.allSettled(context.inFlightCommands.values());
        await context.singletonGuard.release();
        await context.log.flush();
      })();
      const shutdownResult =
        options.shutdownTimeoutMs === undefined
          ? await shutdownTask.then(() => "completed" as const)
          : await waitForRestartShutdownTask(
              shutdownTask,
              options.shutdownTimeoutMs,
            );
      if (shutdownResult === "timed_out") {
        context.log({
          level: "warn",
          event: "bridge.stop.timeout",
          deviceId: context.config.deviceId,
          timeoutMs: options.shutdownTimeoutMs,
        });
      }
      context.log({
        level: "info",
        event: "bridge.process.exiting",
        deviceId: context.config.deviceId,
        reason: options.reason ?? "stop completed",
        signal: options.signal,
      });
      await context.log.flush();
    }
    await persistAggregateStatus();
  };

  const applyBridgeSettingsControl = (
    context: RuntimeContext,
    settings: BridgeControlResponse["settings"],
  ) => {
    const nextMaxInFlight = normalizeControlMaxInFlight(
      settings?.maxInFlight,
    );
    if (nextMaxInFlight === undefined) {
      return;
    }
    const updatedAt = normalizeControlUpdatedAt(settings?.updatedAt);
    if (
      updatedAt !== undefined &&
      context.orgMaxInFlightUpdatedAt !== undefined &&
      updatedAt < context.orgMaxInFlightUpdatedAt
    ) {
      return;
    }
    context.orgMaxInFlight = nextMaxInFlight;
    context.orgMaxInFlightUpdatedAt = updatedAt;
    context.processRegistry.setMaxProcesses(nextMaxInFlight);
    context.status.maxInFlight = nextMaxInFlight;
    context.status.capacity = {
      ...buildBridgeCapacitySnapshot(contexts.values(), localHardMaxInFlight),
      orgMaxInFlight: nextMaxInFlight,
    };
  };

  const logProcessException = (kind: string, error: unknown) => {
    const message = redactForOutput(
      error instanceof Error ? error.message : String(error),
    );
    for (const context of contexts.values()) {
      context.log({
        level: "error",
        event: "bridge.exception",
        deviceId: context.config.deviceId,
        error: message,
        exceptionKind: kind,
      });
    }
  };

  process.on("uncaughtExceptionMonitor", (error) => {
    logProcessException("uncaughtException", error);
  });
  process.on("unhandledRejection", (error) => {
    logProcessException("unhandledRejection", error);
  });
  process.once("SIGINT", () =>
    void stop({ reason: "process signal", signal: "SIGINT" }),
  );
  process.once("SIGTERM", () =>
    void stop({ reason: "process signal", signal: "SIGTERM" }),
  );

  const reserveClaimSlotsForContext = (
    context: RuntimeContext,
  ): BridgeClaimSlotReservation => {
    const bridgeCapacity = buildBridgeCapacitySnapshot(
      contexts.values(),
      localHardMaxInFlight,
    );
    const availableProcessSlots = Math.max(
      0,
      (bridgeCapacity.bridgeMaxInFlight ?? 0) -
        (bridgeCapacity.processSlotUsage ?? totalInFlight()) -
        reservedClaimSlots,
    );
    const availableOrgSlots = Math.max(
      0,
      context.orgMaxInFlight - context.inFlightCommands.size,
    );
    const reservedSlots = Math.min(availableOrgSlots, availableProcessSlots);
    reservedClaimSlots += reservedSlots;
    let released = false;
    return {
      maxInFlight: context.inFlightCommands.size + reservedSlots,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        reservedClaimSlots = Math.max(0, reservedClaimSlots - reservedSlots);
      },
    };
  };

  const runContextLoopPass = async (
    context: RuntimeContext,
    loopPollReason: BridgeLoopPollReason,
  ): Promise<BridgeLoopIterationResult> => {
    const pollReason =
      loopPollReason === "timer" &&
      !context.wakeSignal.isWakeSubscriptionActive?.()
        ? "wake"
        : loopPollReason;
    const bridgeCapacity = buildBridgeCapacitySnapshot(
      contexts.values(),
      localHardMaxInFlight,
    );
    context.status.capacity = {
      ...bridgeCapacity,
      orgMaxInFlight: context.orgMaxInFlight,
    };
    context.status.localJournal = bridgeSupervisorHealthStatus(
      context.supervisor,
    );
    const singletonStatus = await context.singletonGuard.reconcile();
    context.status.processHealth = mergeBridgeProcessHealth(
      context.supervisor.getProcessHealth(),
      singletonStatus,
      context.processRegistryPath,
    );
    const processOrphanCleanupNow = Date.now();
    if (
      shouldCleanupBridgeOrphanedProcesses({
        inFlightCommandCount: context.inFlightCommands.size,
        managerStatus: context.manager.getStatus(),
        singletonCanClaim: singletonStatus.canClaim,
      }) &&
      processOrphanCleanupNow - context.lastProcessOrphanCleanupAt >=
      DEFAULT_PROCESS_ORPHAN_CLEANUP_MS
    ) {
      context.lastProcessOrphanCleanupAt = processOrphanCleanupNow;
      try {
        const orphanCleanup =
          await context.supervisor.cleanupOrphanedProcesses();
        if (
          orphanCleanup &&
          (orphanCleanup.orphanedProcessCount > 0 ||
            orphanCleanup.terminatedOrphanedProcessCount > 0)
        ) {
          context.log({
            level: "warn",
            event: "bridge.process.orphan_cleanup",
            deviceId: context.config.deviceId,
            orphanedProcessCount: orphanCleanup.orphanedProcessCount,
            terminatedOrphanedProcessCount:
              orphanCleanup.terminatedOrphanedProcessCount,
          });
        }
      } catch (error) {
        const message = redactForOutput(
          error instanceof Error ? error.message : String(error),
        );
        context.log({
          level: "warn",
          event: "bridge.process.orphan_cleanup_failed",
          deviceId: context.config.deviceId,
          error: message,
        });
      }
      context.status.processHealth = mergeBridgeProcessHealth(
        context.supervisor.getProcessHealth(),
        context.singletonGuard.getStatus(),
        context.processRegistryPath,
      );
    }
    await publishBridgeSupervisorHealthIfChanged(context);
    const watchdogFailures = context.supervisor.checkWatchdogs();
    for (const watchdog of watchdogFailures) {
      if (watchdog.checkpoint === "quiet") {
        continue;
      }
      context.log({
        level: "warn",
        event: "bridge.watchdog.timeout",
        deviceId: context.config.deviceId,
        queueId: watchdog.queueItemId,
        reason: watchdog.reasonCode,
      });
    }
    return await runBridgeLoopIteration({
      config: context.config,
      agentCommand,
      runtimeCommands: customRuntimeCommands,
      status: context.status,
      maxInFlight: context.inFlightCommands.size,
      getStatusMaxInFlight: () => context.orgMaxInFlight,
      manager: context.manager,
      inFlightCommands: context.inFlightCommands,
      inFlightCommandMetadata: context.inFlightCommandMetadata,
      watchdogFailures,
      lastStaleCleanupAt: context.lastStaleCleanupAt,
      setLastStaleCleanupAt: (value) => {
        context.lastStaleCleanupAt = value;
      },
      staleCleanupTimeoutMs: Math.min(
        cloudRequestTimeoutMs,
        DEFAULT_STALE_CLEANUP_TIMEOUT_MS,
      ),
      cloudRequestTimeoutMs,
      applySettingsControl: (settings) => {
        applyBridgeSettingsControl(context, settings);
      },
      applyFeatureFlagsControl: async () => {
        await appendBridgeRegistration(configPath, context.config);
      },
      log: context.log,
      recordLoopError: recordLoopError(context),
      statusPath,
      canClaimWork: () => context.supervisor.canClaimWork(),
      getProcessHealth: () =>
        mergeBridgeProcessHealth(
          context.supervisor.getProcessHealth(),
          context.singletonGuard.getStatus(),
          context.processRegistryPath,
        ),
      getRuntimeConformance: runtimeConformanceSummary,
      writeStatus: persistAggregateStatus,
      wakeSignal: context.wakeSignal,
      warmRuntimeProfileIds: bridgeWarmRuntimeProfileIdsForStatus(
        warmRuntimeProfileIds,
        context.status,
      ),
      heartbeatIntervalMs:
        pollReason === "timer" ? 0 : DEFAULT_HEARTBEAT_MS,
      pollReason,
      reserveClaimSlots: () => reserveClaimSlotsForContext(context),
      restartHandoffPath,
      isProcessIdleForRestart: () => totalInFlight() === 0,
    });
  };

  const startContextLoop = (context: RuntimeContext) => {
    if (context.loopTask || context.closing) {
      return;
    }
    const task = runBridgeRegistrationScheduler({
      context,
      isActive: (candidate) =>
        !stopping &&
        !candidate.closing &&
        contexts.get(candidate.config.deviceId) === candidate,
      onRestartRequested: async (candidate) => {
        await persistRestartHandoffForStatuses(restartHandoffPath, {
          reason: restartHandoffReasonForStatus(candidate.status),
          status: candidate.status.updateState?.status ?? "restarting",
          statuses: Array.from(contexts.values()).map(
            (context) => context.status,
          ),
          targetVersion:
            candidate.status.controlCommandStatus?.targetVersion ??
            candidate.status.updateState?.targetVersion ??
            BRIDGE_VERSION,
        });
        await stop({
          forceRuntimeProcesses: true,
          reason: "runtime restart requested",
          shutdownTimeoutMs: DEFAULT_RESTART_STOP_TIMEOUT_MS,
          skipLoopTask: candidate.loopTask,
        });
        process.exit(0);
      },
      runContextPass: runContextLoopPass,
      totalInFlight,
      waitForWakeSignal: waitForContextWakeSignal,
    })
      .catch(recordLoopError(context))
      .finally(() => {
        if (context.loopTask === task) {
          context.loopTask = undefined;
        }
      });
    context.loopTask = task;
  };

  const startContextLoops = () => {
    for (const context of contexts.values()) {
      startContextLoop(context);
    }
  };

  while (!stopping) {
    await ensureContexts();
    await refreshRuntimeConformanceIfStale();
    startContextLoops();
    if (cachedRuntimeCatalog && !startupRuntimeCatalogRefreshScheduled) {
      startupRuntimeCatalogRefreshScheduled = true;
      refreshRuntimeCatalogInBackground();
    }
    await sleep(pollMs);
  }
}

export async function refreshRuntimeConformanceProfilesForTest(input: {
  getInFlightProfileIds: () => Set<string>;
  getRunningSessionProfileIds: () => Set<string>;
  now: () => number;
  probeProfile: (
    profile: BridgeRuntimeProfile,
  ) => Promise<RuntimeConformanceRecord>;
  profiles: BridgeRuntimeProfile[];
  priorityProfileIds?: string[];
  records: Record<string, RuntimeConformanceRecord>;
  ttlMs: number;
}): Promise<Record<string, RuntimeConformanceRecord>> {
  const refreshed = await refreshRuntimeConformanceProfiles({
    ...input,
    lastProbeAtByProfile: new Map(
      Object.entries(input.records).map(([profileId, record]) => [
        profileId,
        record.checkedAt,
      ]),
    ),
  });
  return refreshed.records;
}

async function refreshRuntimeConformanceProfiles(input: {
  force?: boolean;
  getInFlightProfileIds: () => Set<string>;
  getRunningSessionProfileIds: () => Set<string>;
  lastProbeAtByProfile: Map<string, number>;
  now: () => number;
  probeProfile: (
    profile: BridgeRuntimeProfile,
  ) => Promise<RuntimeConformanceRecord>;
  profiles: BridgeRuntimeProfile[];
  priorityProfileIds?: string[];
  records: Record<string, RuntimeConformanceRecord>;
  ttlMs: number;
}): Promise<{ records: Record<string, RuntimeConformanceRecord> }> {
  const nextRecords = { ...input.records };
  const priorityProfileIds = new Set(input.priorityProfileIds ?? []);
  const profiles = prioritizeRuntimeConformanceProfiles(
    input.profiles.filter(
      (candidate) =>
        candidate.status === "available" ||
        !isLaunchSpecRuntimeProfile(candidate),
    ),
    input.priorityProfileIds ?? [],
  );
  for (const profile of profiles) {
    if (
      isLaunchSpecRuntimeProfile(profile) &&
      !priorityProfileIds.has(profile.id)
    ) {
      continue;
    }
    const lastProbeAt =
      input.lastProbeAtByProfile.get(profile.id) ??
      nextRecords[profile.id]?.checkedAt ??
      0;
    if (
      shouldRefreshRuntimeConformanceProfile({
        force: input.force || priorityProfileIds.has(profile.id),
        inFlightProfileIds: input.getInFlightProfileIds(),
        lastProbeAt,
        now: input.now(),
        profileId: profile.id,
        runningSessionProfileIds: input.getRunningSessionProfileIds(),
        ttlMs: input.ttlMs,
      })
    ) {
      const record = await input.probeProfile(profile);
      nextRecords[profile.id] = record;
      input.lastProbeAtByProfile.set(profile.id, record.checkedAt);
    }
  }
  return { records: nextRecords };
}

function prioritizeRuntimeConformanceProfiles(
  profiles: BridgeRuntimeProfile[],
  priorityProfileIds: string[],
): BridgeRuntimeProfile[] {
  if (priorityProfileIds.length === 0) {
    return profiles;
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const prioritized: BridgeRuntimeProfile[] = [];
  const seen = new Set<string>();
  for (const profileId of priorityProfileIds) {
    const profile = byId.get(profileId);
    if (profile && !seen.has(profile.id)) {
      prioritized.push(profile);
      seen.add(profile.id);
    }
  }
  for (const profile of profiles) {
    if (!seen.has(profile.id)) {
      prioritized.push(profile);
    }
  }
  return prioritized;
}

function isLaunchSpecRuntimeProfile(profile: BridgeRuntimeProfile): boolean {
  return Boolean(profile.hermesProfileName) || profile.id.includes("|hermes-profile:");
}

function bridgeInFlightRuntimeProfileIds(
  contexts: Iterable<{ inFlightCommandMetadata: Map<string, InFlightCommandMetadata> }>,
): Set<string> {
  const profileIds = new Set<string>();
  for (const context of contexts) {
    for (const command of context.inFlightCommandMetadata.values()) {
      if (command.bridgeProfileId) {
        profileIds.add(command.bridgeProfileId);
      }
    }
  }
  return profileIds;
}

function bridgeRunningSessionRuntimeProfileIds(
  contexts: Iterable<{ manager: BridgeLoopManager }>,
): Set<string> {
  const profileIds = new Set<string>();
  for (const context of contexts) {
    const status = context.manager.getStatus();
    for (const session of status.sessions) {
      if (session.runningQueueItemId && session.runtimeProfileId) {
        profileIds.add(session.runtimeProfileId);
      }
    }
    for (const session of status.liveness?.activeSessions ?? []) {
      if (session.bridgeProfileId) {
        profileIds.add(session.bridgeProfileId);
      }
    }
  }
  return profileIds;
}

function bridgeActiveRuntimeProfileIds(
  contexts: Iterable<{
    inFlightCommandMetadata: Map<string, InFlightCommandMetadata>;
    manager: BridgeLoopManager;
  }>,
): Set<string> {
  const contextList = Array.from(contexts);
  return new Set([
    ...bridgeInFlightRuntimeProfileIds(contextList),
    ...bridgeRunningSessionRuntimeProfileIds(contextList),
  ]);
}

function buildHermesLaunchSpecRuntimeProfiles(input: {
  hermesProfiles: HermesProfileSummary[];
  runtimeProfiles: BridgeRuntimeProfile[];
}): BridgeRuntimeProfile[] {
  const hermesRuntimeProfile = input.runtimeProfiles.find(
    (profile) => profile.kind === "hermes" && profile.status === "available",
  );
  if (!hermesRuntimeProfile) {
    return [];
  }
  return input.hermesProfiles.flatMap((profile) => {
    const profileName = profile.name.trim();
    if (!profileName) {
      return [];
    }
    const launchSpec = buildBridgeLaunchSpec({
      bridgeProfileId: hermesRuntimeProfile.id,
      hermesProfileName: profileName,
      runtimeProfile: hermesRuntimeProfile,
    });
    return [
      {
        ...hermesRuntimeProfile,
        command: launchSpec.agentCommand,
        hermesProfileName: profileName,
        id: launchSpec.key,
        label: `${hermesRuntimeProfile.label}: ${profileName}`,
      },
    ];
  });
}

function buildAggregateBridgeStatus(
  contexts: Array<{
    config: BridgeRegistration;
    status: BridgeStatus;
  }>,
  capacity: NonNullable<BridgeStatus["capacity"]>,
): BridgeStatus {
  const first = contexts[0];
  const registrations = contexts.map(({ config, status }) => ({
    deviceId: config.deviceId,
    appUrl: config.appUrl,
    deviceName: config.deviceName,
    connected: status.connected,
    lifecycle: status.lifecycle,
    updateState: status.updateState,
    devHotReload: status.devHotReload,
    controlCommandStatus: status.controlCommandStatus,
    restartHandoff: status.restartHandoff,
    lastStartedAt: status.lastStartedAt,
    lastHeartbeatAt: status.lastHeartbeatAt,
    lastPollAt: status.lastPollAt,
    maxInFlight: status.maxInFlight,
    capacity: status.capacity,
    runtimeIdentity: status.runtimeIdentity,
    activeSessions: status.activeSessions,
    inFlightCommands: status.inFlightCommands,
    retainedSessions: status.retainedSessions,
    sessionQueues: status.sessionQueues,
    processHealth: status.processHealth,
    runtimeConformance: status.runtimeConformance,
    liveness: status.liveness,
    availability: status.availability,
    lastStaleCleanupAt: status.lastStaleCleanupAt,
    lastStaleCleanup: status.lastStaleCleanup,
    recentErrors: status.recentErrors,
    registrationFailure: status.registrationFailure,
  }));
  return {
    deviceId: first?.config.deviceId,
    appUrl: first?.config.appUrl,
    connected: registrations.some((registration) => registration.connected),
    lifecycle: first?.status.lifecycle,
    updateState: first?.status.updateState,
    devHotReload: first?.status.devHotReload,
    controlCommandStatus: first?.status.controlCommandStatus,
    restartHandoff: first?.status.restartHandoff,
    lastStartedAt: first?.status.lastStartedAt,
    lastHeartbeatAt: first?.status.lastHeartbeatAt,
    lastPollAt: first?.status.lastPollAt,
    maxInFlight: capacity.bridgeMaxInFlight,
    capacity,
    runtimeIdentity: first?.status.runtimeIdentity,
    acpResumeEnabled: first?.status.acpResumeEnabled,
    acpIdleTtlMs: first?.status.acpIdleTtlMs,
    hermesProfiles: first?.status.hermesProfiles,
    runtimeProfiles: first?.status.runtimeProfiles,
    activeSessions: registrations.flatMap(
      (registration) => registration.activeSessions,
    ),
    inFlightCommands: registrations.flatMap(
      (registration) => registration.inFlightCommands ?? [],
    ),
    retainedSessions: registrations.flatMap(
      (registration) =>
        registration.retainedSessions ?? registration.sessionQueues ?? [],
    ),
    sessionQueues: registrations.flatMap(
      (registration) => registration.sessionQueues ?? [],
    ),
    processHealth: first?.status.processHealth,
    runtimeConformance: first?.status.runtimeConformance,
    liveness: first?.status.liveness,
    availability: first?.status.availability,
    lastStaleCleanupAt: first?.status.lastStaleCleanupAt,
    lastStaleCleanup: first?.status.lastStaleCleanup,
    recentErrors: registrations
      .flatMap((registration) => registration.recentErrors)
      .slice(-10),
    registrations,
    registrationFailure: first?.status.registrationFailure,
  };
}

function normalizeControlCommand(
  command?: BridgeControlCommandState,
): BridgeControlCommandState | undefined {
  if (
    command?.command !== "restartWhenIdle" &&
    command?.command !== "updateWhenIdle"
  ) {
    return undefined;
  }
  return {
    command: command.command,
    requestedAt:
      typeof command.requestedAt === "number" ? command.requestedAt : undefined,
  };
}

function normalizeControlCommandStatus(
  value?: BridgeControlCommandStatus,
): BridgeControlCommandStatus | undefined {
  if (
    value?.command !== "restartWhenIdle" &&
    value?.command !== "updateWhenIdle"
  ) {
    return undefined;
  }
  if (
    value.status !== "accepted" &&
    value.status !== "waiting_for_idle" &&
    value.status !== "executing" &&
    value.status !== "succeeded" &&
    value.status !== "failed"
  ) {
    return undefined;
  }
  return compact({
    acceptedAt:
      typeof value.acceptedAt === "number" ? value.acceptedAt : undefined,
    command: value.command,
    completedAt:
      typeof value.completedAt === "number" ? value.completedAt : undefined,
    error: boundControlCommandError(value.error),
    failedAt: typeof value.failedAt === "number" ? value.failedAt : undefined,
    instanceId: stringFromUnknown(value.instanceId),
    requestedAt:
      typeof value.requestedAt === "number" ? value.requestedAt : undefined,
    startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined,
    status: value.status,
    targetVersion: boundControlCommandTargetVersion(value.targetVersion),
  });
}

function buildControlCommandStatus(
  command: BridgeControlCommandName,
  status: BridgeControlCommandLifecycleStatus,
  patch: Partial<BridgeControlCommandStatus> = {},
): BridgeControlCommandStatus {
  return compact({
    acceptedAt:
      typeof patch.acceptedAt === "number" ? patch.acceptedAt : undefined,
    command,
    completedAt:
      typeof patch.completedAt === "number" ? patch.completedAt : undefined,
    error: boundControlCommandError(patch.error),
    failedAt: typeof patch.failedAt === "number" ? patch.failedAt : undefined,
    instanceId: stringFromUnknown(patch.instanceId),
    requestedAt:
      typeof patch.requestedAt === "number" ? patch.requestedAt : undefined,
    startedAt: typeof patch.startedAt === "number" ? patch.startedAt : undefined,
    status,
    targetVersion: boundControlCommandTargetVersion(patch.targetVersion),
  });
}

function boundControlCommandError(value: unknown): string | undefined {
  const text = stringFromUnknown(value);
  if (!text) {
    return undefined;
  }
  const bounded = redactForOutput(text).trim();
  return bounded
    ? bounded.slice(0, MAX_CONTROL_COMMAND_ERROR_LENGTH)
    : undefined;
}

function boundControlCommandTargetVersion(value: unknown): string | undefined {
  const text = stringFromUnknown(value)?.trim();
  return text
    ? text.slice(0, MAX_CONTROL_COMMAND_TARGET_VERSION_LENGTH)
    : undefined;
}

function bridgeRestartHandoffAppUrlHash(appUrl: string): string {
  return createHash("sha256").update(appUrl).digest("hex").slice(0, 32);
}

export function buildBridgeRestartHandoff(input: {
  createdAt?: number;
  reason: BridgeRestartHandoffReason;
  status?: string;
  statuses: BridgeStatus[];
  targetVersion?: string;
}): BridgeRestartHandoff {
  const createdAt = input.createdAt ?? Date.now();
  return {
    schemaVersion: BRIDGE_RESTART_HANDOFF_SCHEMA_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    createdAt,
    expiresAt: createdAt + BRIDGE_RESTART_HANDOFF_TTL_MS,
    reason: input.reason,
    status: boundRestartHandoffStatus(input.status),
    targetVersion: boundControlCommandTargetVersion(input.targetVersion),
    entries: input.statuses
      .map((status) => buildBridgeRestartHandoffEntry(status))
      .filter(
        (entry): entry is BridgeRestartHandoffEntry => entry !== undefined,
      ),
  };
}

function buildBridgeRestartHandoffEntry(
  status: BridgeStatus,
): BridgeRestartHandoffEntry | undefined {
  if (!status.deviceId || !status.appUrl) {
    return undefined;
  }
  const runtimeProfileIds = Array.from(
    new Set([
      ...(status.runtimeProfiles ?? []).map((profile) => profile.id),
      ...(status.sessionQueues ?? [])
        .map((session) => session.runtimeProfileId)
        .filter((id): id is string => Boolean(id)),
    ]),
  )
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, BRIDGE_RESTART_HANDOFF_MAX_PROFILES);
  const sessionWarmupHints = (status.sessionQueues ?? [])
    .filter((session) => session.threadId.trim())
    .map((session) =>
      compact({
        agentSessionId: session.agentSessionId,
        bridgeProfileId: session.bridgeProfileId ?? session.runtimeProfileId,
        claimId: session.claimId,
        hermesProfileName: session.hermesProfileName,
        lastActivityAt: session.lastActivityAt,
        lastUsedAt:
          typeof session.lastUsedAt === "number" &&
          Number.isFinite(session.lastUsedAt)
            ? session.lastUsedAt
            : undefined,
        organizationId: session.organizationId,
        queueItemId: session.runningQueueItemId,
        runtimeProfileId: session.runtimeProfileId,
        sessionKey: session.sessionKey,
        threadId: session.threadId,
      }),
    )
    .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))
    .slice(0, BRIDGE_RESTART_HANDOFF_MAX_SESSIONS);
  return {
    appUrlHash: bridgeRestartHandoffAppUrlHash(status.appUrl),
    deviceId: status.deviceId,
    runtimeProfileIds,
    sessionWarmupHints,
  };
}

export async function writeBridgeRestartHandoffFile(
  path: string,
  value: unknown,
): Promise<void> {
  await writeSecureJsonFile(path, value);
}

export async function consumeBridgeRestartHandoffFile(input: {
  now?: () => number;
  path: string;
  registrations: BridgeRegistration[];
}): Promise<BridgeRestartHandoff | undefined> {
  if (!existsSync(input.path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(input.path);
  } catch {
    await unlinkIfExists(input.path);
    return undefined;
  }
  const metadata = normalizeBridgeRestartHandoffMetadata(raw, input.now);
  if (!metadata) {
    await unlinkIfExists(input.path);
    return undefined;
  }
  const record = recordFromUnknown(raw);
  const validEntries = arrayOfRecords(record?.entries).flatMap((entry) => {
    const normalized = normalizeBridgeRestartHandoffEntry(entry);
    return normalized ? [normalized] : [];
  });
  if (validEntries.length === 0) {
    await unlinkIfExists(input.path);
    return undefined;
  }
  const registrationScopes = bridgeRestartHandoffRegistrationScopes(
    input.registrations,
  );
  const consumedEntries = validEntries.filter((entry) =>
    bridgeRestartHandoffEntryMatches(entry, registrationScopes),
  );
  if (consumedEntries.length === 0) {
    return undefined;
  }
  const remainingEntries = validEntries.filter(
    (entry) => !bridgeRestartHandoffEntryMatches(entry, registrationScopes),
  );
  if (remainingEntries.length === 0) {
    await unlinkIfExists(input.path);
  } else {
    await writeBridgeRestartHandoffFile(input.path, {
      ...metadata,
      entries: remainingEntries,
    });
  }
  return {
    ...metadata,
    entries: consumedEntries,
  };
}

function normalizeBridgeRestartHandoffMetadata(
  raw: unknown,
  now: () => number = Date.now,
): Omit<BridgeRestartHandoff, "entries"> | undefined {
  const record = recordFromUnknown(raw);
  if (
    !record ||
    record.schemaVersion !== BRIDGE_RESTART_HANDOFF_SCHEMA_VERSION ||
    !stringFromUnknown(record.bridgeVersion)
  ) {
    return undefined;
  }
  const createdAt = numberFromUnknown(record.createdAt);
  const expiresAt = numberFromUnknown(record.expiresAt);
  if (
    createdAt === undefined ||
    expiresAt === undefined ||
    createdAt > now() + 60_000 ||
    expiresAt < now()
  ) {
    return undefined;
  }
  const reason = normalizeBridgeRestartHandoffReason(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    schemaVersion: BRIDGE_RESTART_HANDOFF_SCHEMA_VERSION,
    bridgeVersion: stringFromUnknown(record.bridgeVersion) ?? BRIDGE_VERSION,
    createdAt,
    expiresAt,
    reason,
    status: boundRestartHandoffStatus(record.status),
    targetVersion: boundControlCommandTargetVersion(record.targetVersion),
  };
}

function bridgeRestartHandoffRegistrationScopes(
  registrations: BridgeRegistration[],
): Map<string, string> {
  return new Map(
    registrations.map((registration) => [
      registration.deviceId,
      bridgeRestartHandoffAppUrlHash(registration.appUrl),
    ]),
  );
}

function bridgeRestartHandoffEntryMatches(
  entry: BridgeRestartHandoffEntry,
  registrationScopes: Map<string, string>,
): boolean {
  return registrationScopes.get(entry.deviceId) === entry.appUrlHash;
}

function boundRestartHandoffStatus(value: unknown): string | undefined {
  const text = stringFromUnknown(value)?.trim();
  return text ? text.slice(0, 64) : undefined;
}

function normalizeBridgeRestartHandoffReason(
  value: unknown,
): BridgeRestartHandoffReason | undefined {
  return value === "restartWhenIdle" ||
    value === "updateWhenIdle" ||
    value === "runtimeProfileRefresh"
    ? value
    : undefined;
}

function normalizeBridgeRestartHandoffEntry(
  record: Record<string, unknown>,
): BridgeRestartHandoffEntry | undefined {
  const deviceId = stringFromUnknown(record.deviceId);
  const appUrlHash = stringFromUnknown(record.appUrlHash);
  if (!deviceId || !appUrlHash) {
    return undefined;
  }
  const runtimeProfileIds = Array.from(
    new Set(
      (stringArrayFromUnknown(record.runtimeProfileIds) ?? [])
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).slice(0, BRIDGE_RESTART_HANDOFF_MAX_PROFILES);
  const sessionWarmupHints: BridgeRestartHandoffEntry["sessionWarmupHints"] =
    [];
  for (const hint of arrayOfRecords(record.sessionWarmupHints)) {
    const threadId = stringFromUnknown(hint.threadId)?.trim();
    if (!threadId) {
      continue;
    }
    const agentSessionId = stringFromUnknown(hint.agentSessionId)?.trim();
    const bridgeProfileId = stringFromUnknown(hint.bridgeProfileId)?.trim();
    const claimId = stringFromUnknown(hint.claimId)?.trim();
    const hermesProfileName = stringFromUnknown(hint.hermesProfileName)?.trim();
    const lastActivityAt = numberFromUnknown(hint.lastActivityAt);
    const lastUsedAt = numberFromUnknown(hint.lastUsedAt);
    const queueItemId = stringFromUnknown(hint.queueItemId)?.trim();
    const runtimeProfileId = stringFromUnknown(hint.runtimeProfileId);
    const organizationId = stringFromUnknown(hint.organizationId)?.trim();
    const sessionId = stringFromUnknown(hint.sessionId)?.trim();
    const sessionKey = stringFromUnknown(hint.sessionKey)?.trim();
    sessionWarmupHints.push({
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(bridgeProfileId ? { bridgeProfileId } : {}),
      ...(claimId ? { claimId } : {}),
      ...(hermesProfileName ? { hermesProfileName } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(queueItemId ? { queueItemId } : {}),
      ...(runtimeProfileId ? { runtimeProfileId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      threadId,
    });
    if (sessionWarmupHints.length >= BRIDGE_RESTART_HANDOFF_MAX_SESSIONS) {
      break;
    }
  }
  return {
    appUrlHash,
    deviceId,
    runtimeProfileIds,
    sessionWarmupHints,
  };
}

function buildRestartHandoffStatus(
  handoff: BridgeRestartHandoff,
  entry: BridgeRestartHandoffEntry,
  now: number,
): BridgeRestartHandoffStatus {
  return {
    consumedAt: new Date(now).toISOString(),
    createdAt: new Date(handoff.createdAt).toISOString(),
    reason: handoff.reason,
    status: handoff.status,
    targetVersion: handoff.targetVersion,
    runtimeProfileIds: entry.runtimeProfileIds,
    startupPriorityRuntimeProfileIds:
      restartHandoffEntryPriorityProfileIds(entry),
    sessionWarmupHints: entry.sessionWarmupHints.map((hint) =>
      compact({
        bridgeProfileId: hint.bridgeProfileId,
        hermesProfileName: hint.hermesProfileName,
        queueItemId: hint.queueItemId,
        runtimeProfileId: hint.runtimeProfileId,
        threadId: hint.threadId,
      }),
    ),
  };
}

function consumedRestartHandoffPriorityProfileIds(
  handoff: BridgeRestartHandoff | undefined,
): string[] {
  if (!handoff) {
    return [];
  }
  return Array.from(
    new Set(handoff.entries.flatMap((entry) => restartHandoffEntryPriorityProfileIds(entry))),
  );
}

function restartHandoffEntryPriorityProfileIds(
  entry: BridgeRestartHandoffEntry,
): string[] {
  return Array.from(
    new Set(
      [
        ...entry.runtimeProfileIds,
        ...entry.sessionWarmupHints
          .flatMap((hint) => [hint.runtimeProfileId, hint.bridgeProfileId])
          .filter((id): id is string => Boolean(id)),
      ]
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).slice(0, BRIDGE_RESTART_HANDOFF_MAX_PROFILES);
}

function bridgeWarmRuntimeProfileIdsForStatus(
  configuredProfileIds: string[],
  status: BridgeStatus,
): string[] {
  return Array.from(
    new Set([
      ...configuredProfileIds,
      ...(status.restartHandoff?.startupPriorityRuntimeProfileIds ?? []),
    ]),
  )
    .map((id) => id.trim())
    .filter(Boolean);
}

async function unlinkIfExists(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  });
}

export function reconcileBridgeStartupControlCommandStatus(
  previousStatus: Pick<BridgeStatus, "controlCommandStatus"> | undefined,
  runtimeIdentity: BridgeRuntimeIdentity = getBridgeRuntimeIdentity(),
  now: () => number = Date.now,
): BridgeControlCommandStatus | undefined {
  const previous = normalizeControlCommandStatus(
    previousStatus?.controlCommandStatus,
  );
  if (!previous) {
    return undefined;
  }
  if (previous.status !== "executing") {
    return previous;
  }
  if (
    previous.targetVersion &&
    runtimeIdentity.bridgeVersion !== previous.targetVersion
  ) {
    return buildControlCommandStatus(previous.command, "failed", {
      acceptedAt: previous.acceptedAt,
      error: `Bridge restarted on version ${runtimeIdentity.bridgeVersion}, not target version ${previous.targetVersion}`,
      failedAt: now(),
      instanceId: runtimeIdentity.instanceId,
      requestedAt: previous.requestedAt,
      startedAt: previous.startedAt,
      targetVersion: previous.targetVersion,
    });
  }
  return buildControlCommandStatus(previous.command, "succeeded", {
    acceptedAt: previous.acceptedAt,
    completedAt: now(),
    instanceId: runtimeIdentity.instanceId,
    requestedAt: previous.requestedAt,
    startedAt: previous.startedAt,
    targetVersion: previous.targetVersion,
  });
}

async function launchBridgeUpdater(
  input: BridgeUpdaterLaunchInput,
): Promise<void> {
  const updaterPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "bridge-updater.ts",
  );
  const args = [
    updaterPath,
    "--repo-path",
    process.cwd(),
    "--status-path",
    input.statusPath,
    "--current-version",
    input.currentVersion,
    "--parent-pid",
    String(process.pid),
    "--restart-handoff-path",
    input.restartHandoffPath,
    ...buildRestartCommandArgs(input.restartCommand),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function getBridgeRestartCommand(): string[] {
  return [process.execPath, ...process.argv.slice(1)];
}

export async function waitForRestartShutdownTask(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<"completed" | "timed_out"> {
  if (timeoutMs <= 0) {
    return "timed_out";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(
        () => "completed" as const,
        () => "completed" as const,
      ),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function applyPendingBridgeControlCommand(
  status: BridgeStatus,
  now: () => number,
  input: Pick<
    BridgeLoopIterationInput,
    | "isProcessIdleForRestart"
    | "launchUpdater"
    | "restartHandoffPath"
    | "statusPath"
    | "writeStatus"
  >,
): Promise<BridgeLoopIterationResult> {
  const command = normalizeControlCommand(status.pendingControlCommand);
  if (!command) {
    return { restartRequested: false };
  }
  const persistStatus = input.writeStatus ?? writeStatus;
  const acceptedAt = status.controlCommandStatus?.acceptedAt;
  const requestedAt = command.requestedAt;
  const startedAt = now();

  const idleDecision = shouldRestartBridgeForDevHotReload(status);
  const processIdle = input.isProcessIdleForRestart?.() ?? true;
  if (!idleDecision.ready || !processIdle) {
    status.lifecycle = "draining";
    status.updateState = buildBridgeUpdateState("waitingForIdle", now(), {
      requestedAt: command.requestedAt,
    });
    status.controlCommandStatus = buildControlCommandStatus(
      command.command,
      "waiting_for_idle",
      {
        acceptedAt,
        requestedAt,
      },
    );
    await persistStatus(input.statusPath, status);
    return { restartRequested: false };
  }

  if (command.command === "updateWhenIdle") {
    status.lifecycle = "updating";
    status.updateState = buildBridgeUpdateState("installing", now(), {
      requestedAt: command.requestedAt,
      startedAt,
    });
    status.pendingControlCommand = undefined;
    status.controlCommandStatus = buildControlCommandStatus(
      command.command,
      "executing",
      {
        acceptedAt,
        requestedAt,
        startedAt,
        targetVersion: BRIDGE_VERSION,
      },
    );
    await persistStatus(input.statusPath, status);
    await persistRestartHandoffForStatuses(input.restartHandoffPath, {
      reason: "updateWhenIdle",
      status: "installing",
      statuses: [status],
      targetVersion: BRIDGE_VERSION,
    });
    try {
      const launchUpdater = input.launchUpdater ?? launchBridgeUpdater;
      await launchUpdater({
        currentVersion: BRIDGE_VERSION,
        requestedAt: command.requestedAt,
        restartHandoffPath: input.restartHandoffPath ?? DEFAULT_RESTART_HANDOFF_PATH,
        restartCommand: getBridgeRestartCommand(),
        statusPath: input.statusPath,
      });
    } catch (error) {
      status.lifecycle = "error";
      status.updateState = buildBridgeUpdateState("failed", now(), {
        requestedAt: command.requestedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      status.controlCommandStatus = buildControlCommandStatus(
        command.command,
        "failed",
        {
          acceptedAt,
          error: error instanceof Error ? error.message : String(error),
          failedAt: now(),
          requestedAt,
          startedAt,
          targetVersion: BRIDGE_VERSION,
        },
      );
      await persistStatus(input.statusPath, status);
      return { restartRequested: false };
    }
    return { restartRequested: true };
  }

  status.lifecycle = "restarting";
  status.updateState = buildBridgeUpdateState("restarting", now(), {
    requestedAt: command.requestedAt,
    startedAt,
    targetVersion: BRIDGE_VERSION,
  });
  status.pendingControlCommand = undefined;
  status.controlCommandStatus = buildControlCommandStatus(
    command.command,
    "executing",
    {
      acceptedAt,
      requestedAt,
      startedAt,
      targetVersion: BRIDGE_VERSION,
    },
  );
  await persistStatus(input.statusPath, status);
  await persistRestartHandoffForStatuses(input.restartHandoffPath, {
    reason: "restartWhenIdle",
    status: "restarting",
    statuses: [status],
    targetVersion: BRIDGE_VERSION,
  });
  return { restartRequested: true };
}

async function persistRestartHandoffForStatuses(
  path: string | undefined,
  input: {
    reason: BridgeRestartHandoffReason;
    status?: string;
    statuses: BridgeStatus[];
    targetVersion?: string;
  },
): Promise<void> {
  if (!path) {
    return;
  }
  const handoff = buildBridgeRestartHandoff(input);
  if (handoff.entries.length === 0) {
    return;
  }
  await writeBridgeRestartHandoffFile(path, handoff);
}

function restartHandoffReasonForStatus(
  status: BridgeStatus,
): BridgeRestartHandoffReason {
  if (status.controlCommandStatus?.command === "updateWhenIdle") {
    return "updateWhenIdle";
  }
  if (status.controlCommandStatus?.command === "restartWhenIdle") {
    return "restartWhenIdle";
  }
  return "runtimeProfileRefresh";
}

function buildWatchdogTerminalizationMetadata(
  watchdog: BridgeLoopWatchdogResult,
  inFlight: InFlightCommandMetadata | undefined,
  now: number,
): BridgeTerminalizationMetadata | undefined {
  if (
    watchdog.checkpoint === "quiet" ||
    watchdog.reasonCode !== "tool_result_timeout"
  ) {
    return undefined;
  }
  const metadata: BridgeTerminalizationMetadata = {
    reasonCode: watchdog.reasonCode,
  };
  let hasStructuredMetadata = false;

  const addString = (
    key:
      | "failureClass"
      | "toolCallId"
      | "toolClass"
      | "toolName"
      | "toolPolicyId",
    value: string | undefined,
  ) => {
    const normalized = value?.trim();
    if (!normalized) {
      return;
    }
    metadata[key] = normalized;
    hasStructuredMetadata = true;
  };
  const addNumber = (
    key: "ageMs" | "timeoutMs",
    value: number | undefined,
  ) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return;
    }
    metadata[key] = value;
    hasStructuredMetadata = true;
  };

  addString("failureClass", watchdog.failureClass ?? inFlight?.failureClass);
  addString("toolCallId", watchdog.toolCallId ?? inFlight?.toolCallId);
  addString("toolName", watchdog.toolName ?? inFlight?.toolName);
  addString("toolClass", watchdog.toolClass ?? inFlight?.toolClass);
  addString("toolPolicyId", watchdog.toolPolicyId ?? inFlight?.toolPolicyId);
  addNumber("timeoutMs", watchdog.timeoutMs ?? inFlight?.timeoutMs);
  addNumber(
    "ageMs",
    watchdog.ageMs ?? inFlight?.ageMs ?? ageMsFromStartedAt(inFlight, now),
  );

  return hasStructuredMetadata ? metadata : undefined;
}

function ageMsFromStartedAt(
  inFlight: InFlightCommandMetadata | undefined,
  now: number,
): number | undefined {
  if (!inFlight?.startedAt) {
    return undefined;
  }
  const startedAtMs = Date.parse(inFlight.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return undefined;
  }
  return Math.max(0, now - startedAtMs);
}

export async function runBridgeLoopIteration(
  input: BridgeLoopIterationInput,
): Promise<BridgeLoopIterationResult> {
  const heartbeat = input.sendHeartbeat ?? sendHeartbeat;
  const discoverProfiles =
    input.discoverHermesProfiles ?? discoverHermesProfiles;
  const discoverRuntimeProfiles =
    input.discoverRuntimeProfiles ?? discoverBridgeRuntimeProfiles;
  const cleanup = input.cleanupStaleClaims ?? cleanupStaleClaims;
  const claim = input.claimCommands ?? claimCommands;
  const markResult = input.markCommandResult ?? markCommandResult;
  const persistStatus = input.writeStatus ?? writeStatus;
  const currentTime = input.now ?? Date.now;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const pollReason = input.pollReason ?? "wake";

  const syncBridgeStatus = () => {
    syncBridgeRuntimeStatus(
      input.status,
      input.manager,
      input.getStatusMaxInFlight?.() ??
        input.statusMaxInFlight ??
        input.maxInFlight,
      input.inFlightCommandMetadata,
      input.getProcessHealth?.(),
      input.getRuntimeConformance?.(),
    );
  };
  const runCommand = (command: BridgeQueueCommand) => {
    const localDispatchAtMs = currentTime();
    const claimedAtMs =
      command.claimedAtMs ??
      timestampMsFromUnknown(command.claimedAt) ??
      localDispatchAtMs;
    const claimedAt =
      command.claimedAt ??
      (claimedAtMs === undefined
        ? undefined
        : new Date(claimedAtMs).toISOString());
    const createdAtMs =
      command.createdAtMs ?? timestampMsFromUnknown(command.createdAt);
    const createdAt =
      command.createdAt ??
      (createdAtMs === undefined
        ? undefined
        : new Date(createdAtMs).toISOString());
    const commandWithTiming: BridgeQueueCommand = {
      ...command,
      createdAt,
      createdAtMs,
      claimedAt,
      claimedAtMs,
    };
    input.inFlightCommandMetadata.set(command.id, {
      id: command.id,
      type: command.type ?? command.kind,
      threadId: command.threadId,
      sessionId: command.sessionId,
      agentSessionId: command.agentSessionId,
      bridgeProfileId: command.bridgeProfileId,
      createdAt,
      createdAtMs,
      claimedAt,
      claimedAtMs,
      startedAt: new Date(localDispatchAtMs).toISOString(),
    });
    input.log({
      level: "info",
      event: "bridge.queue_item.in_flight",
      deviceId: input.config.deviceId,
      queueId: command.id,
      queueType: command.type ?? command.kind,
      threadId: command.threadId,
      sessionId: command.sessionId,
      agentSessionId: command.agentSessionId,
    });
    const task = input.manager
      .handleQueueItem(commandWithTiming)
      .catch(input.recordLoopError)
      .finally(() => {
        const wasInFlight = input.inFlightCommands.delete(command.id);
        input.inFlightCommandMetadata.delete(command.id);
        syncBridgeStatus();
        if (wasInFlight) {
          input.log({
            level: "info",
            event: "bridge.queue_item.settled",
            deviceId: input.config.deviceId,
            queueId: command.id,
            queueType: command.type ?? command.kind,
            threadId: command.threadId,
            sessionId: command.sessionId,
            agentSessionId: command.agentSessionId,
          });
        }
        void persistStatus(input.statusPath, input.status);
      });
    input.inFlightCommands.set(command.id, task);
    syncBridgeStatus();
  };

  try {
    syncBridgeStatus();
    if (input.status.registrationFailure) {
      input.status.connected = false;
      await persistStatus(input.statusPath, input.status);
      return { restartRequested: false };
    }
    let restartResult = await applyPendingBridgeControlCommand(
      input.status,
      currentTime,
      input,
    );
    if (
      !restartResult.restartRequested &&
      !input.status.pendingControlCommand &&
      input.status.lifecycle === "draining" &&
      input.status.updateState?.status === "waitingForIdle" &&
      input.isProcessIdleForRestart?.() !== false
    ) {
      input.status.lifecycle = "restarting";
      input.status.updateState = buildBridgeUpdateState(
        "restarting",
        currentTime(),
        {
          requestedAt: input.status.updateState.requestedAt,
          startedAt: currentTime(),
          targetVersion: BRIDGE_VERSION,
        },
      );
      await persistRestartHandoffForStatuses(input.restartHandoffPath, {
        reason: "runtimeProfileRefresh",
        status: "restarting",
        statuses: [input.status],
        targetVersion: BRIDGE_VERSION,
      });
      restartResult = { restartRequested: true };
    }
    if (
      !restartResult.restartRequested &&
      input.status.controlCommandStatus?.status === "waiting_for_idle"
    ) {
      syncBridgeStatus();
      await persistStatus(input.statusPath, input.status);
      return restartResult;
    }
    const heartbeatNow = currentTime();
    const heartbeatSignature = bridgeHeartbeatSignature(input.status);
    if (
      shouldSendBridgeHeartbeat(
        input.status,
        heartbeatNow,
        heartbeatSignature,
        heartbeatIntervalMs,
      )
    ) {
      input.status.lastHeartbeatAt = new Date(heartbeatNow).toISOString();
      input.status.lastHeartbeatSignature = heartbeatSignature;
      const heartbeatResult = await heartbeat(input.config, input.status);
      if (!heartbeatResult.ok) {
        const message = redactForOutput(heartbeatResult.error.message);
        input.status.recentErrors.push(message);
        input.status.recentErrors = input.status.recentErrors.slice(-10);
        input.log({
          level: "warn",
          event: "bridge.heartbeat.transient_error",
          deviceId: input.config.deviceId,
          activeSessionCount: input.manager.getStatus().activeSessions.length,
          error: message,
        });
      } else {
        input.wakeSignal?.updateWakeToken?.(heartbeatResult.wake);
      }
      if (
        heartbeatResult.ok &&
        heartbeatResult.enabledFeatureFlags !== undefined &&
        !stringArraysEqual(
          input.config.enabledFeatureFlags ?? [],
          heartbeatResult.enabledFeatureFlags,
        )
      ) {
        input.config.enabledFeatureFlags =
          heartbeatResult.enabledFeatureFlags.length > 0
            ? [...heartbeatResult.enabledFeatureFlags]
            : undefined;
        await input.applyFeatureFlagsControl?.([
          ...heartbeatResult.enabledFeatureFlags,
        ]);
      }
      if (
        heartbeatResult.ok &&
        (heartbeatResult.control?.settings ||
          heartbeatResult.control?.refreshHermesProfiles ||
          heartbeatResult.control?.refreshRuntimeProfiles ||
          heartbeatResult.control?.command)
      ) {
        if (heartbeatResult.control.settings) {
          input.applySettingsControl?.(heartbeatResult.control.settings);
          syncBridgeStatus();
          await persistStatus(input.statusPath, input.status);
        }
        const controlCommand = normalizeControlCommand(
          heartbeatResult.control.command,
        );
        if (controlCommand) {
          const acceptedAt = currentTime();
          input.status.pendingControlCommand = controlCommand;
          input.status.controlCommandStatus = buildControlCommandStatus(
            controlCommand.command,
            "accepted",
            {
              acceptedAt,
              instanceId: input.status.runtimeIdentity?.instanceId,
              requestedAt: controlCommand.requestedAt,
            },
          );
          await persistStatus(input.statusPath, input.status);
          restartResult = await applyPendingBridgeControlCommand(
            input.status,
            currentTime,
            input,
          );
          input.log({
            level: "info",
            event: "bridge.control_command.received",
            deviceId: input.config.deviceId,
            command: controlCommand.command,
            restartRequested: restartResult.restartRequested,
          });
        }
        try {
          if (
            heartbeatResult.control.refreshHermesProfiles ||
            heartbeatResult.control.refreshRuntimeProfiles
          ) {
            const previousRuntimeProfiles = input.status.runtimeProfiles ?? [];
            input.status.hermesProfiles = await discoverProfiles();
            const refreshedRuntimeProfiles = await discoverRuntimeProfiles({
              baseAgentCommand: input.agentCommand ?? DEFAULT_AGENT_COMMAND,
              customCommands: input.runtimeCommands,
            });
            input.status.runtimeProfiles = refreshedRuntimeProfiles;
            const refreshedAt = new Date(currentTime()).toISOString();
            input.status.lastHermesProfileRefreshAt = refreshedAt;
            input.status.lastRuntimeProfileRefreshAt = refreshedAt;
            const runtimeCatalogChanged = runtimeProfilesChanged(
              previousRuntimeProfiles,
              refreshedRuntimeProfiles,
            );
            input.log({
              level: "info",
              event: "bridge.hermes_profiles.refresh",
              deviceId: input.config.deviceId,
              profileCount: input.status.hermesProfiles.length,
              runtimeProfileCount: refreshedRuntimeProfiles.length,
              runtimeCommandChanged: runtimeCatalogChanged,
            });
            if (runtimeCatalogChanged) {
              const requestedAt =
                typeof heartbeatResult.control.refreshRuntimeProfiles
                  ?.requestedAt === "number"
                  ? heartbeatResult.control.refreshRuntimeProfiles.requestedAt
                  : currentTime();
              const acceptedAt = currentTime();
              input.status.pendingControlCommand = {
                command: "restartWhenIdle",
                requestedAt,
              };
              input.status.controlCommandStatus = buildControlCommandStatus(
                "restartWhenIdle",
                "accepted",
                {
                  acceptedAt,
                  instanceId: input.status.runtimeIdentity?.instanceId,
                  requestedAt,
                },
              );
              await persistStatus(input.statusPath, input.status);
              restartResult = await applyPendingBridgeControlCommand(
                input.status,
                currentTime,
                input,
              );
              input.log({
                level: "info",
                event: "bridge.runtime_profiles.restart_requested",
                deviceId: input.config.deviceId,
                restartRequested: restartResult.restartRequested,
              });
            }
            await persistStatus(input.statusPath, input.status);
            const refreshHeartbeatResult = await heartbeat(
              input.config,
              input.status,
            );
            if (!refreshHeartbeatResult.ok) {
              const message = redactForOutput(
                refreshHeartbeatResult.error.message,
              );
              input.status.recentErrors.push(message);
              input.status.recentErrors = input.status.recentErrors.slice(-10);
            }
          }
        } catch (error) {
          const message = redactForOutput(
            error instanceof Error ? error.message : String(error),
          );
          input.status.recentErrors.push(message);
          input.status.recentErrors = input.status.recentErrors.slice(-10);
          input.log({
            level: "warn",
            event: "bridge.hermes_profiles.refresh_error",
            deviceId: input.config.deviceId,
            error: message,
          });
        }
      }
    }
    if (restartResult.restartRequested) {
      syncBridgeStatus();
      await persistStatus(input.statusPath, input.status);
      try {
        await input.log.flush();
      } catch {}
      return restartResult;
    }
    if (normalizeControlCommand(input.status.pendingControlCommand)) {
      syncBridgeStatus();
      await persistStatus(input.statusPath, input.status);
      return { restartRequested: false };
    }
    for (const watchdog of input.watchdogFailures ?? []) {
      if (watchdog.checkpoint === "quiet") {
        input.log({
          level: "warn",
          event: "bridge.watchdog.quiet",
          deviceId: input.config.deviceId,
          queueId: watchdog.queueItemId,
          reason: watchdog.reasonCode,
          silenceMs: watchdog.silenceMs,
        });
        syncBridgeStatus();
        await persistStatus(input.statusPath, input.status);
        continue;
      }
      const terminalizationMetadata = buildWatchdogTerminalizationMetadata(
        watchdog,
        input.inFlightCommandMetadata.get(watchdog.queueItemId),
        currentTime(),
      );
      const terminalized =
        (await input.manager.failActiveQueueItem?.(
          watchdog.queueItemId,
          watchdog.reasonCode,
          terminalizationMetadata,
        )) ?? false;
      if (!terminalized) {
        input.log({
          level: "warn",
          event: "bridge.watchdog.terminalize_missed",
          deviceId: input.config.deviceId,
          queueId: watchdog.queueItemId,
          reason: watchdog.reasonCode,
        });
        continue;
      }
      input.inFlightCommands.delete(watchdog.queueItemId);
      input.inFlightCommandMetadata.delete(watchdog.queueItemId);
      syncBridgeStatus();
      input.log({
        level: "warn",
        event: "bridge.queue_item.settled",
        deviceId: input.config.deviceId,
        queueId: watchdog.queueItemId,
        reason: watchdog.reasonCode,
        ...terminalizationMetadata,
      });
      await persistStatus(input.statusPath, input.status);
    }
    if (normalizeControlCommand(input.status.pendingControlCommand)) {
      syncBridgeStatus();
      await persistStatus(input.statusPath, input.status);
      return { restartRequested: false };
    }
    const claimReservation = input.reserveClaimSlots?.();
    try {
      const maxInFlight = claimReservation?.maxInFlight ?? input.maxInFlight;
      const availableSlots = maxInFlight - input.inFlightCommands.size;
      const shouldPollQueue =
        pollReason !== "timer" || input.inFlightCommands.size > 0;
      const claimInput: BridgeQueueClaimInput | undefined =
        availableSlots > 0
          ? { limit: availableSlots }
          : input.inFlightCommands.size > 0
            ? { lane: "control", limit: 1 }
            : undefined;
      if (claimInput && shouldPollQueue) {
        let processHealth = input.getProcessHealth?.();
        if (processHealth) {
          input.status.processHealth = processHealth;
        }
        const runtimeConformance =
          input.getRuntimeConformance?.() ?? input.status.runtimeConformance;
        if (runtimeConformance) {
          input.status.runtimeConformance = runtimeConformance;
        }
        const now = currentTime();
        if (availableSlots > 0 && now - input.lastStaleCleanupAt >= 60_000) {
          input.setLastStaleCleanupAt(now);
          const cleanupResult = await cleanupStaleClaimsWithTimeout({
            cleanup,
            config: input.config,
            limit: availableSlots,
            log: input.log,
            requestTimeoutMs: Math.min(
              input.cloudRequestTimeoutMs ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS,
              input.staleCleanupTimeoutMs ?? DEFAULT_STALE_CLEANUP_TIMEOUT_MS,
            ),
            timeoutMs:
              input.staleCleanupTimeoutMs ?? DEFAULT_STALE_CLEANUP_TIMEOUT_MS,
          });
          input.status.lastStaleCleanupAt = new Date(now).toISOString();
          if (cleanupResult) {
            input.status.lastStaleCleanup = {
              inspected:
                typeof cleanupResult.inspected === "number"
                  ? cleanupResult.inspected
                  : undefined,
              released:
                typeof cleanupResult.released === "number"
                  ? cleanupResult.released
                  : undefined,
            };
            if (
              typeof cleanupResult.released === "number" &&
              cleanupResult.released > 0
            ) {
              input.log({
                level: "info",
                event: "bridge.queue.cleanup_stale",
                deviceId: input.config.deviceId,
                released: cleanupResult.released,
                inspected: cleanupResult.inspected,
              });
            }
          }
        }
        const pressureCleanupRequest =
          processPressureCleanupRequest(processHealth);
        if (
          pressureCleanupRequest &&
          input.manager.closeIdleSessionsForProcessPressure
        ) {
          const childCountBefore = processHealth?.childCount;
          const processCapBefore = processHealth?.processCap;
          const closedSessionCount =
            await input.manager.closeIdleSessionsForProcessPressure(
              pressureCleanupRequest,
            );
          if (closedSessionCount > 0) {
            processHealth = input.getProcessHealth?.() ?? processHealth;
            if (processHealth) {
              input.status.processHealth = processHealth;
            }
            input.log({
              level: "info",
              event: "bridge.lifecycle.idle_pressure_close",
              deviceId: input.config.deviceId,
              closedSessionCount,
              targetFreeProcessSlots:
                pressureCleanupRequest.targetFreeProcessSlots,
              maxSessionsToClose: pressureCleanupRequest.maxSessionsToClose,
              childCountBefore,
              childCountAfter: processHealth?.childCount,
              processCap: processHealth?.processCap ?? processCapBefore,
            });
          }
        }
        if (processHealth && !processHealth.canClaim) {
          input.log({
            level: "warn",
            event: "bridge.queue.claim_skipped",
            deviceId: input.config.deviceId,
            reason: "process_health_unsafe",
            processHealthStatus: processHealth.status,
            childCount: processHealth.childCount,
            ambiguousProcessCount: processHealth.ambiguousProcessCount,
            processCapExceeded: processHealth.processCapExceeded,
          });
          syncBridgeStatus();
          await persistStatus(input.statusPath, input.status);
          return { restartRequested: false };
        }
        if (input.canClaimWork && !input.canClaimWork()) {
          input.log({
            level: "warn",
            event: "bridge.queue.claim_skipped",
            deviceId: input.config.deviceId,
            reason: "local_journal_hard_failed",
          });
          syncBridgeStatus();
          await persistStatus(input.statusPath, input.status);
          return { restartRequested: false };
        }
        input.status.lastPollAt = new Date(now).toISOString();
        const commands = await claim(
          input.config,
          claimInput.lane
            ? claimInput
            : (claimInput.limit ?? DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS),
        );
        if (commands.length > 0) {
          input.log({
            level: "info",
            event: "bridge.queue.claimed",
            deviceId: input.config.deviceId,
            commandCount: commands.length,
          });
        }
        let dispatchedCommandCount = 0;
        for (const command of commands) {
          const conformanceBlock = runtimeConformanceBlockForCommand(
            command,
            runtimeConformance,
          );
          if (conformanceBlock) {
            const result = runtimeConformanceBlockResult(
              command,
              conformanceBlock,
            );
            await markResult(input.config, command, result);
            input.log({
              level: "warn",
              event: "bridge.queue.claim_skipped",
              deviceId: input.config.deviceId,
              queueId: command.id,
              queueType: command.type ?? command.kind,
              bridgeProfileId: command.bridgeProfileId,
              reason: conformanceBlock.reasonCode,
              runtimeConformanceStatus: conformanceBlock.status,
            });
            continue;
          }
          runCommand(command);
          dispatchedCommandCount += 1;
        }
        const warmRuntimeProfileIds = input.warmRuntimeProfileIds ?? [];
        const processWarmCapacity =
          processHealth && typeof processHealth.processCap === "number"
            ? Math.max(0, processHealth.processCap - processHealth.childCount)
            : Number.POSITIVE_INFINITY;
        const warmCapacity = Math.min(
          Math.max(0, maxInFlight - input.inFlightCommands.size),
          processWarmCapacity,
        );
        if (
          warmRuntimeProfileIds.length > 0 &&
          dispatchedCommandCount === 0 &&
          warmCapacity > 0 &&
          input.manager.warmRuntimeSessions
        ) {
          const warmedCount = await input.manager.warmRuntimeSessions({
            canStartSession: () => {
              const latestProcessHealth =
                input.getProcessHealth?.() ?? processHealth;
              if (!latestProcessHealth) {
                return true;
              }
              if (!latestProcessHealth.canClaim) {
                return false;
              }
              if (
                typeof latestProcessHealth.processCap === "number" &&
                latestProcessHealth.childCount >= latestProcessHealth.processCap
              ) {
                return false;
              }
              return true;
            },
            maxSessions: warmCapacity,
            runtimeProfileIds: warmRuntimeProfileIds,
          });
          if (warmedCount > 0) {
            input.log({
              level: "info",
              event: "bridge.session.warm_runtime_profiles",
              deviceId: input.config.deviceId,
              warmedCount,
              runtimeProfileCount: warmRuntimeProfileIds.length,
            });
          }
        }
      }
    } finally {
      claimReservation?.release();
    }
    syncBridgeStatus();
    await persistStatus(input.statusPath, input.status);
  } catch (error) {
    const registrationFailure = buildBridgeRegistrationFailure(
      error,
      currentTime(),
    );
    if (registrationFailure) {
      input.status.connected = false;
      input.status.registrationFailure = registrationFailure;
      input.status.recentErrors.push(registrationFailure.message);
      input.status.recentErrors = input.status.recentErrors.slice(-10);
      input.log({
        level: "error",
        event: "bridge.registration.disabled",
        deviceId: input.config.deviceId,
        reason: registrationFailure.reasonCode,
        error: registrationFailure.message,
      });
      syncBridgeStatus();
      await persistStatus(input.statusPath, input.status);
      return { restartRequested: false };
    }
    await input.recordLoopError(error);
  }
  return { restartRequested: false };
}

export function buildBridgeRegistrationFailure(
  error: unknown,
  now: number = Date.now(),
): BridgeRegistrationFailure | undefined {
  if (!(error instanceof BridgeCloudHttpError)) {
    return undefined;
  }
  if (
    classifyBridgeCloudFailure({
      body: error.responseBody,
      status: error.status,
    }) !== "auth_failed"
  ) {
    return undefined;
  }
  const message = redactForOutput(error.message);
  if (
    error.status === 401 ||
    /Bridge device credentials are invalid/i.test(error.responseBody)
  ) {
    return {
      kind: "auth_failed",
      reasonCode: "bridge_credentials_invalid",
      message,
      detectedAt: new Date(now).toISOString(),
    };
  }
  if (/Bridge device is not paired/i.test(error.responseBody)) {
    return {
      kind: "auth_failed",
      reasonCode: "bridge_device_not_paired",
      message,
      detectedAt: new Date(now).toISOString(),
    };
  }
  return undefined;
}

export function shouldSendBridgeHeartbeat(
  status: Pick<BridgeStatus, "lastHeartbeatAt" | "lastHeartbeatSignature">,
  now: number,
  signature: string,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
): boolean {
  if (status.lastHeartbeatSignature !== signature) {
    return true;
  }
  const lastHeartbeatAt = status.lastHeartbeatAt
    ? Date.parse(status.lastHeartbeatAt)
    : Number.NaN;
  if (!Number.isFinite(lastHeartbeatAt)) {
    return true;
  }
  return now - lastHeartbeatAt >= heartbeatIntervalMs;
}

export function bridgeHeartbeatSignature(
  status: Pick<
    BridgeStatus,
    | "connected"
    | "devHotReload"
    | "inFlightCommands"
    | "lifecycle"
    | "lastStaleCleanupAt"
    | "lastStaleCleanup"
    | "maxInFlight"
    | "controlCommandStatus"
    | "restartHandoff"
    | "pendingControlCommand"
    | "processHealth"
    | "runtimeConformance"
    | "liveness"
    | "availability"
    | "capacity"
    | "runtimeIdentity"
    | "sessionQueues"
    | "updateState"
  >,
): string {
  return JSON.stringify({
    connected: status.connected,
    devHotReload: status.devHotReload,
    inFlightCommands: (status.inFlightCommands ?? [])
      .map((command) => ({
        agentSessionId: command.agentSessionId,
        bridgeProfileId: command.bridgeProfileId,
        id: command.id,
        sessionId: command.sessionId,
        threadId: command.threadId,
        type: command.type,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    maxInFlight: status.maxInFlight,
    capacity: status.capacity,
    runtimeIdentity: status.runtimeIdentity,
    processHealth: status.processHealth,
    runtimeConformance: status.runtimeConformance,
    liveness: status.liveness,
    availability: status.availability,
    lastStaleCleanupAt: status.lastStaleCleanupAt,
    lastStaleCleanup: status.lastStaleCleanup,
    sessionQueues: (status.sessionQueues ?? [])
      .map((session) => ({
        agentSessionId: session.agentSessionId,
        bridgeProfileId: session.bridgeProfileId,
        hermesProfileName: session.hermesProfileName,
        lastUsedAt: session.lastUsedAt,
        queueDepth: session.queueDepth,
        runningQueueItemId: session.runningQueueItemId,
        runtimeKind: session.runtimeKind,
        runtimeLabel: session.runtimeLabel,
        runtimeProfileId: session.runtimeProfileId,
        sessionKey: session.sessionKey,
        threadId: session.threadId,
      }))
      .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    lifecycle: status.lifecycle,
    pendingControlCommand: status.pendingControlCommand,
    controlCommandStatus: status.controlCommandStatus,
    restartHandoff: status.restartHandoff
      ? {
          reason: status.restartHandoff.reason,
          status: status.restartHandoff.status,
          targetVersion: status.restartHandoff.targetVersion,
          runtimeProfileIds: status.restartHandoff.runtimeProfileIds,
          sessionWarmupHintCount:
            status.restartHandoff.sessionWarmupHints.length,
        }
      : undefined,
    updateState: status.updateState,
  });
}

function runtimeProfilesChanged(
  previousProfiles: BridgeRuntimeProfile[],
  refreshedProfiles: BridgeRuntimeProfile[],
): boolean {
  const previousById = new Map(
    previousProfiles.map((profile) => [
      profile.id,
      runtimeProfileCatalogSignature(profile),
    ]),
  );
  const refreshedIds = new Set(refreshedProfiles.map((profile) => profile.id));
  if (previousProfiles.some((profile) => !refreshedIds.has(profile.id))) {
    return true;
  }
  for (const profile of refreshedProfiles) {
    const previousSignature = previousById.get(profile.id);
    if (
      previousSignature === undefined ||
      previousSignature !== runtimeProfileCatalogSignature(profile)
    ) {
      return true;
    }
  }
  return false;
}

function seedConfiguredHermesRuntimeProfile(
  profiles: BridgeRuntimeProfile[],
  agentCommand: string | string[] | undefined,
): BridgeRuntimeProfile[] {
  const configuredHermesProfile = synthesizeLegacyHermesProfile(agentCommand);
  if (!configuredHermesProfile) {
    return profiles;
  }
  if (profiles.some((profile) => profile.id === configuredHermesProfile.id)) {
    return profiles;
  }
  return [configuredHermesProfile, ...profiles];
}

function runtimeProfileCatalogSignature(profile: BridgeRuntimeProfile): string {
  return JSON.stringify({
    capabilities: profile.capabilities,
    command: profile.command,
  });
}

function syncBridgeRuntimeStatus(
  status: BridgeStatus,
  manager: BridgeLoopManager,
  maxInFlight: number,
  inFlightCommandMetadata: Map<string, InFlightCommandMetadata>,
  processHealth?: BridgeProcessHealth,
  runtimeConformance?: RuntimeConformanceSummary,
): void {
  const managerStatus = manager.getStatus();
  status.lifecycle ??= "running";
  status.updateState ??= buildBridgeUpdateState("upToDate", Date.now());
  status.devHotReload ??= process.env.ZERO_CHAT_DEV_HOT_RELOAD
    ? {
        enabled: true,
        lastRestartReason: process.env.ZERO_CHAT_DEV_HOT_RELOAD_REASON,
        pendingRestart: false,
      }
    : {
        enabled: false,
        pendingRestart: false,
      };
  status.maxInFlight = maxInFlight;
  status.activeSessions = managerStatus.activeSessions;
  status.liveness = normalizeBridgeLivenessStatus(managerStatus.liveness);
  status.retainedSessions = managerStatus.retainedSessions ?? managerStatus.sessions;
  status.sessionQueues = managerStatus.sessions;
  delete (status as { activeQueueItemIds?: unknown }).activeQueueItemIds;
  status.inFlightCommands = Array.from(inFlightCommandMetadata.values());
  if (processHealth) {
    status.processHealth = processHealth;
  }
  if (runtimeConformance) {
    status.runtimeConformance = runtimeConformance;
  }
  status.availability = deriveBridgeAvailability({
    connected: status.connected,
    processHealth: status.processHealth,
    runtimeConformance: status.runtimeConformance,
  });
}

function normalizeBridgeLivenessStatus(
  liveness:
    | {
        activeSessions: Array<{
          bridgeProfileId?: string;
          claimId?: string;
          lastActivityAt: number;
          lastMeaningfulEventAt?: number;
          processAlive?: boolean;
          providerActivitySeen?: boolean;
          queueItemId: string;
          quietSince?: number;
          reasonCode?: string;
          sessionKey: string;
          silenceMs?: number;
          startedAt: number;
          state: string;
          transportOpen?: boolean;
        }>;
      }
    | undefined,
): NonNullable<BridgeStatus["liveness"]> {
  return {
    activeSessions:
      liveness?.activeSessions.map((session) => ({
        bridgeProfileId: session.bridgeProfileId,
        claimId: session.claimId,
        currentState: session.state,
        lastMeaningfulEventAt:
          session.lastMeaningfulEventAt ?? session.lastActivityAt,
        processAlive: session.processAlive,
        providerActivitySeen: session.providerActivitySeen,
        queueItemId: session.queueItemId,
        quietSince: session.quietSince,
        reasonCode: session.reasonCode,
        sessionKey: session.sessionKey,
        silenceMs: session.silenceMs,
        startedAt: session.startedAt,
        transportOpen: session.transportOpen,
      })) ?? [],
  };
}

async function showStatus(parsed: ParsedBridgeArgs) {
  const configPath = getConfigPath(parsed.flags);
  const statusPath = getStatusPath(parsed.flags);
  const configExists = existsSync(configPath);
  const existingStatus = existsSync(statusPath)
    ? await readJsonFile<BridgeStatus>(statusPath)
    : { connected: false, activeSessions: [], recentErrors: [] };

  if (configExists && !existingStatus.deviceId) {
    const config = await readBridgeConfigFile(configPath);
    const first = config.registrations[0];
    existingStatus.deviceId = first?.deviceId;
    existingStatus.appUrl = first?.appUrl;
    existingStatus.registrations = config.registrations.map((registration) => ({
      deviceId: registration.deviceId,
      appUrl: registration.appUrl,
      deviceName: registration.deviceName,
      connected: false,
      activeSessions: [],
      recentErrors: [],
    }));
  }

  writeStdout(describeStatus(existingStatus, configExists));
}

export async function buildBridgeDoctorReport(
  parsed: ParsedBridgeArgs,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<BridgeDoctorReport> {
  const configPath = getConfigPath(parsed.flags, env);
  const statusPath = getStatusPath(parsed.flags, env);
  const traceId = getFlag(parsed.flags, "trace");
  const configExists = existsSync(configPath);
  let registrations: BridgeDoctorReport["config"]["registrations"] = [];
  let configError: string | undefined;

  if (configExists) {
    try {
      registrations = (
        await readBridgeConfigFile(configPath)
      ).registrations.map((registration) => ({
        appUrl: registration.appUrl,
        deviceId: registration.deviceId,
        deviceName: registration.deviceName,
      }));
    } catch (error) {
      configError = redactForOutput(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const explicitJournalPath = getFlag(
    parsed.flags,
    "journal-file",
    env.ZERO_CHAT_BRIDGE_JOURNAL,
  );
  const requestedDeviceId = getFlag(parsed.flags, "device-id");
  const selectedRegistration = requestedDeviceId
    ? registrations.find(
        (registration) => registration.deviceId === requestedDeviceId,
      )
    : registrations[0];
  const journalPath =
    explicitJournalPath ??
    (selectedRegistration
      ? getBridgeJournalPath(parsed.flags, selectedRegistration.deviceId, env)
      : undefined);
  const report: BridgeDoctorReport = {
    bridgeVersion: BRIDGE_VERSION,
    config: {
      error: configError,
      exists: configExists,
      path: configPath,
      registrations,
    },
    generatedAt: new Date(now()).toISOString(),
    localJournal: journalPath
      ? { path: journalPath, status: "unavailable" }
      : {
          message:
            "No journal path available. Pass --journal-file or pair this bridge first.",
          reasonCode: "journal_path_unavailable",
          status: "unavailable",
        },
    snapshot: {
      diagnostics: [],
      pendingOutbox: [],
    },
    statusFile: {
      exists: existsSync(statusPath),
      path: statusPath,
    },
    traceId,
  };

  if (!journalPath) {
    return report;
  }

  try {
    const journal = openBridgeJournal({ path: journalPath });
    try {
      report.localJournal = { path: journalPath, status: "healthy" };
      report.snapshot = filterDoctorSnapshot(
        journal.buildDoctorSnapshot(),
        traceId,
      );
    } finally {
      journal.close();
    }
  } catch (error) {
    report.localJournal = {
      message: redactForOutput(
        error instanceof Error ? error.message : String(error),
      ),
      path: journalPath,
      reasonCode: "local_persistence_unavailable",
      status: "unavailable",
    };
  }

  return report;
}

async function showDoctor(parsed: ParsedBridgeArgs) {
  const report = await buildBridgeDoctorReport(parsed);
  writeStdout(`${JSON.stringify(report, null, 2)}\n`);
}

function filterDoctorSnapshot(
  snapshot: Record<string, unknown>,
  traceId: string | undefined,
): BridgeDoctorReport["snapshot"] {
  const diagnostics = arrayOfRecords(snapshot.diagnostics);
  const pendingOutbox = arrayOfRecords(snapshot.pendingOutbox);
  if (!traceId) {
    return { diagnostics, pendingOutbox };
  }
  return {
    diagnostics: diagnostics.filter((entry) => entry.traceId === traceId),
    pendingOutbox: pendingOutbox.filter((entry) => entry.traceId === traceId),
  };
}

function normalizeCommand(command?: string): BridgeCommandName {
  if (command === "connect-org") {
    return "connect";
  }
  if (
    command === "connect" ||
    command === "doctor" ||
    command === "pair" ||
    command === "start" ||
    command === "status"
  ) {
    return command;
  }
  return "help";
}

export function buildStartupSecuritySummary(input: {
  allowRemoteCwd: boolean;
  configPath: string;
  logUrl?: string;
}): string {
  return [
    "Security defaults:",
    `  config permissions: owner-only 0600 (${input.configPath})`,
    `  remote cwd from 0000 Chat: ${input.allowRemoteCwd ? "enabled" : "ignored"}`,
    `  remote bridge log forwarding: ${input.logUrl ? `enabled (${input.logUrl})` : "disabled"}`,
    "  package-backed runtime defaults: pinned versions",
    "",
  ].join("\n");
}

function helpText(): string {
  return [
    "0000 Chat ACP bridge",
    "",
    "Usage:",
    `  bun scripts/acp-bridge.ts connect <code> --app-url <url> [--agent-command "${DEFAULT_CLAUDE_CODE_ACP_COMMAND}"] [--skill-path <path>]`,
    "  bun scripts/acp-bridge.ts pair <code> --app-url <url> [--device-name <name>] [--log-url <url>]",
    `  bun scripts/acp-bridge.ts start [--agent-command "hermes acp"] [--runtime-command "${DEFAULT_CODEX_ACP_COMMAND}"] [--runtime-command "${DEFAULT_CLAUDE_CODE_ACP_COMMAND}"] [--poll-ms 2000] [--max-in-flight <local-hard-cap>] [--warm-runtime-profile <profile-id>] [--request-timeout-ms ${DEFAULT_ACP_REQUEST_TIMEOUT_MS}] [--cloud-request-timeout-ms ${DEFAULT_CLOUD_REQUEST_TIMEOUT_MS}] [--allow-remote-cwd] [--log-url <url>]`,
    "  bun scripts/acp-bridge.ts status",
    "  bun scripts/acp-bridge.ts doctor [--trace <trace-id>] [--device-id <bridge-device-id>] [--journal-file <path>]",
    "",
    "Environment:",
    "  ZERO_CHAT_APP_URL                         Default app URL for connect or pair",
    "  ZERO_CHAT_AGENT_COMMAND                   Default ACP agent command for connect",
    `  ZERO_CHAT_SKILL_PATH                      Local skill path for connect (default from install script: ${DEFAULT_AGENT_SKILL_PATH})`,
    `  ZERO_CHAT_BRIDGE_CONFIG                  Config path (default: ${DEFAULT_CONFIG_PATH})`,
    "  ZERO_CHAT_BRIDGE_MAX_IN_FLIGHT           Optional local hard cap across all registered organizations",
    "  ZERO_CHAT_BRIDGE_WARM_RUNTIME_PROFILES   Comma-separated runtime profile ids to warm from recent scoped sessions (default: disabled)",
    `  ZERO_CHAT_RUNTIME_CATALOG_CACHE          Runtime catalog cache path (default: ${DEFAULT_RUNTIME_CATALOG_CACHE_PATH})`,
    "  ZERO_CHAT_BRIDGE_REQUEST_TIMEOUT_MS      ACP request timeout in milliseconds",
    "  ZERO_CHAT_BRIDGE_CLOUD_REQUEST_TIMEOUT_MS Bridge cloud API timeout in milliseconds",
    "  ZERO_CHAT_BRIDGE_TOOL_RESULT_TIMEOUT_MS  Unresolved ACP tool-call timeout in milliseconds",
    "  ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD        Honor cwd values from 0000 Chat queue items (default: true; set 0/false to disable)",
    `  ZERO_CHAT_BRIDGE_JOURNAL                 Override local SQLite journal path (default: ${DEFAULT_JOURNAL_DIR}/<device>.sqlite)`,
    `  ZERO_CHAT_BRIDGE_PROCESS_REGISTRY        Override local ACP child registry path (default: ${DEFAULT_PROCESS_REGISTRY_DIR}/<device>.json)`,
    `  ZERO_CHAT_BRIDGE_RESTART_HANDOFF         Override restart handoff path (default: ${DEFAULT_RESTART_HANDOFF_PATH})`,
    "  ZERO_CHAT_BRIDGE_LOG_URL                 Worker log ingest URL (default: disabled)",
    "",
  ].join("\n");
}

function getStatusPath(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    getFlag(flags, "status-file", env.ZERO_CHAT_BRIDGE_STATUS) ??
    DEFAULT_STATUS_PATH
  );
}

function getRuntimeCatalogCachePath(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    getFlag(
      flags,
      "runtime-catalog-cache",
      env.ZERO_CHAT_RUNTIME_CATALOG_CACHE,
    ) ?? DEFAULT_RUNTIME_CATALOG_CACHE_PATH
  );
}

function runtimeCatalogCommandKeys(input: {
  agentCommand: string;
  customRuntimeCommands: string[][];
}): string[][] {
  return [
    splitCommand(input.agentCommand),
    ...input.customRuntimeCommands,
  ].filter((command) => command.length > 0);
}

function getRestartHandoffPath(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    getFlag(
      flags,
      "restart-handoff-file",
      env.ZERO_CHAT_BRIDGE_RESTART_HANDOFF,
    ) ?? DEFAULT_RESTART_HANDOFF_PATH
  );
}

function getBridgeJournalPath(
  flags: FlagMap,
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = getFlag(flags, "journal-file", env.ZERO_CHAT_BRIDGE_JOURNAL);
  if (explicit) {
    return explicit;
  }
  return join(DEFAULT_JOURNAL_DIR, `${sanitizeFileSegment(deviceId)}.sqlite`);
}

function getBridgeProcessRegistryPath(
  flags: FlagMap,
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = getFlag(
    flags,
    "process-registry-file",
    env.ZERO_CHAT_BRIDGE_PROCESS_REGISTRY,
  );
  if (explicit) {
    return explicit;
  }
  return join(
    DEFAULT_PROCESS_REGISTRY_DIR,
    `${sanitizeFileSegment(deviceId)}.json`,
  );
}

function getBridgeSingletonOwnerPath(
  flags: FlagMap,
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const registryPath = getBridgeProcessRegistryPath(flags, deviceId, env);
  return registryPath.endsWith(".json")
    ? registryPath.replace(/\.json$/, ".owner.json")
    : `${registryPath}.owner.json`;
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "bridge";
}

function bridgeSupervisorHealthStatus(
  supervisor: BridgeSupervisor,
): NonNullable<BridgeStatus["localJournal"]> {
  const health = supervisor.getHealth();
  if (health.status === "healthy") {
    return { status: "healthy" };
  }
  return {
    status: "hard_failed",
    reasonCode: health.reasonCode,
    message: health.message,
  };
}

function bridgeSupervisorHealthSignature(supervisor: BridgeSupervisor): string {
  return JSON.stringify(bridgeSupervisorHealthStatus(supervisor));
}

function mergeBridgeProcessHealth(
  processHealth: BridgeProcessHealth,
  singletonStatus: BridgeSingletonStatus,
  registryPath?: string,
): BridgeProcessHealth {
  const singletonOwner = {
    ownerPath: singletonStatus.ownerPath,
    lastReconciledAt: singletonStatus.lastReconciledAt,
    status: singletonStatus.status,
    ...(singletonStatus.status === "duplicate_owner"
      ? { duplicateOwner: singletonStatus.duplicateOwner }
      : {}),
  };
  return {
    ...processHealth,
    canClaim: processHealth.canClaim && singletonStatus.canClaim,
    ...(singletonStatus.canClaim ? {} : { status: "ambiguous" }),
    ...(registryPath ? { registryPath } : {}),
    singletonOwner,
  };
}

async function publishBridgeSupervisorHealthIfChanged(context: {
  config: BridgeRegistration;
  lastJournalHealthSignature: string;
  status: BridgeStatus;
  supervisor: BridgeSupervisor;
}): Promise<void> {
  const signature = bridgeSupervisorHealthSignature(context.supervisor);
  if (signature === context.lastJournalHealthSignature) {
    return;
  }
  context.status.localJournal = bridgeSupervisorHealthStatus(
    context.supervisor,
  );
  await context.supervisor.publishHealthDiagnostic({
    bridgeDeviceId: context.config.deviceId,
  });
  context.status.localJournal = bridgeSupervisorHealthStatus(
    context.supervisor,
  );
  context.lastJournalHealthSignature = bridgeSupervisorHealthSignature(
    context.supervisor,
  );
}

async function claimCommands(
  config: BridgeConfig,
  input: number | BridgeQueueClaimInput = DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS,
): Promise<BridgeQueueCommand[]> {
  const adapter = new ConvexBridgeHostAdapter(createCloudClient(config));
  const claimInput = typeof input === "number" ? { limit: input } : input;
  const response = await adapter.claimWork(claimInput);
  const rawResponse = response.raw as QueueClaimResponse;
  const rawCommands = Array.isArray(rawResponse.commands)
    ? rawResponse.commands
    : rawResponse.command
      ? [rawResponse.command]
      : [];
  return rawCommands
    .map(normalizeQueueCommand)
    .filter((command) => command !== undefined);
}

async function markCommandResult(
  config: BridgeConfig,
  command: BridgeQueueCommand,
  result: BridgeQueueResult,
): Promise<void> {
  await createCloudClient(config).markResult(
    command.id,
    command.claimId ? { ...result, claimId: command.claimId } : result,
    command.claimId,
  );
}

function runtimeConformanceBlockForCommand(
  command: BridgeQueueCommand,
  runtimeConformance: RuntimeConformanceSummary | undefined,
): { launchSpecKey?: string; reasonCode: string; status: string } | undefined {
  if (!commandRequiresRuntimeConformance(command)) {
    return undefined;
  }
  if (!runtimeConformance || !command.bridgeProfileId) {
    return undefined;
  }
  const runtimeProfileId = runtimeProfileIdForCommand(command);
  const profile = runtimeConformance.profiles[runtimeProfileId];
  if (profile && !profile.canClaim && !isSoftRuntimeConformanceBlock(profile)) {
    return {
      reasonCode: profile.reasonCode ?? "runtime_conformance_missing",
      status: runtimeConformance.status,
    };
  }
  const launchSpecKey = launchSpecKeyForCommand(command);
  if (launchSpecKey) {
    const launchSpec = runtimeConformance.launchSpecs?.[launchSpecKey];
    if (!launchSpec) {
      return undefined;
    }
    if (!launchSpec.canClaim) {
      if (isSoftRuntimeConformanceBlock(launchSpec)) {
        return undefined;
      }
      return {
        launchSpecKey,
        reasonCode: launchSpecReasonCode(launchSpec.reasonCode),
        status: runtimeConformance.status,
      };
    }
  }
  return undefined;
}

export function runtimeConformanceRecordsForSuccessfulCommand(
  command: {
    bridgeProfileId?: string;
    hermesProfileName?: string;
    kind?: string;
    type?: string;
    [key: string]: unknown;
  },
  checkedAt = Date.now(),
): Record<string, RuntimeConformanceRecord> {
  if (!command.bridgeProfileId) {
    return {};
  }
  const queueCommand = command as BridgeQueueCommand;
  if (!commandRequiresRuntimeConformance(queueCommand)) {
    return {};
  }
  const profileIds = new Set([runtimeProfileIdForCommand(queueCommand)]);
  const launchSpecKey = launchSpecKeyForCommand(queueCommand);
  if (launchSpecKey) {
    profileIds.add(launchSpecKey);
  }
  return Object.fromEntries(
    Array.from(profileIds).map((runtimeId) => [
      runtimeId,
      {
        checkedAt,
        diagnostics: [],
        runtimeId,
        state: "passing" as const,
        strength: "init_only" as const,
      },
    ]),
  );
}

function isSoftRuntimeConformanceBlock(record: {
  reasonCode?: string;
  state?: string;
}): boolean {
  if (record.reasonCode === "runtime_conformance_missing") {
    return true;
  }
  return (
    record.reasonCode === "runtime_conformance_stale" &&
    record.state === "passing"
  );
}

function launchSpecKeyForCommand(command: BridgeQueueCommand): string | undefined {
  const runtimeProfileId = runtimeProfileIdForCommand(command);
  const profileName =
    command.hermesProfileName?.trim() || legacyHermesProfileNameForCommand(command);
  if (!profileName || runtimeProfileId !== "hermes:default") {
    return undefined;
  }
  return `${runtimeProfileId}|hermes-profile:${profileName}`;
}

function runtimeProfileIdForCommand(command: BridgeQueueCommand): string {
  return legacyHermesProfileNameForCommand(command) ? "hermes:default" : command.bridgeProfileId!;
}

function legacyHermesProfileNameForCommand(
  command: BridgeQueueCommand,
): string | undefined {
  return command.bridgeProfileId?.startsWith("hermes:") &&
    command.bridgeProfileId !== "hermes:default"
    ? command.bridgeProfileId.slice("hermes:".length)
    : undefined;
}

function launchSpecReasonCode(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case "runtime_conformance_stale":
      return "runtime_launch_spec_stale";
    case "runtime_conformance_failed":
      return "runtime_launch_spec_failed";
    case "runtime_quarantined":
      return "runtime_launch_spec_quarantined";
    case "runtime_conformance_insufficient":
      return "runtime_launch_spec_insufficient";
    case "runtime_conformance_missing":
    case undefined:
      return "runtime_launch_spec_missing";
    default:
      return reasonCode;
  }
}

function commandRequiresRuntimeConformance(command: BridgeQueueCommand): boolean {
  const type = command.type ?? command.kind;
  return type === "prompt" || type === "start-session";
}

function runtimeConformanceBlockResult(
  command: BridgeQueueCommand,
  block: { launchSpecKey?: string; reasonCode: string; status: string },
): BridgeQueueResult {
  return {
    ...(command.claimId ? { claimId: command.claimId } : {}),
    bridgeProfileId: command.bridgeProfileId,
    error: block.reasonCode,
    launchSpecKey: block.launchSpecKey,
    ok: false,
    reasonCode: block.reasonCode,
    retryable: true,
    runtimeConformanceStatus: block.status,
  };
}

async function cleanupStaleClaimsWithTimeout(input: {
  cleanup: typeof cleanupStaleClaims;
  config: BridgeConfig;
  limit: number;
  log: FlushableBridgeLogger;
  requestTimeoutMs: number;
  timeoutMs: number;
}): Promise<QueueCleanupResponse | undefined> {
  const timeoutMs = Math.max(1, input.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let timeoutLogged = false;
  const logTimeout = () => {
    if (timeoutLogged) {
      return;
    }
    timeoutLogged = true;
    input.log({
      level: "warn",
      event: "bridge.queue.cleanup_stale_timeout",
      deviceId: input.config.deviceId,
      timeoutMs,
    });
  };

  const cleanupTask = input
    .cleanup(input.config, {
      limit: input.limit,
      requestTimeoutMs: input.requestTimeoutMs,
    })
    .catch((error) => {
      if (timedOut || error instanceof BridgeCloudRequestTimeoutError) {
        logTimeout();
        return undefined;
      }
      throw error;
    });
  const timeoutTask = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      logTimeout();
      resolve(undefined);
    }, timeoutMs);
  });

  try {
    return await Promise.race([cleanupTask, timeoutTask]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function cleanupStaleClaims(
  config: BridgeConfig,
  input: { limit?: number; requestTimeoutMs?: number } = {},
): Promise<QueueCleanupResponse> {
  const { requestTimeoutMs, ...body } = input;
  return await createCloudClient(
    config,
    { requestTimeoutMs },
  ).cleanupStaleClaims<QueueCleanupResponse>(body);
}

type BridgeHeartbeatSendResult =
  | {
      ok: true;
      control?: BridgeControlResponse;
      enabledFeatureFlags?: string[];
      wake?: BridgeWakeToken;
    }
  | {
      ok: false;
      error:
        | (BridgeCloudHttpError & { status: 500 | 502 | 503 | 504 })
        | BridgeCloudRequestTimeoutError;
    };

type BridgeControlResponse = {
  command?: BridgeControlCommandState;
  settings?: {
    maxInFlight?: unknown;
    updatedAt?: unknown;
  };
  refreshHermesProfiles?: {
    requestedAt?: unknown;
  };
  refreshRuntimeProfiles?: {
    requestedAt?: unknown;
  };
};

export function buildHeartbeatStatusPayload(status: BridgeStatus) {
  return {
    connected: status.connected,
    lifecycle: status.lifecycle ?? "running",
    updateState: buildHeartbeatUpdateStatePayload(status.updateState),
    controlCommandStatus: status.controlCommandStatus,
    devHotReload: status.devHotReload,
    activeSessions: status.activeSessions,
    inFlightCommands: status.inFlightCommands ?? [],
    maxInFlight: status.maxInFlight ?? DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS,
    capacity: status.capacity,
    runtimeIdentity: status.runtimeIdentity,
    restartHandoff: status.restartHandoff
      ? {
          consumedAt: status.restartHandoff.consumedAt,
          createdAt: status.restartHandoff.createdAt,
          reason: status.restartHandoff.reason,
          status: status.restartHandoff.status,
          targetVersion: status.restartHandoff.targetVersion,
          runtimeProfileIds: status.restartHandoff.runtimeProfileIds,
          sessionWarmupHintCount:
            status.restartHandoff.sessionWarmupHints.length,
        }
      : undefined,
    processHealth: buildHeartbeatProcessHealthPayload(status.processHealth),
    runtimeConformance: status.runtimeConformance,
    liveness: status.liveness,
    availability: status.availability,
    retainedSessions: (status.retainedSessions ?? status.sessionQueues ?? []).map(
      (session) => ({
        agentSessionId: session.agentSessionId,
        bridgeProfileId: session.bridgeProfileId,
        hermesProfileName: session.hermesProfileName,
        lastUsedAt: session.lastUsedAt,
        queueDepth: session.queueDepth,
        runningQueueItemId: session.runningQueueItemId,
        runtimeProfileId: session.runtimeProfileId,
        sessionKey: session.sessionKey,
        threadId: session.threadId,
      }),
    ),
    sessionQueues: (status.sessionQueues ?? []).map((session) => ({
      agentSessionId: session.agentSessionId,
      bridgeProfileId: session.bridgeProfileId,
      hermesProfileName: session.hermesProfileName,
      lastUsedAt: session.lastUsedAt,
      queueDepth: session.queueDepth,
      runningQueueItemId: session.runningQueueItemId,
      runtimeProfileId: session.runtimeProfileId,
      sessionKey: session.sessionKey,
      threadId: session.threadId,
    })),
    lastPollAt: status.lastPollAt,
    lastStaleCleanupAt: status.lastStaleCleanupAt,
    lastStaleCleanup: status.lastStaleCleanup,
    recentErrors: status.recentErrors.slice(-5),
  };
}

function buildCompatibleHeartbeatStatusPayload(status: BridgeStatus) {
  return {
    activeSessions: status.activeSessions,
    availability: status.availability,
    capacity: status.capacity,
    connected: status.connected,
    inFlightCommands: status.inFlightCommands ?? [],
    lastPollAt: status.lastPollAt,
    lastStaleCleanup: status.lastStaleCleanup,
    lastStaleCleanupAt: status.lastStaleCleanupAt,
    lifecycle: status.lifecycle ?? "running",
    liveness: status.liveness,
    maxInFlight: status.maxInFlight ?? DEFAULT_ORG_MAX_IN_FLIGHT_COMMANDS,
    recentErrors: status.recentErrors.slice(-5),
    retainedSessions: (status.retainedSessions ?? status.sessionQueues ?? []).map(
      (session) => ({
        agentSessionId: session.agentSessionId,
        bridgeProfileId: session.bridgeProfileId,
        hermesProfileName: session.hermesProfileName,
        lastUsedAt: session.lastUsedAt,
        queueDepth: session.queueDepth,
        runningQueueItemId: session.runningQueueItemId,
        runtimeProfileId: session.runtimeProfileId,
        sessionKey: session.sessionKey,
        threadId: session.threadId,
      }),
    ),
    runtimeConformance: status.runtimeConformance,
    runtimeIdentity: status.runtimeIdentity,
    sessionQueues: (status.sessionQueues ?? []).map((session) => ({
      agentSessionId: session.agentSessionId,
      bridgeProfileId: session.bridgeProfileId,
      hermesProfileName: session.hermesProfileName,
      lastUsedAt: session.lastUsedAt,
      queueDepth: session.queueDepth,
      runningQueueItemId: session.runningQueueItemId,
      runtimeProfileId: session.runtimeProfileId,
      sessionKey: session.sessionKey,
      threadId: session.threadId,
    })),
  };
}

function buildHeartbeatUpdateStatePayload(updateState: BridgeStatus["updateState"]) {
  const payload = {
    ...(updateState ?? {
      status: "upToDate" as const,
      currentVersion: BRIDGE_VERSION,
    }),
  };
  delete (payload as { startedAt?: number }).startedAt;
  return payload;
}

function buildHeartbeatProcessHealthPayload(
  processHealth: BridgeStatus["processHealth"],
) {
  if (!processHealth) {
    return undefined;
  }
  const { startupReconciliation, ...rest } = processHealth;
  return {
    ...rest,
    singletonOwner: processHealth.singletonOwner,
    startupReconciliation: startupReconciliation
      ? {
          ambiguousProcessCount: startupReconciliation.ambiguousProcessCount,
          lastReconciledAt: startupReconciliation.lastReconciledAt,
          removedDeadProcessCount:
            startupReconciliation.removedDeadProcessCount,
          retainedProcessCount: startupReconciliation.retainedProcessCount,
          status: heartbeatStartupReconciliationStatus(
            startupReconciliation.status,
          ),
          terminatedProcessCount:
            startupReconciliation.terminatedProcessCount,
        }
      : undefined,
  };
}

function heartbeatStartupReconciliationStatus(
  status: NonNullable<
    NonNullable<BridgeStatus["processHealth"]>["startupReconciliation"]
  >["status"],
): "healthy" | "unsafe" | "cap_exceeded" {
  if (status === "healthy" || status === "not_run") {
    return "healthy";
  }
  return "unsafe";
}

export function sanitizeHermesProfilesForCapabilities(
  profiles: Array<Record<string, unknown>>,
): HermesProfileSummary[] {
  return profiles
    .map((profile) => {
      const name = safeProfileText(profile.name, 80);
      if (!name) {
        return undefined;
      }
      const alias = safeProfileText(profile.alias, 80);
      return {
        alias: alias && isSafeHermesProfileAlias(alias) ? alias : undefined,
        description: safeProfileText(profile.description, 240),
        gateway: safeProfileText(profile.gateway, 80),
        model: safeProfileText(profile.model, 120),
        name,
      };
    })
    .filter((profile) => profile !== undefined)
    .slice(0, 100);
}

export function parseHermesProfileListOutput(
  output: string,
): HermesProfileSummary[] {
  const lines = output.split(/\r?\n/);
  const header = lines.find(
    (line) =>
      line.includes("Profile") &&
      line.includes("Model") &&
      line.includes("Gateway") &&
      line.includes("Alias"),
  );
  const columns = header
    ? ["Profile", "Model", "Gateway", "Alias", "Distribution"]
        .map((label) => ({ label, index: header.indexOf(label) }))
        .filter((column) => column.index >= 0)
        .sort((left, right) => left.index - right.index)
    : [];
  const rows = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed &&
      !trimmed.startsWith("Profile") &&
      !/^[─\s]+$/.test(trimmed)
    );
  });

  return sanitizeHermesProfilesForCapabilities(
    rows
      .map((line) => {
        const hasActiveMarker = /^\s*[◆*]/.test(line);
        const normalized = line.replace(/^(\s*)[◆*]\s*/, "$1 ");
        const semanticParts = parseHermesProfileSemanticRow(normalized);
        if (semanticParts) {
          return semanticParts;
        }
        const whitespaceParts = normalized.trim().split(/\s{2,}/).filter(Boolean);
        const columnParts =
          columns.length >= 4
            ? columns.map((column, index) => {
                const next = columns[index + 1]?.index;
                return normalized.slice(column.index, next).trim();
              })
            : [];
        const parts =
          hasActiveMarker ||
          (whitespaceParts[0]?.endsWith(" —") && whitespaceParts.length >= 3) ||
          (whitespaceParts[0] &&
          columnParts[0] &&
          whitespaceParts[0].length > columnParts[0].length)
            ? whitespaceParts
            : columnParts.length >= 4
              ? columnParts
              : whitespaceParts;
        if (parts.length < 2) {
          return undefined;
        }
        const [rawName, rawModel, rawGateway, rawAlias] = parts;
        const overflowedProfileName =
          rawName.endsWith(" —") && rawModel && rawModel !== "—";
        const name = normalizeHermesProfileNameColumn(rawName);
        const model = overflowedProfileName
          ? undefined
          : normalizeHermesPlaceholder(rawModel);
        const gateway = overflowedProfileName
          ? normalizeHermesPlaceholder(rawModel)
          : normalizeHermesPlaceholder(rawGateway);
        const alias = normalizeHermesPlaceholder(
          (overflowedProfileName ? rawGateway : rawAlias)?.replace(/\s+—$/, ""),
        );
        return {
          alias,
          gateway,
          model,
          name,
        };
      })
      .filter((profile) => profile !== undefined),
  );
}

function parseHermesProfileSemanticRow(
  line: string,
): HermesProfileSummary | undefined {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  const gatewayIndex = tokens.findIndex((token) =>
    /^(running|stopped|starting|stopping|error)$/i.test(token),
  );
  if (gatewayIndex <= 1) {
    return undefined;
  }
  const rawModel = tokens[gatewayIndex - 1];
  const rawName = tokens.slice(0, gatewayIndex - 1).join(" ");
  const name = normalizeHermesProfileNameColumn(rawName);
  if (!name) {
    return undefined;
  }
  return {
    alias: normalizeHermesPlaceholder(tokens[gatewayIndex + 1]),
    gateway: normalizeHermesPlaceholder(tokens[gatewayIndex]),
    model: normalizeHermesPlaceholder(rawModel),
    name,
  };
}

function normalizeHermesProfileNameColumn(value: string): string {
  return value.replace(/\s+—$/, "").trim();
}

function normalizeHermesPlaceholder(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "—") {
    return undefined;
  }
  return trimmed;
}

export async function discoverHermesProfilesFromDisk(
  hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes"),
): Promise<HermesProfileSummary[]> {
  const profilesDir = join(hermesHome, "profiles");
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(
    () => [],
  );
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    const name = safeProfileText(entry.name, 80);
    if (!name) {
      return [];
    }
    const profileDir = join(profilesDir, entry.name);
    if (
      !existsSync(join(profileDir, "config.yaml")) &&
      !existsSync(join(profileDir, "profile.yaml"))
    ) {
      return [];
    }
    return [{ name }];
  });
}

async function discoverHermesProfiles(): Promise<HermesProfileSummary[]> {
  try {
    const { stdout } = await runProcess("hermes", ["profile", "list"], {
      timeoutMs: DEFAULT_HERMES_PROFILE_DISCOVERY_TIMEOUT_MS,
    });
    return parseHermesProfileListOutput(stdout);
  } catch {
    return discoverHermesProfilesFromDisk();
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!child.killed) {
                child.kill("SIGKILL");
              }
            }, 1_000).unref();
            reject(
              new Error(
                `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
    timeout?.unref();
    const settle = () => {
      if (settled) {
        return false;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      return true;
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settle()) {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settle()) {
        return;
      }
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${code}: ${stderr}`,
        ),
      );
    });
  });
}

export async function sendHeartbeat(
  config: BridgeConfig,
  status: BridgeStatus,
): Promise<BridgeHeartbeatSendResult> {
  return sendHeartbeatWithClient(config, status, createCloudClient(config));
}

export async function sendHeartbeatWithClient(
  _config: BridgeConfig,
  status: BridgeStatus,
  client: Pick<ConvexBridgeCloudClient, "heartbeat">,
): Promise<BridgeHeartbeatSendResult> {
  const input: BridgeHeartbeatInput = {
    bridgeInstanceId: status.runtimeIdentity?.instanceId,
    capabilities: buildHeartbeatCapabilities(status),
    status: buildHeartbeatStatusPayload(status),
    version: status.runtimeIdentity?.bridgeVersion ?? BRIDGE_VERSION,
  };
  try {
    return await sendHeartbeatInput(client, input);
  } catch (error) {
    if (isHeartbeatStatusCompatibilityError(error)) {
      try {
        return await sendHeartbeatInput(client, {
          ...input,
          status: buildCompatibleHeartbeatStatusPayload(status),
        });
      } catch (fallbackError) {
        if (isTransientHeartbeatError(fallbackError)) {
          return { ok: false, error: fallbackError };
        }
        throw fallbackError;
      }
    }
    if (isTransientHeartbeatError(error)) {
      return { ok: false, error };
    }
    throw error;
  }
}

async function sendHeartbeatInput(
  client: Pick<ConvexBridgeCloudClient, "heartbeat">,
  input: BridgeHeartbeatInput,
): Promise<Extract<BridgeHeartbeatSendResult, { ok: true }>> {
  const response = await client.heartbeat<{
    control?: BridgeControlResponse;
    enabledFeatureFlags?: unknown;
    wake?: BridgeWakeToken;
  }>(input);
  return {
    ok: true,
    control: response.control,
    enabledFeatureFlags: stringArrayFromUnknownAllowEmpty(
      response.enabledFeatureFlags,
    ),
    wake: response.wake,
  };
}

function isHeartbeatStatusCompatibilityError(
  error: unknown,
): error is BridgeCloudHttpError {
  return (
    error instanceof BridgeCloudHttpError &&
    (error.status === 400 || error.status === 401) &&
    /ArgumentValidationError/i.test(error.responseBody) &&
    /Path:\s*\.status(?:\.|\b)|\.status(?:\.|\b)/i.test(error.responseBody)
  );
}

export function buildHeartbeatCapabilities(
  status: BridgeStatus,
): Record<string, unknown> {
  return compact({
    ...(status.runtimeProfiles && status.runtimeProfiles.length > 0
      ? { runtimeProfiles: status.runtimeProfiles }
      : {}),
    ...(status.hermesProfiles && status.hermesProfiles.length > 0
      ? { hermesProfiles: status.hermesProfiles }
      : {}),
    setupSummary: status.setupSummary,
  });
}

function safeProfileText(
  value: unknown,
  maxLength: number,
): string | undefined {
  const text =
    typeof value === "string" ? value.trim().slice(0, maxLength) : undefined;
  return text && !looksSensitiveProfileText(text) ? text : undefined;
}

function isSafeHermesProfileAlias(value: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) &&
    !looksSensitiveProfileText(value)
  );
}

function looksSensitiveProfileText(value: string): boolean {
  return /token|secret|password|authorization|api[_-]?key/i.test(value);
}

export function isTransientHeartbeatError(
  error: unknown,
): error is
  | (BridgeCloudHttpError & { status: 500 | 502 | 503 | 504 })
  | BridgeCloudRequestTimeoutError {
  if (error instanceof BridgeCloudRequestTimeoutError) {
    return true;
  }
  return (
    error instanceof BridgeCloudHttpError &&
    (error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504)
  );
}

function createCloudClient(
  config: BridgeConfig,
  options: { requestTimeoutMs?: number } = {},
): ConvexBridgeCloudClient {
  return new ConvexBridgeCloudClient({
    appUrl: config.appUrl,
    bridgeApiUrl: config.bridgeApiUrl,
    logIngestUrl: config.logIngestUrl,
    deviceId: config.deviceId,
    bridgeToken: config.bridgeToken,
    requestTimeoutMs:
      options.requestTimeoutMs ?? getCloudRequestTimeoutMs({}, process.env),
    paths: {
      heartbeat: DEFAULT_HEARTBEAT_PATH,
      queueClaim: DEFAULT_CLAIM_PATH,
      queueCleanupStale: DEFAULT_CLEANUP_STALE_PATH,
      queueResult: DEFAULT_RESULT_PATH,
    },
  });
}

function getBridgeLogUrl(
  flags: FlagMap,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return getFlag(flags, "log-url", env.ZERO_CHAT_BRIDGE_LOG_URL);
}

type BridgeWakeSignalClient = {
  close: () => void | Promise<void>;
  onUpdate: (
    query: unknown,
    args: Record<string, unknown>,
    callback: () => void,
    onError?: (error: unknown) => void,
  ) => { unsubscribe?: () => void } | (() => void);
};

export function createBridgeWakeSignal(input: {
  config: BridgeConfig;
  convexUrl: string | undefined;
  limit: number;
  log: FlushableBridgeLogger;
  clientFactory?: (url: string) => BridgeWakeSignalClient;
}): BridgeWakeSignal {
  if (!input.convexUrl) {
    input.log({
      level: "warn",
      event: "bridge.subscription.disabled",
      deviceId: input.config.deviceId,
      reason: "missing_convex_url",
      limit: input.limit,
    });
    return createTimeoutWakeSignal();
  }

  let closed = false;
  let client: BridgeWakeSignalClient | undefined;
  let unsubscribe: (() => void) | undefined;
  let activeToken: string | undefined;
  let activeTokenExpiresAt: number | undefined;
  let activeTokenRefreshAt: number | undefined;
  const waiters = new Set<() => void>();
  const clientFactory =
    input.clientFactory ??
    ((url: string) => new ConvexClient(url) as unknown as BridgeWakeSignalClient);

  const wake = () => {
    for (const resolve of Array.from(waiters)) {
      waiters.delete(resolve);
      resolve();
    }
  };
  const teardownSubscription = async (clearState = false) => {
    unsubscribe?.();
    unsubscribe = undefined;
    const previousClient = client;
    client = undefined;
    if (previousClient) {
      await previousClient.close();
    }
    if (clearState) {
      activeToken = undefined;
      activeTokenExpiresAt = undefined;
      activeTokenRefreshAt = undefined;
    }
  };
  const subscribe = (wakeToken: BridgeWakeToken) => {
    if (closed || wakeToken.token === activeToken) {
      return;
    }
    void teardownSubscription();
    const now = Date.now();
    const refreshAfterMs = Math.max(
      1,
      Math.min(wakeToken.refreshAfterMs, wakeToken.expiresAt - now),
    );
    activeToken = wakeToken.token;
    activeTokenExpiresAt = wakeToken.expiresAt;
    activeTokenRefreshAt = now + refreshAfterMs;
    client = clientFactory(input.convexUrl!);
    const query = makeFunctionReference<"query">("bridgeOutboundQueue:workSignal");
    const result = client.onUpdate(
      query,
      {
        deviceId: input.config.deviceId,
        wakeToken: wakeToken.token,
        limit: input.limit,
      },
      wake,
      (error) => {
        input.log({
          level: "warn",
          event: "bridge.subscription.error",
          deviceId: input.config.deviceId,
          error: redactForOutput(error instanceof Error ? error.message : String(error)),
        });
      },
    );
    unsubscribe =
      typeof result === "function" ? result : () => result.unsubscribe?.();
    input.log({
      level: "info",
      event: "bridge.subscription.enabled",
      deviceId: input.config.deviceId,
      limit: input.limit,
    });
  };

  input.log({
    level: "info",
    event: "bridge.subscription.awaiting_wake_token",
    deviceId: input.config.deviceId,
    limit: input.limit,
  });

  return {
    wait: async (timeoutMs: number) => {
      if (closed) {
        return "timeout";
      }
      return await new Promise<BridgeWakeWaitResult>((resolve) => {
        const onWake = () => {
          clearTimeout(timeout);
          resolve("signal");
        };
        const timeout = setTimeout(() => {
          waiters.delete(onWake);
          resolve("timeout");
        }, timeoutMs);
        waiters.add(onWake);
      });
    },
    close: async () => {
      closed = true;
      wake();
      await teardownSubscription(true);
    },
    isWakeSubscriptionActive: () =>
      !closed &&
      Boolean(unsubscribe) &&
      typeof activeTokenExpiresAt === "number" &&
      activeTokenExpiresAt > Date.now(),
    nextWakeTokenRefreshAt: () => activeTokenRefreshAt,
    updateWakeToken: (wakeToken) => {
      if (!wakeToken || wakeToken.expiresAt <= Date.now()) {
        return;
      }
      subscribe(wakeToken);
    },
  };
}

function createTimeoutWakeSignal(): BridgeWakeSignal {
  let closed = false;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const resolve of Array.from(waiters)) {
      waiters.delete(resolve);
      resolve();
    }
  };
  return {
    wait: async (timeoutMs: number) => {
      if (closed) {
        return "timeout";
      }
      await new Promise<void>((resolve) => {
        const onWake = () => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          waiters.delete(onWake);
          resolve();
        }, timeoutMs);
        waiters.add(onWake);
      });
      return "timeout";
    },
    close: async () => {
      closed = true;
      wake();
    },
  };
}

async function postJson<T>(
  url: string,
  token: string | undefined,
  body: unknown,
): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url} failed (${response.status}): ${text}`);
  }
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as T;
}

async function readBridgeConfigFile(path: string): Promise<MultiBridgeConfig> {
  return normalizeBridgeConfigFile(await readJsonFile<BridgeConfigFile>(path));
}

export async function appendBridgeRegistration(
  path: string,
  registration: BridgeRegistration,
): Promise<MultiBridgeConfig> {
  const existing = existsSync(path)
    ? normalizeAppendableBridgeConfig(await readJsonFile<BridgeConfigFile>(path))
    : ({ version: 2, registrations: [] } satisfies MultiBridgeConfig);
  const next = upsertBridgeRegistration(existing, registration);
  await writeBridgeConfigFile(path, next);
  return next;
}

function normalizeAppendableBridgeConfig(raw: unknown): MultiBridgeConfig {
  const record = recordFromUnknown(raw);
  if (
    record?.version === 2 &&
    Array.isArray(record.registrations) &&
    record.registrations.length === 0
  ) {
    return { version: 2, registrations: [] };
  }
  return normalizeBridgeConfigFile(raw);
}

export async function preparePendingAgentConnectionRequest(
  configPath: string,
  code: string,
): Promise<PendingAgentConnectionRequest> {
  const path = pendingAgentConnectionRequestPath(configPath, code);
  if (existsSync(path)) {
    const existing = normalizePendingAgentConnectionRequest(
      await readJsonFile<PendingAgentConnectionRequest>(path),
      path,
    );
    await chmod(path, BRIDGE_LOCAL_STATE_MODE);
    return existing;
  }

  const request = {
    bridgeToken: randomBridgeToken(),
    createdAt: new Date().toISOString(),
    deviceId: `bridge_${randomBytes(12).toString("hex")}`,
    path,
  };
  await writeSecureJsonFile(path, request);
  return request;
}

async function clearPendingAgentConnectionRequest(
  request: PendingAgentConnectionRequest,
): Promise<void> {
  await unlink(request.path).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  });
}

function pendingAgentConnectionRequestPath(
  configPath: string,
  code: string,
): string {
  const codeHash = createHash("sha256")
    .update(code.trim().toUpperCase())
    .digest("hex")
    .slice(0, 32);
  return join(dirname(configPath), "agent-connection-requests", `${codeHash}.json`);
}

function normalizePendingAgentConnectionRequest(
  value: unknown,
  path: string,
): PendingAgentConnectionRequest {
  const record = recordFromUnknown(value);
  if (!record) {
    throw new Error("pending agent connection request must be an object");
  }
  const deviceId = readString(record.deviceId, "deviceId");
  const bridgeToken = readString(record.bridgeToken, "bridgeToken");
  const createdAt = readString(record.createdAt, "createdAt");
  if (!/^bridge_[0-9a-f]{24}$/.test(deviceId)) {
    throw new Error("pending agent connection request has invalid deviceId");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(bridgeToken)) {
    throw new Error("pending agent connection request has invalid bridgeToken");
  }
  return { bridgeToken, createdAt, deviceId, path };
}

function randomBridgeToken(): string {
  return randomBytes(32).toString("base64url").slice(0, 43);
}

export async function ensureSecureBridgeConfigFile(
  path: string,
): Promise<void> {
  if (!existsSync(path)) {
    return;
  }
  await chmod(path, BRIDGE_LOCAL_STATE_MODE);
}

export async function writeBridgeConfigFile(
  path: string,
  value: unknown,
): Promise<void> {
  await writeSecureJsonFile(path, value);
}

async function writeSecureJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: BRIDGE_LOCAL_STATE_MODE,
  });
  await chmod(tempPath, BRIDGE_LOCAL_STATE_MODE);
  await rename(tempPath, path);
  await chmod(path, BRIDGE_LOCAL_STATE_MODE);
}

export async function writeBridgeStatusFile(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: BRIDGE_LOCAL_STATE_MODE,
  });
  await chmod(tempPath, BRIDGE_LOCAL_STATE_MODE);
  await rename(tempPath, path);
  await chmod(path, BRIDGE_LOCAL_STATE_MODE);
}

async function writeAgentConnectionSkill(
  path: string,
  input: {
    agentCommand: string;
    appUrl: string;
    configPath: string;
    skillPath: string;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = `# 0000 Agent Bridge

Use this skill whenever the user asks you to work through 0000, reconnect to 0000, or diagnose the local 0000 bridge.

## Start or Reconnect

1. Work from the local 0000 checkout that installed this skill.
2. Start the bridge with:

\`\`\`bash
bun scripts/acp-bridge.ts start --agent-command ${JSON.stringify(input.agentCommand)}
\`\`\`

3. If the bridge config is missing, ask the human to generate a new 0000 agent connection code, then run:

\`\`\`bash
bun scripts/acp-bridge.ts connect <code> --app-url ${JSON.stringify(input.appUrl)} --agent-command ${JSON.stringify(input.agentCommand)} --skill-path ${JSON.stringify(input.skillPath)}
\`\`\`

## Local State

- Bridge config: \`${input.configPath}\`
- Skill file: \`${input.skillPath}\`
- App URL: \`${input.appUrl}\`

Never reveal bridge tokens, auth headers, API keys, or raw connection codes in chat. Summarize setup results in plain language and tell the human whether approval is still pending.
`;
  await writeFile(path, content, "utf8");
}

async function writeStatus(path: string, status: BridgeStatus): Promise<void> {
  await writeBridgeStatusFile(path, status);
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as T;
}

function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          recordFromUnknown(entry) !== undefined,
      )
    : [];
}

function attachmentFromUnknown(
  value: unknown,
): BridgeQueueAttachment | undefined {
  const record = recordFromUnknown(value);
  if (!record) {
    return undefined;
  }
  const accessRecord = recordFromUnknown(record.access);
  const access = accessRecord
    ? compact({
        mode: stringFromUnknown(accessRecord.mode),
        url: stringFromUnknown(accessRecord.url),
      })
    : undefined;
  const url = stringFromUnknown(record.url);
  const accessUrl = access?.url;
  if (!url && !accessUrl) {
    return undefined;
  }
  return compact({
    access,
    bucket: stringFromUnknown(record.bucket),
    checksumSha256: stringFromUnknown(record.checksumSha256),
    createdAt: stringFromUnknown(record.createdAt),
    filename: stringFromUnknown(record.filename),
    key: stringFromUnknown(record.key),
    mediaType: stringFromUnknown(record.mediaType),
    objectKey: stringFromUnknown(record.objectKey),
    sizeBytes: numberFromUnknown(record.sizeBytes),
    status: stringFromUnknown(record.status),
    storageBackend: stringFromUnknown(record.storageBackend),
    type: stringFromUnknown(record.type),
    url,
  });
}

function attachmentsFromUnknown(
  value: unknown,
): BridgeQueueCommand["attachments"] | undefined {
  const attachments = arrayOfRecords(value)
    .map((record) => attachmentFromUnknown(record))
    .filter(
      (attachment): attachment is NonNullable<typeof attachment> =>
        attachment !== undefined,
    );
  return attachments.length > 0 ? attachments : undefined;
}

export function normalizeQueueCommand(
  raw: unknown,
): BridgeQueueCommand | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const rawRecord = raw as Record<string, unknown>;
  const payload = recordFromUnknown(rawRecord.payload);
  const record = { ...(payload ?? {}), ...rawRecord };
  const id = stringFromUnknown(record.id);
  const type = stringFromUnknown(record.type ?? record.kind);
  if (!id || !isQueueCommandType(type)) {
    return undefined;
  }
  const payloadText = payload ? stringFromUnknown(payload.text) : undefined;
  const payloadContinuationPrompt = payload
    ? stringFromUnknown(payload.continuationPrompt)
    : undefined;
  const prompt =
    stringFromUnknown(record.prompt) ??
    (type === "choice-response"
      ? (payloadContinuationPrompt ?? payloadText)
      : undefined) ??
    (type === "input-response"
      ? (payloadText ?? payloadContinuationPrompt)
      : undefined);
  const approvalOutcome =
    stringFromUnknown(record.approvalOutcome) ??
    (type === "choice-response" ? payloadText : undefined);
  const createdAtMs = timestampMsFromUnknown(record.createdAt);
  const claimedAtMs = timestampMsFromUnknown(record.claimedAt);
  return {
    id,
    claimId: stringFromUnknown(record.claimId),
    claimedAt:
      stringFromUnknown(record.claimedAt) ??
      (claimedAtMs === undefined
        ? undefined
        : new Date(claimedAtMs).toISOString()),
    claimedAtMs,
    createdAt:
      stringFromUnknown(record.createdAt) ??
      (createdAtMs === undefined
        ? undefined
        : new Date(createdAtMs).toISOString()),
    createdAtMs,
    type,
    attachments: attachmentsFromUnknown(record.attachments),
    threadId: stringFromUnknown(record.threadId),
    sessionId: stringFromUnknown(record.sessionId),
    agentSessionId: stringFromUnknown(record.agentSessionId),
    codeAttribution: codeAttributionFromUnknown(record.codeAttribution),
    cwd: stringFromUnknown(record.cwd),
    prompt,
    threadHistory: stringFromUnknown(record.threadHistory),
    systemPrompt: stringFromUnknown(record.systemPrompt),
    approvalId: stringFromUnknown(record.approvalId),
    approvalOutcome,
    approvalReason: stringFromUnknown(record.approvalReason),
    approvalLevel:
      record.approvalLevel === "ask" ||
      record.approvalLevel === "full_permissions"
        ? record.approvalLevel
        : undefined,
    resumePolicy:
      record.resumePolicy === "live_callback" ||
      record.resumePolicy === "durable_continuation"
        ? record.resumePolicy
        : undefined,
    externalRequestId: stringFromUnknown(record.externalRequestId),
    externalSessionId: stringFromUnknown(record.externalSessionId),
    agentName: stringFromUnknown(record.agentName),
    bridgeProfileId: stringFromUnknown(record.bridgeProfileId),
    hermesProfileName: stringFromUnknown(record.hermesProfileName),
    mailboxConversationId: stringFromUnknown(record.mailboxConversationId),
    organizationId: stringFromUnknown(record.organizationId),
    runtimeConfig: stringRecordFromUnknown(record.runtimeConfig),
    runtimeOptions: runtimeOptionsFromUnknown(record.runtimeOptions),
    traceId: stringFromUnknown(record.traceId),
  };
}

function runtimeOptionsFromUnknown(
  value: unknown,
): BridgeQueueCommand["runtimeOptions"] | undefined {
  const record = recordFromUnknown(value);
  if (!record) {
    return undefined;
  }
  const runtimeOptions = compact({
    modelId: stringFromUnknown(record.modelId),
    thinkingLevel: stringFromUnknown(record.thinkingLevel),
  });
  return Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined;
}

function isQueueCommandType(
  value: string | undefined,
): value is BridgeQueueCommand["type"] {
  return (
    value === "prompt" ||
    value === "cancel" ||
    value === "cancel-session" ||
    value === "close-session" ||
    value === "approval" ||
    value === "approval-response" ||
    value === "choice-response" ||
    value === "input-response" ||
    value === "permission-response" ||
    value === "ping" ||
    value === "revive-session" ||
    value === "start-session" ||
    value === "steer-session"
  );
}

function readString(value: unknown, name: string): string {
  const result = stringFromUnknown(value);
  if (!result) {
    throw new Error(`pair response missing ${name}`);
  }
  return result;
}

function redactForOutput(value: string): string {
  return String(redactLogValue(value));
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return result.length > 0 ? result : undefined;
}

function stringArrayFromUnknownAllowEmpty(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function timestampMsFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringRecordFromUnknown(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, stringFromUnknown(entry)] as const)
    .filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined,
    );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeStdout(message: string): void {
  process.stdout.write(message);
}

function writeStderr(message: string): void {
  process.stderr.write(message);
}

if (import.meta.main) {
  void main();
}
