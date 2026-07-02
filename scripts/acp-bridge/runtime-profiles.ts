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
  probeTimeoutMs?: number
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
  toolCallPolicies?: BridgeRuntimeToolCallPolicy[]
}

export type BridgeRuntimeToolCallClass = "standard" | "subagent" | "long_running"

export type BridgeRuntimeToolCallPolicy = {
  id: string
  timeoutMs?: number
  toolClass: Exclude<BridgeRuntimeToolCallClass, "standard">
  toolNamePatterns: string[]
}

export type BridgeToolCallTimeoutResolution = {
  policyId: string
  timeoutMs: number
  toolClass: BridgeRuntimeToolCallClass
}

export const DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS = 30 * 60 * 1000

const GENERIC_SUBAGENT_TOOL_POLICY: BridgeRuntimeToolCallPolicy = {
  id: "generic-subagent-tool",
  toolClass: "subagent",
  toolNamePatterns: [
    "^delegate(?::|_|-|\\b)",
    "subagent",
    "sub-agent",
    "agent\\.run",
    "^task(?::|_|-|\\b)",
    "workflow",
    "background",
    "^worker(?::|_|-|\\b)",
  ],
}

const GENERIC_LONG_RUNNING_TOOL_POLICY: BridgeRuntimeToolCallPolicy = {
  id: "generic-long-running-tool",
  timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
  toolClass: "long_running",
  toolNamePatterns: [
    "^terminal:.*\\b(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:quality:(?:affected|changed|fast|gate|timings)|typecheck|build|test|work:(?:finish|land))\\b",
    "^terminal:.*\\b(?:cargo|gradle|mvn)\\b",
    "^terminal:.*\\bgh\\s+run\\s+watch\\b",
  ],
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
    probeTimeoutMs: 30_000,
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
    toolCallPolicies: [
      {
        id: "hermes-delegate-subagent",
        timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
        toolClass: "subagent",
        toolNamePatterns: ["^delegate(?::|_|-|\\b)", "^delegate_task$"],
      },
    ],
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

export function resolveToolCallTimeoutPolicy(input: {
  defaultTimeoutMs: number
  explicitTimeoutMs?: number
  profile?: BridgeRuntimeProfile
  requestTimeoutMs?: number
  toolName: string
}): BridgeToolCallTimeoutResolution {
  if (input.explicitTimeoutMs !== undefined) {
    return {
      policyId: "explicit-tool-result-timeout",
      timeoutMs: input.explicitTimeoutMs,
      toolClass: "standard",
    }
  }

  const runtimePolicy = input.profile?.compatibility?.toolCallPolicies?.find((policy) =>
    toolCallPolicyMatches(policy, input.toolName),
  )
  const genericPolicy = [
    GENERIC_SUBAGENT_TOOL_POLICY,
    GENERIC_LONG_RUNNING_TOOL_POLICY,
  ].find((policy) => toolCallPolicyMatches(policy, input.toolName))
  const policy = runtimePolicy ?? genericPolicy

  if (!policy) {
    return {
      policyId: "default-tool-result-timeout",
      timeoutMs: input.defaultTimeoutMs,
      toolClass: "standard",
    }
  }

  return {
    policyId: policy.id,
    timeoutMs: resolvePolicyTimeoutMs(policy, input),
    toolClass: policy.toolClass,
  }
}

function resolvePolicyTimeoutMs(
  policy: BridgeRuntimeToolCallPolicy,
  input: {
    defaultTimeoutMs: number
    requestTimeoutMs?: number
  },
): number {
  let timeoutMs =
    policy.timeoutMs ?? Math.max(input.defaultTimeoutMs, DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS)
  if (input.requestTimeoutMs !== undefined && input.requestTimeoutMs > input.defaultTimeoutMs) {
    timeoutMs = Math.min(timeoutMs, input.requestTimeoutMs)
  }
  return Math.max(1, timeoutMs)
}

function toolCallPolicyMatches(policy: BridgeRuntimeToolCallPolicy, toolName: string): boolean {
  const normalizedToolName = toolName.trim()
  if (!normalizedToolName) {
    return false
  }
  return policy.toolNamePatterns.some((pattern) => patternMatchesToolName(pattern, normalizedToolName))
}

function patternMatchesToolName(pattern: string, toolName: string): boolean {
  try {
    return new RegExp(pattern, "i").test(toolName)
  } catch {
    return toolName.toLowerCase().includes(pattern.toLowerCase())
  }
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
