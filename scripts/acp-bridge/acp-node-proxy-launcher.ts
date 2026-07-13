import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

const VOLTA_NODE_LOOKUP_TIMEOUT_MS = 1_000

export function resolveNodeProxyExecutable(
  env: NodeJS.ProcessEnv | undefined = process.env,
): string {
  const voltaExecutable = resolveExecutableFromPath("volta", env)
  if (voltaExecutable) {
    const voltaNodeExecutable = resolveVoltaNodeExecutable(voltaExecutable, env)
    if (voltaNodeExecutable) {
      return voltaNodeExecutable
    }
  }
  return resolveExecutableFromPath("node", env) ?? "node"
}

function resolveVoltaNodeExecutable(
  voltaExecutable: string,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  try {
    const output = execFileSync(voltaExecutable, ["which", "node"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VOLTA_NODE_LOOKUP_TIMEOUT_MS,
    })
    const candidate = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return candidate && isExecutable(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function resolveExecutableFromPath(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (!command || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : undefined
  }

  for (const directory of (env?.PATH ?? process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue
    }
    const candidate = join(directory, command)
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return undefined
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
