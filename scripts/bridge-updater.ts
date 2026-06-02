#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const STATUS_MODE = 0o600

type UpdaterArgs = {
  currentVersion?: string
  parentPid?: number
  repoPath: string
  restartCommand: string[]
  statusPath?: string
}

type UpdateState = {
  lifecycle?: string
  updateState?: Record<string, unknown>
}

async function main() {
  const args = parseUpdaterArgs(process.argv.slice(2))
  await runBridgeUpdate(args)
}

export function buildRestartCommandArgs(command: string[]): string[] {
  return ["--restart-command", JSON.stringify(command)]
}

export function normalizeReleaseTag(value: string): string | undefined {
  const ref = value.trim().split(/\s+/).at(-1) ?? value.trim()
  const normalized = ref
    .replace(/^refs\/tags\//, "")
    .replace(/\^\{\}$/, "")
    .trim()
  return /^v\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined
}

export function chooseLatestReleaseTag(
  rawTags: string[],
  currentVersion?: string,
): string | undefined {
  const current = currentVersion ? parseStableVersion(currentVersion) : undefined
  const candidates = rawTags
    .map(normalizeReleaseTag)
    .filter((tag) => tag !== undefined)
    .map((tag) => ({ tag, version: parseStableVersion(tag) }))
    .filter(
      (candidate): candidate is { tag: string; version: [number, number, number] } =>
        candidate.version !== undefined,
    )
    .filter((candidate) => !current || compareVersions(candidate.version, current) > 0)
    .sort((left, right) => compareVersions(right.version, left.version))
  return candidates[0]?.tag
}

export async function runBridgeUpdate(args: UpdaterArgs): Promise<void> {
  await waitForParentExit(args.parentPid)
  await writeUpdaterStatus(args.statusPath, {
    lifecycle: "updating",
    updateState: {
      status: "installing",
      currentVersion: args.currentVersion,
      startedAt: Date.now(),
    },
  })

  try {
    await assertCleanCheckout(args.repoPath)
    const tags = await listRemoteReleaseTags(args.repoPath)
    const targetTag = chooseLatestReleaseTag(tags, args.currentVersion)
    if (targetTag) {
      await runProcess("git", ["-C", args.repoPath, "fetch", "--tags", "--force", "origin", targetTag])
      await runProcess("git", ["-C", args.repoPath, "checkout", "--detach", targetTag])
      await runProcess("bun", ["install"], { cwd: args.repoPath })
    }
    await writeUpdaterStatus(args.statusPath, {
      lifecycle: "restarting",
      updateState: {
        status: targetTag ? "updated" : "upToDate",
        currentVersion: args.currentVersion,
        targetVersion: targetTag?.replace(/^v/, ""),
        completedAt: Date.now(),
      },
    })
  } catch (error) {
    await writeUpdaterStatus(args.statusPath, {
      lifecycle: "error",
      updateState: {
        status: "failed",
        currentVersion: args.currentVersion,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }

  spawn(args.restartCommand[0], args.restartCommand.slice(1), {
    cwd: args.repoPath,
    detached: true,
    stdio: "ignore",
  }).unref()
}

async function assertCleanCheckout(repoPath: string): Promise<void> {
  const { stdout } = await runProcess("git", ["-C", repoPath, "status", "--porcelain"])
  if (stdout.trim()) {
    throw new Error("Bridge checkout has local changes; refusing automatic update.")
  }
}

async function listRemoteReleaseTags(repoPath: string): Promise<string[]> {
  const { stdout } = await runProcess("git", ["-C", repoPath, "ls-remote", "--tags", "origin"])
  return stdout.split(/\r?\n/)
}

async function waitForParentExit(parentPid?: number): Promise<void> {
  if (!parentPid || parentPid <= 0) {
    return
  }
  while (processExists(parentPid)) {
    await delay(250)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseUpdaterArgs(argv: string[]): UpdaterArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith("--")) {
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} requires a value`)
    }
    values.set(key.slice(2), value)
    index += 1
  }

  const repoPath = values.get("repo-path")
  if (!repoPath) {
    throw new Error("--repo-path is required")
  }
  const restartCommandRaw = values.get("restart-command")
  if (!restartCommandRaw) {
    throw new Error("--restart-command is required")
  }
  const restartCommand = JSON.parse(restartCommandRaw)
  if (
    !Array.isArray(restartCommand) ||
    restartCommand.length === 0 ||
    restartCommand.some((part) => typeof part !== "string")
  ) {
    throw new Error("--restart-command must be a JSON array of strings")
  }

  const parentPidRaw = values.get("parent-pid")
  const parentPid = parentPidRaw ? Number(parentPidRaw) : undefined
  return {
    currentVersion: values.get("current-version"),
    parentPid: Number.isFinite(parentPid) ? parentPid : undefined,
    repoPath,
    restartCommand,
    statusPath: values.get("status-path"),
  }
}

async function writeUpdaterStatus(statusPath: string | undefined, patch: UpdateState) {
  if (!statusPath) {
    return
  }
  const existing = existsSync(statusPath)
    ? JSON.parse(await readFile(statusPath, "utf8"))
    : { connected: false, activeSessions: [], recentErrors: [] }
  const next = {
    ...existing,
    ...patch,
  }
  await mkdir(dirname(statusPath), { recursive: true, mode: 0o700 })
  const tempPath = `${statusPath}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: STATUS_MODE })
  await chmod(tempPath, STATUS_MODE)
  await rename(tempPath, statusPath)
}

function parseStableVersion(value: string): [number, number, number] | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    return undefined
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout })
        return
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${stderr}`))
    })
  })
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
