import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type BridgeRuntimeAvailableCommand,
  type BridgeRuntimeCapabilitySource,
  type BridgeRuntimeKind,
  type BridgeRuntimeProfile,
  dedupeRuntimeProfiles,
  profileIdForCommand,
  synthesizeLegacyHermesProfile,
} from "./runtime-profiles"
import { DEFAULT_CLAUDE_CODE_ACP_COMMAND, DEFAULT_CODEX_ACP_COMMAND } from "./runtime-defaults"
import { SdkAcpRuntimeClient } from "./sdk-acp-runtime-client"

export type CommandResult = { ok: boolean; stdout: string; stderr?: string }
export type AcpProbeCapabilities = {
  cwdBoundSessions?: boolean
  maxSessions?: number
  models?: string[]
  modes?: string[]
  runtimeConfigOptions?: Record<string, string[]>
  sdkProtocolVersion?: string
  sessionIsolation?: "verified" | "unverified"
  sharedGatewayKey?: boolean
  supportsAuth?: boolean
  supportsCancel?: boolean
  supportsClientFilesystem?: boolean
  supportsClientTerminal?: boolean
  supportsClose?: boolean
  supportsElicitation?: boolean
  supportsExtensions?: boolean
  supportsLogout?: boolean
  supportsPlans?: boolean
  supportsResume?: boolean
  supportsSessionDelete?: boolean
  supportsSessionFork?: boolean
  supportsSessionList?: boolean
  supportsSessionResume?: boolean
  supportsStructuredInteractions?: boolean
  supportsSlashCommands?: boolean
  thoughtLevels?: string[]
}
export type AcpProbeResult =
  | { ok: true; capabilities?: AcpProbeCapabilities }
  | { ok: false; reason: string }
export type AcpProbeOptions = { timeoutMs?: number }

export type RuntimeDiscoveryInput = {
  baseAgentCommand: string | string[] | undefined
  customCommands?: string[][]
  discoverAcpCommands?: (command: string[]) => Promise<BridgeRuntimeAvailableCommand[]>
  probeAcpCommand?: (command: string[], options?: AcpProbeOptions) => Promise<AcpProbeResult>
  runCommand?: (command: string[]) => Promise<CommandResult>
}

export function runtimeDiscoveryEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = baseEnv.HOME ?? homedir()
  const pathParts = [
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
    `${home}/.local/bin`,
    baseEnv.PATH,
  ].filter(Boolean)
  return {
    ...baseEnv,
    PATH: pathParts.join(":"),
    TERM: baseEnv.TERM === "dumb" || !baseEnv.TERM ? "xterm-256color" : baseEnv.TERM,
  }
}

const BUILT_INS: Array<{
  kind: BridgeRuntimeKind
  label: string
  command: string[]
  binary: string
  probeTimeoutMs?: number
}> = [
  { kind: "hermes", label: "Hermes", command: ["hermes", "acp"], binary: "hermes" },
  {
    kind: "codex",
    label: "Codex",
    command: DEFAULT_CODEX_ACP_COMMAND.split(" "),
    binary: "bunx",
    probeTimeoutMs: 30_000,
  },
  {
    kind: "claude-code",
    label: "Claude Code",
    command: DEFAULT_CLAUDE_CODE_ACP_COMMAND.split(" "),
    binary: "npx",
  },
  {
    kind: "openclaw",
    label: "OpenClaw",
    command: ["openclaw", "acp"],
    binary: "openclaw",
    probeTimeoutMs: 20_000,
  },
]

