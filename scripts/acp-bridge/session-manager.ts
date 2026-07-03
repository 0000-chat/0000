import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";

import {
  type HermesAcpPromptAttachment,
  type HermesAcpMcpServer,
  type HermesAcpProcessRegistryMetadata,
  type HermesAcpPromptResult,
  type HermesAcpPromptTimeoutDiagnostics,
  type RuntimeConfigApplicationResult,
  HermesAcpSession,
  resolveRuntimeConfigApplication,
} from "./acp-session";
import {
  type BridgeLogEntry,
  type BridgeLogger,
  redactLogValue,
} from "./bridge-log";
import {
  attributionPromptContext,
  attributionSessionKeyPart,
  gitAuthorEnv,
  sanitizeGitAuthor,
  type BridgeCodeAttribution,
} from "./git-attribution";
import type {
  AgentAttachmentUploadInput,
  BridgeEventInput,
} from "./convex-http";
import type {
  BridgeAttachmentUploadCandidate,
  NormalizedBridgeEvent,
} from "./event-normalizer";
import {
  type BridgeRuntimeProfile,
  type BridgeRuntimeToolCallClass,
  type BridgeToolCallTimeoutResolution,
  applyRuntimeMcpServerCompatibility,
  commandKey,
  findRuntimeProfile,
  resolveToolCallTimeoutPolicy,
} from "./runtime-profiles";
import type {
  BridgeSupervisor,
  BridgeSupervisorWorkItem,
} from "./bridge-supervisor";
import type { AcpBridgeProcessRegistryLike } from "./process-registry";
import {
  createSessionLivenessRecord,
  evaluateSessionLiveness,
  reduceSessionLiveness,
  type SessionLivenessRecord,
} from "./session-liveness";
import {
  TerminalHandleRegistry,
  type TerminalHandleScope,
} from "./terminal-handles";
import type {
  SdkAcpRuntimeTerminalAdapter,
  SdkAcpRuntimeTerminalHandle,
} from "./sdk-acp-runtime-client";

export type BridgeSessionQueueItem = {
  id: string;
  claimId?: string;
  claimedAt?: string;
  claimedAtMs?: number;
  createdAt?: string;
  createdAtMs?: number;
  type?: string;
  kind?: string;
  attachments?: BridgeQueueAttachment[];
  threadId?: string;
  sessionId?: string;
  agentSessionId?: string;
  codeAttribution?: BridgeCodeAttribution;
  cwd?: string;
  prompt?: string;
  threadHistory?: string;
  systemPrompt?: string;
  runtimeOptions?: {
    modelId?: string;
    thinkingLevel?: string;
  };
  approvalId?: string;
  approvalOutcome?: string;
  approvalReason?: string;
  approvalLevel?: "ask" | "full_permissions";
  resumePolicy?: "live_callback" | "durable_continuation";
  externalRequestId?: string;
  externalSessionId?: string;
  organizationId?: string;
  mailboxConversationId?: string;
  runtimeConfig?: Record<string, string | undefined>;
  traceId?: string;
  agentName?: string;
  bridgeProfileId?: string;
  hermesProfileName?: string;
};

export type BridgeQueueAttachment = {
  access?: {
    expiresAt?: number;
    mode?: string;
    url?: string;
  };
  bucket?: string;
  checksumSha256?: string;
  contentHash?: string;
  createdAt?: string;
  createdBy?: string;
  filename?: string;
  key?: string;
  mediaType?: string;
  objectKey?: string;
  sizeBytes?: number;
  status?: string;
  storageBackend?: string;
  threadId?: string;
  type?: string;
  url?: string;
};

export type ManagedAcpSession = {
  readonly sessionId?: string;
  start?(): Promise<string>;
  sendUserMessage(
    text: string,
    options?: {
      systemPrompt?: string;
      threadHistory?: string;
      attachmentReferenceText?: string;
      attachments?: HermesAcpPromptAttachment[];
      attributionContext?: string;
      autoApprovePermissionRequests?: boolean;
      runtimeConfig?: Record<string, string>;
    },
  ): Promise<HermesAcpPromptResult>;
  cancel(): Promise<boolean | void>;
  close(): Promise<void>;
  respondToPermissionRequest?(
    externalRequestId: string,
    response: { approved: boolean; reason?: string },
  ): Promise<boolean>;
  hasPendingPermissionRequests?(): boolean;
  getPromptTimeoutDiagnostics?(): HermesAcpPromptTimeoutDiagnostics;
  getExternalContinuityState?(): {
    attempted: boolean;
    fallback: boolean;
    loaded: boolean;
  };
};

export type BridgeSessionContext = {
  agentCommand?: string | string[];
  agentSessionId?: string;
  bridgeProfileId?: string;
  launchSpecKey?: string;
  launchSpecSummary?: BridgeLaunchSpecSummary;
  runtimeProfile?: BridgeRuntimeProfile;
  sessionKey: string;
  threadId: string;
  cwd?: string;
  hermesProfileName?: string;
  mcpServers: HermesAcpMcpServer[];
  initialSessionId?: string;
  organizationId?: string;
  terminalAdapter?: SdkAcpRuntimeTerminalAdapter;
  terminalScope?: TerminalHandleScope;
  processRegistryMetadata?: HermesAcpProcessRegistryMetadata;
  gitAuthorEnv?: Record<string, string>;
  onEvent: (event: NormalizedBridgeEvent) => void;
  onEventBoundary?: () => void;
  onError: (error: Error) => void;
};

export type BridgeTerminalContext = {
  generation: number;
  terminalScope: TerminalHandleScope;
} & Pick<
  BridgeSessionContext,
  | "agentCommand"
  | "agentSessionId"
  | "bridgeProfileId"
  | "cwd"
  | "hermesProfileName"
  | "initialSessionId"
  | "organizationId"
  | "runtimeProfile"
  | "launchSpecKey"
  | "launchSpecSummary"
  | "sessionKey"
  | "threadId"
>;

type BridgeSessionRecord = {
  sessionKey: string;
  threadId: string;
  cwd?: string;
  pendingAttachmentUploadEvents: NormalizedBridgeEvent[];
  mcpManifestHash?: string;
  toolPolicyHash?: string;
  acp: ManagedAcpSession;
  agentName?: string;
  launchSpecKey?: string;
  launchSpecSummary?: BridgeLaunchSpecSummary;
  runtimeProfile?: BridgeRuntimeProfile;
  hermesProfileName?: string;
  generation: number;
  providerSessionKey: string;
  organizationId?: string;
  scopeConversationId: string;
  scopeKeyWithoutAgent: string;
  terminalScope?: TerminalHandleScope;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastUsedAt: number;
};

type BridgeWarmSessionCandidate = Pick<
  BridgeSessionQueueItem,
  | "agentName"
  | "agentSessionId"
  | "bridgeProfileId"
  | "cwd"
  | "hermesProfileName"
  | "mailboxConversationId"
  | "organizationId"
  | "sessionId"
  | "threadId"
> & {
  lastUsedAt: number;
  launchSpecKey?: string;
  runtimeProfileId?: string;
  sessionKey: string;
};

type BridgeSessionCloudClient = {
  appendEvents(events: BridgeEventInput[]): Promise<Record<string, unknown>>;
  uploadAttachment(
    input: AgentAttachmentUploadInput,
  ): Promise<{ file: Record<string, unknown> }>;
  markResult(
    commandId: string,
    result: Record<string, unknown>,
    claimId?: string,
  ): Promise<Record<string, unknown>>;
};

export type BridgeLaunchSpecSummary = {
  command: string;
  bridgeProfileId?: string;
  hermesProfileName?: string;
  runtimeKind: BridgeRuntimeProfile["kind"];
};

type BridgeLaunchSpec = {
  agentCommand: string[];
  key: string;
  runtimeKind: BridgeRuntimeProfile["kind"];
  summary: BridgeLaunchSpecSummary;
};

type EventWriteOutcome =
  | { ok: true; count: number }
  | { ok: false; count: number; error: Error };

type ActiveToolCall = {
  runtimeProfileId?: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  toolCallId: string;
  toolClass: BridgeRuntimeToolCallClass;
  toolName: string;
  toolPolicyId: string;
  toolTimeoutMs: number;
};

type ToolResultTimeoutDetails = {
  ageMs: number;
  failureClass: "tool_result_propagation_lost";
  timeoutMs: number;
  toolCallId: string;
  toolClass: string;
  toolName: string;
  toolPolicyId: string;
};

type ToolCallReconciliationTrigger =
  | "assistant_output_resumed"
  | "later_tool_started"
  | "turn_completed";

export type BridgeTerminalizationMetadata = {
  ageMs?: number;
  failureClass?: string;
  reasonCode?: string;
  timeoutMs?: number;
  toolCallId?: string;
  toolClass?: string;
  toolName?: string;
  toolPolicyId?: string;
};

type BoundedBridgeTerminalizationMetadata = BridgeTerminalizationMetadata & {
  reasonCode: string;
};

const EVENT_BATCH_MAX_SIZE = 25;
const EVENT_BATCH_FLUSH_MS = 300;
const STREAM_CHUNK_COALESCE_MAX_CHARS = 4_000;
const STREAM_CHUNK_COALESCE_MAX_COUNT = 32;
const APPROVAL_RESPONSE_SESSION_WAIT_MS = 250;
const APPROVAL_RESPONSE_SESSION_POLL_MS = 10;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_LIVENESS_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 5 * 60_000;
const MAX_WARM_SESSION_CANDIDATES = 64;
const MAX_TERMINAL_INTERACTION_SESSION_KEYS = 300;
const MAX_TERMINALIZATION_METADATA_TEXT_LENGTH = 200;

export type BridgeSessionManagerOptions = {
  cloudClient: BridgeSessionCloudClient;
  deviceId?: string;
  agentCommand?: string | string[];
  runtimeProfiles?: BridgeRuntimeProfile[];
  currentMcpManifestHash?: string | (() => string | undefined);
  currentToolPolicyHash?: string | (() => string | undefined);
  requestTimeoutMs?: number;
  createMcpServers?: (
    context: Pick<
      BridgeSessionContext,
      "agentSessionId" | "cwd" | "organizationId" | "sessionKey" | "threadId"
    >,
  ) => HermesAcpMcpServer[];
  createSession?: (context: BridgeSessionContext) => ManagedAcpSession;
  idleSessionTtlMs?: number;
  allowRemoteCwd?: boolean;
  resumeEnabled?: boolean;
  requireScopedIdentity?: boolean;
  log?: BridgeLogger;
  livenessTimeoutMs?: number;
  toolResultTimeoutMs?: number;
  supervisor?: BridgeSupervisor;
  processRegistry?: Pick<
    AcpBridgeProcessRegistryLike,
    "registerProcess" | "terminateProcess"
  >;
  closeTimeoutMs?: number;
  terminalRegistry?: TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>;
  createTerminal?: (
    context: BridgeTerminalContext,
    params: CreateTerminalRequest,
  ) => Promise<SdkAcpRuntimeTerminalHandle>;
  onQueueResultMarked?: (
    item: BridgeSessionQueueItem,
    result: Record<string, unknown>,
  ) => void;
};

export type BridgeSessionManagerStatus = {
  activeSessions: string[];
  liveness?: {
    activeSessions: SessionLivenessRecord[];
  };
  retainedSessions?: BridgeSessionManagerSessionStatus[];
  terminalInteractionSessionKeyCount: number;
  sessions: BridgeSessionManagerSessionStatus[];
};

export type BridgeSessionManagerSessionStatus = {
  sessionKey: string;
  threadId: string;
  agentSessionId?: string;
  bridgeProfileId?: string;
  organizationId?: string;
  launchSpecKey?: string;
  launchSpecSummary?: BridgeLaunchSpecSummary;
  runtimeProfileId?: string;
  runtimeLabel?: string;
  runtimeKind?: string;
  hermesProfileName?: string;
  queueDepth: number;
  runningQueueItemId?: string;
  lastUsedAt: number;
};

export type BridgeProcessPressureCleanupRequest = {
  targetFreeProcessSlots: number;
  maxSessionsToClose?: number;
};

export type BridgeWarmRuntimeSessionRequest = {
  runtimeProfileIds: string[];
  maxSessions?: number;
  canStartSession?: () => boolean;
};

export type BridgeWarmRuntimeSessionSeed = {
  agentName?: string;
  agentSessionId?: string;
  bridgeProfileId?: string;
  cwd?: string;
  hermesProfileName?: string;
  lastUsedAt?: number;
  launchSpecKey?: string;
  mailboxConversationId?: string;
  organizationId?: string;
  runtimeProfileId?: string;
  sessionId?: string;
  threadId: string;
};

export type BridgeWarmRuntimeSessionSeedRequest = {
  candidates: BridgeWarmRuntimeSessionSeed[];
};

export type BridgeSessionLogEntry = BridgeLogEntry;

export function bridgeQueueItemMatchesSessionRuntimeScope(
  item: Pick<BridgeSessionQueueItem, "bridgeProfileId" | "hermesProfileName">,
  session: { hermesProfileName?: string; runtimeProfileId?: string },
): boolean {
  if (
    item.bridgeProfileId !== undefined &&
    item.bridgeProfileId !== session.runtimeProfileId
  ) {
    return false;
  }
  if (
    item.hermesProfileName !== undefined &&
    item.hermesProfileName !== session.hermesProfileName
  ) {
    return false;
  }
  return true;
}

export function resolveHermesProfileAgentCommand(
  baseCommand: string | string[] | undefined,
  hermesProfileName: string | undefined,
): string[] {
  const command = Array.isArray(baseCommand)
    ? [...baseCommand]
    : splitCommand(baseCommand ?? "hermes acp");
  const profileName = hermesProfileName?.trim();
  if (!profileName) {
    return command;
  }
  const acpIndex = command.findIndex((part) => part === "acp");
  if (acpIndex < 0) {
    return [...command, "-p", profileName, "acp"];
  }
  return [
    ...command.slice(0, acpIndex),
    "-p",
    profileName,
    ...command.slice(acpIndex),
  ];
}

export function buildBridgeLaunchSpec(input: {
  baseAgentCommand?: string | string[];
  bridgeProfileId?: string;
  hermesProfileName?: string;
  runtimeProfile?: BridgeRuntimeProfile;
}): BridgeLaunchSpec {
  const legacyHermesProfileName =
    input.runtimeProfile?.id !== input.bridgeProfileId &&
    input.bridgeProfileId?.startsWith("hermes:") &&
    input.bridgeProfileId !== "hermes:default"
      ? input.bridgeProfileId.slice("hermes:".length)
      : undefined;
  const profileName = input.hermesProfileName?.trim() || legacyHermesProfileName;
  const runtimeProfile = input.runtimeProfile;
  if (profileName && runtimeProfile && runtimeProfile.kind !== "hermes") {
    throw new Error(
      `ACP launch spec is incompatible: Hermes profile ${profileName} cannot use runtime ${runtimeProfile.id}`,
    );
  }
  const baseCommand = runtimeProfile?.command ?? input.baseAgentCommand;
  const agentCommand =
    runtimeProfile?.kind === "hermes" || (!runtimeProfile && profileName)
      ? resolveHermesProfileAgentCommand(baseCommand, profileName)
      : Array.isArray(baseCommand)
        ? [...baseCommand]
        : splitCommand(baseCommand ?? "hermes acp");
  const runtimeKind = runtimeProfile?.kind ?? inferRuntimeKind(agentCommand);
  const baseKey =
    runtimeProfile?.id ??
    (legacyHermesProfileName ? "hermes:default" : input.bridgeProfileId) ??
    commandKey(agentCommand);
  const key = profileName
    ? `${baseKey}|hermes-profile:${profileName}`
    : baseKey;
  return {
    agentCommand,
    key,
    runtimeKind,
    summary: removeUndefinedValues({
      bridgeProfileId:
        (legacyHermesProfileName ? "hermes:default" : input.bridgeProfileId) ??
        runtimeProfile?.id,
      command: summarizeLaunchCommand(agentCommand, profileName),
      hermesProfileName: profileName,
      runtimeKind,
    }) as BridgeLaunchSpecSummary,
  };
}

function inferRuntimeKind(command: string[]): BridgeRuntimeProfile["kind"] {
  const executable = command[0]?.toLowerCase() ?? "";
  const joined = command.join(" ").toLowerCase();
  if (executable.includes("hermes") || joined.includes("hermes")) {
    return "hermes";
  }
  if (joined.includes("codex")) {
    return "codex";
  }
  if (joined.includes("claude")) {
    return "claude-code";
  }
  if (joined.includes("openclaw")) {
    return "openclaw";
  }
  return "unknown-acp";
}

function summarizeLaunchCommand(command: string[], hermesProfileName?: string): string {
  if (!hermesProfileName) {
    return command.join(" ");
  }
  return command
    .map((part, index) =>
      index > 0 && command[index - 1] === "-p"
        ? "<hermes-profile>"
        : part,
    )
    .join(" ");
}

export class BridgeSessionManager {
  private readonly cloudClient: BridgeSessionCloudClient;
  private readonly deviceId?: string;
  private readonly agentCommand?: string | string[];
  private readonly runtimeProfiles: BridgeRuntimeProfile[];
  private readonly getCurrentMcpManifestHash: () => string | undefined;
  private readonly getCurrentToolPolicyHash: () => string | undefined;
  private readonly requestTimeoutMs?: number;
  private readonly createMcpServers: (
    context: Pick<
      BridgeSessionContext,
      "agentSessionId" | "cwd" | "organizationId" | "sessionKey" | "threadId"
    >,
  ) => HermesAcpMcpServer[];
  private readonly log?: BridgeLogger;
  private readonly supervisor?: BridgeSupervisor;
  private readonly processRegistry?: Pick<
    AcpBridgeProcessRegistryLike,
    "registerProcess" | "terminateProcess"
  >;
  private readonly idleSessionTtlMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly toolResultTimeoutMs: number;
  private readonly explicitToolResultTimeoutMs?: number;
  private readonly allowRemoteCwd: boolean;
  private readonly resumeEnabled: boolean;
  private readonly requireScopedIdentity: boolean;
  private readonly closeTimeoutMs: number;
  private readonly terminalRegistry?: TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>;
  private readonly createTerminal:
    | ((
        context: BridgeTerminalContext,
        params: CreateTerminalRequest,
      ) => Promise<SdkAcpRuntimeTerminalHandle>)
    | undefined;
  private readonly onQueueResultMarked?: (
    item: BridgeSessionQueueItem,
    result: Record<string, unknown>,
  ) => void;
  private readonly createSession: (
    context: BridgeSessionContext,
  ) => ManagedAcpSession;
  private readonly sessions = new Map<string, BridgeSessionRecord>();
  private readonly promptQueues = new Map<string, Promise<void>>();
  private readonly activeQueueItems = new Map<string, BridgeSessionQueueItem>();
  private readonly sessionQueueState = new Map<
    string,
    { pendingQueueItemIds: string[]; runningQueueItemId?: string }
  >();
  private readonly cancelledQueueItemIds = new Set<string>();
  private readonly externallyTerminalizedQueueItemIds = new Set<string>();
  private readonly terminalInteractionSessionKeys = new Set<string>();
  private readonly terminalInteractionSessionKeyOrder: string[] = [];
  private readonly activeLiveness = new Map<string, SessionLivenessRecord>();
  private readonly activeLivenessFailures = new Map<
    string,
    (error: Error) => void
  >();
  private readonly activeToolCalls = new Map<string, Map<string, ActiveToolCall>>();
  private readonly activeToolTimeoutFailures = new Map<
    string,
    ToolResultTimeoutDetails
  >();
  private readonly warmSessionCandidates = new Map<
    string,
    BridgeWarmSessionCandidate
  >();
  private readonly lastSessionEventQueueItems = new Map<
    string,
    BridgeSessionQueueItem
  >();
  private readonly firstAssistantTextLoggedQueueItems = new Set<string>();
  private readonly firstRuntimeActivityLoggedQueueItems = new Set<string>();
  private readonly eventBatch: BridgeEventInput[] = [];
  private readonly pendingEventWrites: Promise<EventWriteOutcome>[] = [];
  private pendingStreamChunkEvent: CoalescedBridgeStreamChunkEvent | undefined;
  private eventBatchTimer: ReturnType<typeof setTimeout> | undefined;
  private nextSequence = 1;
  private lastSessionUsageAt = 0;
  private readonly activePromptSequenceBases = new Map<string, number>();
  private nextGeneration = 1;

