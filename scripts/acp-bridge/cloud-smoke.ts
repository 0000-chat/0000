#!/usr/bin/env bun
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

import { ConvexBridgeCloudClient } from "./convex-http"

type BridgeRegistration = {
  appUrl: string
  bridgeApiUrl?: string
  bridgeToken: string
  deviceId: string
  deviceName?: string
}

type SmokeEndpointResult = {
  ok: boolean
  status: "pass" | "fail"
  detail?: string
}

type SmokeRow = {
  deviceId: string
  deviceName?: string
  appUrl: string
  heartbeat: SmokeEndpointResult
  poll: SmokeEndpointResult
  claim?: SmokeEndpointResult
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".0000", "bridge.json")

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const configPath = stringFlag(flags, "config") ?? process.env.ZERO_CHAT_BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH
  const includeClaim = Boolean(flags["include-claim"])
  const registrations = await readRegistrations(configPath)
  const rows: SmokeRow[] = []

  for (const registration of registrations) {
    const client = new ConvexBridgeCloudClient(registration)
    const row: SmokeRow = {
      appUrl: registration.appUrl,
      deviceId: registration.deviceId,
      deviceName: registration.deviceName,
      heartbeat: await probe(() =>
        client.heartbeat({
          capabilities: { smoke: true },
          status: {
            activeQueueItemIds: [],
            activeSessions: [],
            connected: true,
            inFlightCommands: [],
            maxInFlight: 0,
            recentErrors: [],
            sessionQueues: [],
          },
        }),
      ),
      poll: await probe(() => client.pollQueue({ limit: 1 })),
    }
    if (includeClaim) {
      row.claim = await probe(() => client.claimWork({ limit: 1 }))
    }
    rows.push(row)
  }

  if (flags.json) {
    writeStdout(`${JSON.stringify({ includeClaim, rows, summary: summarize(rows) }, null, 2)}\n`)
  } else {
    printTextReport(rows, includeClaim)
  }

  if (rows.some((row) => !row.heartbeat.ok || !row.poll.ok || row.claim?.ok === false)) {
    process.exitCode = 1
  }
}

function parseFlags(args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith("--")) {
      continue
    }
    const key = arg.slice(2)
    const next = args[index + 1]
    if (next && !next.startsWith("--")) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

function stringFlag(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === "string" ? value : undefined
}

async function readRegistrations(configPath: string): Promise<BridgeRegistration[]> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as
    | BridgeRegistration
    | { registrations?: BridgeRegistration[] }
  const registrations = Array.isArray((raw as { registrations?: unknown }).registrations)
    ? (raw as { registrations: BridgeRegistration[] }).registrations
    : [raw as BridgeRegistration]
  return registrations.filter(
    (registration) =>
      registration &&
      typeof registration.appUrl === "string" &&
      typeof registration.bridgeToken === "string" &&
      typeof registration.deviceId === "string",
  )
}

async function probe(
  run: () => Promise<unknown>,
): Promise<SmokeEndpointResult> {
  try {
    await run()
    return { ok: true, status: "pass" }
  } catch (error) {
    return {
      detail: normalizeErrorDetail(error),
      ok: false,
      status: "fail",
    }
  }
}

function normalizeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Bridge device credentials are invalid/i.test(message)) {
    return "bridge_credentials_invalid"
  }
  if (/Bridge device is not paired/i.test(message)) {
    return "bridge_device_not_paired"
  }
  return message
    .replace(/[A-Za-z0-9_=-]{24,}/g, "<redacted>")
    .replace(/Bearer\s+[^\s,}]+/gi, "Bearer <redacted>")
    .slice(0, 240)
}

function summarize(rows: SmokeRow[]) {
  const failed = rows.filter((row) => !row.heartbeat.ok || !row.poll.ok || row.claim?.ok === false).length
  return {
    fail: failed,
    pass: rows.length - failed,
    total: rows.length,
  }
}

function printTextReport(rows: SmokeRow[], includeClaim: boolean) {
  const summary = summarize(rows)
  writeStdout(`Bridge cloud smoke: ${summary.pass} pass, ${summary.fail} fail, ${summary.total} total\n`)
  writeStdout("| Device | Heartbeat | Poll | Claim |\n")
  writeStdout("| --- | --- | --- | --- |\n")
  for (const row of rows) {
    const label = row.deviceName ? `${row.deviceName} (${row.deviceId})` : row.deviceId
    writeStdout(
      `| ${escapeCell(label)} | ${formatEndpoint(row.heartbeat)} | ${formatEndpoint(row.poll)} | ${
        includeClaim ? formatEndpoint(row.claim) : "skipped"
      } |\n`,
    )
  }
}

function formatEndpoint(result?: SmokeEndpointResult): string {
  if (!result) {
    return "skipped"
  }
  return result.ok ? "pass" : `fail: ${escapeCell(result.detail ?? "unknown")}`
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim()
}

function writeStdout(message: string) {
  process.stdout.write(message)
}

function writeStderr(message: string) {
  process.stderr.write(message)
}

main().catch((error) => {
  writeStderr(`${normalizeErrorDetail(error)}\n`)
  process.exit(1)
})