export async function discoverRuntimeProfiles(
  input: RuntimeDiscoveryInput,
): Promise<BridgeRuntimeProfile[]> {
  const runCommand = input.runCommand ?? runLocalCommand
  const probeAcpCommand = input.probeAcpCommand ?? probeLocalAcpCommand
  const discoverAcpCommands = input.discoverAcpCommands ?? discoverLocalAcpCommands
  const profiles: BridgeRuntimeProfile[] = []
  const legacyProfile = synthesizeLegacyHermesProfile(input.baseAgentCommand)
  if (legacyProfile) {
    profiles.push(await withAcpDetails(legacyProfile, probeAcpCommand, discoverAcpCommands))
  }

  for (const builtIn of BUILT_INS) {
    const commands = await resolveBuiltInCommandCandidates(builtIn, runCommand)
    if (commands.length === 0) {
      continue
    }
    let fallbackProfile: BridgeRuntimeProfile | undefined
    for (const command of commands) {
      const profile = await profileForBuiltIn(
        { ...builtIn, command },
        runCommand,
        probeAcpCommand,
        discoverAcpCommands,
      )
      if (profile.status === "available") {
        profiles.push(profile)
        fallbackProfile = undefined
        break
      }
      fallbackProfile ??= profile
    }
    if (fallbackProfile) {
      profiles.push(fallbackProfile)
    }
  }

  for (const rawCommand of input.customCommands ?? []) {
    if (isRetiredCodexAcpCommand(rawCommand)) {
      continue
    }
    const command = rawCommand
    const binary = command[0]
    if (!binary) {
      continue
    }
    const exists = await runCommand(["command", "-v", binary])
    if (!exists.ok) {
      continue
    }
    profiles.push(
      await withAcpDetails(
        {
          id: profileIdForCommand("unknown-acp", command),
          kind: "unknown-acp",
          label: command.join(" "),
          command,
          status: "available",
          capabilities: { sessionMcpServers: true },
        },
        probeAcpCommand,
        discoverAcpCommands,
      ),
    )
  }

  return dedupeRuntimeProfiles(profiles)
}

function isRetiredCodexAcpCommand(command: string[]): boolean {
  return command.some(
    (part) =>
      part === "@agentclientprotocol/codex-acp" ||
      part.startsWith("@agentclientprotocol/codex-acp@"),
  )
}

async function resolveBuiltInCommandCandidates(
  builtIn: { command: string[]; binary: string },
  runCommand: (command: string[]) => Promise<CommandResult>,
): Promise<string[][]> {
  const candidates =
    builtIn.binary === "npx" && builtIn.command[0] === "npx" ? ["npx", "bunx"] : [builtIn.binary]
  const commands: string[][] = []
  for (const binary of candidates) {
    const exists = await runCommand(["command", "-v", binary])
    if (exists.ok) {
      commands.push(commandForBinary(binary, builtIn.command))
    }
  }
  return commands
}

function commandForBinary(binary: string, command: string[]): string[] {
  if (command[0] === binary) {
    return command
  }
  const args = command.slice(1)
  if (binary === "bunx" && command[0] === "npx") {
    return [binary, ...args.filter((arg) => arg !== "--yes" && arg !== "-y")]
  }
  return [binary, ...args]
}

async function profileForBuiltIn(
  builtIn: {
    kind: BridgeRuntimeKind
    label: string
    command: string[]
    binary: string
    probeTimeoutMs?: number
  },
  runCommand: (command: string[]) => Promise<CommandResult>,
  probeAcpCommand: (command: string[], options?: AcpProbeOptions) => Promise<AcpProbeResult>,
  discoverAcpCommands: (command: string[]) => Promise<BridgeRuntimeAvailableCommand[]>,
): Promise<BridgeRuntimeProfile> {
  if (builtIn.kind === "codex") {
    const version = await runCommand(["codex", "--version"])
    const mcpList = await runCommand(["codex", "mcp", "list"])
    const contextMode = await runCommand(["command", "-v", "context-mode"])
    const mcpServers = mcpList.ok
      ? mcpList.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean).length
      : 0
    return await withAcpDetails(
      {
        id: "codex:codex-acp",
        kind: "codex",
        label: "Codex",
        command: builtIn.command,
        status: "available",
        diagnostics: {
          contextMode: contextMode.ok ? "available" : "missing",
          hooks: "unknown",
          mcpServers,
          version: firstLine(version.stdout),
        },
        capabilities: {
          nativeSkills: true,
          nativeHooks: true,
          nativeMcp: true,
          sessionMcpServers: true,
        },
      },
      probeAcpCommand,
      discoverAcpCommands,
      { timeoutMs: builtIn.probeTimeoutMs },
    )
  }

  return await withAcpDetails(
    {
      id:
        builtIn.kind === "hermes"
          ? "hermes:default"
          : builtIn.kind === "claude-code"
            ? "claude-code:claude-acp"
            : profileIdForCommand(builtIn.kind, builtIn.command),
      kind: builtIn.kind,
      label: builtIn.label,
      command: builtIn.command,
      status: "available",
      capabilities: { sessionMcpServers: true },
    },
    probeAcpCommand,
    discoverAcpCommands,
    { timeoutMs: builtIn.probeTimeoutMs },
  )
}

