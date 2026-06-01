#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"

import { BridgeCloudHttpError, ConvexBridgeCloudClient } from "./hermes-bridge/convex-http"
import {
  createWorkerBridgeLogger,
  type FlushableBridgeLogger,
  redactLogValue,
} from "./hermes-bridge/bridge-log"
import {
  DEFAULT_ACP_REQUEST_TIMEOUT_MS,
  type HermesAcpMcpServer,
} from "./hermes-bridge/acp-session"
import { BridgeSessionManager, type BridgeSessionQueueItem } from "./hermes-bridge/session-manager"
import { discoverRuntimeProfiles as discoverBridgeRuntimeProfiles } from "./hermes-bridge/runtime-discovery"
import {
  defaultAgentCommandForEnvironment,
  defaultProposedAgentName,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
  inferRuntimeId,
  inferRuntimeLabel,
} from "./hermes-bridge/runtime-defaults"
import type { BridgeRuntimeProfile } from "./hermes-bridge/runtime-profiles"
export {
  defaultAgentCommandForEnvironment,
  defaultProposedAgentName,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
  inferRuntimeId,
  inferRuntimeLabel,
} from "./hermes-bridge/runtime-defaults"

const DEFAULT_CONFIG_PATH = join(homedir(), ".0000", "bridge.json")
const DEFAULT_STATUS_PATH = join(homedir(), ".0000", "bridge-status.json")
const DEFAULT_PAIR_PATH = "/api/agent-bridge/pair"
const DEFAULT_CLAIM_PATH = "/api/agent-bridge/queue/claim"
const DEFAULT_CLEANUP_STALE_PATH = "/api/agent-bridge/queue/cleanup-stale"
const DEFAULT_RESULT_PATH = "/api/agent-bridge/queue/result"
const DEFAULT_HEARTBEAT_PATH = "/api/agent-bridge/heartbeat"
const DEFAULT_POLL_MS = 2000
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_MAX_IN_FLIGHT_COMMANDS = 2
const DEFAULT_AGENT_COMMAND = "hermes acp"
const DEFAULT_BRIDGE_LOG_URL = "https://0000.chat/api/agent-bridge/logs"
const DEFAULT_ACP_RESUME_ENABLED = false
const DEFAULT_ACP_IDLE_TTL_MS = 0
const DEFAULT_AGENT_CONNECTION_REGISTER_PATH = "/api/agent-connections/register"
const DEFAULT_AGENT_SKILL_PATH = join(homedir(), ".claude", "skills", "0000", "SKILL.md")
const BRIDGE_VERSION = "0.1.0"

export type BridgeCommandName = "connect" | "pair" | "start" | "status" | "help"

type FlagValue = string | true | string[]
type FlagMap = Record<string, FlagValue>

export type ParsedBridgeArgs = {
  command: BridgeCommandName
  positionals: string[]
  flags: FlagMap
}

