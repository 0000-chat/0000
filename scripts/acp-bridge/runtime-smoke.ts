import { hostname } from "node:os"

import { splitCommand } from "./acp-session"
import {
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
} from "./runtime-defaults"
import { discoverRuntimeProfiles, terminateActiveAcpDiscoveryChildren } from "./runtime-discovery"
import type { BridgeRuntimeKind, BridgeRuntimeProfile } from "./runtime-profiles"
import { commandKey } from "./runtime-profiles"

export type RuntimeSmokeStatus = "pass" | "fail" | "blocked"

export type RuntimeSmokeRow = {
  runtime: BridgeRuntimeKind | "custom-acp"
  label: string
  command: string[]
  status: RuntimeSmokeStatus
  reason?: string
  acp?: "supported" | "unsupported" | "unknown"
  availableCommands: number
  capabilities: {
    maxSessions?: number
    models?: string[]
    modes?: string[]
    supportsCancel?: boolean
    supportsClose?: boolean
    supportsResume?: boolean
    supportsStructuredInteractions?: boolean
    thoughtLevels?: string[]
  }
}

export type RuntimeSmokeMatrix = {
  generatedAt: string
  host: string
  summary: Record<RuntimeSmokeStatus, number>
  rows: RuntimeSmokeRow[]
}

type RuntimeSmokeInput = {
  baseAgentCommand?: string | string[]
  customCommands?: string[][]
  discover?: typeof discoverRuntimeProfiles
  includeAvailableCommands?: boolean
  now?: () => Date
  host?: string
}

const EXPECTED_BUILT_INS: Array<{
  runtime: BridgeRuntimeKind
  label: string
  command: string[]
}> = [
  { runtime: "hermes", label: "Hermes", command: ["hermes", "acp"] },
  { runtime: "codex", label: "Codex", command: splitCommand(DEFAULT_CODEX_ACP_COMMAND) },
  {
    runtime: "claude-code",
    label: "Claude Code",
    command: splitCommand(DEFAULT_CLAUDE_CODE_ACP_COMMAND),
  },
  { runtime: "openclaw", label: "OpenClaw", command: ["openclaw", "acp"] },
]

type ExpectedRuntimeSmokeRow = {
  runtime: BridgeRuntimeKind | "custom-acp"
  label: string
  command: string[]
}

export async function buildRuntimeSmokeMatrix(
  input: RuntimeSmokeInput = {},
): Promise<RuntimeSmokeMatrix> {
  const baseAgentCommand = input.baseAgentCommand ?? "hermes acp"
  const customCommands = input.customCommands ?? []
  const discover =
    input.discover ??
    ((options) =>
      discoverRuntimeProfiles({
        ...options,
        discoverAcpCommands: input.includeAvailableCommands ? undefined : async () => [],
      }))
  const profiles = await discover({ baseAgentCommand, customCommands })
  const rows = expectedRows(baseAgentCommand, customCommands).map((expected) =>
    rowForExpectedProfile(expected, profiles),
  )
  const summary = { pass: 0, fail: 0, blocked: 0 }
  for (const row of rows) {
    summary[row.status] += 1
  }
  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    host: input.host ?? hostname(),
    summary,
    rows,
  }
}

