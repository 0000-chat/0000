#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"

import { BridgeCloudHttpError, ConvexBridgeCloudClient } from "./acp-bridge/convex-http"
import { ConvexBridgeHostAdapter } from "./acp-bridge/host-adapter"
import { openBridgeSupervisor, type BridgeSupervisor } from "./acp-bridge/bridge-supervisor"
import {
  createWorkerBridgeLogger,
  type FlushableBridgeLogger,
  redactLogValue,
} from "./acp-bridge/bridge-log"
import {
  DEFAULT_ACP_REQUEST_TIMEOUT_MS,
  type HermesAcpMcpServer,
} from "./acp-bridge/acp-session"
import { BridgeSessionManager, type BridgeSessionQueueItem } from "./acp-bridge/session-manager"
import { discoverRuntimeProfiles as discoverBridgeRuntimeProfiles } from "./acp-bridge/runtime-discovery"
import {
  defaultAgentCommandForEnvironment,
  defaultProposedAgentName,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
  inferRuntimeId,
  inferRuntimeLabel,
} from "./acp-bridge/runtime-defaults"
import type { BridgeRuntimeProfile } from "./acp-bridge/runtime-profiles"
import { shouldRestartBridgeForDevHotReload } from "./acp-bridge/dev-hot-reload"
import { buildRestartCommandArgs } from "./bridge-updater"
export {
  defaultAgentCommandForEnvironment,
  defaultProposedAgentName,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
  inferRuntimeId,
  inferRuntimeLabel,
} from "./acp-bridge/runtime-defaults"

const DEFAULT_CONFIG_PATH = join(homedir(), ".0000", "bridge.json")
const DEFAULT_STATUS_PATH = join(homedir(), ".0000", "bridge-status.json")
const DEFAULT_JOURNAL_DIR = join(homedir(), ".0000", "bridge-journals")
const DEFAULT_PAIR_PATH = "/api/agent-bridge/pair"
const DEFAULT_CLAIM_PATH = "/api/agent-bridge/queue/claim"
const DEFAULT_CLEANUP_STALE_PATH = "/api/agent-bridge/queue/cleanup-stale"
const DEFAULT_RESULT_PATH = "/api/agent-bridge/queue/result"
const DEFAULT_HEARTBEAT_PATH = "/api/agent-bridge/heartbeat"
const DEFAULT_POLL_MS = 2000
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_MAX_IN_FLIGHT_COMMANDS = 2
const DEFAULT_AGENT_COMMAND = "hermes acp"
const DEFAULT_ACP_RESUME_ENABLED = false
const DEFAULT_ACP_IDLE_TTL_MS = 0
const DEFAULT_ALLOW_REMOTE_CWD = false
const DEFAULT_AGENT_CONNECTION_REGISTER_PATH = "/api/agent-connections/register"
const DEFAULT_AGENT_SKILL_PATH = join(homedir(), ".claude", "skills", "0000", "SKILL.md")
export const BRIDGE_VERSION = "0.1.7"
const BRIDGE_LOCAL_STATE_MODE = 0o600

export type BridgeCommandName = "connect" | "pair" | "start" | "status" | "help"

type FlagValue = string | true | string[]
type FlagMap = Record<string, FlagValue>

export type ParsedBridgeArgs = {
  command: BridgeCommandName
  positionals: string[]
  flags: FlagMap
}

export type BridgeRegistration = {
  deviceId: string
  bridgeToken: string
  appUrl: string
  deviceName: string
  pairedAt: string
  bridgeApiUrl?: string
  logIngestUrl?: string
}

export type BridgeConfig = BridgeRegistration

export type MultiBridgeConfig = {
  version: 2
  registrations: BridgeRegistration[]
}

type BridgeConfigFile = BridgeConfig | MultiBridgeConfig

type PairResponse = {
  deviceId?: unknown
  bridgeToken?: unknown
  token?: unknown
  bridgeApiUrl?: unknown
  endpoint?: unknown
  logIngestUrl?: unknown
  logUrl?: unknown
}

type QueueClaimResponse = {
  command?: unknown
  commands?: unknown
}

type QueueCleanupResponse = {
  inspected?: unknown
  released?: unknown
}

type ProposedAgentProfile = {
  agentCommand: string
  bridgeVersion: string
  defaultCwd: string
  hostLabel: string
  installMode: string
  proposedAgentName: string
  runtimeId: string
  runtimeLabel: string
  skillInstallPath?: string
}

type BridgeQueueCommand = BridgeSessionQueueItem

type BridgeWakeSignal = {
  wait(timeoutMs: number): Promise<void>
  close(): Promise<void>
}

export type BridgeStatus = {
  deviceId?: string
  appUrl?: string
  connected: boolean
  lifecycle?: BridgeLifecycleStatus
  updateState?: BridgeUpdateState
  devHotReload?: BridgeDevHotReloadStatus
  pendingControlCommand?: BridgeControlCommandState
  lastStartedAt?: string
  lastHeartbeatAt?: string
  lastHeartbeatSignature?: string
  lastPollAt?: string
  maxInFlight?: number
  acpResumeEnabled?: boolean
  acpIdleTtlMs?: number
  hermesProfiles?: HermesProfileSummary[]
  runtimeProfiles?: BridgeRuntimeProfile[]
  lastHermesProfileRefreshAt?: string
  lastRuntimeProfileRefreshAt?: string
  activeSessions: string[]
  activeQueueItemIds?: string[]
  inFlightCommands?: Array<{
    id: string
    type?: string
    threadId?: string
    sessionId?: string
    agentSessionId?: string
    startedAt: string
  }>
  sessionQueues?: Array<{
    sessionKey: string
    threadId: string
    runtimeProfileId?: string
    runtimeLabel?: string
    runtimeKind?: string
    hermesProfileName?: string
    queueDepth: number
    runningQueueItemId?: string
    lastUsedAt?: number
  }>
  setupSummary?: Record<string, unknown>
  recentErrors: string[]
  registrations?: BridgeRegistrationStatus[]
  localJournal?: {
    status: "healthy" | "hard_failed"
    reasonCode?: string
    message?: string
  }
}

export type BridgeRegistrationStatus = {
  deviceId: string
  appUrl: string
  deviceName?: string
  connected: boolean
  lifecycle?: BridgeLifecycleStatus
  updateState?: BridgeUpdateState
  devHotReload?: BridgeDevHotReloadStatus
  pendingControlCommand?: BridgeControlCommandState
  lastStartedAt?: string
  lastHeartbeatAt?: string
  lastPollAt?: string
  maxInFlight?: number
  activeSessions: string[]
  activeQueueItemIds?: string[]
  inFlightCommands?: BridgeStatus["inFlightCommands"]
  sessionQueues?: BridgeStatus["sessionQueues"]
  recentErrors: string[]
}

export type BridgeLifecycleStatus =
  | "running"
  | "draining"
  | "restartPending"
  | "updating"
  | "restarting"
  | "error"

export type BridgeUpdateStatus =
  | "upToDate"
  | "available"
  | "waitingForIdle"
  | "installing"
  | "restarting"
  | "updated"
  | "failed"
  | "unsupported"

export type BridgeUpdateState = {
  status: BridgeUpdateStatus
  available: boolean
  channel: string
  currentVersion: string
  latestVersion?: string
  lastCheckedAt: number
  lastUpdatedAt?: number
  required: boolean
  targetVersion?: string
  requestedAt?: number
  startedAt?: number
  completedAt?: number
  error?: string
}

export type BridgeDevHotReloadStatus = {
  enabled: boolean
  lastRestartReason?: string
  pendingRestart: boolean
}

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
  }
}

export type BridgeControlCommandName = "updateWhenIdle" | "restartWhenIdle"

export type BridgeControlCommandState = {
  command: BridgeControlCommandName
  requestedAt?: number
}

export type HermesProfileSummary = {
  alias?: string
  description?: string
  gateway?: string
  model?: string
  name: string
}

type AgentToolsMcpServerInput = {
  agentSessionId: string
  appUrl: string
  agentToolsUrl?: string
  bridgeToken: string
  deviceId: string
  threadId?: string
}

type InFlightCommandMetadata = {
  id: string
  type?: string
  threadId?: string
  sessionId?: string
  agentSessionId?: string
  startedAt: string
}

type BridgeLoopManager = Pick<BridgeSessionManager, "getStatus" | "handleQueueItem">