  constructor(options: BridgeSessionManagerOptions) {
    this.cloudClient = options.cloudClient;
    this.deviceId = options.deviceId;
    this.agentCommand = options.agentCommand;
    this.runtimeProfiles = options.runtimeProfiles ?? [];
    this.getCurrentMcpManifestHash = createHashReader(
      options.currentMcpManifestHash,
    );
    this.getCurrentToolPolicyHash = createHashReader(
      options.currentToolPolicyHash,
    );
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.log = options.log;
    this.supervisor = options.supervisor;
    this.processRegistry = options.processRegistry;
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? 0;
    this.livenessTimeoutMs =
      options.livenessTimeoutMs ?? DEFAULT_SESSION_LIVENESS_TIMEOUT_MS;
    this.explicitToolResultTimeoutMs = options.toolResultTimeoutMs;
    this.toolResultTimeoutMs =
      options.toolResultTimeoutMs ?? DEFAULT_TOOL_RESULT_TIMEOUT_MS;
    this.allowRemoteCwd = options.allowRemoteCwd !== false;
    this.resumeEnabled = options.resumeEnabled === true;
    this.requireScopedIdentity = options.requireScopedIdentity === true;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.terminalRegistry = options.terminalRegistry;
    this.createTerminal = options.createTerminal;
    this.onQueueResultMarked = options.onQueueResultMarked;
    this.createMcpServers = options.createMcpServers ?? (() => []);
    this.createSession =
      options.createSession ??
      ((context) =>
        new HermesAcpSession({
          agentCommand: context.agentCommand,
          cwd: context.cwd,
          env: context.gitAuthorEnv,
          initialSessionId: context.initialSessionId,
          mcpServers: context.mcpServers,
          processRegistry: this.processRegistry,
          processRegistryMetadata: context.processRegistryMetadata,
          requestTimeoutMs: this.requestTimeoutMs,
          resumeEnabled: this.resumeEnabled,
          onEvent: context.onEvent,
          onEventBoundary: context.onEventBoundary,
          onError: context.onError,
          terminalAdapter: context.terminalAdapter,
        }));
  }

  getStatus(): BridgeSessionManagerStatus {
    const sessions = Array.from(this.sessions.values()).map((session) => {
      const queueState = this.sessionQueueState.get(session.sessionKey);
      return {
        sessionKey: session.sessionKey,
        threadId: session.threadId,
        agentSessionId: session.providerSessionKey,
        bridgeProfileId: session.runtimeProfile?.id,
        organizationId: session.organizationId,
        launchSpecKey: session.launchSpecKey,
        launchSpecSummary: session.launchSpecSummary,
        runtimeProfileId: session.runtimeProfile?.id,
        runtimeLabel: session.runtimeProfile?.label,
        runtimeKind: session.launchSpecSummary?.runtimeKind ?? session.runtimeProfile?.kind,
        hermesProfileName: session.hermesProfileName,
        queueDepth:
          (queueState?.pendingQueueItemIds.length ?? 0) +
          (queueState?.runningQueueItemId ? 1 : 0),
        runningQueueItemId: queueState?.runningQueueItemId,
        lastUsedAt: session.lastUsedAt,
      };
    });
    const activeSessionKeys = new Set(
      Array.from(this.activeLiveness.values()).map(
        (session) => session.sessionKey,
      ),
    );
    for (const session of sessions) {
      if (session.queueDepth > 0 || session.runningQueueItemId) {
        activeSessionKeys.add(session.sessionKey);
      }
    }
    return {
      activeSessions: Array.from(activeSessionKeys),
      liveness: {
        activeSessions: Array.from(this.activeLiveness.values()),
      },
      retainedSessions: sessions,
      terminalInteractionSessionKeyCount:
        this.terminalInteractionSessionKeys.size,
      sessions,
    };
  }

  async closeIdleSessionsForProcessPressure(
    request: BridgeProcessPressureCleanupRequest,
  ): Promise<number> {
    const requestedCloseCount =
      request.maxSessionsToClose ?? request.targetFreeProcessSlots;
    const maxSessionsToClose = Math.max(0, Math.floor(requestedCloseCount));
    if (maxSessionsToClose <= 0) {
      return 0;
    }
    const idleSessions = Array.from(this.sessions.values())
      .filter((session) => this.canCloseSessionForIdlePressure(session))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
      .slice(0, maxSessionsToClose);
    let closedSessionCount = 0;
    for (const session of idleSessions) {
      if (!this.canCloseSessionForIdlePressure(session)) {
        continue;
      }
      this.writeLog({
        level: "info",
        event: "bridge.lifecycle.idle_pressure_close",
        threadId: session.threadId,
        agentSessionId: session.providerSessionKey,
        providerSessionId: session.providerSessionKey,
        acpSessionId: session.acp.sessionId,
        targetFreeProcessSlots: request.targetFreeProcessSlots,
      });
      await this.closeSession(session.sessionKey, {
        removeWarmCandidate: false,
      });
      closedSessionCount += 1;
    }
    return closedSessionCount;
  }

  async warmRuntimeSessions(
    request: BridgeWarmRuntimeSessionRequest,
  ): Promise<number> {
    const warmProfileIds = new Set(
      request.runtimeProfileIds
        .map((profileId) => profileId.trim())
        .filter((profileId) => profileId.length > 0),
    );
    if (warmProfileIds.size === 0) {
      return 0;
    }
    const maxSessions = Math.max(
      0,
      Math.floor(request.maxSessions ?? warmProfileIds.size),
    );
    if (maxSessions <= 0) {
      return 0;
    }
    const candidates = Array.from(this.warmSessionCandidates.values())
      .filter((candidate) =>
        warmSessionCandidateMatchesProfiles(candidate, warmProfileIds),
      )
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
    let warmedCount = 0;
    for (const candidate of candidates) {
      if (warmedCount >= maxSessions) {
        break;
      }
      if (request.canStartSession && !request.canStartSession()) {
        break;
      }
      if (this.sessions.has(candidate.sessionKey)) {
        continue;
      }
      const item = warmSessionQueueItem(candidate);
      if (this.hasLiveSessionForWarmCandidateScope(item, candidate)) {
        continue;
      }
      const session = await this.ensureSession(item, {
        closeReplacedSessions: false,
      });
      try {
        await session.acp.start?.();
      } catch (error) {
        await this.closeSession(session.sessionKey);
        this.warmSessionCandidates.delete(candidate.sessionKey);
        this.writeLog({
          level: "warn",
          event: "bridge.session.warm_failed",
          threadId: session.threadId,
          agentSessionId: session.providerSessionKey,
          reason:
            error instanceof Error
              ? error.message
              : String(error),
        });
        continue;
      }
      this.markSessionUsed(session);
      this.scheduleIdleClose(session);
      this.writeLog({
        level: "info",
        event: "bridge.session.warmed",
        threadId: session.threadId,
        agentSessionId: session.providerSessionKey,
      });
      warmedCount += 1;
    }
    return warmedCount;
  }

  seedWarmRuntimeSessions(
    request: BridgeWarmRuntimeSessionSeedRequest,
  ): number {
    let seededCount = 0;
    for (const candidate of request.candidates) {
      const threadId = candidate.threadId.trim();
      if (!threadId) {
        continue;
      }
      const item = warmSessionQueueItemFromSeed(candidate, threadId);
      if (
        this.requireScopedIdentity &&
        (!item.organizationId || !item.agentSessionId)
      ) {
        continue;
      }
      const sessionKey = this.sessionKeyForItem(item);
      if (!sessionKey) {
        continue;
      }
      this.warmSessionCandidates.set(sessionKey, {
        agentName: candidate.agentName,
        agentSessionId: item.agentSessionId,
        bridgeProfileId: item.bridgeProfileId,
        cwd: item.cwd,
        hermesProfileName: item.hermesProfileName,
        lastUsedAt:
          typeof candidate.lastUsedAt === "number" &&
          Number.isFinite(candidate.lastUsedAt)
            ? candidate.lastUsedAt
            : this.nextSessionUsageTimestamp(),
        launchSpecKey: candidate.launchSpecKey,
        mailboxConversationId: item.mailboxConversationId,
        organizationId: item.organizationId,
        runtimeProfileId: candidate.runtimeProfileId ?? item.bridgeProfileId,
        sessionId: item.sessionId,
        sessionKey,
        threadId,
      });
      seededCount += 1;
    }
    this.pruneWarmSessionCandidates();
    return seededCount;
  }