export type BridgeConfig = {
  deviceId: string
  bridgeToken: string
  appUrl: string
  deviceName: string
  pairedAt: string
  bridgeApiUrl?: string
  logIngestUrl?: string
}

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
    queueDepth: number
    runningQueueItemId?: string
    lastUsedAt?: number
  }>
  setupSummary?: Record<string, unknown>
  recentErrors: string[]
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
  writeStatus?: typeof writeStatus
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
  config: Pick<BridgeConfig, "appUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    getFlag(flags, "convex-url", env.ZERO_CHAT_BRIDGE_CONVEX_URL) ??
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
  const logIngestUrl =
    getFlag(parsed.flags, "log-url") ?? stringFromUnknown(response.logIngestUrl ?? response.logUrl)
  if (logIngestUrl) {
    config.logIngestUrl = logIngestUrl
  }

  const configPath = getConfigPath(parsed.flags)
  await writeJsonFile(configPath, config)
  await writeStatus(getStatusPath(parsed.flags), {
    deviceId,
    appUrl,
    connected: false,
    activeSessions: [],
    recentErrors: [],
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
  const logIngestUrl =
    getFlag(parsed.flags, "log-url") ?? stringFromUnknown(response.logIngestUrl ?? response.logUrl)
  if (logIngestUrl) {
    config.logIngestUrl = logIngestUrl
  }

  await writeJsonFile(configPath, config)
  await writeStatus(getStatusPath(parsed.flags), {
    deviceId,
    appUrl,
    connected: false,
    activeSessions: [],
    recentErrors: [],
  })
  writeStdout(`Paired bridge device ${deviceId}.\nConfig: ${configPath}\n`)
}

async function startBridge(parsed: ParsedBridgeArgs) {
  const configPath = getConfigPath(parsed.flags)
  const statusPath = getStatusPath(parsed.flags)
  const config = await readJsonFile<BridgeConfig>(configPath)
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
  const log = createWorkerBridgeLogger({
    bridgeToken: config.bridgeToken,
    deviceId: config.deviceId,
    logUrl: getBridgeLogUrl(parsed.flags, config),
  })
  const hermesProfiles = await discoverHermesProfiles().catch(() => [])
  const runtimeProfiles = await discoverBridgeRuntimeProfiles({
    baseAgentCommand: agentCommand,
    customCommands: customRuntimeCommands,
  }).catch(() => [])
  const manager = new BridgeSessionManager({
    cloudClient: createCloudClient(config),
    deviceId: config.deviceId,
    agentCommand,
    runtimeProfiles,
    requestTimeoutMs,
    resumeEnabled,
    idleSessionTtlMs,
    createMcpServers: ({ sessionKey, threadId }) =>
      buildAgentToolsMcpServers({
        agentSessionId: sessionKey,
        appUrl: config.appUrl,
        bridgeToken: config.bridgeToken,
        deviceId: config.deviceId,
        threadId,
      }),
    log,
  })
  const wakeSignal = createBridgeWakeSignal({
    config,
    convexUrl: getConvexUrl(parsed.flags, config),
    limit: maxInFlight,
    log,
  })
  const status: BridgeStatus = {
    deviceId: config.deviceId,
    appUrl: config.appUrl,
    connected: true,
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
  }

  await writeStatus(statusPath, status)
  log({
    level: "info",
    event: "bridge.start",
    deviceId: config.deviceId,
    activeSessionCount: 0,
    acpResumeEnabled: resumeEnabled,
    acpIdleTtlMs: idleSessionTtlMs,
  })
  writeStdout(`Started bridge ${config.deviceId}. Press Ctrl+C to stop.\n`)

  const inFlightCommands = new Map<string, Promise<void>>()
  const inFlightCommandMetadata = new Map<
    string,
    {
      id: string
      type?: string
      threadId?: string
      sessionId?: string
      agentSessionId?: string
      startedAt: string
    }
  >()
  let lastStaleCleanupAt = 0
  let stopping = false

  const syncBridgeStatus = () => {
    syncBridgeRuntimeStatus(status, manager, maxInFlight, inFlightCommands, inFlightCommandMetadata)
  }
  const recordLoopError = async (error: unknown) => {
    const message = redactForOutput(error instanceof Error ? error.message : String(error))
    status.recentErrors.push(message)
    status.recentErrors = status.recentErrors.slice(-10)
    log({
      level: "error",
      event: "bridge.loop.error",
      deviceId: config.deviceId,
      activeSessionCount: manager.getStatus().activeSessions.length,
      error: message,
    })
    syncBridgeStatus()
    await writeStatus(statusPath, status)
  }
  const stop = async () => {
    if (stopping) {
      return
    }
    stopping = true
    status.connected = false
    syncBridgeStatus()
    await writeStatus(statusPath, status)
    log({
      level: "info",
      event: "bridge.stop",
      deviceId: config.deviceId,
      activeSessionCount: manager.getStatus().activeSessions.length,
    })
    await wakeSignal.close()
    await manager.close()
    await Promise.allSettled(inFlightCommands.values())
    await log.flush()
  }

  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())

  while (!stopping) {
    await runBridgeLoopIteration({
      config,
      agentCommand,
      runtimeCommands: customRuntimeCommands,
      status,
      maxInFlight,
      manager,
      inFlightCommands,
      inFlightCommandMetadata,
      lastStaleCleanupAt,
      setLastStaleCleanupAt: (value) => {
        lastStaleCleanupAt = value
      },
      log,
      recordLoopError,
      statusPath,
    })
    await wakeSignal.wait(pollMs)
  }
}

export async function runBridgeLoopIteration(input: BridgeLoopIterationInput): Promise<void> {
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
        heartbeatResult.control?.refreshRuntimeProfiles
      ) {
        try {
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
    const availableSlots = input.maxInFlight - input.inFlightCommands.size
    if (availableSlots > 0) {
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
    "activeQueueItemIds" | "connected" | "inFlightCommands" | "maxInFlight" | "sessionQueues"
  >,
): string {
  return JSON.stringify({
    activeQueueItemIds: [...(status.activeQueueItemIds ?? [])].sort(),
    connected: status.connected,
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
        queueDepth: session.queueDepth,
        runningQueueItemId: session.runningQueueItemId,
        sessionKey: session.sessionKey,
        threadId: session.threadId,
      }))
      .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
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
    const config = await readJsonFile<BridgeConfig>(configPath)
    existingStatus.deviceId = config.deviceId
    existingStatus.appUrl = config.appUrl
  }

  writeStdout(describeStatus(existingStatus, configExists))
}