export type BridgeLoopIterationInput = {
  config: BridgeConfig
  agentCommand?: string
  runtimeCommands?: string[][]
  status: BridgeStatus
  maxInFlight: number
  manager: BridgeLoopManager
  inFlightCommands: Map<string, Promise<void>>
  inFlightCommandMetadata: Map<string, InFlightCommandMetadata>
  lastStaleCleanupAt: number
  setLastStaleCleanupAt: (value: number) => void
  log: FlushableBridgeLogger
  recordLoopError: (error: unknown) => Promise<void>
  statusPath: string
  now?: () => number
  heartbeatIntervalMs?: number
  sendHeartbeat?: typeof sendHeartbeat
  discoverHermesProfiles?: typeof discoverHermesProfiles
  discoverRuntimeProfiles?: typeof discoverBridgeRuntimeProfiles
  cleanupStaleClaims?: typeof cleanupStaleClaims
  claimCommands?: typeof claimCommands
  canClaimWork?: () => boolean
  writeStatus?: typeof writeStatus
  launchUpdater?: typeof launchBridgeUpdater
}

export type BridgeLoopIterationResult = {
  restartRequested: boolean
}

export type BridgeUpdaterLaunchInput = {
  currentVersion: string
  requestedAt?: number
  restartCommand: string[]
  statusPath: string
}

export function normalizeBridgeConfigFile(raw: unknown): MultiBridgeConfig {
  const record = recordFromUnknown(raw)
  if (!record) {
    throw new Error("Bridge config must be an object")
  }
  if (record.version === 2) {
    const registrations = Array.isArray(record.registrations)
      ? record.registrations.map(normalizeBridgeRegistration)
      : []
    if (registrations.length === 0) {
      throw new Error("Bridge config has no registrations")
    }
    return { version: 2, registrations }
  }
  return { version: 2, registrations: [normalizeBridgeRegistration(record)] }
}

export function upsertBridgeRegistration(
  config: MultiBridgeConfig,
  registration: BridgeRegistration,
): MultiBridgeConfig {
  const registrations = [...config.registrations]
  const existingIndex = registrations.findIndex((entry) => entry.deviceId === registration.deviceId)
  if (existingIndex >= 0) {
    registrations[existingIndex] = registration
  } else {
    registrations.push(registration)
  }
  return { version: 2, registrations }
}

function normalizeBridgeRegistration(raw: unknown): BridgeRegistration {
  const record = recordFromUnknown(raw)
  if (!record) {
    throw new Error("Bridge registration must be an object")
  }
  const deviceId = readString(record.deviceId, "deviceId")
  const bridgeToken = readString(record.bridgeToken, "bridgeToken")
  const appUrl = readString(record.appUrl, "appUrl")
  const deviceName = readString(record.deviceName, "deviceName")
  const pairedAt = readString(record.pairedAt, "pairedAt")
  return compact({
    appUrl,
    bridgeApiUrl: stringFromUnknown(record.bridgeApiUrl),
    bridgeToken,
    deviceId,
    deviceName,
    logIngestUrl: stringFromUnknown(record.logIngestUrl),
    pairedAt,
  })
}

export function parseBridgeArgs(argv: string[]): ParsedBridgeArgs {
  const [rawCommand, ...rest] = argv
  const command = normalizeCommand(rawCommand)
  const flags: FlagMap = {}
  const positionals: string[] = []

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value.startsWith("--")) {
      const inlineValueIndex = value.indexOf("=")
      if (inlineValueIndex > 2) {
        addFlagValue(flags, value.slice(2, inlineValueIndex), value.slice(inlineValueIndex + 1))
        continue
      }

      const name = value.slice(2)
      const next = rest[index + 1]
      if (next && !next.startsWith("--")) {
        addFlagValue(flags, name, next)
        index += 1
      } else {
        addFlagValue(flags, name, true)
      }
      continue
    }

    positionals.push(value)
  }

  return { command, positionals, flags }
}

function addFlagValue(flags: FlagMap, name: string, value: FlagValue): void {
  const current = flags[name]
  if (current === undefined) {
    flags[name] = value
    return
  }
  if (Array.isArray(current)) {
    flags[name] = [...current, ...(Array.isArray(value) ? value : [value].filter(isStringFlag))]
    return
  }
  const currentValues = [current].filter(isStringFlag)
  const nextValues = Array.isArray(value) ? value : [value].filter(isStringFlag)
  flags[name] = [...currentValues, ...nextValues]
}

function isStringFlag(value: FlagValue): value is string {
  return typeof value === "string"
}

export function getFlag(flags: FlagMap, name: string, fallback?: string): string | undefined {
  const value = flags[name]
  if (typeof value === "string" && value.length > 0) {
    return value
  }
  return fallback
}

export function getRepeatedFlags(flags: FlagMap, name: string): string[] {
  const value = flags[name]
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  }
  return typeof value === "string" && value.length > 0 ? [value] : []
}

export function getConfigPath(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): string {
  return getFlag(flags, "config", env.ZERO_CHAT_BRIDGE_CONFIG) ?? DEFAULT_CONFIG_PATH
}

export function getAcpResumeEnabled(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): boolean {
  const rawValue = getFlag(flags, "acp-resume", env.ZERO_CHAT_BRIDGE_ACP_RESUME)
  if (rawValue === undefined) {
    return DEFAULT_ACP_RESUME_ENABLED
  }
  return rawValue === "1" || rawValue === "true" || rawValue === "yes"
}

export function getAcpIdleTtlMs(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = getFlag(flags, "acp-idle-ttl-ms", env.ZERO_CHAT_BRIDGE_ACP_IDLE_TTL_MS)
  if (rawValue === undefined) {
    return DEFAULT_ACP_IDLE_TTL_MS
  }
  const ttlMs = Number(rawValue)
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("acp-idle-ttl-ms must be a non-negative number of milliseconds")
  }
  return ttlMs
}

export function getRequestTimeoutMs(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = getFlag(flags, "request-timeout-ms", env.ZERO_CHAT_BRIDGE_REQUEST_TIMEOUT_MS)
  if (rawValue === undefined) {
    return DEFAULT_ACP_REQUEST_TIMEOUT_MS
  }

  const timeoutMs = Number(rawValue)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("request-timeout-ms must be a positive number of milliseconds")
  }
  return timeoutMs
}

export function getMaxInFlight(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = getFlag(flags, "max-in-flight", env.ZERO_CHAT_BRIDGE_MAX_IN_FLIGHT)
  if (rawValue === undefined) {
    return DEFAULT_MAX_IN_FLIGHT_COMMANDS
  }

  const maxInFlight = Number(rawValue)
  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
    throw new Error("max-in-flight must be a positive integer")
  }
  return Math.max(2, maxInFlight)
}

export function getAllowRemoteCwd(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): boolean {
  const rawValue = getFlag(flags, "allow-remote-cwd", env.ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD)
  if (rawValue === undefined) {
    return DEFAULT_ALLOW_REMOTE_CWD
  }
  return rawValue === "1" || rawValue === "true" || rawValue === "yes"
}

export function deriveConvexCloudUrl(appUrl: string): string | undefined {
  const url = new URL(appUrl)
  if (url.hostname.endsWith(".convex.cloud")) {
    url.pathname = ""
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  }
  if (!url.hostname.endsWith(".convex.site")) {
    return undefined
  }
  url.hostname = `${url.hostname.slice(0, -".convex.site".length)}.convex.cloud`
  url.pathname = ""
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

export function getConvexUrl(
  flags: FlagMap,
  config: Pick<BridgeConfig, "appUrl" | "bridgeApiUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    getFlag(flags, "convex-url", env.ZERO_CHAT_BRIDGE_CONVEX_URL) ??
    (config.bridgeApiUrl ? deriveConvexCloudUrl(config.bridgeApiUrl) : undefined) ??
    deriveConvexCloudUrl(config.appUrl)
  )
}

export function buildAgentToolsMcpServers(input: AgentToolsMcpServerInput): HermesAcpMcpServer[] {
  return [
    {
      args: ["scripts/agent-tools-mcp.ts"],
      command: "bun",
      env: [
        { name: "ZERO_CHAT_AGENT_SESSION_ID", value: input.agentSessionId },
        { name: "ZERO_CHAT_APP_URL", value: input.appUrl },
        ...(input.agentToolsUrl
          ? [{ name: "ZERO_CHAT_AGENT_TOOLS_URL", value: input.agentToolsUrl }]
          : []),
        { name: "ZERO_CHAT_BRIDGE_DEVICE_ID", value: input.deviceId },
        ...(input.threadId ? [{ name: "ZERO_CHAT_THREAD_ID", value: input.threadId }] : []),
        { name: "ZERO_CHAT_BRIDGE_TOKEN", value: input.bridgeToken },
      ],
      name: "0000-chat",
    },
  ]
}