async function withAcpDetails(
  profile: BridgeRuntimeProfile,
  probeAcpCommand: (command: string[], options?: AcpProbeOptions) => Promise<AcpProbeResult>,
  discoverAcpCommands: (command: string[]) => Promise<BridgeRuntimeAvailableCommand[]>,
  options: AcpProbeOptions = {},
): Promise<BridgeRuntimeProfile> {
  const probe = await probeAcpCommand(profile.command, options)
  if (probe.ok) {
    const availableCommands = await discoverAcpCommands(profile.command).catch(() => [])
    const probedProfile = applyProbeCapabilities(profile, probe.capabilities)
    return {
      ...probedProfile,
      ...(availableCommands.length > 0 ? { availableCommands } : {}),
      diagnostics: { ...probedProfile.diagnostics, acp: "supported" },
      status: "available",
    }
  }
  const failureDiagnostics = diagnosticsForProbeFailure(profile, probe.reason)
  return {
    ...profile,
    diagnostics: { ...profile.diagnostics, acp: "unsupported", ...failureDiagnostics },
    status: "unavailable",
  }
}

function diagnosticsForProbeFailure(
  profile: BridgeRuntimeProfile,
  reason: string,
): { reason: string; detail?: string } {
  if (
    profile.kind === "openclaw" &&
    /gateway token missing|gateway\\.remote\\.token|unauthorized/i.test(reason)
  ) {
    return {
      reason: "openclaw_gateway_token_missing",
      detail:
        "OpenClaw gateway auth is enabled, but the ACP client has no matching gateway.remote.token. Set gateway.remote.token to match gateway.auth.token, or pass --token/--token-file in a custom OpenClaw ACP command.",
    }
  }
  return { reason }
}

