import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

import { bridgeLogEventNames, isBridgeLogEventName } from "./hermes-bridge/bridge-log"

type CheckOptions = {
  files?: string[]
  readFile?: (filename: string) => string
}

const rawConsolePattern = /\bconsole\.(?:log|info|warn|error|debug)\s*\(/g
const eventLiteralPattern = /\bevent:\s*"([^"]+)"/g
const writeAgentTurnEventPattern = /\bwriteAgentTurnLog\(\s*"([^"]+)"/g
const sensitiveLogFieldPattern =
  /\b(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|prompt)\s*:/
const allowedSensitiveFiles = new Set(["scripts/hermes-bridge/bridge-log.ts"])

export function listBridgeSourceFiles() {
  const rgFiles = spawnSync("rg", ["--files", "scripts"], { encoding: "utf8" })
  if (rgFiles.status === 0) {
    return rgFiles.stdout.trim().split("\n").filter((filename) => filename.endsWith(".ts"))
  }
  const reason = rgFiles.error?.message || rgFiles.stderr || `exit ${rgFiles.status ?? 1}`
  throw new Error(`could not list bridge source files: ${reason}`)
}

export function checkBridgeObservability(options: CheckOptions = {}) {
  const files = options.files ?? listBridgeSourceFiles()
  const readFile = options.readFile ?? ((filename) => readFileSync(filename, "utf8"))
  const reports: string[] = []

  for (const filename of files) {
    if (!filename.endsWith(".ts") || filename.endsWith(".test.ts")) continue
    const source = readFile(filename)

    for (const match of source.matchAll(rawConsolePattern)) {
      reports.push(`${filename} uses raw ${match[0].replace(/\s*\($/, "")}; use BridgeLogger or an explicit stdout/stderr writer boundary`)
    }

    for (const eventName of findEventNames(source)) {
      if (!isBridgeLogEventName(eventName)) {
        reports.push(`${filename} references unregistered bridge log event ${eventName}`)
      }
    }

    if (!allowedSensitiveFiles.has(filename)) {
      for (const logWindow of findEventObjectWindows(source)) {
        if (sensitiveLogFieldPattern.test(logWindow)) {
          reports.push(`${filename} contains sensitive log-like field names; redact through bridge-log.ts before emitting`)
          break
        }
      }
    }
  }

  return reports
}

function findEventNames(source: string) {
  const eventNames = new Set<string>()
  for (const match of source.matchAll(eventLiteralPattern)) {
    eventNames.add(match[1])
  }
  for (const match of source.matchAll(writeAgentTurnEventPattern)) {
    eventNames.add(match[1])
  }
  return eventNames
}

function findEventObjectWindows(source: string) {
  return [...source.matchAll(eventLiteralPattern)].map((match) =>
    source.slice(Math.max(0, match.index - 180), Math.min(source.length, match.index + 360)),
  )
}

if (import.meta.main) {
  const reports = checkBridgeObservability()
  for (const report of reports) {
    process.stderr.write(`${report}\n`)
  }
  if (reports.length > 0) {
    process.exit(1)
  }
  process.stdout.write(`bridge observability check passed (${bridgeLogEventNames.length} registered events)\n`)
}