  async handleQueueItem(item: BridgeSessionQueueItem): Promise<void> {
    const type = normalizeType(item);
    this.activeQueueItems.set(item.id, item);
    this.supervisor?.recordQueued(this.supervisorWorkItem(item));
    this.supervisor?.recordClaimed(this.supervisorWorkItem(item));
    this.writeLog({
      level: "info",
      event: "bridge.queue_item.start",
      queueId: item.id,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
      bridgeProfileId: item.bridgeProfileId,
      hermesProfileName: item.hermesProfileName,
    });
    try {
      if (type === "ping") {
        await this.markQueueResult(item, { ok: true, kind: "pong" });
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (type === "start-session") {
        await this.handleStartSession(item);
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (type === "prompt") {
        this.writeAgentTurnLog("agent.turn.started", item, type);
        await this.handlePrompt(item);
        if (this.externallyTerminalizedQueueItemIds.has(item.id)) {
          return;
        }
        this.writeAgentTurnLog("agent.turn.completed", item, type);
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (type === "cancel" || type === "cancel-session") {
        this.supervisor?.recordCancelling(this.supervisorWorkItem(item));
        const cancelled = await this.handleCancel(item);
        if (cancelled) {
          this.supervisor?.recordCancelled(this.supervisorWorkItem(item));
        } else {
          this.supervisor?.recordFailed(
            this.supervisorWorkItem(item),
            "cancel_not_acknowledged",
          );
        }
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (type === "close-session") {
        await this.handleCloseSession(item);
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (type === "steer-session") {
        await this.handleSteerSession(item);
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (type === "revive-session") {
        await this.handleReviveSession(item);
        this.writeQueueCompleteLog(item, type);
        return;
      }

      if (isApprovalResponseType(type)) {
        await this.handleApprovalResponse(item, type);
        this.supervisor?.recordInteractionAnswered(
          this.supervisorWorkItem(item),
          item.externalRequestId ?? item.approvalId ?? item.id,
        );
        this.writeQueueCompleteLog(item, type);
        return;
      }

      await this.markQueueResult(item, {
        ok: false,
        error: `unsupported command type: ${type}`,
      });
      this.writeQueueCompleteLog(item, type);
    } catch (error) {
      if (this.externallyTerminalizedQueueItemIds.has(item.id)) {
        this.writeLog({
          level: "info",
          event: "bridge.lifecycle.externally_terminalized_result_ignored",
          queueId: item.id,
          queueType: type,
          threadId: item.threadId,
          sessionId: item.sessionId,
          agentSessionId: item.agentSessionId,
        });
        return;
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = String(redactLogValue(rawMessage));
      const startupFailure = classifyAcpStartupError(error);
      const launchSpec = this.safeLaunchSpecForItem(item);
      this.writeLog({
        level: "error",
        event: "bridge.queue_item.error",
        queueId: item.id,
        queueType: type,
        threadId: item.threadId,
        sessionId: item.sessionId,
        agentSessionId: item.agentSessionId,
        bridgeProfileId: item.bridgeProfileId,
        hermesProfileName: item.hermesProfileName
          ? "<hermes-profile>"
          : undefined,
        launchSpecKey: redactLaunchSpecKey(launchSpec?.key),
        launchSpecSummary: redactLaunchSpecSummary(launchSpec?.summary),
        runtimeKind: launchSpec?.runtimeKind,
        reasonCode: startupFailure?.reasonCode,
        error: message,
      });
      if (type === "prompt") {
        this.writeAgentTurnLog("agent.turn.failed", item, type, message);
      }
      this.supervisor?.recordFailed(this.supervisorWorkItem(item), message);
      await this.drainEventWrites();
      const terminal =
        startupFailure?.terminal === true ||
        isTerminalQueueItemError(type, rawMessage);
      await this.markQueueResult(
        item,
        terminal
          ? {
              ok: false,
              error: message,
              reasonCode: startupFailure?.reasonCode,
              bridgeProfileId: item.bridgeProfileId,
              hermesProfileName: item.hermesProfileName,
              launchSpecKey: launchSpec?.key,
              launchSpecSummary: launchSpec?.summary,
              runtimeKind: launchSpec?.runtimeKind,
              terminal,
            }
          : {
              ok: false,
              error: message,
            },
      );
    } finally {
      this.activeQueueItems.delete(item.id);
      this.clearFirstOutputLogState(item);
      if (!this.sessionQueueStateHasQueueItem(item.id)) {
        this.externallyTerminalizedQueueItemIds.delete(item.id);
      }
    }
  }

  async failActiveQueueItem(
    queueItemId: string,
    reasonCode: string,
    metadata?: BridgeTerminalizationMetadata,
  ): Promise<boolean> {
    const item = this.activeQueueItems.get(queueItemId);
    if (!item) {
      return false;
    }
    const failureMetadata = boundTerminalizationMetadata(reasonCode, metadata);
    const type = normalizeType(item);
    const sessionKey =
      this.findSessionKeyForActiveQueueItem(queueItemId) ??
      this.findSessionKeyForItem(item);
    const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
    this.externallyTerminalizedQueueItemIds.add(queueItemId);
    this.clearToolCallsForQueueItem(queueItemId);
    this.activeToolTimeoutFailures.delete(queueItemId);
    if (sessionKey) {
      this.clearQueueItemFromSessionQueue(sessionKey, queueItemId);
    }
    const message =
      reasonCode === "provider_silent_timeout"
        ? "ACP provider stopped producing events before the run completed."
        : `ACP bridge terminalized active queue item: ${reasonCode}`;
    if (type === "prompt") {
      this.writeAgentTurnLog("agent.turn.failed", item, type, reasonCode);
    }
    if (session) {
      this.enqueueEventWrite(session, {
        externalEventId: `${queueItemId}:${reasonCode}`,
        source: "bridge",
        eventType: "bridge_error",
        payload: {
          queueId: queueItemId,
          ...failureMetadata,
        },
        part: {
          type: "error",
          text: message,
          json: failureMetadata,
          status: "error",
        },
      });
    }
    this.supervisor?.recordFailed(
      this.supervisorWorkItem(item, session),
      reasonCode,
    );
    await this.drainEventWrites();
    await this.markQueueResult(item, {
      ok: false,
      error: message,
      ...failureMetadata,
      terminal: true,
    });
    this.writeLog({
      level: "warn",
      event: "bridge.queue_item.externally_terminalized",
      queueId: queueItemId,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
      reasonCode,
    });
    if (sessionKey) {
      await this.closeSession(sessionKey, { terminalInteraction: true });
    }
    this.activeQueueItems.delete(queueItemId);
    this.clearFirstOutputLogState(item);
    return true;
  }

  async close(): Promise<void> {
    await this.drainEventWrites();
    for (const queueItemId of this.activeToolCalls.keys()) {
      this.clearToolCallsForQueueItem(queueItemId);
    }
    this.activeToolTimeoutFailures.clear();
    this.warmSessionCandidates.clear();
    this.lastSessionEventQueueItems.clear();
    this.firstAssistantTextLoggedQueueItems.clear();
    this.firstRuntimeActivityLoggedQueueItems.clear();
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        this.clearIdleTimer(session);
        await this.releaseTerminalHandles(session);
        return await this.closeAcpSession(session);
      }),
    );
  }

  private async handlePrompt(item: BridgeSessionQueueItem): Promise<void> {
    if (!item.prompt) {
      throw new Error(`prompt command ${item.id} is missing prompt text`);
    }
    const promptText = item.prompt;
    const threadId = item.threadId ?? item.sessionId;
    if (!threadId) {
      throw new Error(`queue item ${item.id} is missing threadId`);
    }
    this.assertRequiredScopedIdentity(item);
    const sessionKey = this.sessionKeyForItem(item) ?? threadId;
    const attachments = normalizeBridgeAttachments(item.attachments);
    const attachmentReferenceText =
      attachmentReferenceTextForPrompt(attachments);
    const threadHistory = normalizeThreadHistory(item.threadHistory);
    const systemPrompt = normalizeSystemPrompt(item.systemPrompt);
    const attributionContext = attributionPromptContext(item);
    const autoApprovePermissionRequests =
      item.approvalLevel === "full_permissions";
    if (attachments.length > 0) {
      this.writeLog({
        level: "info",
        event: "bridge.attachments.received",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId,
        attachmentCount: attachments.length,
        attachmentMediaTypes: summarizeAttachmentMediaTypes(attachments),
        attachmentTotalBytes: attachments.reduce(
          (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
          0,
        ),
        deliveryMode: "pending",
      });
    }
    await this.runSerializedPrompt(sessionKey, item.id, () =>
      this.handlePromptNow(item, promptText, {
        attachmentReferenceText,
        attachments,
        attributionContext,
        autoApprovePermissionRequests,
        resultMetadata:
          attachments.length > 0
            ? {
                attachmentCount: attachments.length,
                attachmentMediaTypes:
                  summarizeAttachmentMediaTypes(attachments),
                attachmentTotalBytes: attachments.reduce(
                  (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
                  0,
                ),
              }
            : undefined,
        systemPrompt,
        threadHistory,
      }),
    );
  }

  private async handlePromptNow(
    item: BridgeSessionQueueItem,
    prompt: string,
    options: {
      systemPrompt?: string;
      threadHistory?: string;
      attachmentReferenceText?: string;
      attachments?: HermesAcpPromptAttachment[];
      attributionContext?: string;
      autoApprovePermissionRequests?: boolean;
      resultMetadata?: Record<string, unknown>;
      sessionKey?: string;
    } = {},
  ): Promise<void> {
    const session = options.sessionKey
      ? this.sessions.get(options.sessionKey)
      : await this.ensureSession(item);
    if (!session) {
      throw new Error(`ACP session ${options.sessionKey} is no longer active`);
    }
    const {
      resultMetadata: baseResultMetadata,
      sessionKey: _resolvedSessionKey,
      ...acpPromptOptions
    } = options;
    this.lastSessionEventQueueItems.set(session.sessionKey, item);
    session.pendingAttachmentUploadEvents = [];
    this.markSessionUsed(session);
    this.clearIdleTimer(session);
    this.supervisor?.recordPromptPersisted(
      this.supervisorWorkItem(item, session),
    );
    const messageStartedSequence = this.enqueueEventWrite(session, {
      externalEventId: `${item.id}:message_started`,
      source: "bridge",
      eventType: "message_started",
      payload: {
        codeAttribution: item.codeAttribution,
        queueId: item.id,
        queueType: normalizeType(item),
      },
      part: {
        type: "event",
        text: `${displayNameForSessionStart(session)} started this run.`,
        status: "streaming",
      },
    });
    this.activePromptSequenceBases.set(session.sessionKey, messageStartedSequence);
    let result: HermesAcpPromptResult;
    const runtimeConfigApplication = applyRuntimeConfigFallback(
      item,
      session.runtimeProfile,
    );
    const resultMetadata =
      runtimeConfigApplication === undefined
        ? baseResultMetadata
        : {
            ...baseResultMetadata,
            runtimeConfigApplied: runtimeConfigApplication.applied,
            runtimeConfigDiagnostics: runtimeConfigApplication.diagnostics,
            runtimeConfigPolicy: runtimeConfigApplication.policy,
          };
    try {
      this.supervisor?.recordPromptSent(this.supervisorWorkItem(item, session));
      result = await this.sendPromptWithLiveness(item, session, prompt, {
        ...acpPromptOptions,
        runtimeConfig: runtimeConfigApplication?.applied,
      });
    } catch (error) {
      this.activePromptSequenceBases.delete(session.sessionKey);
      if (this.externallyTerminalizedQueueItemIds.has(item.id)) {
        return;
      }
      const promptFailure = classifyPromptError(
        error,
        this.activeToolTimeoutFailures.get(item.id),
      );
      this.activeToolTimeoutFailures.delete(item.id);
      if (promptFailure.terminal) {
        const diagnostics = session.acp.getPromptTimeoutDiagnostics?.();
        const failureDetails = promptFailure.details ?? {};
        this.enqueueEventWrite(session, {
          externalEventId: `${item.id}:${promptFailure.reasonCode}`,
          source: "bridge",
          eventType: "bridge_error",
          payload: removeUndefinedValues({
            diagnostics,
            queueId: item.id,
            reasonCode: promptFailure.reasonCode,
            ...failureDetails,
          }),
          part: {
            type: "error",
            text: promptFailure.message,
            json: removeUndefinedValues({
              diagnostics,
              reasonCode: promptFailure.reasonCode,
              ...failureDetails,
            }),
            status: "error",
          },
        });
        await this.drainEventWrites();
        await this.markQueueResult(item, {
          ok: false,
          diagnostics,
          error: promptFailure.message,
          reasonCode: promptFailure.reasonCode,
          ...failureDetails,
          terminal: true,
        });
        this.externallyTerminalizedQueueItemIds.add(item.id);
        this.writeAgentTurnLog(
          "agent.turn.failed",
          item,
          normalizeType(item),
          promptFailure.reasonCode,
        );
        this.supervisor?.recordFailed(
          this.supervisorWorkItem(item, session),
          promptFailure.reasonCode,
        );
        await this.closeSession(session.sessionKey, {
          terminalInteraction: true,
        });
        return;
      }
      await this.closeSession(session.sessionKey, {
        terminalInteraction: true,
      });
      throw error;
    }
    this.activePromptSequenceBases.delete(session.sessionKey);
    this.activeToolTimeoutFailures.delete(item.id);
    if (this.externallyTerminalizedQueueItemIds.has(item.id)) {
      this.writeLog({
        level: "info",
        event: "bridge.lifecycle.late_prompt_result_ignored",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId: session.threadId,
        sessionId: item.sessionId,
        agentSessionId: session.providerSessionKey,
        acpSessionId: result.sessionId,
        textLength: result.text.length,
        reason: "externally_terminalized",
      });
      return;
    }
    if (this.cancelledQueueItemIds.delete(item.id)) {
      await this.markQueueResult(item, {
        ok: false,
        cancelled: true,
        ignoredLateResult: true,
        stopReason: "cancelled",
        terminal: true,
      });
      this.supervisor?.recordCancelled(this.supervisorWorkItem(item, session));
      this.writeLog({
        level: "info",
        event: "bridge.lifecycle.late_prompt_result_ignored",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId: session.threadId,
        sessionId: item.sessionId,
        agentSessionId: session.providerSessionKey,
        acpSessionId: result.sessionId,
        textLength: result.text.length,
      });
      return;
    }
    if (!this.isCurrentSessionRecord(session)) {
      throw new Error(
        `ACP session ${session.sessionKey} was replaced before prompt completed`,
      );
    }
    result.events = mergePendingAttachmentUploadEvents(
      session.pendingAttachmentUploadEvents,
      result.events,
    );
    session.pendingAttachmentUploadEvents = [];
    const mediaExtraction = extractMediaAttachmentReferences(
      result.text,
      session.cwd,
    );
    if (mediaExtraction.attachments.length > 0) {
      result.text = mediaExtraction.text;
      result.events.push(
        ...mediaExtraction.attachments.map((attachment, index) => ({
          externalEventId: `${item.id}:media_attachment:${index + 1}`,
          source: "bridge" as const,
          eventType: "file",
          payload: {
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            type: "media_reference",
          },
          part: {
            type: "event" as const,
            text: "Agent emitted an attachment.",
            json: {
              filename: attachment.filename,
              mediaType: attachment.mediaType,
              type: "media_reference",
            },
            status: "streaming" as const,
          },
          attachmentUpload: attachment,
        })),
      );
    }
    const emptyVisibleOutput = isEmptyVisiblePromptResult(result);
    if (normalizeType(item) === "steer-session" && emptyVisibleOutput) {
      await this.markQueueResult(item, {
        ok: false,
        error: "steer_reprompt_failed",
        terminal: true,
        finalText: result.finalText,
        stopReason: result.stopReason,
      });
      this.supervisor?.recordFailed(
        this.supervisorWorkItem(item, session),
        "steer_reprompt_failed",
      );
      await this.closeSession(session.sessionKey, {
        terminalInteraction: true,
      });
      return;
    }
    this.enqueueEventWrite(session, {
      externalEventId: `${item.id}:message_completed`,
      source: "bridge",
      eventType: "message_completed",
      payload: {
        finalText: result.finalText,
        queueId: item.id,
        stopReason: result.stopReason,
        text: result.text,
      },
      part: {
        type: "event",
        text: result.text,
        json: { finalText: result.finalText, stopReason: result.stopReason },
        status: "complete",
      },
    });
    if (result.usage) {
      this.enqueueEventWrite(session, {
        externalEventId: `${item.id}:usage_update`,
        source: "bridge",
        eventType: "usage_update",
        payload: {
          ...result.usage,
          queueId: item.id,
          queueType: normalizeType(item),
        },
        part: {
          type: "event",
          text: "ACP usage updated.",
          json: result.usage,
          status: "complete",
        },
      });
    }
    if (result.finalText?.withheld) {
      this.writeLog({
        level: "warn",
        event: "agent.final_text.withheld",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId: session.threadId,
        sessionId: item.sessionId,
        agentSessionId: session.providerSessionKey,
        acpSessionId: result.sessionId,
        answerChunkCount: result.finalText.answerChunkCount,
        answerTextLength: result.finalText.answerTextLength,
        reason: result.finalText.reason,
        runtimeId: result.finalText.runtimeId,
        thoughtChunkCount: result.finalText.thoughtChunkCount,
        toolEventCount: result.finalText.toolEventCount,
        trustedFinalResultText: result.finalText.trustedFinalResultText,
      });
    }
    const attachmentUploadSummary = await this.resolveAgentAttachmentUploads(
      item,
      session,
      result.events,
    );
    await this.drainEventWrites();
    const finalResultMetadata = {
      ...resultMetadata,
      ...(result.attachmentDeliveryMode
        ? { attachmentDeliveryMode: result.attachmentDeliveryMode }
        : {}),
      ...(result.continuityMode
        ? { acpContinuityMode: result.continuityMode }
        : {}),
      ...(typeof result.threadHistoryInjected === "boolean"
        ? { acpThreadHistoryInjected: result.threadHistoryInjected }
        : {}),
      ...(result.externalContinuity
        ? { acpExternalContinuity: result.externalContinuity }
        : {}),
      ...(result.usage ? { acpUsage: result.usage } : {}),
    };
    if (result.attachmentDeliveryMode && baseResultMetadata?.attachmentCount) {
      this.writeLog({
        level: "info",
        event: "bridge.attachments.delivered",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId: session.threadId,
        sessionId: item.sessionId,
        agentSessionId: session.providerSessionKey,
        acpSessionId: result.sessionId,
        attachmentCount: baseResultMetadata.attachmentCount,
        attachmentDeliveryMode: result.attachmentDeliveryMode,
      });
    }
    const attachmentParts = attachmentPartsFromPromptEvents(result.events);
    if (
      normalizeType(item) === "prompt" &&
      emptyVisibleOutput &&
      attachmentParts.length === 0
    ) {
      const diagnostic = buildEmptyFinalResponseDiagnostic(item, result);
      this.enqueueEventWrite(session, diagnostic.event);
      await this.drainEventWrites();
      await this.markQueueResult(item, diagnostic.result);
      this.supervisor?.recordFailed(
        this.supervisorWorkItem(item, session),
        "empty_final_response",
      );
      await this.closeSession(session.sessionKey, {
        terminalInteraction: true,
      });
      return;
    }
    if (attachmentParts.length > 0) {
      this.writeLog({
        level: "info",
        event: "agent.attachments.emitted",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId: session.threadId,
        sessionId: item.sessionId,
        agentSessionId: session.providerSessionKey,
        acpSessionId: result.sessionId,
        attachmentCount: attachmentParts.length,
        attachmentMediaTypes: summarizeAttachmentMediaTypes(
          attachmentParts.map((part) => part.payload as BridgeQueueAttachment),
        ),
        attachmentTotalBytes: attachmentParts.reduce(
          (sum, part) =>
            sum +
            (typeof (part.payload as BridgeQueueAttachment).sizeBytes ===
            "number"
              ? ((part.payload as BridgeQueueAttachment).sizeBytes ?? 0)
              : 0),
          0,
        ),
      });
    }
    if (
      attachmentUploadSummary.uploadedCount > 0 ||
      attachmentUploadSummary.failedCount > 0
    ) {
      this.writeLog({
        level: attachmentUploadSummary.failedCount > 0 ? "warn" : "info",
        event: "agent.attachments.upload_resolved",
        queueId: item.id,
        queueType: normalizeType(item),
        threadId: session.threadId,
        sessionId: item.sessionId,
        agentSessionId: session.providerSessionKey,
        acpSessionId: result.sessionId,
        uploadedCount: attachmentUploadSummary.uploadedCount,
        failedCount: attachmentUploadSummary.failedCount,
        attachmentMediaTypes: attachmentUploadSummary.mediaTypes,
        attachmentTotalBytes: attachmentUploadSummary.totalBytes,
      });
    }
    await this.markQueueResult(item, {
      ok: true,
      agentSessionId: session.providerSessionKey,
      acpSessionId: result.sessionId,
      acpCapabilities: result.capabilities,
      stopReason: result.stopReason,
      text: result.text,
      parts: attachmentParts.length > 0 ? attachmentParts : undefined,
      result: result.rawResult,
      ...finalResultMetadata,
    });
    this.supervisor?.recordCompleted(this.supervisorWorkItem(item, session));
    this.markSessionUsed(session);
    this.scheduleIdleClose(session);
    this.writeLog({
      level: "info",
      event: "bridge.session.ready",
      queueId: item.id,
      queueType: normalizeType(item),
      threadId: session.threadId,
      sessionId: item.sessionId,
      agentSessionId: session.providerSessionKey,
      acpSessionId: result.sessionId,
    });
  }

  private async runSerializedPrompt(
    sessionKey: string,
    queueItemId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const queueState = this.getSessionQueueState(sessionKey);
    queueState.pendingQueueItemIds.push(queueItemId);
    const previous = this.promptQueues.get(sessionKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        queueState.pendingQueueItemIds = queueState.pendingQueueItemIds.filter(
          (id) => id !== queueItemId,
        );
        queueState.runningQueueItemId = queueItemId;
        try {
          await task();
        } finally {
          if (queueState.runningQueueItemId === queueItemId) {
            queueState.runningQueueItemId = undefined;
          }
          this.deleteEmptySessionQueueState(sessionKey);
        }
      });
    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.promptQueues.set(sessionKey, tracked);
    try {
      await current;
    } finally {
      if (this.promptQueues.get(sessionKey) === tracked) {
        this.promptQueues.delete(sessionKey);
      }
      queueState.pendingQueueItemIds = queueState.pendingQueueItemIds.filter(
        (id) => id !== queueItemId,
      );
      this.deleteEmptySessionQueueState(sessionKey);
    }
  }

  private async sendPromptWithLiveness(
    item: BridgeSessionQueueItem,
    session: BridgeSessionRecord,
    prompt: string,
    options: Parameters<ManagedAcpSession["sendUserMessage"]>[1],
  ): Promise<HermesAcpPromptResult> {
    const now = Date.now();
    const queueItemId = item.id;
    this.activeLiveness.set(
      queueItemId,
      createSessionLivenessRecord({
        bridgeProfileId: item.bridgeProfileId ?? session.runtimeProfile?.id,
        claimId: item.claimId,
        now,
        queueItemId,
        sessionKey: session.sessionKey,
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const livenessFailure = new Promise<never>((_, reject) => {
      this.activeLivenessFailures.set(queueItemId, reject);
      const schedule = () => {
        if (timer) {
          clearTimeout(timer);
        }
        const record = this.activeLiveness.get(queueItemId);
        if (!record) {
          return;
        }
        const silenceMs = Date.now() - record.lastMeaningfulEventAt;
        if (silenceMs >= this.livenessTimeoutMs && record.state !== "quiet") {
          const next = reduceSessionLiveness(record, {
            at: Date.now(),
            type: "provider_quiet",
          });
          this.activeLiveness.set(queueItemId, next);
          this.writeLog({
            level: "warn",
            event: "bridge.session.quiet_degraded",
            queueId: queueItemId,
            threadId: item.threadId,
            sessionId: item.sessionId,
            agentSessionId: session.providerSessionKey,
            bridgeProfileId: item.bridgeProfileId ?? session.runtimeProfile?.id,
            reasonCode: "provider_quiet",
            silenceMs,
          });
        }
        const decision = evaluateSessionLiveness({
          now: Date.now(),
          record: this.activeLiveness.get(queueItemId) ?? record,
          timeoutMs: this.livenessTimeoutMs,
        });
        if (!decision.ok) {
          reject(new Error(`ACP live session lost: ${decision.reasonCode}`));
          return;
        }
        const currentRecord = this.activeLiveness.get(queueItemId) ?? record;
        const delay =
          currentRecord.state === "quiet"
            ? this.livenessTimeoutMs
            : Math.max(
                1,
                this.livenessTimeoutMs -
                  (Date.now() - currentRecord.lastMeaningfulEventAt),
              );
        timer = setTimeout(schedule, delay);
      };
      schedule();
    });
    try {
      const result = await Promise.race([
        session.acp.sendUserMessage(prompt, options),
        livenessFailure,
      ]);
      if (!isEmptyVisiblePromptResult(result)) {
        this.reconcilePendingToolCalls(queueItemId, session, {
          trigger: "turn_completed",
        });
      }
      return result;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      this.clearToolCallsForQueueItem(queueItemId);
      this.activeLiveness.delete(queueItemId);
      this.activeLivenessFailures.delete(queueItemId);
    }
  }

  private recordLivenessEvent(
    queueItemId: string,
    type: Parameters<typeof reduceSessionLiveness>[1]["type"],
  ): void {
    const record = this.activeLiveness.get(queueItemId);
    if (!record) {
      return;
    }
    const next = reduceSessionLiveness(record, { at: Date.now(), type });
    this.activeLiveness.set(queueItemId, next);
    const decision = evaluateSessionLiveness({
      now: Date.now(),
      record: next,
      timeoutMs: this.livenessTimeoutMs,
    });
    if (!decision.ok) {
      this.activeLivenessFailures.get(queueItemId)?.(
        new Error(`ACP live session lost: ${decision.reasonCode}`),
      );
    }
  }

  private annotateToolEvent(
    queueItemId: string,
    session: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): NormalizedBridgeEvent {
    const part = event.part;
    if (!part || (part.type !== "tool_call" && part.type !== "tool_result")) {
      return event;
    }
    const tool = readToolLogFields(part.json);
    const toolCallId =
      tool.toolCallId ??
      event.externalEventId ??
      `${queueItemId}:${tool.toolName}`;
    const activeTool = this.activeToolCalls.get(queueItemId)?.get(toolCallId);
    if (activeTool && activeTool.toolClass !== "standard") {
      const metadata = activeToolPolicyMetadata(activeTool);
      return {
        ...event,
        payload: mergeRecordMetadata(event.payload, metadata),
        part: {
          ...part,
          json: mergeRecordMetadata(part.json, metadata),
        },
      };
    }
    const policy = this.resolveToolCallPolicy(session, tool.toolName);
    if (policy.toolClass === "standard") {
      return event;
    }
    const metadata = toolEventPolicyMetadata(session, policy);
    return {
      ...event,
      payload: mergeRecordMetadata(event.payload, metadata),
      part: {
        ...part,
        json: mergeRecordMetadata(part.json, metadata),
      },
    };
  }

  private recordToolEvent(
    queueItemId: string,
    session: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): void {
    const part = event.part;
    if (!part || (part.type !== "tool_call" && part.type !== "tool_result")) {
      return;
    }
    const tool = readToolLogFields(part.json);
    const toolCallId =
      tool.toolCallId ??
      event.externalEventId ??
      `${queueItemId}:${tool.toolName}`;
    if (part.type === "tool_call") {
      this.reconcilePendingToolCalls(queueItemId, session, {
        exceptToolCallId: toolCallId,
        trigger: "later_tool_started",
      });
      this.trackPendingToolCall(queueItemId, session, {
        toolCallId,
        toolName: tool.toolName,
      });
      return;
    }
    const state = readToolState(part.json);
    if (state === "input-streaming" || state === "input-available") {
      this.reconcilePendingToolCalls(queueItemId, session, {
        exceptToolCallId: toolCallId,
        trigger: "later_tool_started",
      });
      this.trackPendingToolCall(queueItemId, session, {
        toolCallId,
        toolName: tool.toolName,
      });
      return;
    }
    this.clearToolCall(queueItemId, toolCallId);
  }

  private reconcilePendingToolCallsIfAssistantOutputResumed(
    queueItemId: string,
    session: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): void {
    const partType = event.part?.type;
    if (partType !== "text" && partType !== "thinking") {
      return;
    }
    this.reconcilePendingToolCalls(queueItemId, session, {
      trigger: "assistant_output_resumed",
    });
  }

  private reconcilePendingToolCalls(
    queueItemId: string,
    session: BridgeSessionRecord,
    options: {
      exceptToolCallId?: string;
      trigger: ToolCallReconciliationTrigger;
    },
  ): void {
    const queueTools = this.activeToolCalls.get(queueItemId);
    if (!queueTools || queueTools.size === 0) {
      return;
    }
    const tools = Array.from(queueTools.values()).filter(
      (tool) => tool.toolCallId !== options.exceptToolCallId,
    );
    if (tools.length === 0) {
      return;
    }
    let clearedToolCallCount = 0;
    for (const tool of tools) {
      if (shouldKeepNativeToolPending(tool, options.trigger)) {
        continue;
      }
      const ageMs = Date.now() - tool.startedAt;
      if (shouldSettleNativeSubagentAsUnjoined(tool, options.trigger)) {
        this.clearToolCall(queueItemId, tool.toolCallId);
        clearedToolCallCount += 1;
        this.writeLog({
          level: "info",
          event: "bridge.session.native_subagent_unjoined",
          queueId: queueItemId,
          threadId: session.threadId,
          agentSessionId: session.providerSessionKey,
          bridgeProfileId: session.runtimeProfile?.id,
          ageMs,
          reasonCode: "native_subagent_unjoined",
          settlementState: "detached_unjoined",
          toolCallId: tool.toolCallId,
          toolClass: tool.toolClass,
          toolName: tool.toolName,
          toolPolicyId: tool.toolPolicyId,
          toolTimeoutMs: tool.toolTimeoutMs,
          trigger: options.trigger,
        });
        const metadata = activeToolPolicyMetadata(tool);
        this.enqueueEventWrite(session, {
          externalEventId: `${queueItemId}:${tool.toolCallId}:native_subagent_unjoined`,
          source: "bridge",
          eventType: "tool_call_update",
          payload: {
            ageMs,
            queueId: queueItemId,
            reasonCode: "native_subagent_unjoined",
            settlementState: "detached_unjoined",
            sessionUpdate: "tool_call_update",
            state: "detached_unjoined",
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            trigger: options.trigger,
            ...metadata,
          },
          part: {
            type: "tool_result",
            text: `${tool.toolName} delegated work was not joined before the turn completed.`,
            json: {
              ageMs,
              reasonCode: "native_subagent_unjoined",
              settlementState: "detached_unjoined",
              state: "detached_unjoined",
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              trigger: options.trigger,
              ...metadata,
            },
            status: "complete",
          },
        });
        continue;
      }
      this.clearToolCall(queueItemId, tool.toolCallId);
      clearedToolCallCount += 1;
      this.writeLog({
        level: "debug",
        event: "bridge.session.tool_call_reconciled",
        queueId: queueItemId,
        threadId: session.threadId,
        agentSessionId: session.providerSessionKey,
        bridgeProfileId: session.runtimeProfile?.id,
        ageMs,
        reasonCode: "provider_progressed_without_tool_result",
        settlementState: "provider_progressed",
        toolCallId: tool.toolCallId,
        toolClass: tool.toolClass,
        toolName: tool.toolName,
        toolPolicyId: tool.toolPolicyId,
        toolTimeoutMs: tool.toolTimeoutMs,
        trigger: options.trigger,
      });
    }
    if (clearedToolCallCount === 0) {
      return;
    }
    this.writeLog({
      level: "debug",
      event: "bridge.session.tool_calls_reconciled",
      queueId: queueItemId,
      threadId: session.threadId,
      agentSessionId: session.providerSessionKey,
      bridgeProfileId: session.runtimeProfile?.id,
      clearedToolCallCount,
      trigger: options.trigger,
    });
  }

  private resolveToolCallPolicy(
    session: BridgeSessionRecord,
    toolName: string,
  ): BridgeToolCallTimeoutResolution {
    return resolveToolCallTimeoutPolicy({
      defaultTimeoutMs: this.toolResultTimeoutMs,
      explicitTimeoutMs: this.explicitToolResultTimeoutMs,
      profile: session.runtimeProfile,
      requestTimeoutMs: this.requestTimeoutMs,
      toolName,
    });
  }

  private trackPendingToolCall(
    queueItemId: string,
    session: BridgeSessionRecord,
    tool: { toolCallId: string; toolName: string },
  ): void {
    this.clearToolCall(queueItemId, tool.toolCallId);
    let queueTools = this.activeToolCalls.get(queueItemId);
    if (!queueTools) {
      queueTools = new Map();
      this.activeToolCalls.set(queueItemId, queueTools);
    }
    const startedAt = Date.now();
    const policy = this.resolveToolCallPolicy(session, tool.toolName);
    const timeout = setTimeout(() => {
      const activeTool = this.activeToolCalls.get(queueItemId)?.get(tool.toolCallId);
      if (!activeTool) {
        return;
      }
      const ageMs = Date.now() - activeTool.startedAt;
      const details = {
        ageMs,
        failureClass: "tool_result_propagation_lost" as const,
        timeoutMs: activeTool.toolTimeoutMs,
        toolCallId: activeTool.toolCallId,
        toolClass: activeTool.toolClass,
        toolName: activeTool.toolName,
        toolPolicyId: activeTool.toolPolicyId,
      };
      this.activeToolTimeoutFailures.set(queueItemId, details);
      this.writeLog({
        level: "warn",
        event: "bridge.session.tool_result_timeout",
        queueId: queueItemId,
        threadId: session.threadId,
        agentSessionId: session.providerSessionKey,
        bridgeProfileId: session.runtimeProfile?.id,
        reasonCode: "tool_result_timeout",
        ...details,
      });
      this.activeLivenessFailures.get(queueItemId)?.(
        new Error("ACP live session lost: tool_result_timeout"),
      );
    }, policy.timeoutMs);
    timeout.unref?.();
    queueTools.set(tool.toolCallId, {
      runtimeProfileId: session.runtimeProfile?.id,
      startedAt,
      timeout,
      toolCallId: tool.toolCallId,
      toolClass: policy.toolClass,
      toolName: tool.toolName,
      toolPolicyId: policy.policyId,
      toolTimeoutMs: policy.timeoutMs,
    });
  }

  private clearToolCall(queueItemId: string, toolCallId: string): void {
    const queueTools = this.activeToolCalls.get(queueItemId);
    const activeTool = queueTools?.get(toolCallId);
    if (!queueTools || !activeTool) {
      return;
    }
    clearTimeout(activeTool.timeout);
    queueTools.delete(toolCallId);
    if (queueTools.size === 0) {
      this.activeToolCalls.delete(queueItemId);
    }
  }

  private clearToolCallsForQueueItem(queueItemId: string): void {
    const queueTools = this.activeToolCalls.get(queueItemId);
    if (!queueTools) {
      return;
    }
    for (const activeTool of queueTools.values()) {
      clearTimeout(activeTool.timeout);
    }
    this.activeToolCalls.delete(queueItemId);
  }

  private getSessionQueueState(sessionKey: string) {
    const existing = this.sessionQueueState.get(sessionKey);
    if (existing) {
      return existing;
    }
    const next: { pendingQueueItemIds: string[]; runningQueueItemId?: string } =
      {
        pendingQueueItemIds: [],
      };
    this.sessionQueueState.set(sessionKey, next);
    return next;
  }

  private deleteEmptySessionQueueState(sessionKey: string): void {
    const state = this.sessionQueueState.get(sessionKey);
    if (
      state &&
      state.pendingQueueItemIds.length === 0 &&
      !state.runningQueueItemId
    ) {
      this.sessionQueueState.delete(sessionKey);
    }
  }

  private findSessionKeyForActiveQueueItem(
    queueItemId: string,
  ): string | undefined {
    for (const [sessionKey, state] of this.sessionQueueState.entries()) {
      if (
        state.runningQueueItemId === queueItemId ||
        state.pendingQueueItemIds.includes(queueItemId)
      ) {
        return sessionKey;
      }
    }
    return undefined;
  }

  private clearQueueItemFromSessionQueue(
    sessionKey: string,
    queueItemId: string,
  ): void {
    const state = this.sessionQueueState.get(sessionKey);
    if (!state) {
      return;
    }
    state.pendingQueueItemIds = state.pendingQueueItemIds.filter(
      (id) => id !== queueItemId,
    );
    if (state.runningQueueItemId === queueItemId) {
      state.runningQueueItemId = undefined;
    }
    this.deleteEmptySessionQueueState(sessionKey);
  }

  private sessionQueueStateHasQueueItem(queueItemId: string): boolean {
    for (const state of this.sessionQueueState.values()) {
      if (
        state.runningQueueItemId === queueItemId ||
        state.pendingQueueItemIds.includes(queueItemId)
      ) {
        return true;
      }
    }
    return false;
  }

  private getActiveTurnId(sessionKey: string): string | undefined {
    return this.sessionQueueState.get(sessionKey)?.runningQueueItemId;
  }

  private markActiveTurnCancelled(sessionKey: string): void {
    const runningQueueItemId = this.getActiveTurnId(sessionKey);
    if (runningQueueItemId) {
      this.cancelledQueueItemIds.add(runningQueueItemId);
    }
  }

  private enqueueCancellationEvent(
    session: BridgeSessionRecord,
    item: BridgeSessionQueueItem,
  ): void {
    this.enqueueEventWrite(session, {
      externalEventId: `${item.id}:message_cancelled`,
      source: "bridge",
      eventType: "message_cancelled",
      payload: {
        queueId: item.id,
        queueType: normalizeType(item),
        stopReason: "cancelled",
      },
      part: {
        type: "event",
        text: "Run cancelled.",
        status: "complete",
      },
    });
  }

  private async handleApprovalResponse(
    item: BridgeSessionQueueItem,
    type: string,
  ): Promise<void> {
    const key = this.findSessionKeyForItem(item);
    if (type === "input-response") {
      const responseText = item.prompt?.trim();
      if (!responseText) {
        throw new Error(`input response ${item.id} is missing response text`);
      }
      const threadId = item.threadId ?? item.sessionId;
      const requestedSessionKey = this.sessionKeyForItem(item);
      if (
        !key &&
        this.isTerminalInteractionResponseItem(item, requestedSessionKey, threadId)
      ) {
        await this.markStaleInteractionResponse(item, type);
        return;
      }
      if (!key && this.hasActiveRuntimeConflictForItem(item)) {
        throw new Error(
          `input response ${item.id} does not match an active ACP session for the requested runtime`,
        );
      }
      const sessionKey = key ?? requestedSessionKey ?? threadId;
      if (!sessionKey) {
        throw new Error(`input response ${item.id} is missing threadId`);
      }
      if (!key && this.isTerminalInteractionSessionKey(sessionKey)) {
        await this.markStaleInteractionResponse(item, type);
        return;
      }
      const systemPrompt = normalizeSystemPrompt(item.systemPrompt);
      const threadHistory = normalizeThreadHistory(item.threadHistory);
      this.writeLog({
        level: "info",
        event: "bridge.input_response.continuation",
        queueId: item.id,
        queueType: type,
        threadId,
        agentSessionId: key,
        hasActiveSession: this.sessions.has(sessionKey),
        hasQueuedSessionWork: this.sessionQueueState.has(sessionKey),
      });
      await this.runSerializedPrompt(sessionKey, item.id, () =>
        this.handlePromptNow(item, responseText, {
          systemPrompt,
          threadHistory,
          sessionKey: key,
          resultMetadata: { inputResponse: true },
        }),
      );
      return;
    }

    if (type === "choice-response") {
      const choiceId = item.approvalOutcome?.trim();
      if (!choiceId) {
        throw new Error(`choice response ${item.id} is missing choice id`);
      }
      const threadId = item.threadId ?? item.sessionId;
      const requestedSessionKey = this.sessionKeyForItem(item);
      const durableContinuation = isDurableContinuationChoiceResponse(item);
      if (
        !durableContinuation &&
        !key &&
        this.isTerminalInteractionResponseItem(item, requestedSessionKey, threadId)
      ) {
        await this.markStaleInteractionResponse(item, type);
        return;
      }
      if (!key && this.hasActiveRuntimeConflictForItem(item)) {
        throw new Error(
          `choice response ${item.id} does not match an active ACP session for the requested runtime`,
        );
      }
      const sessionKey = key ?? requestedSessionKey ?? threadId;
      if (!sessionKey) {
        throw new Error(`choice response ${item.id} is missing threadId`);
      }
      if (
        !durableContinuation &&
        !key &&
        this.isTerminalInteractionSessionKey(sessionKey)
      ) {
        await this.markStaleInteractionResponse(item, type);
        return;
      }
      const systemPrompt = normalizeSystemPrompt(item.systemPrompt);
      const threadHistory = normalizeThreadHistory(item.threadHistory);
      this.writeLog({
        level: "info",
        event: "bridge.choice_response.continuation",
        queueId: item.id,
        queueType: type,
        threadId,
        agentSessionId: key,
        hasActiveSession: this.sessions.has(sessionKey),
        hasQueuedSessionWork: this.sessionQueueState.has(sessionKey),
      });
      const continuationPrompt =
        item.prompt && item.prompt.trim() !== choiceId
          ? item.prompt.trim()
          : `Selected choice: ${choiceId}`;
      await this.runSerializedPrompt(sessionKey, item.id, () =>
        this.handlePromptNow(item, continuationPrompt, {
          systemPrompt,
          threadHistory,
          sessionKey: key,
          resultMetadata: { choiceId },
        }),
      );
      return;
    }

    let session = key ? this.sessions.get(key) : undefined;
    if (!session && key && this.sessionQueueState.has(key)) {
      session = await this.waitForSession(key);
    }
    if (!session) {
      await this.markStaleInteractionResponse(item, type);
      return;
    }
    const externalRequestId = item.externalRequestId ?? item.approvalId;
    if (!externalRequestId) {
      throw new Error(
        `approval response ${item.id} is missing external request id`,
      );
    }
    const approved =
      item.approvalOutcome === "approved" || item.approvalOutcome === "allow";
    const handled = await session.acp.respondToPermissionRequest?.(
      externalRequestId,
      {
        approved,
        reason: item.approvalReason,
      },
    );
    if (!handled) {
      await this.markStaleInteractionResponse(item, type);
      return;
    }
    this.markSessionUsed(session);
    this.scheduleIdleClose(session);
    await this.markQueueResult(item, { ok: true, approved });
  }

  private async markStaleInteractionResponse(
    item: BridgeSessionQueueItem,
    type: string,
  ): Promise<void> {
    this.writeLog({
      level: "info",
      event: "bridge.interaction_response.stale_noop",
      queueId: item.id,
      queueType: type,
      threadId: item.threadId ?? item.sessionId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
    });
    await this.markQueueResult(item, {
      ok: true,
      stale: true,
      noOp: true,
      reasonCode: "stale_interaction_response",
    });
  }

  private isTerminalInteractionSessionKey(sessionKey: string): boolean {
    return this.terminalInteractionSessionKeys.has(sessionKey);
  }

  private isTerminalInteractionResponseItem(
    item: BridgeSessionQueueItem,
    requestedSessionKey: string | undefined,
    threadId: string | undefined,
  ): boolean {
    return [
      requestedSessionKey,
      threadId,
      item.sessionId,
      item.agentSessionId,
    ].some((sessionKey) =>
      sessionKey ? this.isTerminalInteractionSessionKey(sessionKey) : false,
    );
  }

  private hasActiveRuntimeConflictForItem(item: BridgeSessionQueueItem): boolean {
    if (!hasExplicitRuntimeScope(item)) {
      return false;
    }
    const providerSessionKey = providerSessionKeyForItem(item);
    const threadId = item.threadId ?? item.sessionId;
    if (!providerSessionKey || !threadId) {
      return false;
    }
    const scopeKeyWithoutAgent = this.scopeKeyWithoutAgentForItem(
      item,
      providerSessionKey,
      threadId,
    );
    const scopeConversationId = item.mailboxConversationId ?? threadId;
    return Array.from(this.sessions.values()).some(
      (session) =>
        (session.scopeKeyWithoutAgent === scopeKeyWithoutAgent ||
          (session.providerSessionKey === providerSessionKey &&
            session.scopeConversationId === scopeConversationId)) &&
        !this.sessionMatchesExplicitRuntimeRequest(session, item),
    );
  }

  private async waitForSession(
    sessionKey: string,
  ): Promise<BridgeSessionRecord | undefined> {
    const deadline = Date.now() + APPROVAL_RESPONSE_SESSION_WAIT_MS;
    while (Date.now() < deadline) {
      const session = this.sessions.get(sessionKey);
      if (session) {
        return session;
      }
      const queueState = this.sessionQueueState.get(sessionKey);
      const hasQueuedPrompt =
        (queueState?.pendingQueueItemIds.length ?? 0) > 0 ||
        Boolean(queueState?.runningQueueItemId);
      if (!hasQueuedPrompt) {
        return undefined;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, APPROVAL_RESPONSE_SESSION_POLL_MS),
      );
    }
    return this.sessions.get(sessionKey);
  }

  private async handleStartSession(
    item: BridgeSessionQueueItem,
  ): Promise<void> {
    const session = await this.ensureSession(item);
    this.markSessionUsed(session);
    this.scheduleIdleClose(session);
    await this.markQueueResult(item, {
      ok: true,
      started: true,
      agentSessionId: session.providerSessionKey,
    });
  }

  private async handleCancel(item: BridgeSessionQueueItem): Promise<boolean> {
    const key = this.findSessionKeyForItem(item);
    const session = key ? this.sessions.get(key) : undefined;
    if (!key || !session) {
      await this.markQueueResult(item, {
        ok: false,
        error: "cancel_not_acknowledged",
        terminal: true,
      });
      return false;
    }
    const activeTurnId = this.getActiveTurnId(key);
    let acknowledged: boolean;
    try {
      acknowledged = (await session.acp.cancel()) !== false;
    } catch {
      acknowledged = false;
    }
    if (!acknowledged) {
      if (activeTurnId) {
        this.cancelledQueueItemIds.add(activeTurnId);
        await this.killTerminalHandles(session);
        this.enqueueCancellationEvent(session, item);
        await this.drainEventWrites();
        await this.closeSession(key, { terminalInteraction: true });
        await this.markQueueResult(item, {
          ok: true,
          cancelled: true,
          forced: true,
          stopReason: "cancelled",
          terminal: true,
        });
        return true;
      }
      await this.markQueueResult(item, {
        ok: false,
        error: "cancel_not_acknowledged",
        terminal: true,
      });
      return false;
    }
    this.markActiveTurnCancelled(key);
    await this.killTerminalHandles(session);
    this.enqueueCancellationEvent(session, item);
    await this.drainEventWrites();
    await this.markQueueResult(item, {
      ok: true,
      cancelled: true,
      stopReason: "cancelled",
      terminal: true,
    });
    return true;
  }

  private async handleCloseSession(
    item: BridgeSessionQueueItem,
  ): Promise<void> {
    const key = this.findSessionKeyForItem(item);
    const removedWarmCandidateCount = this.removeWarmSessionCandidatesForItem(item);
    const closed = Boolean(key && this.sessions.has(key)) ||
      removedWarmCandidateCount > 0;
    if (key) {
      await this.closeSession(key, { terminalInteraction: true });
    }
    await this.markQueueResult(item, { ok: true, closed });
  }

  private async handleSteerSession(
    item: BridgeSessionQueueItem,
  ): Promise<void> {
    const instruction = item.prompt?.trim();
    if (!instruction) {
      await this.markQueueResult(item, {
        ok: false,
        error: "steer_empty_instruction",
        terminal: true,
      });
      this.supervisor?.recordFailed(
        this.supervisorWorkItem(item),
        "steer_empty_instruction",
      );
      return;
    }
    const key = this.findSessionKeyForItem(item);
    const session = key ? this.sessions.get(key) : undefined;
    if (!key || !session) {
      await this.markQueueResult(item, {
        ok: false,
        error: "session_replacement_required",
        terminal: true,
      });
      this.supervisor?.recordFailed(
        this.supervisorWorkItem(item),
        "session_replacement_required",
      );
      return;
    }
    this.supervisor?.recordSteering(this.supervisorWorkItem(item, session));
    const activeTurnId = this.getActiveTurnId(key);
    let acknowledged: boolean;
    try {
      acknowledged = (await session.acp.cancel()) !== false;
    } catch {
      acknowledged = false;
    }
    if (!acknowledged) {
      if (activeTurnId) {
        this.cancelledQueueItemIds.add(activeTurnId);
        await this.killTerminalHandles(session);
        await this.closeSession(key, { terminalInteraction: true });
        await this.handlePromptNow(item, instruction, {
          resultMetadata: {
            steered: true,
            replacementSession: true,
            forcedCancel: true,
          },
        });
        return;
      }
      await this.markQueueResult(item, {
        ok: false,
        error: "session_replacement_required",
        terminal: true,
      });
      this.supervisor?.recordFailed(
        this.supervisorWorkItem(item, session),
        "session_replacement_required",
      );
      return;
    }
    if (activeTurnId) {
      this.cancelledQueueItemIds.add(activeTurnId);
      await this.killTerminalHandles(session);
      await this.closeSession(key, { terminalInteraction: true });
      await this.handlePromptNow(item, instruction, {
        resultMetadata: { steered: true, replacementSession: true },
      });
      return;
    }
    await this.handlePromptNow(item, instruction, {
      sessionKey: key,
      resultMetadata: { steered: true },
    });
  }

  private async handleReviveSession(
    item: BridgeSessionQueueItem,
  ): Promise<void> {
    const existingSessionKey = this.findSessionKeyForItem(item);
    const existingSession = existingSessionKey
      ? this.sessions.get(existingSessionKey)
      : undefined;
    const session = await this.ensureSession(item);
    const createdForRevive =
      !existingSession ||
      existingSession.sessionKey !== session.sessionKey ||
      existingSession.generation !== session.generation;
    if (
      createdForRevive &&
      this.resumeEnabled &&
      item.externalSessionId &&
      session.acp.start
    ) {
      try {
        await session.acp.start();
      } catch (error) {
        await this.closeSession(session.sessionKey);
        throw error;
      }
    }
    const nativeLoad =
      createdForRevive &&
      this.resumeEnabled &&
      Boolean(item.externalSessionId) &&
      session.acp.getExternalContinuityState?.().loaded === true;
    this.markSessionUsed(session);
    this.scheduleIdleClose(session);
    await this.markQueueResult(item, {
      ok: true,
      revived: true,
      reviveMode: nativeLoad ? "native-load" : "thread-history",
      agentSessionId: session.providerSessionKey,
    });
  }

  private async markQueueResult(
    item: BridgeSessionQueueItem,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.cloudClient.markResult(
      item.id,
      item.claimId ? { ...result, claimId: item.claimId } : result,
      item.claimId,
    );
    this.onQueueResultMarked?.(item, result);
  }

  private async closeSession(
    sessionKey: string,
    options: {
      removeWarmCandidate?: boolean;
      terminalInteraction?: boolean;
    } = {},
  ): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }
    if (options.terminalInteraction) {
      this.rememberTerminalInteractionSession(session);
    }
    this.sessions.delete(sessionKey);
    if (options.removeWarmCandidate !== false) {
      this.warmSessionCandidates.delete(sessionKey);
    }
    this.lastSessionEventQueueItems.delete(sessionKey);
    this.clearIdleTimer(session);
    await this.releaseTerminalHandles(session);
    await this.drainEventWrites();
    await this.closeAcpSession(session);
  }

  private rememberTerminalInteractionSession(
    session: BridgeSessionRecord,
  ): void {
    this.rememberTerminalInteractionSessionKey(session.sessionKey);
    this.rememberTerminalInteractionSessionKey(session.threadId);
    this.rememberTerminalInteractionSessionKey(session.providerSessionKey);
  }

  private rememberTerminalInteractionSessionKey(
    sessionKey: string | undefined,
  ): void {
    if (!sessionKey || this.terminalInteractionSessionKeys.has(sessionKey)) {
      return;
    }
    this.terminalInteractionSessionKeys.add(sessionKey);
    this.terminalInteractionSessionKeyOrder.push(sessionKey);
    while (
      this.terminalInteractionSessionKeyOrder.length >
      MAX_TERMINAL_INTERACTION_SESSION_KEYS
    ) {
      const expired = this.terminalInteractionSessionKeyOrder.shift();
      if (expired) {
        this.terminalInteractionSessionKeys.delete(expired);
      }
    }
  }

  private async closeAcpSession(session: BridgeSessionRecord): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.acp.close(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private terminalScopeForSession(input: {
    item: BridgeSessionQueueItem;
    providerSessionKey: string;
    runtimeProfile?: BridgeRuntimeProfile;
    threadId: string;
  }): TerminalHandleScope | undefined {
    if (!this.terminalRegistry || !this.createTerminal) {
      return undefined;
    }
    const organizationId = input.item.organizationId;
    const bridgeDeviceId = this.deviceId;
    if (!organizationId || !bridgeDeviceId) {
      return undefined;
    }
    return {
      agentSessionId: input.providerSessionKey,
      bridgeDeviceId,
      organizationId,
      runtimeProfileId:
        input.runtimeProfile?.id ??
        input.item.bridgeProfileId ??
        input.item.hermesProfileName ??
        "default",
      threadId: input.threadId,
    };
  }

  private terminalAdapterForSession(
    context: BridgeTerminalContext,
  ): SdkAcpRuntimeTerminalAdapter | undefined {
    const createTerminal = this.createTerminal;
    if (!this.terminalRegistry || !createTerminal) {
      return undefined;
    }
    return {
      createTerminal: (params) => createTerminal(context, params),
      registry: this.terminalRegistry,
      scope: context.terminalScope,
    };
  }

  private async killTerminalHandles(
    session: BridgeSessionRecord,
  ): Promise<void> {
    if (!this.terminalRegistry || !session.terminalScope) {
      return;
    }
    await this.terminalRegistry.killSession(session.terminalScope);
  }

  private async releaseTerminalHandles(
    session: BridgeSessionRecord,
  ): Promise<void> {
    if (!this.terminalRegistry || !session.terminalScope) {
      return;
    }
    await this.terminalRegistry.releaseSession(session.terminalScope);
  }

  private async ensureSession(
    item: BridgeSessionQueueItem,
    options: { closeReplacedSessions?: boolean } = {},
  ): Promise<BridgeSessionRecord> {
    const threadId = item.threadId ?? item.sessionId;
    if (!threadId) {
      throw new Error(`queue item ${item.id} is missing threadId`);
    }
    this.assertRequiredScopedIdentity(item);
    const sessionKey = this.sessionKeyForItem(item) ?? threadId;
    const providerSessionKey = providerSessionKeyForItem(item) ?? threadId;
    const scopeKeyWithoutAgent = this.scopeKeyWithoutAgentForItem(
      item,
      providerSessionKey,
      threadId,
    );
    const currentHashes = this.currentSessionHashes();
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.agentName =
        normalizeAgentName(item.agentName) ?? existing.agentName;
      if (!this.sessionMatchesExplicitRuntimeRequest(existing, item)) {
        this.writeLog({
          level: "warn",
          event: "bridge.session.runtime_profile_changed",
          queueId: item.id,
          threadId,
          agentSessionId: sessionKey,
          previousBridgeProfileId: existing.runtimeProfile?.id,
          requestedBridgeProfileId: item.bridgeProfileId,
          previousHermesProfileName: existing.hermesProfileName,
          requestedHermesProfileName: item.hermesProfileName,
        });
        await this.closeSession(sessionKey);
      } else if (this.sessionHashesChanged(existing, currentHashes)) {
        this.writeSessionHashChangeLog({
          currentHashes,
          existing,
          queueId: item.id,
          threadId,
        });
        await this.closeSession(sessionKey);
      } else {
        return existing;
      }
    }

    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    const runtimeProfile = this.resolveRuntimeProfileForItem(item);
    const launchSpec = buildBridgeLaunchSpec({
      baseAgentCommand: this.agentCommand,
      bridgeProfileId: item.bridgeProfileId,
      hermesProfileName: item.hermesProfileName,
      runtimeProfile,
    });
    const agentCommand = launchSpec.agentCommand;
    const gitAuthor = sanitizeGitAuthor(item);
    const gitAuthorProcessEnv = gitAuthor ? gitAuthorEnv(gitAuthor) : undefined;
    const cwd = this.allowRemoteCwd ? item.cwd : undefined;
    const terminalScope = this.terminalScopeForSession({
      item,
      providerSessionKey,
      runtimeProfile,
      threadId,
    });
    const terminalAdapter = terminalScope
      ? this.terminalAdapterForSession({
          agentCommand,
          agentSessionId: item.agentSessionId,
          bridgeProfileId: item.bridgeProfileId,
          cwd,
          generation,
          hermesProfileName: item.hermesProfileName,
          launchSpecKey: launchSpec.key,
          launchSpecSummary: launchSpec.summary,
          initialSessionId: this.resumeEnabled
            ? item.externalSessionId
            : undefined,
          organizationId: item.organizationId,
          runtimeProfile,
          sessionKey,
          terminalScope,
          threadId,
        })
      : undefined;
    const record: BridgeSessionRecord = {
      sessionKey,
      threadId,
      cwd,
      pendingAttachmentUploadEvents: [],
      mcpManifestHash: currentHashes.mcpManifestHash,
      toolPolicyHash: currentHashes.toolPolicyHash,
      agentName: normalizeAgentName(item.agentName),
      generation,
      providerSessionKey,
      organizationId: item.organizationId,
      scopeConversationId: item.mailboxConversationId ?? threadId,
      scopeKeyWithoutAgent,
      terminalScope,
      lastUsedAt: this.nextSessionUsageTimestamp(),
      launchSpecKey: launchSpec.key,
      launchSpecSummary: launchSpec.summary,
      acp: this.createSession({
        agentCommand,
        bridgeProfileId: item.bridgeProfileId,
        launchSpecKey: launchSpec.key,
        launchSpecSummary: launchSpec.summary,
        runtimeProfile,
        sessionKey,
        threadId,
        cwd,
        gitAuthorEnv: gitAuthorProcessEnv,
        hermesProfileName: item.hermesProfileName,
        agentSessionId: item.agentSessionId,
        organizationId: item.organizationId,
        terminalAdapter,
        terminalScope,
        processRegistryMetadata: {
          bridgeDeviceId: this.deviceId,
          claimId: item.claimId,
          hermesProfileName: item.hermesProfileName,
          launchSpecKey: launchSpec.key,
          queueItemId: item.id,
          runtimeProfileId: runtimeProfile?.id ?? item.bridgeProfileId,
          sessionKey,
        },
        initialSessionId: this.resumeEnabled
          ? item.externalSessionId
          : undefined,
        mcpServers: applyRuntimeMcpServerCompatibility(
          this.createMcpServers({
            agentSessionId: item.agentSessionId,
            cwd,
            organizationId: item.organizationId,
            sessionKey,
            threadId,
          }),
          runtimeProfile,
        ),
        onEvent: (event) => {
          if (this.isCurrentSessionRecord(record)) {
            const eventItem = this.currentQueueItemForSessionEvent(
              record,
              item,
            );
            const annotatedEvent = this.annotateToolEvent(
              eventItem.id,
              record,
              event,
            );
            this.writeFirstRuntimeActivityLog(
              eventItem,
              record,
              annotatedEvent,
            );
            this.writeFirstAssistantTextLog(eventItem, record, annotatedEvent);
            this.recordLivenessEvent(
              eventItem.id,
              annotatedEvent.eventType.includes("tool")
                ? "tool_progress"
                : "assistant_output",
            );
            this.recordToolEvent(eventItem.id, record, annotatedEvent);
            this.reconcilePendingToolCallsIfAssistantOutputResumed(
              eventItem.id,
              record,
              annotatedEvent,
            );
            this.supervisor?.recordProviderEvent(
              this.supervisorWorkItem(eventItem, record),
              {
                eventType: annotatedEvent.eventType,
              },
            );
            if (
              annotatedEvent.part?.type === "approval_request" ||
              annotatedEvent.part?.type === "choice"
            ) {
              this.recordLivenessEvent(eventItem.id, "permission_request");
              this.supervisor?.recordWaitingForInteraction(
                this.supervisorWorkItem(eventItem, record),
                annotatedEvent.externalEventId ??
                  eventItem.externalRequestId ??
                  eventItem.approvalId ??
                  eventItem.id,
              );
            }
            if (annotatedEvent.attachmentUpload) {
              record.pendingAttachmentUploadEvents.push(annotatedEvent);
              this.writeLog({
                level: "debug",
                event: "agent.attachments.upload_deferred",
                threadId: record.threadId,
                sessionId: eventItem.sessionId,
                agentSessionId: record.providerSessionKey,
                queueId: eventItem.id,
                queueType: normalizeType(eventItem),
                candidateKind: annotatedEvent.attachmentUpload.kind,
                mediaType: annotatedEvent.attachmentUpload.mediaType,
                sizeBytes: annotatedEvent.attachmentUpload.sizeBytes,
              });
              return;
            }
            this.enqueueEventWrite(record, annotatedEvent);
          }
        },
        onEventBoundary: () => {
          this.flushPendingStreamChunkEvent();
        },
        onError: (error) => {
          if (this.isCurrentSessionRecord(record)) {
            const eventItem = this.currentQueueItemForSessionEvent(
              record,
              item,
            );
            if (/runtime process exited/i.test(error.message)) {
              this.recordLivenessEvent(eventItem.id, "process_exited");
            }
            this.enqueueErrorWrite(record, error);
          }
        },
      }),
      runtimeProfile,
      hermesProfileName: item.hermesProfileName,
    };
    if (options.closeReplacedSessions !== false) {
      await this.closeReplacedRuntimeSessions(scopeKeyWithoutAgent, sessionKey);
    }
    this.sessions.set(sessionKey, record);
    this.rememberWarmSessionCandidate(item, record);
    return record;
  }

  private rememberWarmSessionCandidate(
    item: BridgeSessionQueueItem,
    record: BridgeSessionRecord,
  ): void {
    this.warmSessionCandidates.set(record.sessionKey, {
      agentName: item.agentName,
      agentSessionId: item.agentSessionId,
      bridgeProfileId: record.runtimeProfile?.id ?? item.bridgeProfileId,
      cwd: record.cwd,
      hermesProfileName: record.hermesProfileName,
      lastUsedAt: record.lastUsedAt,
      launchSpecKey: record.launchSpecKey,
      mailboxConversationId: item.mailboxConversationId,
      organizationId: item.organizationId,
      runtimeProfileId: record.runtimeProfile?.id,
      sessionId: item.sessionId,
      sessionKey: record.sessionKey,
      threadId: record.threadId,
    });
    this.pruneWarmSessionCandidates();
  }

  private pruneWarmSessionCandidates(): void {
    const excessCount =
      this.warmSessionCandidates.size - MAX_WARM_SESSION_CANDIDATES;
    if (excessCount <= 0) {
      return;
    }
    const oldestCandidates = Array.from(this.warmSessionCandidates.values())
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
      .slice(0, excessCount);
    for (const candidate of oldestCandidates) {
      this.warmSessionCandidates.delete(candidate.sessionKey);
    }
  }

  private markSessionUsed(record: BridgeSessionRecord): void {
    record.lastUsedAt = this.nextSessionUsageTimestamp();
    const candidate = this.warmSessionCandidates.get(record.sessionKey);
    if (candidate) {
      candidate.lastUsedAt = record.lastUsedAt;
    }
  }

  private nextSessionUsageTimestamp(): number {
    const timestamp = Math.max(Date.now(), this.lastSessionUsageAt + 1);
    this.lastSessionUsageAt = timestamp;
    return timestamp;
  }

  private hasLiveSessionForWarmCandidateScope(
    item: BridgeSessionQueueItem,
    candidate: BridgeWarmSessionCandidate,
  ): boolean {
    const threadId = item.threadId ?? item.sessionId;
    const providerSessionKey = providerSessionKeyForItem(item);
    if (!threadId || !providerSessionKey) {
      return true;
    }
    const scopeKeyWithoutAgent = this.scopeKeyWithoutAgentForItem(
      item,
      providerSessionKey,
      threadId,
    );
    return Array.from(this.sessions.values()).some(
      (session) =>
        session.scopeKeyWithoutAgent === scopeKeyWithoutAgent &&
        session.sessionKey !== candidate.sessionKey,
    );
  }

  private removeWarmSessionCandidatesForItem(
    item: BridgeSessionQueueItem,
  ): number {
    let removedCount = 0;
    const exact = this.sessionKeyForItem(item);
    if (exact && this.warmSessionCandidates.delete(exact)) {
      removedCount += 1;
    }
    for (const candidate of Array.from(this.warmSessionCandidates.values())) {
      if (this.queueItemMatchesWarmSessionCandidate(item, candidate)) {
        this.warmSessionCandidates.delete(candidate.sessionKey);
        removedCount += 1;
      }
    }
    return removedCount;
  }

  private queueItemMatchesWarmSessionCandidate(
    item: BridgeSessionQueueItem,
    candidate: BridgeWarmSessionCandidate,
  ): boolean {
    if (this.sessionKeyForItem(item) === candidate.sessionKey) {
      return true;
    }
    const providerSessionKey = providerSessionKeyForItem(item);
    const threadId = item.threadId ?? item.sessionId;
    const candidateProviderSessionKey =
      candidate.agentSessionId ?? candidate.sessionId ?? candidate.threadId;
    if (
      !providerSessionKey ||
      !threadId ||
      providerSessionKey !== candidateProviderSessionKey ||
      threadId !== candidate.threadId
    ) {
      return false;
    }
    if (
      item.organizationId &&
      candidate.organizationId &&
      item.organizationId !== candidate.organizationId
    ) {
      return false;
    }
    if (
      item.mailboxConversationId &&
      candidate.mailboxConversationId &&
      item.mailboxConversationId !== candidate.mailboxConversationId
    ) {
      return false;
    }
    if (
      hasExplicitRuntimeScope(item) &&
      !bridgeQueueItemMatchesSessionRuntimeScope(item, {
        hermesProfileName: candidate.hermesProfileName,
        runtimeProfileId: candidate.runtimeProfileId ?? candidate.bridgeProfileId,
      })
    ) {
      return false;
    }
    return true;
  }

  private currentSessionHashes(): {
    mcpManifestHash?: string;
    toolPolicyHash?: string;
  } {
    return {
      mcpManifestHash: this.getCurrentMcpManifestHash(),
      toolPolicyHash: this.getCurrentToolPolicyHash(),
    };
  }

  private sessionHashesChanged(
    session: BridgeSessionRecord,
    currentHashes: {
      mcpManifestHash?: string;
      toolPolicyHash?: string;
    },
  ): boolean {
    return (
      session.mcpManifestHash !== currentHashes.mcpManifestHash ||
      session.toolPolicyHash !== currentHashes.toolPolicyHash
    );
  }

  private writeSessionHashChangeLog(input: {
    existing: BridgeSessionRecord;
    currentHashes: {
      mcpManifestHash?: string;
      toolPolicyHash?: string;
    };
    queueId: string;
    threadId: string;
  }): void {
    this.log?.(
      redactLogValue({
        currentMcpManifestHash: input.currentHashes.mcpManifestHash,
        currentToolPolicyHash: input.currentHashes.toolPolicyHash,
        event: "bridge.session.mcp_manifest_changed",
        level: "info",
        previousMcpManifestHash: input.existing.mcpManifestHash,
        previousToolPolicyHash: input.existing.toolPolicyHash,
        queueId: input.queueId,
        runtimeProfileId: input.existing.runtimeProfile?.id,
        sessionKey: input.existing.sessionKey,
        threadId: input.threadId,
      }) as BridgeLogEntry,
    );
  }

  private sessionMatchesExplicitRuntimeRequest(
    session: BridgeSessionRecord,
    item: BridgeSessionQueueItem,
  ): boolean {
    const requestedCwd = this.allowRemoteCwd ? item.cwd : undefined;
    if (
      session.runtimeProfile?.identityRules?.cwdBoundSessions &&
      session.cwd !== requestedCwd
    ) {
      return false;
    }
    if (item.bridgeProfileId) {
      if (session.runtimeProfile?.id === item.bridgeProfileId) {
        return true;
      }
      return (
        item.bridgeProfileId.startsWith("hermes:") &&
        item.bridgeProfileId !== "hermes:default" &&
        session.runtimeProfile?.id === "hermes:default" &&
        session.hermesProfileName === item.bridgeProfileId.slice("hermes:".length)
      );
    }
    if (item.hermesProfileName) {
      return session.hermesProfileName === item.hermesProfileName;
    }
    return true;
  }

  private resolveRuntimeProfileForItem(
    item: BridgeSessionQueueItem,
  ): BridgeRuntimeProfile | undefined {
    if (item.bridgeProfileId) {
      const selected =
        this.runtimeProfiles.find((profile) => profile.id === item.bridgeProfileId) ??
        (item.bridgeProfileId.startsWith("hermes:") &&
        item.bridgeProfileId !== "hermes:default"
          ? this.runtimeProfiles.find((profile) => profile.id === "hermes:default")
          : undefined);
      const selectedProfileId = selected?.id ?? item.bridgeProfileId;
      if (!selected) {
        throw new Error(
          `Bridge runtime profile is unavailable: ${item.bridgeProfileId}`,
        );
      }
      if (selected.status !== "available") {
        const reason = selected.diagnostics?.reason
          ? `: ${selected.diagnostics.reason}`
          : "";
        throw new Error(
          `Bridge runtime profile is unavailable: ${selectedProfileId}${reason}`,
        );
      }
      return selected;
    }
    if (item.hermesProfileName) {
      return undefined;
    }
    const availableProfiles = this.runtimeProfiles.filter(
      (profile) => profile.status === "available",
    );
    if (availableProfiles.length > 1) {
      throw new Error(
        "Bridge runtime profile is required when multiple ACP runtimes are available",
      );
    }
    return findRuntimeProfile(this.runtimeProfiles, undefined);
  }

  private safeLaunchSpecForItem(
    item: BridgeSessionQueueItem,
  ): BridgeLaunchSpec | undefined {
    try {
      const runtimeProfile = item.bridgeProfileId
        ? this.runtimeProfiles.find((profile) => profile.id === item.bridgeProfileId) ??
          (item.bridgeProfileId.startsWith("hermes:") &&
          item.bridgeProfileId !== "hermes:default"
            ? this.runtimeProfiles.find((profile) => profile.id === "hermes:default")
            : undefined)
        : this.runtimeProfiles.find((profile) => profile.status === "available");
      return buildBridgeLaunchSpec({
        baseAgentCommand: this.agentCommand,
        bridgeProfileId: item.bridgeProfileId,
        hermesProfileName: item.hermesProfileName,
        runtimeProfile,
      });
    } catch {
      return undefined;
    }
  }

  private isCurrentSessionRecord(record: BridgeSessionRecord): boolean {
    const current = this.sessions.get(record.sessionKey);
    return current === record && current.generation === record.generation;
  }

  private currentQueueItemForSessionEvent(
    record: BridgeSessionRecord,
    fallback: BridgeSessionQueueItem,
  ): BridgeSessionQueueItem {
    const runningQueueItemId = this.sessionQueueState.get(
      record.sessionKey,
    )?.runningQueueItemId;
    if (!runningQueueItemId) {
      return this.lastSessionEventQueueItems.get(record.sessionKey) ?? fallback;
    }
    return this.activeQueueItems.get(runningQueueItemId) ?? fallback;
  }

  private writeFirstRuntimeActivityLog(
    item: BridgeSessionQueueItem,
    record: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): void {
    const key = queueItemOnceKey(item);
    if (this.firstRuntimeActivityLoggedQueueItems.has(key)) {
      return;
    }
    this.firstRuntimeActivityLoggedQueueItems.add(key);
    this.writeLog({
      ...this.firstOutputLogFields(item, record),
      level: "info",
      event: "bridge.queue_item.first_runtime_activity",
      runtimeEventType: event.eventType,
      runtimePartType: event.part?.type,
    });
  }

  private writeFirstAssistantTextLog(
    item: BridgeSessionQueueItem,
    record: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): void {
    if (event.part?.type !== "text" || !event.part.text) {
      return;
    }
    const key = queueItemOnceKey(item);
    if (this.firstAssistantTextLoggedQueueItems.has(key)) {
      return;
    }
    this.firstAssistantTextLoggedQueueItems.add(key);
    this.writeLog({
      ...this.firstOutputLogFields(item, record),
      level: "info",
      event: "bridge.queue_item.first_assistant_text",
      runtimeEventType: event.eventType,
      runtimePartType: event.part.type,
    });
  }

  private clearFirstOutputLogState(item: BridgeSessionQueueItem): void {
    const key = queueItemOnceKey(item);
    this.firstAssistantTextLoggedQueueItems.delete(key);
    this.firstRuntimeActivityLoggedQueueItems.delete(key);
  }

  private firstOutputLogFields(
    item: BridgeSessionQueueItem,
    record: BridgeSessionRecord,
  ): Record<string, unknown> {
    const now = Date.now();
    return removeUndefinedValues({
      queueId: item.id,
      queueType: normalizeType(item),
      threadId: item.threadId ?? record.threadId,
      sessionId: item.sessionId,
      agentSessionId: record.providerSessionKey,
      acpSessionId: record.acp.sessionId,
      organizationId: item.organizationId,
      bridgeProfileId: item.bridgeProfileId,
      runtimeProfileId: record.runtimeProfile?.id ?? item.bridgeProfileId,
      runtimeKind:
        record.launchSpecSummary?.runtimeKind ?? record.runtimeProfile?.kind,
      hermesProfileName: item.hermesProfileName ? "<hermes-profile>" : undefined,
      queueCreatedToFirstOutputMs: elapsedSince(item.createdAtMs, now),
      claimedToFirstOutputMs: elapsedSince(item.claimedAtMs, now),
    });
  }

  private clearIdleTimer(record: BridgeSessionRecord): void {
    if (record.idleTimer !== undefined) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
  }

  private scheduleIdleClose(record: BridgeSessionRecord): void {
    if (this.idleSessionTtlMs <= 0 || !this.isCurrentSessionRecord(record)) {
      return;
    }
    this.clearIdleTimer(record);
    record.idleTimer = setTimeout(() => {
      void this.closeSessionIfIdle(record.sessionKey, record.generation);
    }, this.idleSessionTtlMs);
  }

  private async closeSessionIfIdle(
    sessionKey: string,
    generation: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session || session.generation !== generation) {
      return;
    }
    if (!this.canCloseSessionForIdlePressure(session)) {
      this.scheduleIdleClose(session);
      return;
    }
    this.writeLog({
      level: "info",
      event: "bridge.lifecycle.idle_close",
      threadId: session.threadId,
      agentSessionId: session.providerSessionKey,
      providerSessionId: session.providerSessionKey,
      acpSessionId: session.acp.sessionId,
    });
    await this.closeSession(sessionKey);
  }

  private canCloseSessionForIdlePressure(record: BridgeSessionRecord): boolean {
    if (!this.isCurrentSessionRecord(record)) {
      return false;
    }
    const queueState = this.sessionQueueState.get(record.sessionKey);
    const hasQueueWork =
      (queueState?.pendingQueueItemIds.length ?? 0) > 0 ||
      Boolean(queueState?.runningQueueItemId);
    const hasActiveLiveness = Array.from(this.activeLiveness.values()).some(
      (liveness) => liveness.sessionKey === record.sessionKey,
    );
    const hasActiveQueueItem = Array.from(this.activeQueueItems.values()).some(
      (item) => this.queueItemMatchesSessionRecord(item, record),
    );
    const hasEventWrites =
      this.eventBatch.length > 0 ||
      this.pendingStreamChunkEvent !== undefined ||
      this.pendingEventWrites.length > 0 ||
      this.eventBatchTimer !== undefined;
    const hasPendingPermissions =
      record.acp.hasPendingPermissionRequests?.() === true;
    return (
      !hasQueueWork &&
      !hasActiveLiveness &&
      !hasActiveQueueItem &&
      !hasEventWrites &&
      !hasPendingPermissions
    );
  }

  private queueItemMatchesSessionRecord(
    item: BridgeSessionQueueItem,
    record: BridgeSessionRecord,
  ): boolean {
    if (this.sessionKeyForItem(item) === record.sessionKey) {
      return true;
    }
    const providerSessionKey = providerSessionKeyForItem(item);
    const threadId = item.threadId ?? item.sessionId;
    if (!providerSessionKey || !threadId) {
      return false;
    }
    if (
      providerSessionKey !== record.providerSessionKey ||
      threadId !== record.threadId
    ) {
      return false;
    }
    if (
      hasExplicitRuntimeScope(item) &&
      !bridgeQueueItemMatchesSessionRuntimeScope(item, {
        hermesProfileName: record.hermesProfileName,
        runtimeProfileId: record.runtimeProfile?.id,
      })
    ) {
      return false;
    }
    return true;
  }

  private enqueueEventWrite(
    record: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): number {
    const preparedEvent = stripMediaAttachmentReferencesFromStreamEvent(
      event,
      record.cwd,
    );
    const sequence = this.allocateEventSequence(record, event);
    if (!preparedEvent) {
      return sequence;
    }
    this.writeBridgeActivityLog(record, preparedEvent, sequence);
    this.enqueueBridgeEvent(toBridgeEvent(record, preparedEvent, sequence));
    return sequence;
  }

  private allocateEventSequence(
    record: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
  ): number {
    const baseSequence = this.activePromptSequenceBases.get(record.sessionKey);
    if (
      event.source === "acp_bridge" &&
      baseSequence !== undefined &&
      typeof event.providerSequence === "number" &&
      Number.isInteger(event.providerSequence) &&
      event.providerSequence >= 1
    ) {
      const sequence = baseSequence + event.providerSequence;
      this.nextSequence = Math.max(this.nextSequence, sequence + 1);
      return sequence;
    }
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    return sequence;
  }

  private async resolveAgentAttachmentUploads(
    item: BridgeSessionQueueItem,
    record: BridgeSessionRecord,
    events: NormalizedBridgeEvent[],
  ): Promise<{
    failedCount: number;
    mediaTypes: string[];
    totalBytes: number;
    uploadedCount: number;
  }> {
    let failedCount = 0;
    let totalBytes = 0;
    let uploadedCount = 0;
    const mediaTypes = new Set<string>();

    for (const event of events) {
      if (!event.attachmentUpload) {
        continue;
      }
      const candidate = event.attachmentUpload;
      try {
        const uploadInput = await buildAgentAttachmentUploadInput(
          candidate,
          record.threadId,
          record.providerSessionKey,
          record.cwd,
        );
        const response = await this.cloudClient.uploadAttachment(uploadInput);
        const file = normalizeUploadedAgentAttachment(response.file);
        event.part = {
          type: "attachment",
          json: file,
          status: "complete",
        };
        event.payload = summarizeResolvedAgentAttachment(file);
        delete event.attachmentUpload;
        this.enqueueEventWrite(record, event);
        uploadedCount += 1;
        if (typeof file.mediaType === "string") {
          mediaTypes.add(file.mediaType);
        }
        if (typeof file.sizeBytes === "number") {
          totalBytes += file.sizeBytes;
        }
      } catch (error) {
        failedCount += 1;
        const message = String(
          redactLogValue(
            error instanceof Error ? error.message : String(error),
          ),
        );
        event.part = {
          type: "attachment",
          json: removeUndefinedValues({
            error: "upload_failed",
            filename: candidate.filename ?? "Attachment",
            mediaType: candidate.mediaType,
            sizeBytes: candidate.sizeBytes,
            status: "error",
            type: "file",
          }),
          status: "error",
        };
        event.payload = removeUndefinedValues({
          type: "agent_attachment_upload_failed",
          candidateKind: candidate.kind,
          mediaType: candidate.mediaType,
          sizeBytes: candidate.sizeBytes,
          status: "error",
        });
        delete event.attachmentUpload;
        this.enqueueEventWrite(record, event);
        this.writeLog({
          level: "warn",
          event: "agent.attachments.upload_failed",
          queueId: item.id,
          queueType: normalizeType(item),
          threadId: record.threadId,
          sessionId: item.sessionId,
          agentSessionId: record.providerSessionKey,
          candidateKind: candidate.kind,
          mediaType: candidate.mediaType,
          sizeBytes: candidate.sizeBytes,
          error: message,
        });
      }
    }

    return {
      failedCount,
      mediaTypes: [...mediaTypes].sort(),
      totalBytes,
      uploadedCount,
    };
  }

  private writeBridgeActivityLog(
    record: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
    sequence: number,
  ): void {
    const queueId =
      this.sessionQueueState.get(record.sessionKey)?.runningQueueItemId ??
      this.lastSessionEventQueueItems.get(record.sessionKey)?.id;
    const base = {
      agentSessionId: record.providerSessionKey,
      queueId,
      threadId: record.threadId,
      timelineSequence: sequence,
      turnId: queueId,
    };

    if (event.part?.type === "thinking") {
      this.writeLog({
        ...base,
        event: "agent.reasoning.chunk",
        level: "debug",
        textLength: event.part.text?.length ?? 0,
      });
      return;
    }

    if (event.part?.type === "tool_call") {
      const tool = readToolLogFields(event.part.json);
      this.writeLog({
        ...base,
        event: "agent.tool.requested",
        level: "info",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
      });
      return;
    }

    if (event.part?.type === "tool_result") {
      const tool = readToolLogFields(event.part.json);
      this.writeLog({
        ...base,
        event:
          event.part.status === "error"
            ? "agent.tool.failed"
            : "agent.tool.completed",
        level: event.part.status === "error" ? "error" : "info",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
      });
    }
  }

  private enqueueErrorWrite(record: BridgeSessionRecord, error: Error): void {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const message = String(redactLogValue(error.message));
    this.enqueueBridgeEvent({
      threadId: record.threadId,
      agentSessionId: record.providerSessionKey,
      eventType: "bridge_error",
      sequence,
      rawPayload: { message },
      normalizedPayload: { type: "error", text: message, status: "error" },
      source: "bridge",
      externalEventId: `${record.sessionKey}:${sequence}:bridge_error`,
      createdAt: Date.now(),
    });
  }

  private async drainEventWrites(): Promise<void> {
    this.flushPendingStreamChunkEvent();
    this.flushEventBatch();
    const pending = this.pendingEventWrites.splice(
      0,
      this.pendingEventWrites.length,
    );
    const outcomes = await Promise.all(pending);
    const failures = outcomes.filter((outcome) => !outcome.ok);
    if (failures.length > 0) {
      const firstFailure = failures[0];
      throw new Error(
        `bridge event upload failed for ${failures.reduce((total, failure) => total + failure.count, 0)} event(s): ${firstFailure.error.message}`,
      );
    }
  }

  private enqueueBridgeEvent(event: BridgeEventInput): void {
    if (isStreamChunkBridgeEvent(event)) {
      this.enqueueStreamChunkEvent(event);
      return;
    }
    this.flushPendingStreamChunkEvent();
    this.eventBatch.push(event);
    if (this.eventBatch.length >= EVENT_BATCH_MAX_SIZE) {
      this.flushEventBatch();
      return;
    }
    this.scheduleEventBatchFlush();
  }

  private scheduleEventBatchFlush(): void {
    if (this.eventBatchTimer !== undefined) {
      return;
    }
    this.eventBatchTimer = setTimeout(() => {
      this.eventBatchTimer = undefined;
      this.flushEventBatch();
    }, EVENT_BATCH_FLUSH_MS);
  }

  private flushEventBatch(): void {
    this.flushPendingStreamChunkEvent();
    if (this.eventBatchTimer !== undefined) {
      clearTimeout(this.eventBatchTimer);
      this.eventBatchTimer = undefined;
    }
    if (this.eventBatch.length === 0) {
      return;
    }
    const events = this.eventBatch.splice(0, this.eventBatch.length);
    this.trackEventWrite(this.appendEventBatchWithFallback(events));
  }

  private enqueueStreamChunkEvent(event: BridgeEventInput): void {
    const pending = this.pendingStreamChunkEvent;
    const eventText = readBridgeEventText(event);
    const eventTextLength = eventText.length;
    if (eventTextLength === 0) {
      return;
    }
    if (
      pending &&
      (pending.eventType !== event.eventType ||
        pending.chunkCount >= STREAM_CHUNK_COALESCE_MAX_COUNT ||
        pending.textLength + eventTextLength > STREAM_CHUNK_COALESCE_MAX_CHARS)
    ) {
      this.flushPendingStreamChunkEvent();
    }

    if (!this.pendingStreamChunkEvent) {
      this.pendingStreamChunkEvent =
        createCoalescedBridgeStreamChunkEvent(event);
      this.scheduleEventBatchFlush();
      return;
    }

    appendCoalescedBridgeStreamChunkEvent(this.pendingStreamChunkEvent, event);
    this.scheduleEventBatchFlush();
  }

  private flushPendingStreamChunkEvent(): void {
    if (!this.pendingStreamChunkEvent) {
      return;
    }
    this.eventBatch.push(
      finalizeCoalescedBridgeStreamChunkEvent(this.pendingStreamChunkEvent),
    );
    this.pendingStreamChunkEvent = undefined;
  }

  private trackEventWrite(write: Promise<EventWriteOutcome>): void {
    this.pendingEventWrites.push(write);
    const forgetWrite = () => {
      const index = this.pendingEventWrites.indexOf(write);
      if (index >= 0) {
        this.pendingEventWrites.splice(index, 1);
      }
    };
    void write.then(forgetWrite, forgetWrite);
  }

  private async appendEventBatchWithFallback(
    events: BridgeEventInput[],
  ): Promise<EventWriteOutcome> {
    try {
      await this.cloudClient.appendEvents(events);
      this.writeLog({
        level: "debug",
        event: "bridge.events.appended",
        eventCount: events.length,
      });
      return { ok: true, count: events.length };
    } catch (error) {
      const message = String(
        redactLogValue(error instanceof Error ? error.message : String(error)),
      );
      this.writeLog({
        level: "error",
        event: "bridge.events.append_failed",
        eventCount: events.length,
        error: message,
      });
      if (isBridgeEventUploadOverload(error)) {
        return { ok: false, count: events.length, error: new Error(message) };
      }
      if (events.length <= 1) {
        return { ok: false, count: events.length, error: new Error(message) };
      }

      let failedCount = 0;
      let firstError: Error | undefined;
      for (const event of events) {
        try {
          await this.cloudClient.appendEvents([event]);
          this.writeLog({
            level: "debug",
            event: "bridge.events.appended_single",
            eventType: event.eventType,
            threadId: event.threadId,
          });
        } catch (singleError) {
          failedCount += 1;
          const singleMessage = String(
            redactLogValue(
              singleError instanceof Error
                ? singleError.message
                : String(singleError),
            ),
          );
          firstError = firstError ?? new Error(singleMessage);
          this.writeLog({
            level: "error",
            event: "bridge.events.append_single_failed",
            eventType: event.eventType,
            threadId: event.threadId,
            externalEventId: event.externalEventId,
            error: singleMessage,
          });
        }
      }

      if (failedCount > 0) {
        return {
          ok: false,
          count: failedCount,
          error:
            firstError ??
            new Error(`bridge event upload failed for ${failedCount} event(s)`),
        };
      }
      return { ok: true, count: events.length };
    }
  }

  private writeQueueCompleteLog(
    item: BridgeSessionQueueItem,
    type: string,
  ): void {
    this.writeLog({
      level: "info",
      event: "bridge.queue_item.complete",
      queueId: item.id,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
      activeSessionCount: this.sessions.size,
    });
  }

  private writeAgentTurnLog(
    event: "agent.turn.completed" | "agent.turn.failed" | "agent.turn.started",
    item: BridgeSessionQueueItem,
    type: string,
    error?: string,
  ): void {
    this.writeLog({
      level: event === "agent.turn.failed" ? "error" : "info",
      event,
      queueId: item.id,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
      error,
    });
  }

  private supervisorWorkItem(
    item: BridgeSessionQueueItem,
    session?: BridgeSessionRecord,
  ): BridgeSupervisorWorkItem {
    return {
      agentId:
        item.bridgeProfileId ??
        item.hermesProfileName ??
        item.agentName ??
        session?.runtimeProfile?.id ??
        "default-agent",
      agentName: item.agentName,
      bridgeDeviceId: this.deviceId,
      bridgeProfileId: item.bridgeProfileId,
      claimId: item.claimId,
      hermesProfileName: item.hermesProfileName,
      id: item.id,
      organizationId: item.organizationId,
      runtimeProfileId: item.bridgeProfileId ?? session?.runtimeProfile?.id,
      sessionId: item.sessionId,
      threadId: item.threadId ?? item.sessionId ?? session?.threadId,
      traceId: item.traceId,
      type: item.type,
      kind: item.kind,
    };
  }

  private sessionKeyForItem(item: BridgeSessionQueueItem): string | undefined {
    const providerSessionKey = providerSessionKeyForItem(item);
    if (!providerSessionKey) {
      return undefined;
    }
    const threadId = item.threadId ?? item.sessionId ?? "unknown-thread";
    return [
      item.organizationId ?? "unknown-org",
      this.deviceId ?? "unknown-device",
      item.bridgeProfileId ??
        item.hermesProfileName ??
        item.agentName ??
        "unknown-agent",
      item.mailboxConversationId ?? threadId,
      providerSessionKey,
      attributionSessionKeyPart(item),
    ]
      .filter((part) => part !== undefined)
      .map(encodeSessionKeyPart)
      .join(":");
  }

  private assertRequiredScopedIdentity(item: BridgeSessionQueueItem): void {
    if (!this.requireScopedIdentity) {
      return;
    }
    if (!item.organizationId) {
      throw new Error(
        `queue item ${item.id} is missing organizationId; reconnect the bridge with a fresh agent link`,
      );
    }
    if (!this.deviceId) {
      throw new Error(
        "bridge device identity is missing; reconnect the bridge",
      );
    }
    if (!item.agentSessionId) {
      throw new Error(
        `queue item ${item.id} is missing agentSessionId; reconnect the agent from 0000`,
      );
    }
  }

  private findSessionKeyForItem(
    item: BridgeSessionQueueItem,
  ): string | undefined {
    const exact = this.sessionKeyForItem(item);
    if (
      exact &&
      (this.sessions.has(exact) || this.sessionQueueState.has(exact))
    ) {
      return exact;
    }
    if (hasExplicitRuntimeScope(item)) {
      const scopedMatches = Array.from(this.sessions.values()).filter((session) =>
        this.queueItemMatchesSessionRecord(item, session),
      );
      if (scopedMatches.length > 1) {
        throw new Error(
          `queue item ${item.id} matches multiple active ACP sessions; include organization and runtime scope`,
        );
      }
      return scopedMatches[0]?.sessionKey;
    }

    const providerSessionKey = providerSessionKeyForItem(item);
    const threadId = item.threadId ?? item.sessionId;
    if (!providerSessionKey || !threadId) {
      return exact;
    }

    const scopeKeyWithoutAgent = this.scopeKeyWithoutAgentForItem(
      item,
      providerSessionKey,
      threadId,
    );
    const scopeMatch = this.latestSessionMatching(
      (session) => session.scopeKeyWithoutAgent === scopeKeyWithoutAgent,
    );
    if (scopeMatch) {
      return scopeMatch.sessionKey;
    }

    const providerThreadMatches = Array.from(this.sessions.values()).filter(
      (session) =>
        session.providerSessionKey === providerSessionKey &&
        session.scopeConversationId ===
          (item.mailboxConversationId ?? threadId),
    );
    if (providerThreadMatches.length > 1) {
      throw new Error(
        `queue item ${item.id} matches multiple active ACP sessions; include organization and runtime scope`,
      );
    }
    return providerThreadMatches[0]?.sessionKey;
  }

  private latestSessionMatching(
    predicate: (session: BridgeSessionRecord) => boolean,
  ): BridgeSessionRecord | undefined {
    return Array.from(this.sessions.values())
      .filter(predicate)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0];
  }

  private scopeKeyWithoutAgentForItem(
    item: BridgeSessionQueueItem,
    providerSessionKey: string,
    threadId: string,
  ): string {
    return [
      item.organizationId ?? "unknown-org",
      this.deviceId ?? "unknown-device",
      item.mailboxConversationId ?? threadId,
      providerSessionKey,
    ]
      .map(encodeSessionKeyPart)
      .join(":");
  }

  private async closeReplacedRuntimeSessions(
    scopeKeyWithoutAgent: string,
    nextSessionKey: string,
  ): Promise<void> {
    const replaced = Array.from(this.sessions.values()).filter(
      (session) =>
        session.scopeKeyWithoutAgent === scopeKeyWithoutAgent &&
        session.sessionKey !== nextSessionKey,
    );
    await Promise.all(
      replaced.map(async (session) => {
        this.writeLog({
          level: "info",
          event: "bridge.lifecycle.replacement_session",
          threadId: session.threadId,
          sessionId: session.providerSessionKey,
          agentSessionId: session.sessionKey,
          replacementAgentSessionId: nextSessionKey,
          bridgeProfileId: session.runtimeProfile?.id,
          hermesProfileName: session.hermesProfileName,
          reason: "runtime_profile_changed",
        });
        await this.closeSession(session.sessionKey);
      }),
    );
  }

  private writeLog(entry: BridgeLogEntry): void {
    this.log?.(
      redactLogValue({ deviceId: this.deviceId, ...entry }) as BridgeLogEntry,
    );
  }
}

function warmSessionCandidateMatchesProfiles(
  candidate: BridgeWarmSessionCandidate,
  warmProfileIds: Set<string>,
): boolean {
  return [
    candidate.bridgeProfileId,
    candidate.runtimeProfileId,
    candidate.launchSpecKey,
  ].some((profileId) => profileId !== undefined && warmProfileIds.has(profileId));
}

function warmSessionQueueItem(
  candidate: BridgeWarmSessionCandidate,
): BridgeSessionQueueItem {
  return removeUndefinedValues({
    agentName: candidate.agentName,
    agentSessionId: candidate.agentSessionId,
    bridgeProfileId: candidate.bridgeProfileId,
    cwd: candidate.cwd,
    hermesProfileName: candidate.hermesProfileName,
    id: `warm:${candidate.sessionKey}`,
    mailboxConversationId: candidate.mailboxConversationId,
    organizationId: candidate.organizationId,
    sessionId: candidate.sessionId,
    threadId: candidate.threadId,
    type: "start-session",
  }) as BridgeSessionQueueItem;
}

function warmSessionQueueItemFromSeed(
  candidate: BridgeWarmRuntimeSessionSeed,
  threadId: string,
): BridgeSessionQueueItem {
  return removeUndefinedValues({
    agentName: candidate.agentName,
    agentSessionId: candidate.agentSessionId,
    bridgeProfileId: candidate.bridgeProfileId ?? candidate.runtimeProfileId,
    cwd: candidate.cwd,
    hermesProfileName: candidate.hermesProfileName,
    id: `warm-seed:${threadId}`,
    mailboxConversationId: candidate.mailboxConversationId,
    organizationId: candidate.organizationId,
    sessionId: candidate.sessionId,
    threadId,
    type: "start-session",
  }) as BridgeSessionQueueItem;
}

function isBridgeEventUploadOverload(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /too many concurrent|concurrent requests|limited to \d+ concurrent|timeout|timed out/i.test(
    message,
  );
}

function isEmptyVisiblePromptResult(result: { text: string }): boolean {
  return result.text.trim().length === 0;
}

function classifyPromptError(
  error: unknown,
  toolTimeoutDetails?: ToolResultTimeoutDetails,
):
  | {
      terminal: true;
      details?: Record<string, unknown>;
      message: string;
      reasonCode:
        | "acp_method_timeout"
        | "provider_silent_timeout"
        | "runtime_process_exited"
        | "tool_result_timeout";
    }
  | { terminal: false } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ACP live session lost: tool_result_timeout")) {
    return {
      terminal: true,
      details: toolTimeoutDetails,
      message: "ACP tool call did not return a result before the timeout.",
      reasonCode: "tool_result_timeout",
    };
  }
  if (message.includes("ACP live session lost: provider_silent_timeout")) {
    return {
      terminal: true,
      message: "ACP live session stopped producing progress.",
      reasonCode: "provider_silent_timeout",
    };
  }
  if (message.includes("ACP live session lost: runtime_process_exited")) {
    return {
      terminal: true,
      message: "ACP runtime process exited during the live session.",
      reasonCode: "runtime_process_exited",
    };
  }
  if (message.includes("ACP request timed out: session/prompt")) {
    return {
      terminal: true,
      message: "ACP prompt request timed out.",
      reasonCode: "acp_method_timeout",
    };
  }
  return { terminal: false };
}

function classifyAcpStartupError(
  error: unknown,
): { terminal: true; reasonCode: string } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/launch spec is incompatible/i.test(message)) {
    return { terminal: true, reasonCode: "launch_spec_incompatible" };
  }
  if (/ACP initialize failed:\s*ACP connection closed/i.test(message)) {
    return { terminal: true, reasonCode: "initialize_closed" };
  }
  if (/ACP request timed out:\s*initialize/i.test(message)) {
    return { terminal: true, reasonCode: "initialize_timeout" };
  }
  if (/runtime process exited/i.test(message)) {
    return { terminal: true, reasonCode: "runtime_process_exited" };
  }
  return undefined;
}