function applyProbeCapabilities(
  profile: BridgeRuntimeProfile,
  capabilities: AcpProbeCapabilities | undefined,
): BridgeRuntimeProfile {
  const provenance = { ...profile.capabilityProvenance }
  const profileCapabilities = { ...profile.capabilities }
  const diagnostics = { ...profile.diagnostics }
  const identityRules = { ...profile.identityRules }
  let maxSessions = profile.maxSessions

  const mark = (
    key: string,
    source: BridgeRuntimeCapabilitySource,
    input: { diagnosticReasonCode?: string; nativeMethod?: string; value?: unknown } = {},
  ) => {
    provenance[key] = { source, ...input }
  }

  if (capabilities?.models && capabilities.models.length > 0) {
    mark("modelSelection", "native")
  }
  if (capabilities?.thoughtLevels && capabilities.thoughtLevels.length > 0) {
    mark("thoughtLevelSelection", "native")
  }
  if (capabilities?.modes && capabilities.modes.length > 0) {
    mark("modeSelection", "native")
  }
  if (typeof capabilities?.maxSessions === "number") {
    maxSessions = capabilities.maxSessions
    mark("maxSessions", "native", { value: capabilities.maxSessions })
  }

  applyBooleanCapability({
    key: "cancelTurn",
    nativeMethod: "session/cancel",
    present: capabilities?.supportsCancel,
    provenance: mark,
    unsupportedReason: "cancel_not_acknowledged",
  })
  applyBooleanCapability({
    key: "closeSession",
    nativeMethod: "session/close",
    present: capabilities?.supportsClose,
    provenance: mark,
    unsupportedReason: "session_close_unsupported",
  })
  applyBooleanCapability({
    key: "resumeSession",
    nativeMethod: "session/load",
    present: capabilities?.supportsResume,
    provenance: mark,
    unsupportedReason: "session_resume_failed",
    unsupportedSource: "fallback",
  })
  applyBooleanCapability({
    key: "structuredInteractions",
    nativeMethod: "permission/response",
    present: capabilities?.supportsStructuredInteractions,
    provenance: mark,
    unsupportedReason: "capability_missing",
  })

  if (capabilities?.supportsCancel !== undefined) {
    profileCapabilities.supportsCancel = capabilities.supportsCancel
  }
  if (capabilities?.supportsClose !== undefined) {
    profileCapabilities.supportsClose = capabilities.supportsClose
  }
  if (capabilities?.supportsResume !== undefined) {
    profileCapabilities.resumableSessions = capabilities.supportsResume
  }
  if (capabilities?.supportsStructuredInteractions !== undefined) {
    profileCapabilities.supportsStructuredInteractions = capabilities.supportsStructuredInteractions
  }
  if (capabilities?.sdkProtocolVersion !== undefined) {
    profileCapabilities.sdkProtocolVersion = capabilities.sdkProtocolVersion
  }
  for (const key of [
    "supportsAuth",
    "supportsClientFilesystem",
    "supportsClientTerminal",
    "supportsElicitation",
    "supportsExtensions",
    "supportsLogout",
    "supportsPlans",
    "supportsSessionDelete",
    "supportsSessionFork",
    "supportsSessionList",
    "supportsSessionResume",
    "supportsSlashCommands",
  ] as const) {
    if (capabilities?.[key] !== undefined) {
      profileCapabilities[key] = capabilities[key]
      mark(key, capabilities[key] ? "native" : "unsupported")
    }
  }

  if (profile.kind === "hermes" || capabilities?.cwdBoundSessions) {
    identityRules.cwdBoundSessions = capabilities?.cwdBoundSessions ?? profile.kind === "hermes"
    identityRules.cwdSwitchPolicy = "new_session_required"
    identityRules.scopeSessionKeyByThread = true
  }

  if (profile.kind === "openclaw") {
    identityRules.appIdentityFromMeta = false
    identityRules.scopeSessionKeyByThread = true
    if (capabilities?.sharedGatewayKey && capabilities.sessionIsolation !== "verified") {
      diagnostics.reason = "runtime_isolation_unverified"
      profileCapabilities.isolatedSessions = false
      mark("sessionIsolation", "fallback", {
        diagnosticReasonCode: "runtime_isolation_unverified",
      })
    } else if (capabilities?.sessionIsolation === "verified") {
      profileCapabilities.isolatedSessions = true
      mark("sessionIsolation", "native")
    }
  } else if (capabilities?.sessionIsolation === "verified") {
    profileCapabilities.isolatedSessions = true
    mark("sessionIsolation", "native")
  }

  return {
    ...profile,
    ...(capabilities?.models ? { models: capabilities.models } : {}),
    ...(capabilities?.thoughtLevels ? { thoughtLevels: capabilities.thoughtLevels } : {}),
    ...(capabilities?.modes ? { modes: capabilities.modes } : {}),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    ...(capabilities?.runtimeConfigOptions
      ? { runtimeConfigOptions: capabilities.runtimeConfigOptions }
      : {}),
    capabilities: profileCapabilities,
    capabilityProvenance: provenance,
    diagnostics,
    identityRules,
  }
}

function applyBooleanCapability(input: {
  key: string
  nativeMethod: string
  present: boolean | undefined
  provenance: (
    key: string,
    source: BridgeRuntimeCapabilitySource,
    detail?: { diagnosticReasonCode?: string; nativeMethod?: string; value?: unknown },
  ) => void
  unsupportedReason: string
  unsupportedSource?: BridgeRuntimeCapabilitySource
}) {
  if (input.present === true) {
    input.provenance(input.key, "native", { nativeMethod: input.nativeMethod })
  } else if (input.present === false) {
    input.provenance(input.key, input.unsupportedSource ?? "unsupported", {
      diagnosticReasonCode: input.unsupportedReason,
    })
  }
}

export function probeLocalAcpCommand(
  command: string[],
  options: AcpProbeOptions = {},
): Promise<AcpProbeResult> {
  return new Promise((resolve) => {
    const child = spawnAcpCommand(command, {
      env: runtimeDiscoveryEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let settled = false
    let stderr = ""
    const settle = (result: AcpProbeResult) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      terminateSpawnedAcpCommand(child)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      settle({ ok: false, reason: "ACP initialize probe timed out" })
    }, options.timeoutMs ?? 10_000)
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      settle({ ok: false, reason: error.message })
    })
    child.on("close", (code) => {
      if (settled) {
        return
      }
      const reason = firstLine(stderr) ?? `ACP process exited with code ${code ?? "unknown"}`
      settle({ ok: false, reason })
    })
    const client = SdkAcpRuntimeClient.fromChildProcess(
      child as ChildProcessWithoutNullStreams,
    )
    void client
      .initialize()
      .then((result) =>
        settle({ ok: true, capabilities: capabilitiesFromInitializeResult(result.raw) }),
      )
      .catch((error) => {
        const reason =
          error instanceof Error
            ? error.message || "ACP initialize probe returned an error"
            : "ACP initialize probe returned an error"
        settle({ ok: false, reason })
      })
  })
}

