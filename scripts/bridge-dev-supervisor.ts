import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import {
  shouldRestartBridgeForDevHotReload,
  type DevHotReloadStatus,
} from "./hermes-bridge/dev-hot-reload"

type SupervisorConfig = {
  command: string[]
  statusPath: string
  watchPaths: string[]
  idlePollMs: number
  restartGraceMs: number
}

const DEFAULT_STATUS_PATH = join(homedir(), ".0000", "bridge-status.json")
const DEFAULT_WATCH_PATHS = ["scripts/acp-bridge.ts", "scripts/hermes-bridge"]

async function main() {
  const config = parseArgs(process.argv.slice(2))
  const supervisor = new BridgeDevSupervisor(config)
  await supervisor.run()
}

class BridgeDevSupervisor {
  private child: ChildProcess | null = null
  private restartPending = false
  private restarting = false
  private stopped = false
  private readonly watchers: FSWatcher[] = []

  constructor(private readonly config: SupervisorConfig) {}

  async run() {
    this.installSignalHandlers()
    this.installWatchers()
    this.startBridge("initial start")

    while (!this.stopped) {
      if (this.restartPending && !this.restarting) {
        await this.restartWhenIdle()
      }
      await delay(this.config.idlePollMs)
    }
  }

  private installSignalHandlers() {
    const stop = () => void this.stop()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  }

  private installWatchers() {
    for (const watchPath of this.config.watchPaths) {
      for (const directory of directoriesForWatchPath(resolve(watchPath))) {
        const watcher = watch(directory, { persistent: true }, () => {
          this.restartPending = true
        })
        this.watchers.push(watcher)
      }
    }
  }

  private startBridge(reason: string) {
    const [command, ...args] = this.config.command
    this.child = spawn(command, args, {
      env: {
        ...process.env,
        ZERO_CHAT_DEV_HOT_RELOAD: "1",
        ZERO_CHAT_DEV_HOT_RELOAD_REASON: reason,
      },
      stdio: "inherit",
    })
    this.child.once("exit", () => {
      this.child = null
      if (!this.stopped && !this.restarting) {
        this.startBridge("bridge process exited")
      }
    })
  }

  private async restartWhenIdle() {
    this.restarting = true
    try {
      const status = readStatusFile(this.config.statusPath)
      const decision = shouldRestartBridgeForDevHotReload(status)
      if (!decision.ready) {
        return
      }
      this.restartPending = false
      await this.restartBridge("bridge files changed")
    } finally {
      this.restarting = false
    }
  }

  private async restartBridge(reason: string) {
    const child = this.child
    if (child) {
      child.kill("SIGTERM")
      const exited = waitForExit(child)
      const timeout = delay(this.config.restartGraceMs).then(() => "timeout" as const)
      if ((await Promise.race([exited, timeout])) === "timeout") {
        child.kill("SIGKILL")
        await exited
      }
    }
    if (!this.stopped) {
      this.startBridge(reason)
    }
  }

  private async stop() {
    this.stopped = true
    for (const watcher of this.watchers) {
      watcher.close()
    }
    const child = this.child
    if (child) {
      child.kill("SIGTERM")
      await waitForExit(child)
    }
  }
}

function parseArgs(argv: string[]): SupervisorConfig {
  const bridgeSeparator = argv.indexOf("--")
  const supervisorArgs = bridgeSeparator === -1 ? argv : argv.slice(0, bridgeSeparator)
  const command =
    bridgeSeparator === -1 || bridgeSeparator === argv.length - 1
      ? ["bun", "scripts/acp-bridge.ts", "start"]
      : argv.slice(bridgeSeparator + 1)

  return {
    command,
    statusPath: valueAfter(supervisorArgs, "--status-path") ?? DEFAULT_STATUS_PATH,
    watchPaths: valuesAfter(supervisorArgs, "--watch").flatMap((value) =>
      value.split(",").map((entry) => entry.trim()).filter(Boolean),
    ).length
      ? valuesAfter(supervisorArgs, "--watch").flatMap((value) =>
          value.split(",").map((entry) => entry.trim()).filter(Boolean),
        )
      : DEFAULT_WATCH_PATHS,
    idlePollMs: numberAfter(supervisorArgs, "--idle-poll-ms", 1000),
    restartGraceMs: numberAfter(supervisorArgs, "--restart-grace-ms", 10_000),
  }
}

function readStatusFile(path: string): DevHotReloadStatus {
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DevHotReloadStatus
  } catch {
    return {}
  }
}

function directoriesForWatchPath(path: string): string[] {
  if (!existsSync(path)) {
    return []
  }
  if (!statSync(path).isDirectory()) {
    return [resolve(path, "..")]
  }
  const directories = [path]
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(...directoriesForWatchPath(join(path, entry.name)))
    }
  }
  return directories
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function valuesAfter(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1])
      index += 1
    }
  }
  return values
}

function numberAfter(args: string[], name: string, fallback: number): number {
  const value = Number(valueAfter(args, name))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function waitForExit(child: ChildProcess): Promise<"exit"> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit("exit")
      return
    }
    child.once("exit", () => resolveExit("exit"))
  })
}

if (import.meta.main) {
  await main()
}
