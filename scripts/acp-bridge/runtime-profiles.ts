import { splitCommand } from "./acp-session"

export type BridgeRuntimeKind = "hermes" | "codex" | "claude-code" | "openclaw" | "unknown-acp"
export type BridgeRuntimeProfileStatus = "available" | "unavailable"
export type BridgeRuntimeCapabilitySource = "native" | "adapter" | "fallback" | "unsupported"

export type BridgeRuntimeAvailableCommand = {
  name: string
  description?: string
  inputHint?: string
}

export type BridgeRuntimeProfile = {
  id: string
  kind: BridgeRuntimeKind
  label: string
  command: string[]
  status: BridgeRuntimeProfileStatus
  availableCommands?: BridgeRuntimeAvailableCommand[]
  compatibility?: BridgeRuntimeCompatibility
  defaultCwd?: string
  hermesProfileName?: string
  models?: string[]
  thoughtLevels?: string[]
  modes?: string[]
  maxSessions?: number
  identityRules?: {
    appIdentityFromMeta?: boolean
    cwdBoundSessions?: boolean
    cwdSwitchPolicy?: "new_session_required" | "explicit_switch_required" | "blocked"
    scopeSessionKeyByThread?: boolean
  }
  runtimeConfigOptions?: Record<string, string[]>
  capabilityProvenance?: Record<
    string,
    {
      diagnosticReasonCode?: string
      nativeMethod?: string
      source: BridgeRuntimeCapabilitySource
      value?: unknown
    }
  >
  diagnostics?: {
    acp?: "supported" | "unsupported" | "unknown"
    contextMode?: "available" | "missing" | "unknown"
    hooks?: "available" | "missing" | "unknown"
    mcpServers?: number
    skills?: number
    version?: string
    reason?: string
  }
  capabilities: {
    nativeSkills?: boolean
    nativeHooks?: boolean
    nativeMcp?: boolean
    sessionMcpServers?: boolean
    resumableSessions?: boolean
    isolatedSessions?: boolean
    supportsCancel?: boolean
    supportsClose?: boolean
    sdkProtocolVersion?: string
    supportsAuth?: boolean
    supportsClientFilesystem?: boolean
    supportsClientTerminal?: boolean
    supportsElicitation?: boolean
    supportsExtensions?: boolean
    supportsLogout?: boolean
    supportsPlans?: boolean
    supportsSessionDelete?: boolean
    supportsSessionFork?: boolean
    supportsSessionList?: boolean
    supportsSessionResume?: boolean
    supportsSlashCommands?: boolean
    supportsStructuredInteractions?: boolean
  }
}

export type BridgeRuntimeCompatibility = {
  mcpServerNameAliases?: Record<string, string>
}

export function normalizeCommand(
  command: string | string[] | undefined,
  fallback: string,
): string[] {
  if (Array.isArray(command)) {
    return command.filter(Boolean)
  }
  return splitCommand(command ?? fallback)
}

export function commandKey(command: string[]): string {
  return command.join(" ")
}

export function profileIdForCommand(kind: BridgeRuntimeKind, command: string[]): string {
  const suffix = command
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `${kind}:${suffix || "default"}`
}

export function synthesizeLegacyHermesProfile(
  command: string | string[] | undefined,
): BridgeRuntimeProfile | undefined {
  const normalizedCommand = normalizeCommand(command, "hermes acp")
  if (!normalizedCommand.some((part) => part.toLowerCase().includes("hermes"))) {
    return undefined
  }
  return {
    id: "hermes:default",
    kind: "hermes",
    label: "Hermes",
    command: normalizedCommand,
    status: "available",
    compatibility: hermesRuntimeCompatibility(),
    identityRules: {
      cwdBoundSessions: true,
      cwdSwitchPolicy: "new_session_required",
      scopeSessionKeyByThread: true,
    },
    capabilityProvenance: {
      sessionIsolation: { source: "adapter" },
    },
    capabilities: {
      sessionMcpServers: true,
    },
  }
}

export function hermesRuntimeCompatibility(): BridgeRuntimeCompatibility {
  return {
    mcpServerNameAliases: {
      "0000": "zero-chat",
    },
  }
}

export function applyRuntimeMcpServerCompatibility<TServer extends { name: string }>(
  servers: TServer[],
  profile: BridgeRuntimeProfile | undefined,
): TServer[] {
  const aliases = profile?.compatibility?.mcpServerNameAliases
  if (!aliases || Object.keys(aliases).length === 0) {
    return servers
  }
  return servers.map((server) => {
    const alias = aliases[server.name]
    if (!alias || alias === server.name) {
      return server
    }
    return { ...server, name: alias }
  })
}

export function dedupeRuntimeProfiles(profiles: BridgeRuntimeProfile[]): BridgeRuntimeProfile[] {
  const seen = new Set<string>()
  const deduped: BridgeRuntimeProfile[] = []
  for (const profile of profiles) {
    if (seen.has(profile.id)) {
      continue
    }
    seen.add(profile.id)
    deduped.push(profile)
  }
  return deduped
}

export function findRuntimeProfile(
  profiles: BridgeRuntimeProfile[],
  bridgeProfileId: string | undefined,
): BridgeRuntimeProfile | undefined {
  if (bridgeProfileId) {
    const selected = profiles.find((profile) => profile.id === bridgeProfileId)
    if (selected?.status === "available") {
      return selected
    }
  }
  return profiles.find((profile) => profile.status === "available")
}