export function capabilitiesFromInitializeResult(
  result: unknown,
): AcpProbeCapabilities | undefined {
  const record = recordFromUnknown(result)
  const agentCapabilities = recordFromUnknown(record.agentCapabilities)
  const runtimeCapabilities = recordFromUnknown(
    record.runtimeCapabilities ?? record.capabilities ?? agentCapabilities.runtimeCapabilities,
  )
  const sessionCapabilities = recordFromUnknown(
    agentCapabilities.sessionCapabilities ?? runtimeCapabilities.sessionCapabilities,
  )
  const agentAuthCapabilities = recordFromUnknown(
    agentCapabilities.auth ?? runtimeCapabilities.auth,
  )
  const agentMeta = recordFromUnknown(agentCapabilities._meta)
  const runtimeMeta = recordFromUnknown(runtimeCapabilities._meta)
  const resultMeta = recordFromUnknown(record._meta)
  const runtimeConfigOptions = runtimeConfigOptionsFromUnknown(
    record.runtimeConfigOptions ??
      runtimeCapabilities.runtimeConfigOptions ??
      runtimeCapabilities.configOptions,
  )
  const capabilities: AcpProbeCapabilities = {}
  const sdkProtocolVersion =
    stringFromUnknown(record.protocolVersion) ??
    numberStringFromUnknown(record.protocolVersion) ??
    stringFromUnknown(runtimeCapabilities.sdkProtocolVersion)
  if (sdkProtocolVersion) capabilities.sdkProtocolVersion = sdkProtocolVersion
  const models =
    stringArrayFromUnknown(runtimeCapabilities.models) ??
    stringArrayFromUnknown(record.models) ??
    runtimeConfigOptions?.model
  const thoughtLevels =
    stringArrayFromUnknown(runtimeCapabilities.thoughtLevels) ??
    stringArrayFromUnknown(runtimeCapabilities.thinkingLevels) ??
    stringArrayFromUnknown(record.thoughtLevels) ??
    runtimeConfigOptions?.thoughtLevel
  const modes =
    stringArrayFromUnknown(runtimeCapabilities.modes) ??
    stringArrayFromUnknown(record.modes) ??
    runtimeConfigOptions?.mode
  if (models) capabilities.models = models
  if (thoughtLevels) capabilities.thoughtLevels = thoughtLevels
  if (modes) capabilities.modes = modes
  if (runtimeConfigOptions) capabilities.runtimeConfigOptions = runtimeConfigOptions

  const maxSessions = numberFromUnknown(
    runtimeCapabilities.maxSessions ?? record.maxSessions ?? agentCapabilities.maxSessions,
  )
  if (maxSessions !== undefined) capabilities.maxSessions = maxSessions

  const supportsCancel = booleanFromUnknown(runtimeCapabilities.supportsCancel)
  capabilities.supportsCancel =
    supportsCancel ?? (Object.hasOwn(sessionCapabilities, "cancel") ? true : undefined)

  const supportsClose = booleanFromUnknown(runtimeCapabilities.supportsClose)
  capabilities.supportsClose =
    supportsClose ?? (Object.hasOwn(sessionCapabilities, "close") ? true : undefined)

  const supportsResume =
    booleanFromUnknown(runtimeCapabilities.supportsResume) ??
    booleanFromUnknown(agentCapabilities.loadSession)
  capabilities.supportsResume =
    supportsResume ??
    (Object.hasOwn(sessionCapabilities, "resume") || Object.hasOwn(sessionCapabilities, "load")
      ? true
      : undefined)

  const supportsStructuredInteractions = booleanFromUnknown(
    runtimeCapabilities.supportsStructuredInteractions ??
      runtimeCapabilities.structuredInteractions ??
      agentCapabilities.structuredInteractions,
  )
  if (supportsStructuredInteractions !== undefined) {
    capabilities.supportsStructuredInteractions = supportsStructuredInteractions
  }

  capabilities.supportsSessionList = Object.hasOwn(sessionCapabilities, "list")
  capabilities.supportsSessionDelete = Object.hasOwn(sessionCapabilities, "delete")
  capabilities.supportsSessionFork = Object.hasOwn(sessionCapabilities, "fork")
  capabilities.supportsSessionResume = capabilities.supportsResume === true
  capabilities.supportsAuth =
    Object.keys(agentAuthCapabilities).length > 0 || Array.isArray(record.authMethods)
  capabilities.supportsLogout = Object.hasOwn(agentAuthCapabilities, "logout")

  const supportExtensionBoolean = (key: string): boolean | undefined =>
    booleanFromUnknown(runtimeCapabilities[key] ?? agentMeta[key] ?? runtimeMeta[key] ?? resultMeta[key])

  const supportsClientFilesystem = supportExtensionBoolean("supportsClientFilesystem")
  if (supportsClientFilesystem !== undefined) {
    capabilities.supportsClientFilesystem = supportsClientFilesystem
  }
  const supportsClientTerminal = supportExtensionBoolean("supportsClientTerminal")
  if (supportsClientTerminal !== undefined) {
    capabilities.supportsClientTerminal = supportsClientTerminal
  }
  const supportsPlans = supportExtensionBoolean("supportsPlans")
  if (supportsPlans !== undefined) {
    capabilities.supportsPlans = supportsPlans
  }
  const supportsSlashCommands =
    supportExtensionBoolean("supportsSlashCommands") ??
    (Array.isArray(record.availableCommands) ? true : undefined)
  if (supportsSlashCommands !== undefined) {
    capabilities.supportsSlashCommands = supportsSlashCommands
  }
  const supportsElicitation = supportExtensionBoolean("supportsElicitation")
  if (supportsElicitation !== undefined) {
    capabilities.supportsElicitation = supportsElicitation
  }
  const supportsExtensions = supportExtensionBoolean("supportsExtensions")
  if (supportsExtensions !== undefined) {
    capabilities.supportsExtensions = supportsExtensions
  }

  const cwdBoundSessions = booleanFromUnknown(
    runtimeCapabilities.cwdBoundSessions ?? agentCapabilities.cwdBoundSessions,
  )
  if (cwdBoundSessions !== undefined) capabilities.cwdBoundSessions = cwdBoundSessions

  const sharedGatewayKey = booleanFromUnknown(runtimeCapabilities.sharedGatewayKey)
  if (sharedGatewayKey !== undefined) capabilities.sharedGatewayKey = sharedGatewayKey
  const sessionIsolation = stringFromUnknown(runtimeCapabilities.sessionIsolation)
  if (sessionIsolation === "verified" || sessionIsolation === "unverified") {
    capabilities.sessionIsolation = sessionIsolation
  }

  return Object.keys(capabilities).length > 0 ? capabilities : undefined
}

