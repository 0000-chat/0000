import { splitCommand } from "./acp-session"

export type BridgeRuntimeKind = "hermes" | "codex" | "claude-code" | "openclaw" | "unknown-acp"
export type BridgeRuntimeProfileStatus = "available" | "unavailable"

export type BridgeRuntimeProfile = {
  id: string
  kind: BridgeRuntimeKind
  label: string
  command: string[]
  status: BridgeRuntimeProfileStatus
  defaultCwd?: string
  hermesProfileName?: string
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
  }
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
    capabilities: {
      sessionMcpServers: true,
    },
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