function redactLaunchSpecKey(key: string | undefined): string | undefined {
  return key?.replace(/\|hermes-profile:.+$/, "|hermes-profile:<hermes-profile>");
}

function redactLaunchSpecSummary(
  summary: BridgeLaunchSpecSummary | undefined,
): BridgeLaunchSpecSummary | undefined {
  return summary
    ? removeUndefinedValues({
        ...summary,
        hermesProfileName: summary.hermesProfileName
          ? "<hermes-profile>"
          : undefined,
      }) as BridgeLaunchSpecSummary
    : undefined;
}

function buildEmptyFinalResponseDiagnostic(
  item: BridgeSessionQueueItem,
  result: {
    finalText?: unknown;
    events?: NormalizedBridgeEvent[];
    rawResult: unknown;
    stopReason?: string;
  },
): {
  event: NormalizedBridgeEvent;
  result: Record<string, unknown>;
} {
  const reasonCode = "empty_final_response";
  const message = "ACP runtime completed without visible assistant output.";
  const finalText = safeEmptyFinalTextDiagnostics(result.finalText);
  const streamSummary = safeEmptyFinalStreamSummary(result.events);
  return {
    event: {
      externalEventId: `${item.id}:empty_final_response`,
      source: "bridge",
      eventType: "bridge_error",
      payload: {
        finalText,
        queueId: item.id,
        reasonCode,
        stopReason: result.stopReason,
        streamSummary,
      },
      part: {
        type: "error",
        text: message,
        json: {
          finalText,
          reasonCode,
          stopReason: result.stopReason,
          streamSummary,
        },
        status: "error",
      },
    },
    result: {
      ok: false,
      error: reasonCode,
      message,
      reasonCode: "no_visible_assistant_output",
      terminal: true,
      finalText,
      stopReason: result.stopReason,
      streamSummary,
      result: result.rawResult,
    },
  };
}

function safeEmptyFinalTextDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return removeUndefinedValues({
    answerChunkCount: finiteNumber(record.answerChunkCount),
    answerTextLength: finiteNumber(record.answerTextLength),
    reason: typeof record.reason === "string" ? record.reason : undefined,
    runtimeId:
      typeof record.runtimeId === "string" ? record.runtimeId : undefined,
    thoughtChunkCount: finiteNumber(record.thoughtChunkCount),
    toolEventCount: finiteNumber(record.toolEventCount),
    trustedFinalResultText:
      typeof record.trustedFinalResultText === "boolean"
        ? record.trustedFinalResultText
        : undefined,
    withheld:
      typeof record.withheld === "boolean" ? record.withheld : undefined,
  });
}

function safeEmptyFinalStreamSummary(
  events: NormalizedBridgeEvent[] | undefined,
): unknown {
  if (!events) {
    return undefined;
  }
  const eventTypeCounts: Record<string, number> = {};
  const unknownEvents: Array<Record<string, unknown>> = [];
  for (const event of events) {
    eventTypeCounts[event.eventType] =
      (eventTypeCounts[event.eventType] ?? 0) + 1;
    if (event.eventType === "unknown" && unknownEvents.length < 10) {
      unknownEvents.push(summarizeUnknownBridgeEvent(event));
    }
  }
  return removeUndefinedValues({
    eventTypeCounts,
    totalEventCount: events.length,
    unknownEvents: unknownEvents.length > 0 ? unknownEvents : undefined,
  });
}

