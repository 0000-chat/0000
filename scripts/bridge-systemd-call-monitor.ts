#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import { appendLocalBridgeAudit, type LocalBridgeAuditEntry } from "./acp-bridge/local-audit-log";

const DEFAULT_UNIT = "0000-chat-bridge.service";
const TRACKED_METHODS = new Set([
  "ReloadOrRestartUnit",
  "RestartUnit",
  "StartUnit",
  "StopUnit",
  "TryRestartUnit",
]);

export type SystemdUnitCall = {
  method: string;
  sender?: string;
  unit: string;
};

type PendingMessage = {
  method?: string;
  sender?: string;
};

export function parseSystemdMonitorOutput(output: string, targetUnit = DEFAULT_UNIT): SystemdUnitCall[] {
  const parser = new SystemdMonitorParser(targetUnit);
  const calls: SystemdUnitCall[] = [];
  for (const line of output.split("\n")) {
    const call = parser.pushLine(line);
    if (call) {
      calls.push(call);
    }
  }
  return calls;
}

export class SystemdMonitorParser {
  private pending: PendingMessage | null = null;

  constructor(private readonly targetUnit = DEFAULT_UNIT) {}

  pushLine(line: string): SystemdUnitCall | undefined {
    const methodMatch = line.match(/\b[Mm]ember=([A-Za-z0-9_]+)/);
    if (methodMatch) {
      const method = methodMatch[1] ?? "";
      this.pending = TRACKED_METHODS.has(method)
        ? {
            method,
            sender: line.match(/\b[Ss]ender=([^\s]+)/)?.[1],
          }
        : null;
      return undefined;
    }
    if (!this.pending?.method) {
      return undefined;
    }
    const unitMatch = line.match(/^\s*(?:string|STRING)\s+"([^"]+)"/);
    if (!unitMatch) {
      return undefined;
    }
    const unit = unitMatch[1] ?? "";
    const pending = this.pending;
    const method = pending.method;
    this.pending = null;
    if (!method) {
      return undefined;
    }
    if (unit !== this.targetUnit) {
      return undefined;
    }
    return {
      method,
      sender: pending.sender,
      unit,
    };
  }
}

export function buildSystemdUnitCallEntry(input: {
  caller?: Record<string, unknown>;
  call: SystemdUnitCall;
}): LocalBridgeAuditEntry {
  return {
    event: "bridge.systemd.unit_call",
    level: "info",
    service: "bridge-systemd-call-monitor",
    unit: input.call.unit,
    systemdMethod: input.call.method,
    systemdSender: input.call.sender,
    caller: input.caller,
  };
}

export function collectCallerMetadata(sender: string | undefined): Record<string, unknown> | undefined {
  if (!sender) {
    return undefined;
  }
  const pid = readSenderUnixProcessId(sender);
  if (pid === undefined) {
    return { sender };
  }
  return {
    sender,
    pid,
    uid: readProcNumber(pid, "status", /^Uid:\s+(\d+)/m),
    ppid: readProcNumber(pid, "status", /^PPid:\s+(\d+)/m),
    basename: readProcBasename(pid),
    cwd: readProcSymlink(pid, "cwd"),
    cmdlineHash: readProcCmdlineHash(pid),
  };
}

async function main() {
  const unit = valueAfter(process.argv.slice(2), "--unit") ?? DEFAULT_UNIT;
  const parser = new SystemdMonitorParser(unit);
  const monitor = spawn("busctl", [
    "--user",
    "monitor",
    "org.freedesktop.systemd1",
  ], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: monitor.stdout });
  for await (const line of lines) {
    const call = parser.pushLine(line);
    if (!call) {
      continue;
    }
    appendLocalBridgeAudit(
      buildSystemdUnitCallEntry({
        call,
        caller: collectCallerMetadata(call.sender),
      }),
    );
  }
}

function readSenderUnixProcessId(sender: string): number | undefined {
  try {
    const output = execFileSync("busctl", [
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "GetConnectionUnixProcessID",
      "s",
      sender,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return Number(output.match(/\bu\s+(\d+)/)?.[1]);
  } catch {
    return undefined;
  }
}

function readProcBasename(pid: number): string | undefined {
  const exe = readProcSymlink(pid, "exe");
  if (exe) {
    return basename(exe);
  }
  const comm = readProcFile(pid, "comm")?.trim();
  return comm || undefined;
}

function readProcCmdlineHash(pid: number): string | undefined {
  const cmdline = readProcFile(pid, "cmdline");
  if (!cmdline) {
    return undefined;
  }
  return createHash("sha256").update(cmdline).digest("hex");
}

function readProcNumber(pid: number, file: string, pattern: RegExp): number | undefined {
  const value = readProcFile(pid, file)?.match(pattern)?.[1];
  return value ? Number(value) : undefined;
}

function readProcFile(pid: number, file: string): string | undefined {
  const path = `/proc/${pid}/${file}`;
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function readProcSymlink(pid: number, name: string): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/${name}`);
  } catch {
    return undefined;
  }
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.main) {
  await main();
}