export function describeStatus(status: BridgeStatus, configExists: boolean): string {
  const lines = ["0000 Chat ACP bridge status"]
  lines.push(`paired: ${configExists ? "yes" : "no"}`)
  if (status.registrations) {
    lines.push(`registered links: ${status.registrations.length}`)
    for (const registration of status.registrations) {
      lines.push(`  - ${registration.deviceName ?? registration.deviceId}`)
      lines.push(`    device: ${registration.deviceId}`)
      lines.push(`    app: ${registration.appUrl}`)
      lines.push(`    connected: ${registration.connected ? "yes" : "no"}`)
      lines.push(`    active sessions: ${registration.activeSessions.length}`)
      lines.push(`    in-flight commands: ${registration.inFlightCommands?.length ?? 0}`)
      if (registration.lastHeartbeatAt) {
        lines.push(`    last heartbeat: ${registration.lastHeartbeatAt}`)
      }
      if (registration.lastPollAt) {
        lines.push(`    last queue poll: ${registration.lastPollAt}`)
      }
      if (registration.recentErrors.length > 0) {
        lines.push("    recent errors:")
        for (const error of registration.recentErrors.slice(-3)) {
          lines.push(`      - ${redactForOutput(error)}`)
        }
      }
    }
  }
  if (status.deviceId) {
    lines.push(`device: ${status.deviceId}`)
  }
  if (status.appUrl) {
    lines.push(`app: ${status.appUrl}`)
  }
  lines.push(`connected: ${status.connected ? "yes" : "no"}`)
  lines.push(`max in-flight commands: ${status.maxInFlight ?? 0}`)
  lines.push(`in-flight commands: ${status.inFlightCommands?.length ?? 0}`)
  for (const command of status.inFlightCommands ?? []) {
    lines.push(
      `  - ${command.id}${command.type ? ` (${command.type})` : ""}${command.threadId ? ` thread=${command.threadId}` : ""}`,
    )
  }
  lines.push(`active sessions: ${status.activeSessions.length}`)
  for (const sessionId of status.activeSessions) {
    const sessionQueue = status.sessionQueues?.find((session) => session.sessionKey === sessionId)
    lines.push(`  - ${sessionId}${sessionQueue ? ` queueDepth=${sessionQueue.queueDepth}` : ""}`)
  }
  if (status.lastStartedAt) {
    lines.push(`last started: ${status.lastStartedAt}`)
  }
  if (status.lastHeartbeatAt) {
    lines.push(`last heartbeat: ${status.lastHeartbeatAt}`)
  }
  if (status.lastPollAt) {
    lines.push(`last queue poll: ${status.lastPollAt}`)
  }
  if (status.recentErrors.length > 0) {
    lines.push("recent errors:")
    for (const error of status.recentErrors.slice(-5)) {
      lines.push(`  - ${redactForOutput(error)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export function buildEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaping = false

  for (const character of command) {
    if (escaping) {
      current += character
      escaping = false
      continue
    }
    if (character === "\\") {
      escaping = true
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else {
        current += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += character
  }

  if (current.length > 0) {
    parts.push(current)
  }
  return parts
}

async function main() {
  const parsed = parseBridgeArgs(process.argv.slice(2))
  try {
    if (parsed.command === "connect") {
      await connectBridge(parsed)
    } else if (parsed.command === "pair") {
      await pairBridge(parsed)
    } else if (parsed.command === "start") {
      await startBridge(parsed)
    } else if (parsed.command === "status") {
      await showStatus(parsed)
    } else {
      writeStdout(helpText())
    }
  } catch (error) {
    writeStderr(`${redactForOutput(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  }
}

async function connectBridge(parsed: ParsedBridgeArgs) {
  const code = getFlag(parsed.flags, "code") ?? parsed.positionals[0]
  if (!code) {
    throw new Error("connect requires a connection code")
  }

  const appUrl = getFlag(parsed.flags, "app-url", process.env.ZERO_CHAT_APP_URL)
  if (!appUrl) {
    throw new Error("connect requires --app-url or ZERO_CHAT_APP_URL")
  }

  const agentCommand =
    getFlag(parsed.flags, "agent-command", process.env.ZERO_CHAT_AGENT_COMMAND) ??
    defaultAgentCommandForEnvironment()
  const skillPath = getFlag(parsed.flags, "skill-path", process.env.ZERO_CHAT_SKILL_PATH)
  const installMode =
    getFlag(parsed.flags, "install-mode", process.env.ZERO_CHAT_BRIDGE_INSTALL_MODE) ?? "unknown"
  const proposedProfile: ProposedAgentProfile = {
    agentCommand,
    bridgeVersion: BRIDGE_VERSION,
    defaultCwd: getFlag(parsed.flags, "default-cwd", process.cwd()) ?? process.cwd(),
    hostLabel: hostname(),
    installMode,
    proposedAgentName:
      getFlag(parsed.flags, "agent-name") ?? defaultProposedAgentName(agentCommand, hostname()),
    runtimeId: getFlag(parsed.flags, "runtime-id") ?? inferRuntimeId(agentCommand),
    runtimeLabel: getFlag(parsed.flags, "runtime-label") ?? inferRuntimeLabel(agentCommand),
    skillInstallPath: skillPath,
  }

  if (skillPath) {
    await writeAgentConnectionSkill(skillPath, {
      appUrl,
      agentCommand,
      configPath: getConfigPath(parsed.flags),
      skillPath,
    })
  }

  const endpoint = buildEndpoint(
    appUrl,
    getFlag(parsed.flags, "register-path", DEFAULT_AGENT_CONNECTION_REGISTER_PATH) ??
      DEFAULT_AGENT_CONNECTION_REGISTER_PATH,
  )
  const response = await postJson<PairResponse>(endpoint, undefined, {
    code,
    deviceName: proposedProfile.proposedAgentName,
    host: hostname(),
    platform: process.platform,
    proposedProfile,
  })

  const deviceId = readString(response.deviceId, "deviceId")
  const bridgeToken = readString(response.bridgeToken ?? response.token, "bridgeToken")
  const config: BridgeConfig = {
    appUrl,
    bridgeToken,
    deviceId,
    deviceName: proposedProfile.proposedAgentName,
    pairedAt: new Date().toISOString(),
  }

  const bridgeApiUrl = stringFromUnknown(response.bridgeApiUrl ?? response.endpoint)
  if (bridgeApiUrl) {
    config.bridgeApiUrl = bridgeApiUrl
  }
  const logIngestUrl = getFlag(parsed.flags, "log-url")
  if (logIngestUrl) {
    config.logIngestUrl = logIngestUrl
  }

  const configPath = getConfigPath(parsed.flags)
  const updatedConfig = await appendBridgeRegistration(configPath, config)
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
  })

  writeStdout(
    `Connected pending agent bridge ${deviceId}.\nConfig: ${configPath}\nOpen 0000 Chat to approve this agent before it can run work.\n`,
  )
}

async function pairBridge(parsed: ParsedBridgeArgs) {
  const code = getFlag(parsed.flags, "code") ?? parsed.positionals[0]
  if (!code) {
    throw new Error(
      "pair requires a pairing code: bun scripts/acp-bridge.ts pair <code> --app-url <url>",
    )
  }

  const appUrl = getFlag(parsed.flags, "app-url", process.env.ZERO_CHAT_APP_URL)
  if (!appUrl) {
    throw new Error("pair requires --app-url or ZERO_CHAT_APP_URL")
  }

  const configPath = getConfigPath(parsed.flags)
  const deviceName =
    getFlag(parsed.flags, "device-name", `${hostname()} bridge`) ?? `${hostname()} bridge`
  const pairPath = getFlag(parsed.flags, "pair-path", DEFAULT_PAIR_PATH) ?? DEFAULT_PAIR_PATH
  const endpoint = buildEndpoint(appUrl, pairPath)
  const response = await postJson<PairResponse>(endpoint, undefined, {
    code,
    deviceName,
    host: hostname(),
    runtime: "bun",
  })

  const deviceId = readString(response.deviceId, "deviceId")
  const bridgeToken = readString(response.bridgeToken ?? response.token, "bridgeToken")
  const config: BridgeConfig = {
    deviceId,
    bridgeToken,
    appUrl,
    deviceName,
    pairedAt: new Date().toISOString(),
  }

  const bridgeApiUrl = stringFromUnknown(response.bridgeApiUrl ?? response.endpoint)
  if (bridgeApiUrl) {
    config.bridgeApiUrl = bridgeApiUrl
  }
  const logIngestUrl = getFlag(parsed.flags, "log-url")
  if (logIngestUrl) {
    config.logIngestUrl = logIngestUrl
  }

  const updatedConfig = await appendBridgeRegistration(configPath, config)
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
  })
  writeStdout(`Paired bridge device ${deviceId}.\nConfig: ${configPath}\n`)
}

