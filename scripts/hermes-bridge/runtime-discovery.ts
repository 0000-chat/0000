import { spawn } from "node:child_process"
import {
  type BridgeRuntimeKind,
  type BridgeRuntimeProfile,
  dedupeRuntimeProfiles,
  profileIdForCommand,
  synthesizeLegacyHermesProfile,
} from "./runtime-profiles"

export type CommandResult = { ok: boolean; stdout: string; stderr?: string }

export type RuntimeDiscoveryInput = {
  baseAgentCommand: string | string[] | undefined
  customCommands?: string[][]
  runCommand?: (command: string[]) => Promise<CommandResult>
}

const BUILT_INS: Array<{
  kind: BridgeRuntimeKind
  label: string
  command: string[]
  binary: string
}> = [
  { kind: "hermes", label: "Hermes", command: ["hermes", "acp"], binary: "hermes" },
  { kind: "codex", label: "Codex", command: ["codex", "acp"], binary: "codex" },
  { kind: "claude-code", label: "Claude Code", command: ["claude", "acp"], binary: "claude" },
  { kind: "openclaw", label: "OpenClaw", command: ["openclaw", "acp"], binary: "openclaw" },
]

export async function discoverRuntimeProfiles(
  input: RuntimeDiscoveryInput,
): Promise<BridgeRuntimeProfile[]> {
  const runCommand = input.runCommand ?? runLocalCommand
  const profiles: BridgeRuntimeProfile[] = [synthesizeLegacyHermesProfile(input.baseAgentCommand)]

  for (const builtIn of BUILT_INS) {
    const exists = await runCommand(["command", "-v", builtIn.binary])
    if (!exists.ok) {
      continue
    }
    profiles.push(await profileForBuiltIn(builtIn, runCommand))
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
    profiles.push({
      id: profileIdForCommand("unknown-acp", command),
      kind: "unknown-acp",
      label: command.join(" "),
      command,
      status: "available",
      diagnostics: { acp: "unknown" },
      capabilities: { sessionMcpServers: true },
    })
  }

  return dedupeRuntimeProfiles(profiles)
}

async function profileForBuiltIn(
  builtIn: { kind: BridgeRuntimeKind; label: string; command: string[]; binary: string },
  runCommand: (command: string[]) => Promise<CommandResult>,
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
    return {
      id: "codex:codex-acp",
      kind: "codex",
      label: "Codex",
      command: builtIn.command,
      status: "available",
      diagnostics: {
        acp: "unknown",
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
    }
  }

  return {
    id: builtIn.kind === "hermes" ? "hermes:default" : profileIdForCommand(builtIn.kind, builtIn.command),
    kind: builtIn.kind,
    label: builtIn.label,
    command: builtIn.command,
    status: "available",
    diagnostics: { acp: "unknown" },
    capabilities: { sessionMcpServers: true },
  }
}

function firstLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

export function runLocalCommand(command: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      env: process.env,
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
      child.kill("SIGTERM")
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