export function formatRuntimeSmokeMatrix(matrix: RuntimeSmokeMatrix): string {
  const lines = [
    `ACP runtime smoke matrix (${matrix.generatedAt})`,
    `Host: ${matrix.host}`,
    `Summary: ${matrix.summary.pass} pass, ${matrix.summary.fail} fail, ${matrix.summary.blocked} blocked`,
    "",
    "| Runtime | Status | ACP | Command | Evidence |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const row of matrix.rows) {
    lines.push(
      [
        row.label,
        row.status,
        row.acp ?? "unknown",
        row.command.join(" "),
        rowEvidence(row),
      ]
        .map(escapeTableCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    )
  }
  return `${lines.join("\n")}\n`
}

function expectedRows(
  baseAgentCommand: string | string[],
  customCommands: string[][],
): ExpectedRuntimeSmokeRow[] {
  const expected: ExpectedRuntimeSmokeRow[] = [...EXPECTED_BUILT_INS]
  const normalizedBase = Array.isArray(baseAgentCommand)
    ? baseAgentCommand
    : splitCommand(baseAgentCommand)
  if (
    normalizedBase.length > 0 &&
    !expected.some((entry) => commandKey(entry.command) === commandKey(normalizedBase))
  ) {
    expected.unshift({
      runtime: "custom-acp",
      label: normalizedBase.join(" "),
      command: normalizedBase,
    })
  }
  for (const command of customCommands) {
    if (
      command.length > 0 &&
      !expected.some((entry) => commandKey(entry.command) === commandKey(command))
    ) {
      expected.push({ runtime: "custom-acp", label: command.join(" "), command })
    }
  }
  return expected
}

function rowForExpectedProfile(
  expected: { runtime: BridgeRuntimeKind | "custom-acp"; label: string; command: string[] },
  profiles: BridgeRuntimeProfile[],
): RuntimeSmokeRow {
  const profile = profiles.find(
    (candidate) =>
      commandKey(candidate.command) === commandKey(expected.command) ||
      candidate.kind === expected.runtime,
  )
  if (!profile) {
    return {
      ...expected,
      status: "blocked",
      reason: "runtime binary or profile was not discovered",
      availableCommands: 0,
      capabilities: {},
    }
  }
  const acp = profile.diagnostics?.acp ?? "unknown"
  const status = profile.status === "available" && acp === "supported" ? "pass" : "fail"
  return {
    runtime: expected.runtime,
    label: profile.label || expected.label,
    command: profile.command,
    status,
    reason: profile.diagnostics?.reason,
    acp,
    availableCommands: profile.availableCommands?.length ?? 0,
    capabilities: {
      maxSessions: profile.maxSessions,
      models: profile.models,
      modes: profile.modes,
      supportsCancel: profile.capabilities.supportsCancel,
      supportsClose: profile.capabilities.supportsClose,
      supportsResume: profile.capabilities.resumableSessions,
      supportsStructuredInteractions: profile.capabilities.supportsStructuredInteractions,
      thoughtLevels: profile.thoughtLevels,
    },
  }
}

function rowEvidence(row: RuntimeSmokeRow): string {
  const evidence = [
    row.reason,
    row.availableCommands > 0 ? `${row.availableCommands} command(s)` : undefined,
    row.capabilities.maxSessions !== undefined ? `maxSessions=${row.capabilities.maxSessions}` : undefined,
    row.capabilities.models?.length ? `models=${row.capabilities.models.join(",")}` : undefined,
    row.capabilities.thoughtLevels?.length
      ? `thoughtLevels=${row.capabilities.thoughtLevels.join(",")}`
      : undefined,
    row.capabilities.supportsCancel === true ? "cancel" : undefined,
    row.capabilities.supportsClose === true ? "close" : undefined,
    row.capabilities.supportsResume === true ? "resume" : undefined,
    row.capabilities.supportsStructuredInteractions === true ? "structured-input" : undefined,
  ].filter(Boolean)
  return evidence.length > 0 ? evidence.join("; ") : "discovered"
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|")
}

function parseSmokeArgs(argv: string[]): {
  baseAgentCommand?: string
  customCommands: string[][]
  includeAvailableCommands: boolean
  json: boolean
} {
  const customCommands: string[][] = []
  let baseAgentCommand: string | undefined
  let includeAvailableCommands = false
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--include-commands") {
      includeAvailableCommands = true
      continue
    }
    if (value === "--base-command") {
      baseAgentCommand = argv[index + 1]
      index += 1
      continue
    }
    if (value.startsWith("--base-command=")) {
      baseAgentCommand = value.slice("--base-command=".length)
      continue
    }
    if (value === "--custom-command") {
      const command = argv[index + 1]
      if (command) {
        customCommands.push(splitCommand(command))
      }
      index += 1
      continue
    }
    if (value.startsWith("--custom-command=")) {
      customCommands.push(splitCommand(value.slice("--custom-command=".length)))
    }
  }
  return { baseAgentCommand, customCommands, includeAvailableCommands, json }
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2))
  const matrix = await buildRuntimeSmokeMatrix({
    baseAgentCommand: args.baseAgentCommand,
    customCommands: args.customCommands,
    includeAvailableCommands: args.includeAvailableCommands,
  })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`)
    await shutdownSmokeProbeChildren()
    return
  }
  process.stdout.write(formatRuntimeSmokeMatrix(matrix))
  await shutdownSmokeProbeChildren()
}

async function shutdownSmokeProbeChildren() {
  terminateActiveAcpDiscoveryChildren()
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

if (import.meta.main) {
  await main()
}