function normalizeCommand(command?: string): BridgeCommandName {
  if (command === "connect" || command === "pair" || command === "start" || command === "status") {
    return command
  }
  return "help"
}

function helpText(): string {
  return `0000 Chat ACP bridge\n\nUsage:\n  bun scripts/acp-bridge.ts connect <code> --app-url <url> [--agent-command "${DEFAULT_CLAUDE_CODE_ACP_COMMAND}"] [--skill-path <path>]\n  bun scripts/acp-bridge.ts pair <code> --app-url <url> [--device-name <name>] [--log-url <url>]\n  bun scripts/acp-bridge.ts start [--agent-command "hermes acp"] [--runtime-command "${DEFAULT_CODEX_ACP_COMMAND}"] [--runtime-command "${DEFAULT_CLAUDE_CODE_ACP_COMMAND}"] [--poll-ms 2000] [--max-in-flight ${DEFAULT_MAX_IN_FLIGHT_COMMANDS}] [--request-timeout-ms ${DEFAULT_ACP_REQUEST_TIMEOUT_MS}] [--log-url <url>]\n  bun scripts/acp-bridge.ts status\n\nEnvironment:\n  ZERO_CHAT_APP_URL                         Default app URL for connect or pair\n  ZERO_CHAT_AGENT_COMMAND                   Default ACP agent command for connect\n  ZERO_CHAT_SKILL_PATH                      Local skill path for connect (default from install script: ${DEFAULT_AGENT_SKILL_PATH})\n  ZERO_CHAT_BRIDGE_CONFIG                  Config path (default: ${DEFAULT_CONFIG_PATH})\n  ZERO_CHAT_BRIDGE_MAX_IN_FLIGHT           Max concurrent claimed bridge commands\n  ZERO_CHAT_BRIDGE_REQUEST_TIMEOUT_MS      ACP request timeout in milliseconds\n  ZERO_CHAT_BRIDGE_LOG_URL                 Worker log ingest URL (default: ${DEFAULT_BRIDGE_LOG_URL})\n\n`
}

function getStatusPath(flags: FlagMap): string {
  return getFlag(flags, "status-file", process.env.ZERO_CHAT_BRIDGE_STATUS) ?? DEFAULT_STATUS_PATH
}

async function claimCommands(
  config: BridgeConfig,
  limit = DEFAULT_MAX_IN_FLIGHT_COMMANDS,
): Promise<BridgeQueueCommand[]> {
  const response = await createCloudClient(config).claimWork<QueueClaimResponse>({ limit })
  const rawCommands = Array.isArray(response.commands)
    ? response.commands
    : response.command
      ? [response.command]
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

function getBridgeLogUrl(
  flags: FlagMap,
  config: Pick<BridgeConfig, "logIngestUrl">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    getFlag(flags, "log-url", env.ZERO_CHAT_BRIDGE_LOG_URL) ??
    config.logIngestUrl ??
    DEFAULT_BRIDGE_LOG_URL
  )
}

function createBridgeWakeSignal(input: {
  config: BridgeConfig
  convexUrl: string | undefined
  limit: number
  log: FlushableBridgeLogger
}): BridgeWakeSignal {
  input.log({
    level: "warn",
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

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tempPath, path)
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
  await writeJsonFile(path, status)
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

function normalizeQueueCommand(raw: unknown): BridgeQueueCommand | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const id = stringFromUnknown(record.id)
  const type = stringFromUnknown(record.type ?? record.kind)
  if (!id || !isQueueCommandType(type)) {
    return undefined
  }
  return {
    id,
    type,
    threadId: stringFromUnknown(record.threadId),
    sessionId: stringFromUnknown(record.sessionId),
    agentSessionId: stringFromUnknown(record.agentSessionId),
    cwd: stringFromUnknown(record.cwd),
    prompt: stringFromUnknown(record.prompt),
    systemPrompt: stringFromUnknown(record.systemPrompt),
    approvalId: stringFromUnknown(record.approvalId),
    approvalOutcome: stringFromUnknown(record.approvalOutcome),
    approvalReason: stringFromUnknown(record.approvalReason),
    externalRequestId: stringFromUnknown(record.externalRequestId),
  }
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
