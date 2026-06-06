import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
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

export type CommandResult = { ok: boolean; stdout: string; stderr?: string }
export type AcpProbeCapabilities = {
  cwdBoundSessions?: boolean
  maxSessions?: number
  models?: string[]
  modes?: string[]
  runtimeConfigOptions?: Record<string, string[]>
  sessionIsolation?: "verified" | "unverified"
  sharedGatewayKey?: boolean
  supportsCancel?: boolean
  supportsClose?: boolean
  supportsResume?: boolean
  supportsStructuredInteractions?: boolean
  thoughtLevels?: string[]
}
export type AcpProbeResult =
  | { ok: true; capabilities?: AcpProbeCapabilities }
  | { ok: false; reason: string }

export type RuntimeDiscoveryInput = {
  baseAgentCommand: string | string[] | undefined
  customCommands?: string[][]
  discoverAcpCommands?: (command: string[]) => Promise<BridgeRuntimeAvailableCommand[]>
  probeAcpCommand?: (command: string[]) => Promise<AcpProbeResult>
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
}> = [
  { kind: "hermes", label: "Hermes", command: ["hermes", "acp"], binary: "hermes" },
  { kind: "codex", label: "Codex", command: DEFAULT_CODEX_ACP_COMMAND.split(" "), binary: "npx" },
  {
    kind: "claude-code",
    label: "Claude Code",
    command: DEFAULT_CLAUDE_CODE_ACP_COMMAND.split(" "),
    binary: "npx",
  },
  { kind: "openclaw", label: "OpenClaw", command: ["openclaw", "acp"], binary: "openclaw" },
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
    const command = await resolveBuiltInCommand(builtIn, runCommand)
    if (!command) {
      continue
    }
    profiles.push(
      await profileForBuiltIn({ ...builtIn, command }, runCommand, probeAcpCommand, discoverAcpCommands),
    )
  }

  for (const command of input.customCommands ?? []) {
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

async function resolveBuiltInCommand(
  builtIn: { command: string[]; binary: string },
  runCommand: (command: string[]) => Promise<CommandResult>,
): Promise<string[] | undefined> {
  const candidates = builtIn.binary === "npx" ? ["npx", "bunx"] : [builtIn.binary]
  for (const binary of candidates) {
    const exists = await runCommand(["command", "-v", binary])
    if (exists.ok) {
      return [binary, ...builtIn.command.slice(1)]
    }
  }
  return undefined
}

async function profileForBuiltIn(
  builtIn: { kind: BridgeRuntimeKind; label: string; command: string[]; binary: string },
  runCommand: (command: string[]) => Promise<CommandResult>,
  probeAcpCommand: (command: string[]) => Promise<AcpProbeResult>,
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
  )
}

async function withAcpDetails(
  profile: BridgeRuntimeProfile,
  probeAcpCommand: (command: string[]) => Promise<AcpProbeResult>,
  discoverAcpCommands: (command: string[]) => Promise<BridgeRuntimeAvailableCommand[]>,
): Promise<BridgeRuntimeProfile> {
  const probe = await probeAcpCommand(profile.command)
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

export function probeLocalAcpCommand(command: string[]): Promise<AcpProbeResult> {
  return new Promise((resolve) => {
    const child = spawnAcpCommand(command, {
      env: runtimeDiscoveryEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let settled = false
    let stdout = ""
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
    }, 10_000)
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) {
          continue
        }
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown }
          if (message.id === 1 && message.result !== undefined) {
            settle({ ok: true, capabilities: capabilitiesFromInitializeResult(message.result) })
            return
          }
          if (message.id === 1 && message.error !== undefined) {
            settle({ ok: false, reason: "ACP initialize probe returned an error" })
            return
          }
        } catch {
          // Ignore non-JSON banners and wait for an ACP response.
        }
      }
    })
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
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: { name: "0000-chat-acp-probe", version: "0.1.0" },
          sessionId: randomUUID(),
        },
      })}\n`,
    )
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
  const runtimeConfigOptions = runtimeConfigOptionsFromUnknown(
    record.runtimeConfigOptions ??
      runtimeCapabilities.runtimeConfigOptions ??
      runtimeCapabilities.configOptions,
  )
  const capabilities: AcpProbeCapabilities = {}
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
    let stdout = ""
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
    const write = (message: unknown) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    }
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        try {
          const message = JSON.parse(line) as {
            id?: unknown
            method?: unknown
            params?: unknown
            result?: unknown
          }
          if (message.id === 1 && message.result !== undefined) {
            write({
              jsonrpc: "2.0",
              id: 2,
              method: "session/new",
              params: { cwd: process.cwd(), mcpServers: [] },
            })
            continue
          }
          const commands = commandsFromSessionUpdate(message)
          if (commands.length > 0) {
            settle(commands)
            return
          }
        } catch {
          // Ignore non-JSON banners and keep waiting for ACP messages.
        }
      }
    })
    child.on("error", () => settle([]))
    child.on("close", () => settle([]))
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "0000-chat-command-discovery", version: "0.1.0" },
        sessionId: randomUUID(),
      },
    })
  })
}

function commandsFromSessionUpdate(message: {
  method?: unknown
  params?: unknown
}): BridgeRuntimeAvailableCommand[] {
  if (message.method !== "session/update") {
    return []
  }
  const params = recordFromUnknown(message.params)
  const update = recordFromUnknown(params.update)
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
  const args = command.slice(1)
  const child = process.versions.bun
    ? spawn(
        "node",
        [join(dirname(fileURLToPath(import.meta.url)), "acp-node-proxy.cjs"), executable, ...args],
        { ...options, detached: process.platform !== "win32" },
      )
    : spawn(executable, args, options)
  activeAcpDiscoveryChildren.add(child)
  child.once("close", () => activeAcpDiscoveryChildren.delete(child))
  return child
}

export function terminateActiveAcpDiscoveryChildren(): void {
  for (const child of activeAcpDiscoveryChildren) {
    terminateSpawnedAcpCommand(child)
  }
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