function summarizeUnknownBridgeEvent(
  event: NormalizedBridgeEvent,
): Record<string, unknown> {
  const payload = isRecord(event.payload) ? event.payload : {};
  const params = isRecord(payload.params) ? payload.params : {};
  const update = isRecord(params.update) ? params.update : {};
  const meta = isRecord(update._meta) ? update._meta : {};
  const codexMeta = isRecord(meta.codex) ? meta.codex : {};
  const threadStatus = isRecord(codexMeta.threadStatus)
    ? codexMeta.threadStatus
    : {};
  return removeUndefinedValues({
    method: readString(payload.method),
    sessionUpdate:
      readString(update.sessionUpdate) ?? readString(params.sessionUpdate),
    codexThreadStatus: readString(threadStatus.type),
    hasTextLikeField: hasTextLikeField(update),
  });
}

function hasTextLikeField(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const content = isRecord(value.content) ? value.content : undefined;
  return (
    readString(value.text) !== undefined ||
    readString(value.delta) !== undefined ||
    readString(value.message) !== undefined ||
    readString(value.markdown) !== undefined ||
    readString(value.output) !== undefined ||
    readString(content?.text) !== undefined
  );
}

type CoalescedBridgeStreamChunkEvent = {
  chunkCount: number;
  event: BridgeEventInput;
  eventType: string;
  firstCreatedAt?: number;
  firstSequence: number;
  lastSequence: number;
  lastUpdatedAt?: number;
  text: string;
  textLength: number;
};

