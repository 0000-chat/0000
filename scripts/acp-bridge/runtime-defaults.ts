export const DEFAULT_CODEX_ACP_COMMAND = "npx --yes @zed-industries/codex-acp@0.15.0"
export const DEFAULT_CLAUDE_CODE_ACP_COMMAND =
  "npx --yes @agentclientprotocol/claude-agent-acp@0.39.0"

export function inferRuntimeId(agentCommand: string): string {
  const normalized = agentCommand.toLowerCase()
  if (normalized.includes("claude-agent-acp") || normalized.includes("claude")) {
    return "claude-code"
  }
  if (normalized.includes("hermes")) {
    return "hermes"
  }
  if (normalized.includes("codex")) {
    return "codex"
  }
  if (normalized.includes("openclaw")) {
    return "openclaw"
  }
  return "custom-acp"
}

export function inferRuntimeLabel(agentCommand: string): string {
  const runtimeId = inferRuntimeId(agentCommand)
  if (runtimeId === "claude-code") {
    return "Claude Code"
  }
  if (runtimeId === "hermes") {
    return "Hermes"
  }
  if (runtimeId === "codex") {
    return "Codex"
  }
  if (runtimeId === "openclaw") {
    return "OpenClaw"
  }
  return "Custom ACP"
}

export function defaultProposedAgentName(agentCommand: string, host: string): string {
  return `${inferRuntimeLabel(agentCommand)} on ${host}`.slice(0, 80)
}

export function defaultAgentCommandForEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  if (
    hasAnyEnvPrefix(env, "CLAUDE_") ||
    env.CLAUDECODE ||
    env.CLAUDE_CODE ||
    env.CLAUDE_CODE_ENTRYPOINT
  ) {
    return DEFAULT_CLAUDE_CODE_ACP_COMMAND
  }
  if (hasAnyEnvPrefix(env, "CODEX_")) {
    return DEFAULT_CODEX_ACP_COMMAND
  }
  if (hasAnyEnvPrefix(env, "HERMES_")) {
    return "hermes acp"
  }
  return DEFAULT_CLAUDE_CODE_ACP_COMMAND
}

function hasAnyEnvPrefix(env: NodeJS.ProcessEnv, prefix: string): boolean {
  return Object.keys(env).some((key) => key.startsWith(prefix))
}