async function startBridge(parsed: ParsedBridgeArgs) {
  const configPath = getConfigPath(parsed.flags)
  const statusPath = getStatusPath(parsed.flags)
  await ensureSecureBridgeConfigFile(configPath)
  await readBridgeConfigFile(configPath)
  const pollMs = Number(getFlag(parsed.flags, "poll-ms", String(DEFAULT_POLL_MS)))
  const maxInFlight = getMaxInFlight(parsed.flags)
  const agentCommand =
    getFlag(parsed.flags, "agent-command", DEFAULT_AGENT_COMMAND) ?? DEFAULT_AGENT_COMMAND
  const customRuntimeCommands = getRepeatedFlags(parsed.flags, "runtime-command").map((command) =>
    splitCommand(command),
  )
  const requestTimeoutMs = getRequestTimeoutMs(parsed.flags)
  const resumeEnabled = getAcpResumeEnabled(parsed.flags)
  const idleSessionTtlMs = getAcpIdleTtlMs(parsed.flags)
  const allowRemoteCwd = getAllowRemoteCwd(parsed.flags)
  const logUrl = getBridgeLogUrl(parsed.flags, process.env)
  const hermesProfiles = await discoverHermesProfiles().catch(() => [])
  const runtimeProfiles = await discoverBridgeRuntimeProfiles({
    baseAgentCommand: agentCommand,
    customCommands: customRuntimeCommands,
  }).catch(() => [])

  type RuntimeContext = {
    config: BridgeRegistration
    inFlightCommands: Map<string, Promise<void>>
    inFlightCommandMetadata: Map<string, InFlightCommandMetadata>
    lastStaleCleanupAt: number
    lastJournalHealthSignature: string
    log: FlushableBridgeLogger
    manager: BridgeSessionManager
    status: BridgeStatus
    supervisor: BridgeSupervisor
    wakeSignal: BridgeWakeSignal
  }

  const contexts = new Map<string, RuntimeContext>()
  let stopping = false

  const aggregateStatus = () => buildAggregateBridgeStatus(Array.from(contexts.values()), maxInFlight)
  const persistAggregateStatus = async () => {
    await writeStatus(statusPath, aggregateStatus())
  }
  const totalInFlight = () =>
    Array.from(contexts.values()).reduce(
      (count, context) => count + context.inFlightCommands.size,
      0,
    )
  const ensureContexts = async () => {
    const latestConfig = await readBridgeConfigFile(configPath)
    const activeIds = new Set(latestConfig.registrations.map((registration) => registration.deviceId))
    for (const registration of latestConfig.registrations) {
      if (contexts.has(registration.deviceId)) {
        contexts.get(registration.deviceId)!.config = registration
        continue
      }
      const log = createWorkerBridgeLogger({
        bridgeToken: registration.bridgeToken,
        deviceId: registration.deviceId,
        logUrl,
      })
      const cloudClient = createCloudClient(registration)
      const hostAdapter = new ConvexBridgeHostAdapter(cloudClient)
      const supervisor = openBridgeSupervisor({
        bridgeDeviceId: registration.deviceId,
        host: hostAdapter,
        journalPath: getBridgeJournalPath(parsed.flags, registration.deviceId),
      })
      await supervisor.publishHealthDiagnostic({ bridgeDeviceId: registration.deviceId })
      await supervisor.replayOutboxBeforeClaiming()
      const manager = new BridgeSessionManager({
        cloudClient,
        deviceId: registration.deviceId,
        agentCommand,
        runtimeProfiles,
        requestTimeoutMs,
        resumeEnabled,
        idleSessionTtlMs,
        createMcpServers: ({ sessionKey, threadId }) =>
          buildAgentToolsMcpServers({
            agentSessionId: sessionKey,
            appUrl: registration.appUrl,
            agentToolsUrl: registration.appUrl,
            bridgeToken: registration.bridgeToken,
            deviceId: registration.deviceId,
            threadId,
          }),
        log,
        allowRemoteCwd,
        supervisor,
      })
      const wakeSignal = createBridgeWakeSignal({
        config: registration,
        convexUrl: getConvexUrl(parsed.flags, registration),
        limit: maxInFlight,
        log,
      })
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
        maxInFlight,
        acpResumeEnabled: resumeEnabled,
        acpIdleTtlMs: idleSessionTtlMs,
        hermesProfiles,
        runtimeProfiles,
        activeSessions: [],
        activeQueueItemIds: [],
        inFlightCommands: [],
        sessionQueues: [],
        recentErrors: [],
        localJournal: bridgeSupervisorHealthStatus(supervisor),
      }
      const context: RuntimeContext = {
        config: registration,
        inFlightCommands: new Map(),
        inFlightCommandMetadata: new Map(),
        lastJournalHealthSignature: bridgeSupervisorHealthSignature(supervisor),
        lastStaleCleanupAt: 0,
        log,
        manager,
        status,
        supervisor,
        wakeSignal,
      }
      contexts.set(registration.deviceId, context)
      log({
        level: "info",
        event: "bridge.start",
        deviceId: registration.deviceId,
        activeSessionCount: 0,
        acpResumeEnabled: resumeEnabled,
        acpIdleTtlMs: idleSessionTtlMs,
      })
    }
    for (const [deviceId, context] of contexts) {
      if (activeIds.has(deviceId) || context.inFlightCommands.size > 0) {
        continue
      }
      context.status.connected = false
      await context.wakeSignal.close()
      await context.manager.close()
      context.supervisor.close()
      await context.log.flush()
      contexts.delete(deviceId)
    }
    await persistAggregateStatus()
  }
  const waitForAnyWakeSignal = async () => {
    const signals = Array.from(contexts.values()).map((context) => context.wakeSignal)
    if (signals.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      return
    }
    await Promise.race(signals.map((signal) => signal.wait(pollMs)))
  }

  await ensureContexts()
  writeStdout(buildStartupSecuritySummary({ allowRemoteCwd, configPath, logUrl }))
  writeStdout(
    `Started bridge for ${contexts.size} registered link${contexts.size === 1 ? "" : "s"}. Press Ctrl+C to stop.\n`,
  )

  const recordLoopError = (context: RuntimeContext) => async (error: unknown) => {
    const message = redactForOutput(error instanceof Error ? error.message : String(error))
    context.status.recentErrors.push(message)
    context.status.recentErrors = context.status.recentErrors.slice(-10)
    context.log({
      level: "error",
      event: "bridge.loop.error",
      deviceId: context.config.deviceId,
      activeSessionCount: context.manager.getStatus().activeSessions.length,
      error: message,
    })
    syncBridgeRuntimeStatus(
      context.status,
      context.manager,
      maxInFlight,
      context.inFlightCommands,
      context.inFlightCommandMetadata,
    )
    await persistAggregateStatus()
  }
  const stop = async () => {
    if (stopping) {
      return
    }
    stopping = true
    for (const context of contexts.values()) {
      context.status.connected = false
      syncBridgeRuntimeStatus(
        context.status,
        context.manager,
        maxInFlight,
        context.inFlightCommands,
        context.inFlightCommandMetadata,
      )
      context.status.localJournal = bridgeSupervisorHealthStatus(context.supervisor)
      context.log({
        level: "info",
        event: "bridge.stop",
        deviceId: context.config.deviceId,
        activeSessionCount: context.manager.getStatus().activeSessions.length,
      })
      await context.wakeSignal.close()
      await context.manager.close()
      context.supervisor.close()
      await Promise.allSettled(context.inFlightCommands.values())
      await context.log.flush()
    }
    await persistAggregateStatus()
  }

  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())

  while (!stopping) {
    await ensureContexts()
    for (const context of contexts.values()) {
      const availableProcessSlots = Math.max(0, maxInFlight - totalInFlight())
      const effectiveMaxInFlight = context.inFlightCommands.size + availableProcessSlots
      context.status.localJournal = bridgeSupervisorHealthStatus(context.supervisor)
      await publishBridgeSupervisorHealthIfChanged(context)
      for (const watchdog of context.supervisor.checkWatchdogs()) {
        context.log({
          level: "warn",
          event: "bridge.watchdog.timeout",
          deviceId: context.config.deviceId,
          queueId: watchdog.queueItemId,
          reason: watchdog.reasonCode,
        })
      }
      const result = await runBridgeLoopIteration({
        config: context.config,
        agentCommand,
        runtimeCommands: customRuntimeCommands,
        status: context.status,
        maxInFlight: effectiveMaxInFlight,
        manager: context.manager,
        inFlightCommands: context.inFlightCommands,
        inFlightCommandMetadata: context.inFlightCommandMetadata,
        lastStaleCleanupAt: context.lastStaleCleanupAt,
        setLastStaleCleanupAt: (value) => {
          context.lastStaleCleanupAt = value
        },
        log: context.log,
        recordLoopError: recordLoopError(context),
        statusPath,
        canClaimWork: () => context.supervisor.canClaimWork(),
        writeStatus: persistAggregateStatus,
      })
      if (result.restartRequested) {
        await stop()
        break
      }
    }
    await waitForAnyWakeSignal()
  }
}

