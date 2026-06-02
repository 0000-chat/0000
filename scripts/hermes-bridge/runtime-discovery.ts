import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import {
  type BridgeRuntimeAvailableCommand,
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
    return {
      ...profile,
      ...(availableCommands.length > 0 ? { availableCommands } : {}),
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

export function discoverLocalAcpCommands(
  command: string[],
): Promise<BridgeRuntimeAvailableCommand[]> {
  return new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
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
      child.kill("SIGTERM")
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
