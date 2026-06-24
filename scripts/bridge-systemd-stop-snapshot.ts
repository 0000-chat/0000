#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { appendLocalBridgeAudit, type LocalBridgeAuditEntry } from "./acp-bridge/local-audit-log";

const DEFAULT_UNIT = "0000-chat-bridge.service";

type StopSnapshotArgs = {
  statusPath: string;
  unit: string;
};

export function parseStopSnapshotArgs(argv: string[]): StopSnapshotArgs {
  return {
    statusPath:
      valueAfter(argv, "--status-path") ??
      process.env.ZERO_CHAT_BRIDGE_STATUS ??
      join(homedir(), ".0000", "bridge-status.json"),
    unit: valueAfter(argv, "--unit") ?? DEFAULT_UNIT,
  };
}

export function parseSystemctlShow(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

export function summarizeBridgeStatus(raw: string): Record<string, unknown> {
  const status = JSON.parse(raw) as Record<string, unknown>;
  const runtimeIdentity = objectValue(status.runtimeIdentity);
  const runtimeConformance = objectValue(status.runtimeConformance);
  const processHealth = objectValue(status.processHealth);
  return {
    connected: status.connected,
    lifecycle: status.lifecycle,
    lastHeartbeatAt: status.lastHeartbeatAt,
    lastStartedAt: status.lastStartedAt,
    pid: runtimeIdentity?.pid,
    bridgeVersion: runtimeIdentity?.bridgeVersion,
    runtimeConformance: runtimeConformance
      ? {
          canClaim: runtimeConformance.canClaim,
          status: runtimeConformance.status,
        }
      : undefined,
    processHealth: processHealth
      ? {
          canClaim: processHealth.canClaim,
          status: processHealth.status,
        }
      : undefined,
    recentErrorCount: Array.isArray(status.recentErrors) ? status.recentErrors.length : undefined,
    runtimeProfileCount: Array.isArray(status.runtimeProfiles)
      ? status.runtimeProfiles.length
      : undefined,
  };
}

export function buildStopSnapshotEntry(input: {
  env: Record<string, string | undefined>;
  statusSummary?: Record<string, unknown>;
  systemd: Record<string, string>;
  unit: string;
}): LocalBridgeAuditEntry {
  return {
    event: "bridge.systemd.stop_snapshot",
    level: "info",
    service: "bridge-systemd-stop-snapshot",
    unit: input.unit,
    serviceResult: input.env.SERVICE_RESULT,
    exitCode: input.env.EXIT_CODE,
    exitStatus: input.env.EXIT_STATUS,
    invocationId: input.systemd.InvocationID,
    systemdActiveState: input.systemd.ActiveState,
    systemdSubState: input.systemd.SubState,
    systemdResult: input.systemd.Result,
    statusSummary: input.statusSummary,
  };
}

async function main() {
  const args = parseStopSnapshotArgs(process.argv.slice(2));
  const systemd = parseSystemctlShow(readSystemctlShow(args.unit));
  const statusSummary = existsSync(args.statusPath)
    ? summarizeBridgeStatus(readFileSync(args.statusPath, "utf8"))
    : undefined;
  appendLocalBridgeAudit(
    buildStopSnapshotEntry({
      env: process.env,
      statusSummary,
      systemd,
      unit: args.unit,
    }),
  );
}

function readSystemctlShow(unit: string): string {
  try {
    return execFileSync("systemctl", [
      "--user",
      "show",
      unit,
      "-p",
      "ActiveState",
      "-p",
      "SubState",
      "-p",
      "Result",
      "-p",
      "InvocationID",
      "-p",
      "ExecMainCode",
      "-p",
      "ExecMainStatus",
      "-p",
      "MainPID",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return `ReadError=${error instanceof Error ? error.message : String(error)}`;
  }
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

if (import.meta.main) {
  await main();
}