function buildAggregateBridgeStatus(
  contexts: Array<{
    config: BridgeRegistration
    status: BridgeStatus
  }>,
  maxInFlight: number,
): BridgeStatus {
  const first = contexts[0]
  const registrations = contexts.map(({ config, status }) => ({
    deviceId: config.deviceId,
    appUrl: config.appUrl,
    deviceName: config.deviceName,
    connected: status.connected,
    lifecycle: status.lifecycle,
    updateState: status.updateState,
    devHotReload: status.devHotReload,
    lastStartedAt: status.lastStartedAt,
    lastHeartbeatAt: status.lastHeartbeatAt,
    lastPollAt: status.lastPollAt,
    maxInFlight: status.maxInFlight,
    activeSessions: status.activeSessions,
    activeQueueItemIds: status.activeQueueItemIds,
    inFlightCommands: status.inFlightCommands,
    sessionQueues: status.sessionQueues,
    recentErrors: status.recentErrors,
  }))
  return {
    deviceId: first?.config.deviceId,
    appUrl: first?.config.appUrl,
    connected: registrations.some((registration) => registration.connected),
    lifecycle: first?.status.lifecycle,
    updateState: first?.status.updateState,
    devHotReload: first?.status.devHotReload,
    lastStartedAt: first?.status.lastStartedAt,
    lastHeartbeatAt: first?.status.lastHeartbeatAt,
    lastPollAt: first?.status.lastPollAt,
    maxInFlight,
    acpResumeEnabled: first?.status.acpResumeEnabled,
    acpIdleTtlMs: first?.status.acpIdleTtlMs,
    hermesProfiles: first?.status.hermesProfiles,
    runtimeProfiles: first?.status.runtimeProfiles,
    activeSessions: registrations.flatMap((registration) => registration.activeSessions),
    activeQueueItemIds: registrations.flatMap(
      (registration) => registration.activeQueueItemIds ?? [],
    ),
    inFlightCommands: registrations.flatMap((registration) => registration.inFlightCommands ?? []),
    sessionQueues: registrations.flatMap((registration) => registration.sessionQueues ?? []),
    recentErrors: registrations.flatMap((registration) => registration.recentErrors).slice(-10),
    registrations,
  }
}

function normalizeControlCommand(command?: BridgeControlCommandState): BridgeControlCommandState | undefined {
  if (command?.command !== "restartWhenIdle" && command?.command !== "updateWhenIdle") {
    return undefined
  }
  return {
    command: command.command,
    requestedAt: typeof command.requestedAt === "number" ? command.requestedAt : undefined,
  }
}

async function launchBridgeUpdater(input: BridgeUpdaterLaunchInput): Promise<void> {
  const updaterPath = join(dirname(fileURLToPath(import.meta.url)), "bridge-updater.ts")
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
    ...buildRestartCommandArgs(input.restartCommand),
  ]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

function getBridgeRestartCommand(): string[] {
  return [process.execPath, ...process.argv.slice(1)]
}

async function applyPendingBridgeControlCommand(
  status: BridgeStatus,
  now: () => number,
  input: Pick<BridgeLoopIterationInput, "launchUpdater" | "statusPath">,
): Promise<BridgeLoopIterationResult> {
  const command = normalizeControlCommand(status.pendingControlCommand)
  if (!command) {
    return { restartRequested: false }
  }

  const idleDecision = shouldRestartBridgeForDevHotReload(status)
  if (!idleDecision.ready) {
    status.lifecycle = "draining"
	    status.updateState = buildBridgeUpdateState("waitingForIdle", now(), {
	      requestedAt: command.requestedAt,
	    })
    return { restartRequested: false }
  }

  if (command.command === "updateWhenIdle") {
    status.lifecycle = "updating"
	    status.updateState = buildBridgeUpdateState("installing", now(), {
	      requestedAt: command.requestedAt,
	      startedAt: now(),
	    })
    status.pendingControlCommand = undefined
    try {
      const launchUpdater = input.launchUpdater ?? launchBridgeUpdater
      await launchUpdater({
        currentVersion: BRIDGE_VERSION,
        requestedAt: command.requestedAt,
        restartCommand: getBridgeRestartCommand(),
        statusPath: input.statusPath,
      })
    } catch (error) {
      status.lifecycle = "error"
	      status.updateState = buildBridgeUpdateState("failed", now(), {
	        requestedAt: command.requestedAt,
	        error: error instanceof Error ? error.message : String(error),
	      })
      return { restartRequested: false }
    }
    return { restartRequested: true }
  }

  status.lifecycle = "restarting"
	  status.updateState = buildBridgeUpdateState("restarting", now(), {
	    requestedAt: command.requestedAt,
	    startedAt: now(),
	  })
  status.pendingControlCommand = undefined
  return { restartRequested: true }
}