export function discoverLocalAcpCommands(
  command: string[],
): Promise<BridgeRuntimeAvailableCommand[]> {
  return new Promise((resolve) => {
    const child = spawnAcpCommand(command, {
      env: runtimeDiscoveryEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let settled = false
    const settle = (commands: BridgeRuntimeAvailableCommand[]) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      terminateSpawnedAcpCommand(child)
      resolve(commands)
    }
    const timeout = setTimeout(() => settle([]), 5000)
    child.on("error", () => settle([]))
    child.on("close", () => settle([]))
    const client = SdkAcpRuntimeClient.fromChildProcess(
      child as ChildProcessWithoutNullStreams,
    )
    client.onUpdate((event) => {
      const commands = commandsFromSessionUpdate(event.update)
      if (commands.length > 0) {
        settle(commands)
      }
    })
    void client
      .initialize()
      .then(() => client.createSession({ cwd: process.cwd(), mcpServers: [] }))
      .catch(() => settle([]))
  })
}

function commandsFromSessionUpdate(value: unknown): BridgeRuntimeAvailableCommand[] {
  const update = recordFromUnknown(value)
  if (update.sessionUpdate !== "available_commands_update") {
    return []
  }
  return normalizeAvailableCommands(arrayFromUnknown(update.availableCommands)) ?? []
}

function firstLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function normalizeAvailableCommands(
  commands: unknown[] | undefined,
): BridgeRuntimeAvailableCommand[] | undefined {
  if (!commands) {
    return undefined
  }
  return commands
    .map((command) => {
      const record = recordFromUnknown(command)
      const input = recordFromUnknown(record.input)
      const name = stringFromUnknown(record.name)?.trim().replace(/^\/+/, "")
      if (!name) {
        return undefined
      }
      const normalized: BridgeRuntimeAvailableCommand = { name }
      const description = stringFromUnknown(record.description)
      const inputHint = stringFromUnknown(record.inputHint) ?? stringFromUnknown(input.hint)
      if (description) normalized.description = description
      if (inputHint) normalized.inputHint = inputHint
      return normalized
    })
    .filter((command): command is BridgeRuntimeAvailableCommand => command !== undefined)
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function arrayFromUnknown(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  const array = arrayFromUnknown(value)
  if (!array) {
    return undefined
  }
  const strings = array.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  )
  return strings.length > 0 ? strings : undefined
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberStringFromUnknown(value: unknown): string | undefined {
  const number = numberFromUnknown(value)
  return number === undefined ? undefined : String(number)
}

function runtimeConfigOptionsFromUnknown(value: unknown): Record<string, string[]> | undefined {
  const record = recordFromUnknown(value)
  const entries = Object.entries(record)
    .map(([key, entry]) => [key, stringArrayFromUnknown(entry)] as const)
    .filter((entry): entry is readonly [string, string[]] => entry[1] !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function runLocalCommand(command: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      env: runtimeDiscoveryEnv(),
      shell: command[0] === "command",
      stdio: ["ignore", "pipe", "pipe"],
    })
    let settled = false
    let stdout = ""
    let stderr = ""
    const settle = (result: CommandResult) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      terminateSpawnedAcpCommand(child)
      settle({ ok: false, stdout, stderr: "Command timed out" })
    }, 3000)
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      settle({ ok: false, stdout, stderr: error.message })
    })
    child.on("close", (code) => {
      settle({ ok: code === 0, stdout, stderr })
    })
  })
}