function isStreamChunkBridgeEvent(event: BridgeEventInput): boolean {
  return (
    event.eventType === "agent_thought_chunk" ||
    event.eventType === "agent_message_chunk"
  );
}

function createCoalescedBridgeStreamChunkEvent(
  event: BridgeEventInput,
): CoalescedBridgeStreamChunkEvent {
  const text = readBridgeEventText(event);
  return {
    chunkCount: 1,
    event,
    eventType: event.eventType,
    firstCreatedAt: event.createdAt,
    firstSequence: event.sequence,
    lastSequence: event.sequence,
    lastUpdatedAt: event.createdAt,
    text,
    textLength: text.length,
  };
}

function appendCoalescedBridgeStreamChunkEvent(
  pending: CoalescedBridgeStreamChunkEvent,
  event: BridgeEventInput,
): void {
  const text = readBridgeEventText(event);
  pending.chunkCount += 1;
  pending.lastSequence = event.sequence;
  pending.lastUpdatedAt = event.createdAt;
  pending.text += text;
  pending.textLength += text.length;
}

function finalizeCoalescedBridgeStreamChunkEvent(
  pending: CoalescedBridgeStreamChunkEvent,
): BridgeEventInput {
  const metadata =
    pending.chunkCount > 1
      ? removeUndefinedValues({
          chunkCount: pending.chunkCount,
          firstCreatedAt: pending.firstCreatedAt,
          firstSequence: pending.firstSequence,
          lastSequence: pending.lastSequence,
          lastUpdatedAt: pending.lastUpdatedAt,
        })
      : {};
  return {
    ...pending.event,
    normalizedPayload: mergeBridgeEventTextPayload(
      pending.event.normalizedPayload,
      pending.text,
      metadata,
    ),
    rawPayload: mergeBridgeEventTextPayload(
      pending.event.rawPayload,
      pending.text,
      pending.chunkCount > 1 ? { ...metadata, coalesced: true } : metadata,
    ),
    sequence: pending.firstSequence,
    createdAt: pending.firstCreatedAt,
  };
}

