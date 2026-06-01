import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  type BridgeRuntimeKind,
  type BridgeRuntimeProfile,
  dedupeRuntimeProfiles,
  profileIdForCommand,
  synthesizeLegacyHermesProfile,
} from "./runtime-profiles"
import { DEFAULT_CLAUDE_CODE_ACP_COMMAND, DEFAULT_CODEX_ACP_COMMAND } from "./runtime-defaults"

export type CommandResult = { ok: boolean; stdout: string; stderr?: string }
export type AcpProbeResult = { ok: true } | { ok: false; reason: string }

export type RuntimeDiscoveryInput = {
  baseAgentCommand: string | string[] | undefined
  customCommands?: string[][]
  probeAcpCommand?: (command: string[]) => Promise<AcpProbeResult>
  runCommand?: (command: string[]) => Promise<CommandResult>
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
  const profiles: BridgeRuntimeProfile[] = []
  const legacyProfile = synthesizeLegacyHermesProfile(input.baseAgentCommand)
  if (legacyProfile) {
    profiles.push(await withAcpProbe(legacyProfile, probeAcpCommand))
  }

  for (const builtIn of BUILT_INS) {
    const exists = await runCommand(["command", "-v", builtIn.binary])
    if (!exists.ok) {
      continue
    }
    profiles.push(await profileForBuiltIn(builtIn, runCommand, probeAcpCommand))
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
      await withAcpProbe(
        {
          id: profileIdForCommand("unknown-acp", command),
          kind: "unknown-acp",
          label: command.join(" "),
          command,
          status: "available",
          capabilities: { sessionMcpServers: true },
        },
        probeAcpCommand,
      ),
    )
  }

  return dedupeRuntimeProfiles(profiles)
}

async function profileForBuiltIn(
  builtIn: { kind: BridgeRuntimeKind; label: string; command: string[]; binary: string },
  runCommand: (command: string[]) => Promise<CommandResult>,
  probeAcpCommand: (command: string[]) => Promise<AcpProbeResult>,
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
    return await withAcpProbe(
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
    )
  }

  return await withAcpProbe(
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
  )
}

async function withAcpProbe(
  profile: BridgeRuntimeProfile,
  probeAcpCommand: (command: string[]) => Promise<AcpProbeResult>,
): Promise<BridgeRuntimeProfile> {
  const probe = await probeAcpCommand(profile.command)
  if (probe.ok) {
    return {
      ...profile,
      diagnostics: { ...profile.diagnostics, acp: "supported" },
      status: "available",
    }
  }
  return {
    ...profile,
    diagnostics: { ...profile.diagnostics, acp: "unsupported", reason: probe.reason },
    status: "unavailable",
  }
}

export function probeLocalAcpCommand(command: string[]): Promise<AcpProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      env: { ...process.env, TERM: process.env.TERM === "dumb" ? "xterm-256color" : process.env.TERM },
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
      child.kill("SIGTERM")
      resolve(result)
    }
    const timeout = setTimeout(() => {
      settle({ ok: false, reason: "ACP initialize probe timed out" })
    }, 3000)
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) {
          continue
        }
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown }
          if (message.id === 1 && message.result !== undefined) {
            settle({ ok: true })
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