export async function runBridgeLoopIteration(
  input: BridgeLoopIterationInput,
): Promise<BridgeLoopIterationResult> {
  const heartbeat = input.sendHeartbeat ?? sendHeartbeat
  const discoverProfiles = input.discoverHermesProfiles ?? discoverHermesProfiles
  const discoverRuntimeProfiles = input.discoverRuntimeProfiles ?? discoverBridgeRuntimeProfiles
  const cleanup = input.cleanupStaleClaims ?? cleanupStaleClaims
  const claim = input.claimCommands ?? claimCommands
  const persistStatus = input.writeStatus ?? writeStatus
  const currentTime = input.now ?? Date.now
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS

  const syncBridgeStatus = () => {
    syncBridgeRuntimeStatus(
      input.status,
      input.manager,
      input.maxInFlight,
      input.inFlightCommands,
      input.inFlightCommandMetadata,
    )
  }
  const runCommand = (command: BridgeQueueCommand) => {
    input.inFlightCommandMetadata.set(command.id, {
      id: command.id,
      type: command.type ?? command.kind,
      threadId: command.threadId,
      sessionId: command.sessionId,
      agentSessionId: command.agentSessionId,
      startedAt: new Date(currentTime()).toISOString(),
    })
    input.log({
      level: "info",
      event: "bridge.queue_item.in_flight",
      deviceId: input.config.deviceId,
      queueId: command.id,
      queueType: command.type ?? command.kind,
      threadId: command.threadId,
      sessionId: command.sessionId,
      agentSessionId: command.agentSessionId,
      activeQueueItemIds: Array.from(input.inFlightCommands.keys()),
    })
    const task = input.manager
      .handleQueueItem(command)
      .catch(input.recordLoopError)
      .finally(() => {
        input.inFlightCommands.delete(command.id)
        input.inFlightCommandMetadata.delete(command.id)
        syncBridgeStatus()
        input.log({
          level: "info",
          event: "bridge.queue_item.settled",
          deviceId: input.config.deviceId,
          queueId: command.id,
          queueType: command.type ?? command.kind,
          threadId: command.threadId,
          sessionId: command.sessionId,
          agentSessionId: command.agentSessionId,
          activeQueueItemIds: Array.from(input.inFlightCommands.keys()),
        })
        void persistStatus(input.statusPath, input.status)
      })
    input.inFlightCommands.set(command.id, task)
    syncBridgeStatus()
  }

  try {
    syncBridgeStatus()
    let restartResult = await applyPendingBridgeControlCommand(input.status, currentTime, input)
    const heartbeatNow = currentTime()
    const heartbeatSignature = bridgeHeartbeatSignature(input.status)
    if (
      shouldSendBridgeHeartbeat(input.status, heartbeatNow, heartbeatSignature, heartbeatIntervalMs)
    ) {
      input.status.lastHeartbeatAt = new Date(heartbeatNow).toISOString()
      input.status.lastHeartbeatSignature = heartbeatSignature
      const heartbeatResult = await heartbeat(input.config, input.status)
      if (!heartbeatResult.ok) {
        const message = redactForOutput(heartbeatResult.error.message)
        input.status.recentErrors.push(message)
        input.status.recentErrors = input.status.recentErrors.slice(-10)
        input.log({
          level: "warn",
          event: "bridge.heartbeat.transient_error",
          deviceId: input.config.deviceId,
          activeSessionCount: input.manager.getStatus().activeSessions.length,
          error: message,
        })
      } else if (
        heartbeatResult.control?.refreshHermesProfiles ||
        heartbeatResult.control?.refreshRuntimeProfiles ||
        heartbeatResult.control?.command
      ) {
        const controlCommand = normalizeControlCommand(heartbeatResult.control.command)
        if (controlCommand) {
          input.status.pendingControlCommand = controlCommand
          restartResult = await applyPendingBridgeControlCommand(input.status, currentTime, input)
          input.log({
            level: "info",
            event: "bridge.control_command.received",
            deviceId: input.config.deviceId,
            command: controlCommand.command,
            restartRequested: restartResult.restartRequested,
          })
        }
        try {
          if (
            heartbeatResult.control.refreshHermesProfiles ||
            heartbeatResult.control.refreshRuntimeProfiles
          ) {
            input.status.hermesProfiles = await discoverProfiles()
            input.status.runtimeProfiles = await discoverRuntimeProfiles({
              baseAgentCommand: input.agentCommand ?? DEFAULT_AGENT_COMMAND,
              customCommands: input.runtimeCommands,
            })
            const refreshedAt = new Date(currentTime()).toISOString()
            input.status.lastHermesProfileRefreshAt = refreshedAt
            input.status.lastRuntimeProfileRefreshAt = refreshedAt
            input.log({
              level: "info",
              event: "bridge.hermes_profiles.refresh",
              deviceId: input.config.deviceId,
              profileCount: input.status.hermesProfiles.length,
            })
            await persistStatus(input.statusPath, input.status)
            const refreshHeartbeatResult = await heartbeat(input.config, input.status)
            if (!refreshHeartbeatResult.ok) {
              const message = redactForOutput(refreshHeartbeatResult.error.message)
              input.status.recentErrors.push(message)
              input.status.recentErrors = input.status.recentErrors.slice(-10)
            }
          }
        } catch (error) {
          const message = redactForOutput(error instanceof Error ? error.message : String(error))
          input.status.recentErrors.push(message)
          input.status.recentErrors = input.status.recentErrors.slice(-10)
          input.log({
            level: "warn",
            event: "bridge.hermes_profiles.refresh_error",
            deviceId: input.config.deviceId,
            error: message,
          })
        }
      }
    }
    if (restartResult.restartRequested) {
      syncBridgeStatus()
      await persistStatus(input.statusPath, input.status)
      return restartResult
    }
    const availableSlots = input.maxInFlight - input.inFlightCommands.size
    if (availableSlots > 0) {
      if (input.canClaimWork && !input.canClaimWork()) {
        input.log({
          level: "warn",
          event: "bridge.queue.claim_skipped",
          deviceId: input.config.deviceId,
          reason: "local_journal_hard_failed",
        })
        syncBridgeStatus()
        await persistStatus(input.statusPath, input.status)
        return { restartRequested: false }
      }
      const now = currentTime()
      if (now - input.lastStaleCleanupAt >= 60_000) {
        input.setLastStaleCleanupAt(now)
        const cleanupResult = await cleanup(input.config, { limit: availableSlots })
        if (typeof cleanupResult.released === "number" && cleanupResult.released > 0) {
          input.log({
            level: "info",
            event: "bridge.queue.cleanup_stale",
            deviceId: input.config.deviceId,
            released: cleanupResult.released,
            inspected: cleanupResult.inspected,
          })
        }
      }
      input.status.lastPollAt = new Date(now).toISOString()
      const commands = await claim(input.config, availableSlots)
      if (commands.length > 0) {
        input.log({
          level: "info",
          event: "bridge.queue.claimed",
          deviceId: input.config.deviceId,
          commandCount: commands.length,
        })
      }
      for (const command of commands) {
        runCommand(command)
      }
    }
    syncBridgeStatus()
    await persistStatus(input.statusPath, input.status)
  } catch (error) {
    await input.recordLoopError(error)
  }
  return { restartRequested: false }
}

export function shouldSendBridgeHeartbeat(
  status: Pick<BridgeStatus, "lastHeartbeatAt" | "lastHeartbeatSignature">,
  now: number,
  signature: string,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
): boolean {
  if (status.lastHeartbeatSignature !== signature) {
    return true
  }
  const lastHeartbeatAt = status.lastHeartbeatAt ? Date.parse(status.lastHeartbeatAt) : Number.NaN
  if (!Number.isFinite(lastHeartbeatAt)) {
    return true
  }
  return now - lastHeartbeatAt >= heartbeatIntervalMs
}