const activeAcpDiscoveryChildren = new Set<ReturnType<typeof spawn>>()

function spawnAcpCommand(
  command: string[],
  options: Parameters<typeof spawn>[2],
): ReturnType<typeof spawn> {
  const executable = command[0] ?? ""
  const resolvedExecutable = resolveExecutableForSpawn(executable, options?.env)
  const args = command.slice(1)
  const child = process.versions.bun
    ? spawn(
        "node",
        [
          join(dirname(fileURLToPath(import.meta.url)), "acp-node-proxy.cjs"),
          resolvedExecutable,
          ...args,
        ],
        { ...options, detached: process.platform !== "win32" },
      )
    : spawn(resolvedExecutable, args, options)
  activeAcpDiscoveryChildren.add(child)
  child.once("close", () => activeAcpDiscoveryChildren.delete(child))
  return child
}

export function resolveExecutableForSpawn(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): string {
  if (!executable || executable.includes("/") || executable.includes("\\")) {
    return executable
  }

  for (const directory of (env?.PATH ?? process.env.PATH ?? "").split(":")) {
    if (!directory) {
      continue
    }
    const candidate = join(directory, executable)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking through PATH.
    }
  }

  return executable
}

export function terminateActiveAcpDiscoveryChildren(): void {
  for (const child of activeAcpDiscoveryChildren) {
    terminateSpawnedAcpCommand(child)
  }
}

export function getActiveAcpDiscoveryChildCount(): number {
  return activeAcpDiscoveryChildren.size
}

function terminateSpawnedAcpCommand(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (child.pid) {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {
        // Fall through to direct process signals below.
      }
    }
    try {
      process.kill(child.pid, "SIGTERM")
    } catch {
      // Fall through to ChildProcess.kill; Node may still have a live handle.
    }
  }
  child.kill("SIGTERM")

  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      return
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // The process group exited between the graceful signal and fallback.
      }
    }
    try {
      process.kill(child.pid, "SIGKILL")
    } catch {
      // The process exited between the graceful signal and fallback.
    }
    child.kill("SIGKILL")
  }, 1000).unref()
}