function mergeBridgeEventTextPayload(
  payload: unknown,
  text: string,
  metadata: Record<string, unknown>,
): unknown {
  if (!isRecord(payload)) {
    return removeUndefinedValues({ ...metadata, text });
  }
  const content = isRecord(payload.content) ? payload.content : undefined;
  return removeUndefinedValues({
    ...payload,
    ...metadata,
    ...(typeof payload.text === "string" ? { text } : {}),
    ...(typeof payload.delta === "string" ? { delta: text } : {}),
    ...(typeof payload.message === "string" ? { message: text } : {}),
    ...(typeof payload.markdown === "string" ? { markdown: text } : {}),
    ...(typeof payload.output === "string" ? { output: text } : {}),
    ...(content && typeof content.text === "string"
      ? { content: { ...content, text } }
      : {}),
  });
}

function readBridgeEventText(event: BridgeEventInput): string {
  return (
    readPayloadText(event.normalizedPayload) ??
    readPayloadText(event.rawPayload) ??
    ""
  );
}

function readPayloadText(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const content = isRecord(payload.content) ? payload.content : undefined;
  return (
    readString(payload.text) ??
    readString(payload.delta) ??
    readString(payload.message) ??
    readString(payload.markdown) ??
    readString(payload.output) ??
    readString(content?.text)
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function splitCommand(command: string): string[] {
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

function toBridgeEvent(
  record: BridgeSessionRecord,
  event: NormalizedBridgeEvent,
  sequence: number,
): BridgeEventInput {
  const shouldRedactPayload =
    event.eventType === "bridge_error" || event.part?.type === "error";
  const rawPayload = withRuntimeEventMetadata(
    event.payload,
    record.runtimeProfile,
  );
  return {
    threadId: record.threadId,
    agentSessionId: record.providerSessionKey,
    eventType: event.eventType,
    sequence,
    rawPayload: shouldRedactPayload ? redactLogValue(rawPayload) : rawPayload,
    normalizedPayload: shouldRedactPayload
      ? redactLogValue(event.part)
      : event.part,
    source: event.source,
    externalEventId: event.externalEventId,
    externalRequestId: event.externalRequestId,
    createdAt: Date.now(),
  };
}

function withRuntimeEventMetadata(
  payload: unknown,
  runtimeProfile: BridgeRuntimeProfile | undefined,
): unknown {
  if (!runtimeProfile || !isRecord(payload)) {
    return payload;
  }
  return removeUndefinedValues({
    ...payload,
    runtimeProfileId: runtimeProfile.id,
    runtimeKind: runtimeProfile.kind,
    runtimeLabel: runtimeProfile.label,
    runtimeCommand: summarizeRuntimeCommand(runtimeProfile.command),
  });
}

function mergeRecordMetadata(
  value: unknown,
  metadata: Record<string, unknown>,
): unknown {
  return isRecord(value)
    ? removeUndefinedValues({ ...value, ...metadata })
    : value;
}

function toolEventPolicyMetadata(
  session: BridgeSessionRecord,
  policy: BridgeToolCallTimeoutResolution,
): Record<string, unknown> {
  return removeUndefinedValues({
    runtimeProfileId: session.runtimeProfile?.id,
    toolClass: policy.toolClass,
    toolPolicyId: policy.policyId,
    toolTimeoutMs: policy.timeoutMs,
  });
}

function activeToolPolicyMetadata(
  tool: ActiveToolCall,
): Record<string, unknown> {
  return removeUndefinedValues({
    runtimeProfileId: tool.runtimeProfileId,
    toolClass: tool.toolClass,
    toolPolicyId: tool.toolPolicyId,
    toolTimeoutMs: tool.toolTimeoutMs,
  });
}

function shouldKeepNativeToolPending(
  tool: ActiveToolCall,
  trigger: ToolCallReconciliationTrigger,
): boolean {
  return (
    trigger !== "turn_completed" &&
    (tool.toolClass === "subagent" || tool.toolClass === "long_running")
  );
}

function shouldSettleNativeSubagentAsUnjoined(
  tool: ActiveToolCall,
  trigger: ToolCallReconciliationTrigger,
): boolean {
  return trigger === "turn_completed" && tool.toolClass === "subagent";
}

function summarizeRuntimeCommand(command: string[] | undefined):
  | {
      executable?: string;
      package?: string;
    }
  | undefined {
  if (!command || command.length === 0) {
    return undefined;
  }
  return removeUndefinedValues({
    executable: command[0],
    package: command.find(
      (part) => part.startsWith("@") || part.includes("codex-acp"),
    ),
  });
}

function normalizeType(item: BridgeSessionQueueItem): string {
  return item.type ?? item.kind ?? "unknown";
}

function attachmentPartsFromPromptEvents(events: NormalizedBridgeEvent[]) {
  return events.flatMap((event, index) => {
    if (event.part?.type !== "attachment" || !isRecord(event.part.json)) {
      return [];
    }
    return [
      {
        externalPartId: `${event.externalEventId}:attachment`,
        order: index + 1,
        payload: event.part.json,
        type: "attachment",
      },
    ];
  });
}

function mergePendingAttachmentUploadEvents(
  pendingEvents: NormalizedBridgeEvent[],
  resultEvents: NormalizedBridgeEvent[],
): NormalizedBridgeEvent[] {
  if (pendingEvents.length === 0) {
    return resultEvents;
  }
  const seen = new Set<string>();
  const merged: NormalizedBridgeEvent[] = [];
  for (const event of [...pendingEvents, ...resultEvents]) {
    const key =
      event.externalEventId ||
      `${event.sessionId ?? "session"}:${event.providerSequence ?? merged.length}:${event.eventType}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

const MEDIA_ATTACHMENT_LINE_PATTERN = /^\s*MEDIA:\s*(\S.*?)\s*$/;

function stripMediaAttachmentReferencesFromStreamEvent(
  event: NormalizedBridgeEvent,
  cwd: string | undefined,
): NormalizedBridgeEvent | undefined {
  if (event.eventType !== "agent_message_chunk" || event.part?.type !== "text") {
    return event;
  }
  const text = event.part.text;
  if (!text?.includes("MEDIA:")) {
    return event;
  }
  const mediaExtraction = extractMediaAttachmentReferences(text, cwd);
  if (mediaExtraction.attachments.length === 0) {
    return event;
  }
  if (!mediaExtraction.text) {
    return undefined;
  }
  return {
    ...event,
    part: {
      ...event.part,
      text: mediaExtraction.text,
    },
    payload: mergeBridgeEventTextPayload(event.payload, mediaExtraction.text, {}),
  };
}

function extractMediaAttachmentReferences(
  text: string,
  cwd: string | undefined,
): { attachments: BridgeAttachmentUploadCandidate[]; text: string } {
  const attachments: BridgeAttachmentUploadCandidate[] = [];
  const lines = text.split(/\r?\n/);
  const keptLines: string[] = [];

  for (const line of lines) {
    const match = MEDIA_ATTACHMENT_LINE_PATTERN.exec(line);
    if (!match?.[1]) {
      keptLines.push(line);
      continue;
    }
    const rawPath = match[1].trim();
    const mediaType = mediaTypeFromImagePath(rawPath);
    if (!mediaType || !isScopedLocalAttachmentPath(rawPath, cwd)) {
      keptLines.push(line);
      continue;
    }
    attachments.push({
      filename: basename(rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath),
      kind: "local_file",
      mediaType,
      path: rawPath,
    });
  }

  return { attachments, text: keptLines.join("\n").trim() };
}

function mediaTypeFromImagePath(path: string): string | undefined {
  const cleanPath = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (cleanPath.endsWith(".png")) return "image/png";
  if (cleanPath.endsWith(".jpg") || cleanPath.endsWith(".jpeg")) return "image/jpeg";
  if (cleanPath.endsWith(".gif")) return "image/gif";
  if (cleanPath.endsWith(".webp")) return "image/webp";
  if (cleanPath.endsWith(".avif")) return "image/avif";
  return undefined;
}

function isScopedLocalAttachmentPath(
  path: string,
  cwd: string | undefined,
): boolean {
  try {
    resolveLocalAttachmentPath(path, cwd);
    return true;
  } catch {
    return false;
  }
}

async function buildAgentAttachmentUploadInput(
  candidate: BridgeAttachmentUploadCandidate,
  threadId: string,
  agentSessionId: string | undefined,
  cwd: string | undefined,
): Promise<AgentAttachmentUploadInput> {
  if (candidate.kind === "base64") {
    return {
      agentSessionId,
      bytes: Buffer.from(candidate.dataBase64, "base64"),
      filename: candidate.filename,
      mediaType: candidate.mediaType,
      threadId,
    };
  }

  const path = resolveLocalAttachmentPath(candidate.path, cwd);
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error("agent attachment path is not a regular file");
  }
  return {
    agentSessionId,
    bytes: await readFile(path),
    filename: candidate.filename ?? basename(path),
    mediaType: candidate.mediaType,
    threadId,
  };
}

function resolveLocalAttachmentPath(
  path: string,
  cwd: string | undefined,
): string {
  const normalizedPath = path.startsWith("file://")
    ? fileURLToPath(path)
    : path;
  if (!cwd) {
    throw new Error(
      "agent attachment local paths require a scoped working directory",
    );
  }
  const base = resolve(cwd);
  const resolved = isAbsolute(normalizedPath)
    ? resolve(normalizedPath)
    : resolve(base, normalizedPath);
  const rel = relative(base, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolved;
  }
  throw new Error(
    "agent attachment path is outside the scoped working directory",
  );
}

function normalizeUploadedAgentAttachment(
  value: Record<string, unknown>,
): BridgeQueueAttachment {
  return removeUndefinedValues({
    access: isRecord(value.access) ? value.access : undefined,
    bucket: typeof value.bucket === "string" ? value.bucket : undefined,
    checksumSha256:
      typeof value.checksumSha256 === "string"
        ? value.checksumSha256
        : undefined,
    contentHash:
      typeof value.contentHash === "string" ? value.contentHash : undefined,
    createdAt:
      typeof value.createdAt === "string" ? value.createdAt : undefined,
    createdBy:
      typeof value.createdBy === "string" ? value.createdBy : undefined,
    filename:
      typeof value.filename === "string" ? value.filename : "Attachment",
    key:
      typeof value.key === "string"
        ? value.key
        : typeof value.objectKey === "string"
          ? value.objectKey
          : undefined,
    mediaType:
      typeof value.mediaType === "string" ? value.mediaType : undefined,
    objectKey:
      typeof value.objectKey === "string"
        ? value.objectKey
        : typeof value.key === "string"
          ? value.key
          : undefined,
    sizeBytes:
      typeof value.sizeBytes === "number" ? value.sizeBytes : undefined,
    status: typeof value.status === "string" ? value.status : "available",
    storageBackend:
      typeof value.storageBackend === "string"
        ? value.storageBackend
        : undefined,
    threadId: typeof value.threadId === "string" ? value.threadId : undefined,
    type: typeof value.type === "string" ? value.type : "file",
    url: typeof value.url === "string" ? value.url : undefined,
  }) as BridgeQueueAttachment;
}

function summarizeResolvedAgentAttachment(
  file: BridgeQueueAttachment,
): Record<string, unknown> {
  return removeUndefinedValues({
    type: "agent_attachment_uploaded",
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    storageBackend: file.storageBackend,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeUndefinedValues(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function boundTerminalizationMetadata(
  reasonCode: string,
  metadata: BridgeTerminalizationMetadata | undefined,
): BoundedBridgeTerminalizationMetadata {
  const output: BoundedBridgeTerminalizationMetadata = { reasonCode };
  const addString = (
    key:
      | "failureClass"
      | "toolCallId"
      | "toolClass"
      | "toolName"
      | "toolPolicyId",
    value: string | undefined,
  ) => {
    const normalized = boundTerminalizationMetadataText(value);
    if (normalized) {
      output[key] = normalized;
    }
  };
  const addNumber = (
    key: "ageMs" | "timeoutMs",
    value: number | undefined,
  ) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      output[key] = value;
    }
  };

  addString("failureClass", metadata?.failureClass);
  addString("toolCallId", metadata?.toolCallId);
  addString("toolName", metadata?.toolName);
  addString("toolClass", metadata?.toolClass);
  addString("toolPolicyId", metadata?.toolPolicyId);
  addNumber("timeoutMs", metadata?.timeoutMs);
  addNumber("ageMs", metadata?.ageMs);
  return output;
}

function boundTerminalizationMetadataText(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_TERMINALIZATION_METADATA_TEXT_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_TERMINALIZATION_METADATA_TEXT_LENGTH);
}

function displayNameForSessionStart(session: BridgeSessionRecord): string {
  const agentName = normalizeAgentName(session.agentName);
  if (agentName) {
    return agentName;
  }
  return "Agent";
}

function normalizeAgentName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isApprovalResponseType(type: string): boolean {
  return (
    type === "approval-response" ||
    type === "permission-response" ||
    type === "choice-response" ||
    type === "input-response"
  );
}

function isTerminalQueueItemError(type: string, message: string): boolean {
  if (type === "prompt") {
    return isTerminalPromptError(message);
  }
  if (!isApprovalResponseType(type)) {
    return false;
  }
  return (
    message.includes("does not match an active ACP session") ||
    message.includes("did not match a pending ACP permission request")
  );
}

function isTerminalPromptError(message: string): boolean {
  return (
    message.includes("ACP request timed out: session/prompt") ||
    message.includes("ACP live session lost: provider_silent_timeout") ||
    message.includes("ACP live session lost: runtime_process_exited") ||
    message.includes("ACP live session lost: tool_result_timeout") ||
    /\bprovider_login_failed(?:\s+\(code\s+-?\d+\))?\b/i.test(message)
  );
}

function normalizeSystemPrompt(
  systemPrompt: string | undefined,
): string | undefined {
  const normalized = systemPrompt?.trim();
  return normalized ? normalized : undefined;
}

function normalizeBridgeAttachments(
  attachments: BridgeQueueAttachment[] | undefined,
): BridgeQueueAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((attachment) => {
    const url = attachment.access?.url ?? attachment.url;
    return typeof url === "string" && url.trim().length > 0;
  });
}

function attachmentReferenceTextForPrompt(
  attachments: BridgeQueueAttachment[],
): string | undefined {
  if (attachments.length === 0) {
    return undefined;
  }
  const lines = attachments.map((attachment, index) => {
    const label = attachment.filename?.trim() || `Attachment ${index + 1}`;
    const mediaType =
      attachment.mediaType?.trim() || "application/octet-stream";
    const size =
      typeof attachment.sizeBytes === "number"
        ? `, ${attachment.sizeBytes} bytes`
        : "";
    const checksum = attachment.checksumSha256
      ? `, sha256=${attachment.checksumSha256}`
      : "";
    const url = attachment.access?.url ?? attachment.url;
    return `- ${label} (${mediaType}${size}${checksum}): ${url}`;
  });
  return `Attached files available to this ACP run:\n${lines.join("\n")}`;
}

function summarizeAttachmentMediaTypes(attachments: BridgeQueueAttachment[]) {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const mediaType =
      attachment.mediaType?.trim() || "application/octet-stream";
    counts.set(mediaType, (counts.get(mediaType) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([mediaType, count]) => ({
    count,
    mediaType,
  }));
}

function normalizeThreadHistory(
  threadHistory: string | undefined,
): string | undefined {
  const normalized = threadHistory?.trim();
  return normalized ? normalized : undefined;
}

function providerSessionKeyForItem(
  item: BridgeSessionQueueItem,
): string | undefined {
  return item.agentSessionId ?? item.sessionId ?? item.threadId;
}

function hasExplicitRuntimeScope(item: BridgeSessionQueueItem): boolean {
  return Boolean(item.bridgeProfileId ?? item.hermesProfileName);
}

function isDurableContinuationChoiceResponse(
  item: BridgeSessionQueueItem,
): boolean {
  return (
    normalizeType(item) === "choice-response" &&
    item.resumePolicy === "durable_continuation"
  );
}

function applyRuntimeConfigFallback(
  item: BridgeSessionQueueItem,
  profile: BridgeRuntimeProfile | undefined,
): RuntimeConfigApplicationResult | undefined {
  const requested = requestedRuntimeConfigForItem(item, profile);
  if (!requested || !profile?.runtimeConfigOptions) {
    return undefined;
  }
  return resolveRuntimeConfigApplication({
    requested,
    supportedOptions: profile.runtimeConfigOptions,
  });
}

function requestedRuntimeConfigForItem(
  item: BridgeSessionQueueItem,
  profile: BridgeRuntimeProfile | undefined,
): Record<string, string | undefined> | undefined {
  const requested: Record<string, string | undefined> = {
    ...(item.runtimeConfig ?? {}),
  };
  const modelId = normalizeRuntimeOptionValue(item.runtimeOptions?.modelId);
  if (modelId) {
    requested.model = modelId;
  }
  const thinkingLevel = normalizeRuntimeOptionValue(
    item.runtimeOptions?.thinkingLevel,
  );
  const thinkingConfigId = thinkingLevel
    ? findRuntimeConfigOptionId(profile?.runtimeConfigOptions, [
        "thoughtLevel",
        "thought_level",
        "thinkingLevel",
        "reasoningLevel",
      ])
    : undefined;
  if (thinkingConfigId) {
    requested[thinkingConfigId] = thinkingLevel;
  }
  return Object.keys(requested).length > 0 ? requested : undefined;
}

function findRuntimeConfigOptionId(
  supportedOptions: Record<string, string[]> | undefined,
  candidates: string[],
): string | undefined {
  if (!supportedOptions) {
    return undefined;
  }
  return candidates.find(
    (candidate) => supportedOptions[candidate] !== undefined,
  );
}

function normalizeRuntimeOptionValue(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function encodeSessionKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function readToolLogFields(value: unknown): {
  toolCallId?: string;
  toolName: string;
} {
  const records = toolFieldRecords(value);
  return {
    toolCallId: readFirstToolString(records, [
      "toolCallId",
      "tool_call_id",
      "id",
    ]),
    toolName:
      readFirstToolString(records, ["toolName", "name", "tool", "title"]) ??
      "unknown",
  };
}

function readToolState(value: unknown): string | undefined {
  const records = toolFieldRecords(value);
  return readFirstToolString(records, ["state", "status"]);
}

function toolFieldRecords(value: unknown): Record<string, unknown>[] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!record) {
    return [];
  }
  const records = [record];
  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const itemRecord = asToolRecord(item);
      if (itemRecord) {
        records.push(itemRecord);
        const nestedContent = asToolRecord(itemRecord.content);
        if (nestedContent) {
          records.push(nestedContent);
        }
      }
    }
    return records;
  }
  const contentRecord = asToolRecord(content);
  if (contentRecord) {
    records.push(contentRecord);
  }
  return records;
}

function asToolRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFirstToolString(
  records: Record<string, unknown>[],
  keys: string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function createHashReader(
  value: string | (() => string | undefined) | undefined,
): () => string | undefined {
  if (typeof value === "function") {
    return value;
  }
  return () => value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function elapsedSince(startMs: number | undefined, nowMs: number): number | undefined {
  return startMs === undefined ? undefined : Math.max(0, nowMs - startMs);
}

function queueItemOnceKey(item: BridgeSessionQueueItem): string {
  return `${item.organizationId ?? "unknown-org"}\u0000${item.id}`;
}