export function bridgeHeartbeatSignature(
  status: Pick<
    BridgeStatus,
    | "activeQueueItemIds"
    | "connected"
    | "devHotReload"
    | "inFlightCommands"
    | "lifecycle"
    | "maxInFlight"
    | "pendingControlCommand"
    | "sessionQueues"
    | "updateState"
  >,
): string {
  return JSON.stringify({
    activeQueueItemIds: [...(status.activeQueueItemIds ?? [])].sort(),
    connected: status.connected,
    devHotReload: status.devHotReload,
    inFlightCommands: (status.inFlightCommands ?? [])
      .map((command) => ({
        agentSessionId: command.agentSessionId,
        id: command.id,
        sessionId: command.sessionId,
        threadId: command.threadId,
        type: command.type,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    maxInFlight: status.maxInFlight,
    sessionQueues: (status.sessionQueues ?? [])
      .map((session) => ({
        hermesProfileName: session.hermesProfileName,
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
    updateState: status.updateState,
  })
}

function syncBridgeRuntimeStatus(
  status: BridgeStatus,
  manager: BridgeLoopManager,
  maxInFlight: number,
  inFlightCommands: Map<string, Promise<void>>,
  inFlightCommandMetadata: Map<string, InFlightCommandMetadata>,
): void {
  const managerStatus = manager.getStatus()
  status.lifecycle ??= "running"
	  status.updateState ??= buildBridgeUpdateState("upToDate", Date.now())
	  status.devHotReload ??= process.env.ZERO_CHAT_DEV_HOT_RELOAD
	    ? {
	        enabled: true,
	        lastRestartReason: process.env.ZERO_CHAT_DEV_HOT_RELOAD_REASON,
	        pendingRestart: false,
	      }
	    : {
	        enabled: false,
	        pendingRestart: false,
	      }
  status.maxInFlight = maxInFlight
  status.activeSessions = managerStatus.activeSessions
  status.sessionQueues = managerStatus.sessions
  status.activeQueueItemIds = Array.from(inFlightCommands.keys())
  status.inFlightCommands = Array.from(inFlightCommandMetadata.values())
}

async function showStatus(parsed: ParsedBridgeArgs) {
  const configPath = getConfigPath(parsed.flags)
  const statusPath = getStatusPath(parsed.flags)
  const configExists = existsSync(configPath)
  const existingStatus = existsSync(statusPath)
    ? await readJsonFile<BridgeStatus>(statusPath)
    : { connected: false, activeSessions: [], recentErrors: [] }

  if (configExists && !existingStatus.deviceId) {
    const config = await readBridgeConfigFile(configPath)
    const first = config.registrations[0]
    existingStatus.deviceId = first?.deviceId
    existingStatus.appUrl = first?.appUrl
    existingStatus.registrations = config.registrations.map((registration) => ({
      deviceId: registration.deviceId,
      appUrl: registration.appUrl,
      deviceName: registration.deviceName,
      connected: false,
      activeSessions: [],
      recentErrors: [],
    }))
  }

  writeStdout(describeStatus(existingStatus, configExists))
}

function normalizeCommand(command?: string): BridgeCommandName {
  if (command === "connect" || command === "pair" || command === "start" || command === "status") {
    return command
  }
  return "help"
}

export function buildStartupSecuritySummary(input: {
  allowRemoteCwd: boolean
  configPath: string
  logUrl?: string
}): string {
  return [
    "Security defaults:",
    `  config permissions: owner-only 0600 (${input.configPath})`,
    `  remote cwd from 0000 Chat: ${input.allowRemoteCwd ? "enabled" : "ignored"}`,
    `  remote bridge log forwarding: ${input.logUrl ? `enabled (${input.logUrl})` : "disabled"}`,
    "  package-backed runtime defaults: pinned versions",
    "",
  ].join("\n")
}

function helpText(): string {
  return `0000 Chat ACP bridge\n\nUsage:\n  bun scripts/acp-bridge.ts connect <code> --app-url <url> [--agent-command "${DEFAULT_CLAUDE_CODE_ACP_COMMAND}"] [--skill-path <path>]\n  bun scripts/acp-bridge.ts pair <code> --app-url <url> [--device-name <name>] [--log-url <url>]\n  bun scripts/acp-bridge.ts start [--agent-command "hermes acp"] [--runtime-command "${DEFAULT_CODEX_ACP_COMMAND}"] [--runtime-command "${DEFAULT_CLAUDE_CODE_ACP_COMMAND}"] [--poll-ms 2000] [--max-in-flight ${DEFAULT_MAX_IN_FLIGHT_COMMANDS}] [--request-timeout-ms ${DEFAULT_ACP_REQUEST_TIMEOUT_MS}] [--allow-remote-cwd] [--log-url <url>]\n  bun scripts/acp-bridge.ts status\n\nEnvironment:\n  ZERO_CHAT_APP_URL                         Default app URL for connect or pair\n  ZERO_CHAT_AGENT_COMMAND                   Default ACP agent command for connect\n  ZERO_CHAT_SKILL_PATH                      Local skill path for connect (default from install script: ${DEFAULT_AGENT_SKILL_PATH})\n  ZERO_CHAT_BRIDGE_CONFIG                  Config path (default: ${DEFAULT_CONFIG_PATH})\n  ZERO_CHAT_BRIDGE_MAX_IN_FLIGHT           Max concurrent claimed bridge commands\n  ZERO_CHAT_BRIDGE_REQUEST_TIMEOUT_MS      ACP request timeout in milliseconds\n  ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD        Honor cwd values from 0000 Chat queue items (default: false)\n  ZERO_CHAT_BRIDGE_JOURNAL                 Override local SQLite journal path (default: ${DEFAULT_JOURNAL_DIR}/<device>.sqlite)\n  ZERO_CHAT_BRIDGE_LOG_URL                 Worker log ingest URL (default: disabled)\n\n`
}

function getStatusPath(flags: FlagMap): string {
  return getFlag(flags, "status-file", process.env.ZERO_CHAT_BRIDGE_STATUS) ?? DEFAULT_STATUS_PATH
}

function getBridgeJournalPath(flags: FlagMap, deviceId: string): string {
  const explicit = getFlag(flags, "journal-file", process.env.ZERO_CHAT_BRIDGE_JOURNAL)
  if (explicit) {
    return explicit
  }
  return join(DEFAULT_JOURNAL_DIR, `${sanitizeFileSegment(deviceId)}.sqlite`)
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
  return sanitized.length > 0 ? sanitized : "bridge"
}

function bridgeSupervisorHealthStatus(supervisor: BridgeSupervisor): NonNullable<BridgeStatus["localJournal"]> {
  const health = supervisor.getHealth()
  if (health.status === "healthy") {
    return { status: "healthy" }
  }
  return {
    status: "hard_failed",
    reasonCode: health.reasonCode,
    message: health.message,
  }
}

function bridgeSupervisorHealthSignature(supervisor: BridgeSupervisor): string {
  return JSON.stringify(bridgeSupervisorHealthStatus(supervisor))
}

async function publishBridgeSupervisorHealthIfChanged(context: {
  config: BridgeRegistration
  lastJournalHealthSignature: string
  status: BridgeStatus
  supervisor: BridgeSupervisor
}): Promise<void> {
  const signature = bridgeSupervisorHealthSignature(context.supervisor)
  if (signature === context.lastJournalHealthSignature) {
    return
  }
  context.status.localJournal = bridgeSupervisorHealthStatus(context.supervisor)
  await context.supervisor.publishHealthDiagnostic({ bridgeDeviceId: context.config.deviceId })
  context.status.localJournal = bridgeSupervisorHealthStatus(context.supervisor)
  context.lastJournalHealthSignature = bridgeSupervisorHealthSignature(context.supervisor)
}

async function claimCommands(
  config: BridgeConfig,
  limit = DEFAULT_MAX_IN_FLIGHT_COMMANDS,
): Promise<BridgeQueueCommand[]> {
  const adapter = new ConvexBridgeHostAdapter(createCloudClient(config))
  const response = await adapter.claimWork({ limit })
  const rawResponse = response.raw as QueueClaimResponse
  const rawCommands = Array.isArray(rawResponse.commands)
    ? rawResponse.commands
    : rawResponse.command
      ? [rawResponse.command]
      : []
  return rawCommands.map(normalizeQueueCommand).filter((command) => command !== undefined)
}

async function cleanupStaleClaims(
  config: BridgeConfig,
  input: { limit?: number } = {},
): Promise<QueueCleanupResponse> {
  return await createCloudClient(config).cleanupStaleClaims<QueueCleanupResponse>(input)
}

type BridgeHeartbeatSendResult =
  | { ok: true; control?: BridgeControlResponse }
  | { ok: false; error: BridgeCloudHttpError & { status: 500 | 502 | 503 | 504 } }

type BridgeControlResponse = {
  command?: BridgeControlCommandState
  refreshHermesProfiles?: {
    requestedAt?: unknown
  }
  refreshRuntimeProfiles?: {
    requestedAt?: unknown
  }
}

export function buildHeartbeatStatusPayload(status: BridgeStatus) {
  return {
    connected: status.connected,
    lifecycle: status.lifecycle ?? "running",
    updateState: status.updateState ?? { status: "upToDate", currentVersion: BRIDGE_VERSION },
    devHotReload: status.devHotReload,
    activeSessions: status.activeSessions,
    activeQueueItemIds: status.activeQueueItemIds ?? [],
    inFlightCommands: status.inFlightCommands ?? [],
    maxInFlight: status.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT_COMMANDS,
    sessionQueues: (status.sessionQueues ?? []).map((session) => ({
      queueDepth: session.queueDepth,
      runningQueueItemId: session.runningQueueItemId,
      sessionKey: session.sessionKey,
      threadId: session.threadId,
    })),
    lastPollAt: status.lastPollAt,
    recentErrors: status.recentErrors.slice(-5),
  }
}

export function sanitizeHermesProfilesForCapabilities(
  profiles: Array<Record<string, unknown>>,
): HermesProfileSummary[] {
  return profiles
    .map((profile) => {
      const name = safeProfileText(profile.name, 80)
      if (!name) {
        return undefined
      }
      const alias = safeProfileText(profile.alias, 80)
      return {
        alias: alias && isSafeHermesProfileAlias(alias) ? alias : undefined,
        description: safeProfileText(profile.description, 240),
        gateway: safeProfileText(profile.gateway, 80),
        model: safeProfileText(profile.model, 120),
        name,
      }
    })
    .filter((profile) => profile !== undefined)
    .slice(0, 100)
}

export function parseHermesProfileListOutput(output: string): HermesProfileSummary[] {
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Profile") && !/^[─\s]+$/.test(line))

  return sanitizeHermesProfilesForCapabilities(
    rows
      .map((line) => {
        const normalized = line.replace(/^◆\s*/, "").replace(/^\*\s*/, "")
        const parts = normalized.split(/\s{2,}/).filter(Boolean)
        if (parts.length < 2) {
          return undefined
        }
        const [name, model, gateway, alias] = parts
        return {
          alias: alias === "—" ? undefined : alias,
          gateway: gateway === "—" ? undefined : gateway,
          model: model === "—" ? undefined : model,
          name,
        }
      })
      .filter((profile) => profile !== undefined),
  )
}

async function discoverHermesProfiles(): Promise<HermesProfileSummary[]> {
  const { stdout } = await runProcess("hermes", ["profile", "list"])
  return parseHermesProfileListOutput(stdout)
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout })
        return
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${stderr}`))
    })
  })
}

export async function sendHeartbeat(
  config: BridgeConfig,
  status: BridgeStatus,
): Promise<BridgeHeartbeatSendResult> {
  return sendHeartbeatWithClient(config, status, createCloudClient(config))
}

export async function sendHeartbeatWithClient(
  _config: BridgeConfig,
  status: BridgeStatus,
  client: Pick<ConvexBridgeCloudClient, "heartbeat">,
): Promise<BridgeHeartbeatSendResult> {
  try {
    const response = await client.heartbeat<{
      control?: BridgeControlResponse
    }>({
      capabilities: buildHeartbeatCapabilities(status),
      status: buildHeartbeatStatusPayload(status),
    })
    return { ok: true, control: response.control }
  } catch (error) {
    if (isTransientHeartbeatError(error)) {
      return { ok: false, error }
    }
    throw error
  }
}

export function buildHeartbeatCapabilities(status: BridgeStatus): Record<string, unknown> {
  return compact({
    ...(status.runtimeProfiles && status.runtimeProfiles.length > 0
      ? { runtimeProfiles: status.runtimeProfiles }
      : {}),
    ...(status.hermesProfiles && status.hermesProfiles.length > 0
      ? { hermesProfiles: status.hermesProfiles }
      : {}),
    setupSummary: status.setupSummary,
  })
}

function safeProfileText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value.trim().slice(0, maxLength) : undefined
  return text && !looksSensitiveProfileText(text) ? text : undefined
}

function isSafeHermesProfileAlias(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) && !looksSensitiveProfileText(value)
}

function looksSensitiveProfileText(value: string): boolean {
  return /token|secret|password|authorization|api[_-]?key/i.test(value)
}

export function isTransientHeartbeatError(
  error: unknown,
): error is BridgeCloudHttpError & { status: 500 | 502 | 503 | 504 } {
  return (
    error instanceof BridgeCloudHttpError &&
    (error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504)
  )
}

function createCloudClient(config: BridgeConfig): ConvexBridgeCloudClient {
  return new ConvexBridgeCloudClient({
    appUrl: config.appUrl,
    bridgeApiUrl: config.bridgeApiUrl,
    logIngestUrl: config.logIngestUrl,
    deviceId: config.deviceId,
    bridgeToken: config.bridgeToken,
    paths: {
      heartbeat: DEFAULT_HEARTBEAT_PATH,
      queueClaim: DEFAULT_CLAIM_PATH,
      queueCleanupStale: DEFAULT_CLEANUP_STALE_PATH,
      queueResult: DEFAULT_RESULT_PATH,
    },
  })
}

function getBridgeLogUrl(flags: FlagMap, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return getFlag(flags, "log-url", env.ZERO_CHAT_BRIDGE_LOG_URL)
}

function createBridgeWakeSignal(input: {
  config: BridgeConfig
  convexUrl: string | undefined
  limit: number
  log: FlushableBridgeLogger
}): BridgeWakeSignal {
  input.log({
    level: input.convexUrl ? "info" : "warn",
    event: "bridge.subscription.disabled",
    deviceId: input.config.deviceId,
    reason: input.convexUrl
      ? "public_bridge_uses_http_polling"
      : "missing_convex_url",
    limit: input.limit,
  })
  return createTimeoutWakeSignal()
}

function createTimeoutWakeSignal(): BridgeWakeSignal {
  let closed = false
  return {
    wait: async (timeoutMs: number) => {
      if (!closed) {
        await sleep(timeoutMs)
      }
    },
    close: async () => {
      closed = true
    },
  }
}

async function postJson<T>(url: string, token: string | undefined, body: unknown): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" })
  if (token) {
    headers.set("authorization", `Bearer ${token}`)
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`POST ${url} failed (${response.status}): ${text}`)
  }
  return (text.length > 0 ? JSON.parse(text) : {}) as T
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, "utf8")
  return JSON.parse(content) as T
}

async function readBridgeConfigFile(path: string): Promise<MultiBridgeConfig> {
  return normalizeBridgeConfigFile(await readJsonFile<BridgeConfigFile>(path))
}

async function appendBridgeRegistration(
  path: string,
  registration: BridgeRegistration,
): Promise<MultiBridgeConfig> {
  const existing = existsSync(path)
    ? await readBridgeConfigFile(path)
    : ({ version: 2, registrations: [] } satisfies MultiBridgeConfig)
  const next = upsertBridgeRegistration(existing, registration)
  await writeBridgeConfigFile(path, next)
  return next
}

export async function ensureSecureBridgeConfigFile(path: string): Promise<void> {
  if (!existsSync(path)) {
    return
  }
  await chmod(path, BRIDGE_LOCAL_STATE_MODE)
}

export async function writeBridgeConfigFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: BRIDGE_LOCAL_STATE_MODE,
  })
  await chmod(tempPath, BRIDGE_LOCAL_STATE_MODE)
  await rename(tempPath, path)
  await chmod(path, BRIDGE_LOCAL_STATE_MODE)
}

export async function writeBridgeStatusFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: BRIDGE_LOCAL_STATE_MODE,
  })
  await chmod(tempPath, BRIDGE_LOCAL_STATE_MODE)
  await rename(tempPath, path)
  await chmod(path, BRIDGE_LOCAL_STATE_MODE)
}

async function writeAgentConnectionSkill(
  path: string,
  input: { agentCommand: string; appUrl: string; configPath: string; skillPath: string },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
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
`
  await writeFile(path, content, "utf8")
}

async function writeStatus(path: string, status: BridgeStatus): Promise<void> {
  await writeBridgeStatusFile(path, status)
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeQueueCommand(raw: unknown): BridgeQueueCommand | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const rawRecord = raw as Record<string, unknown>
  const payload = recordFromUnknown(rawRecord.payload)
  const record = { ...(payload ?? {}), ...rawRecord }
  const id = stringFromUnknown(record.id)
  const type = stringFromUnknown(record.type ?? record.kind)
  if (!id || !isQueueCommandType(type)) {
    return undefined
  }
  return {
    id,
    claimId: stringFromUnknown(record.claimId),
    type,
    threadId: stringFromUnknown(record.threadId),
    sessionId: stringFromUnknown(record.sessionId),
    agentSessionId: stringFromUnknown(record.agentSessionId),
    cwd: stringFromUnknown(record.cwd),
    prompt: stringFromUnknown(record.prompt),
    threadHistory: stringFromUnknown(record.threadHistory),
    systemPrompt: stringFromUnknown(record.systemPrompt),
    approvalId: stringFromUnknown(record.approvalId),
    approvalOutcome: stringFromUnknown(record.approvalOutcome),
    approvalReason: stringFromUnknown(record.approvalReason),
    approvalLevel:
      record.approvalLevel === "ask" || record.approvalLevel === "full_permissions"
        ? record.approvalLevel
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
  }
}

function runtimeOptionsFromUnknown(
  value: unknown,
): BridgeQueueCommand["runtimeOptions"] | undefined {
  const record = recordFromUnknown(value)
  if (!record) {
    return undefined
  }
  const runtimeOptions = compact({
    modelId: stringFromUnknown(record.modelId),
    thinkingLevel: stringFromUnknown(record.thinkingLevel),
  })
  return Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined
}

function isQueueCommandType(value: string | undefined): value is BridgeQueueCommand["type"] {
  return (
    value === "prompt" ||
    value === "cancel" ||
    value === "approval" ||
    value === "approval-response" ||
    value === "choice-response" ||
    value === "permission-response" ||
    value === "ping"
  )
}

function readString(value: unknown, name: string): string {
  const result = stringFromUnknown(value)
  if (!result) {
    throw new Error(`pair response missing ${name}`)
  }
  return result
}

function redactForOutput(value: string): string {
  return String(redactLogValue(value))
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringRecordFromUnknown(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, stringFromUnknown(entry)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeStdout(message: string): void {
  process.stdout.write(message)
}

function writeStderr(message: string): void {
  process.stderr.write(message)
}

if (import.meta.main) {
  void main()
}
