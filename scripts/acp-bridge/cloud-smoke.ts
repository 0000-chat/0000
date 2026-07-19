#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { ConvexBridgeCloudClient } from "./convex-http";
import {
  BridgeDeviceRealtimeClient,
  issueBridgeDeviceRealtimeTicket,
} from "./bridge-realtime";

type BridgeRegistration = {
  appUrl: string;
  bridgeApiUrl?: string;
  bridgeToken: string;
  deviceId: string;
  deviceName?: string;
};

type CloudSmokeFlags = {
  bridgeStopped: boolean;
  deviceId?: string;
  includeClaim: boolean;
  json: boolean;
};

type SmokeEndpointResult = {
  ok: boolean;
  status: "pass" | "fail";
  detail?: string;
};

type SmokeRow = {
  deviceId: string;
  deviceName?: string;
  appUrl: string;
  realtime: SmokeEndpointResult;
  claim?: SmokeEndpointResult;
};

const DEFAULT_CONFIG_PATH = join(homedir(), ".0000", "bridge.json");

async function main() {
  const rawFlags = parseFlags(process.argv.slice(2));
  const flags: CloudSmokeFlags = {
    bridgeStopped: Boolean(rawFlags["bridge-stopped"]),
    deviceId: stringFlag(rawFlags, "device-id"),
    includeClaim: Boolean(rawFlags["include-claim"]),
    json: Boolean(rawFlags.json),
  };
  validateCloudSmokeFlags(flags);
  const configPath =
    stringFlag(rawFlags, "config") ??
    process.env.ZERO_CHAT_BRIDGE_CONFIG ??
    DEFAULT_CONFIG_PATH;
  const registrations = selectRegistrations(
    await readRegistrations(configPath),
    flags,
  );
  const rows: SmokeRow[] = [];

  for (const registration of registrations) {
    const client = new ConvexBridgeCloudClient(registration);
    const realtime: {
      client?: BridgeDeviceRealtimeClient;
      connectionEpoch?: string;
      result: SmokeEndpointResult;
    } = flags.includeClaim
      ? await connectRealtime(registration)
      : {
          result: await probe(() =>
            issueBridgeDeviceRealtimeTicket(registration),
          ),
        };
    const row: SmokeRow = {
      appUrl: registration.appUrl,
      deviceId: registration.deviceId,
      deviceName: registration.deviceName,
      realtime: realtime.result,
    };
    if (flags.includeClaim && realtime.connectionEpoch) {
      row.claim = await probe(() =>
        client.claimWork({
          connectionEpoch: realtime.connectionEpoch,
          limit: 1,
        }),
      );
    } else if (flags.includeClaim) {
      row.claim = {
        detail: "realtime_connection_unavailable",
        ok: false,
        status: "fail",
      };
    }
    await realtime.client?.close();
    rows.push(row);
  }

  if (flags.json) {
    writeStdout(
      `${JSON.stringify({ includeClaim: flags.includeClaim, rows, summary: summarize(rows) }, null, 2)}\n`,
    );
  } else {
    printTextReport(rows, flags.includeClaim);
  }

  process.exitCode = cloudSmokeExitCode(rows);
}

export function validateCloudSmokeFlags(
  flags: Pick<CloudSmokeFlags, "bridgeStopped" | "includeClaim">,
) {
  if (flags.includeClaim && !flags.bridgeStopped) {
    throw new Error(
      "--include-claim requires --bridge-stopped because a claim probe replaces the live Device Room connection",
    );
  }
}

async function connectRealtime(registration: BridgeRegistration): Promise<{
  client: BridgeDeviceRealtimeClient;
  connectionEpoch?: string;
  result: SmokeEndpointResult;
}> {
  let resolveConnected: ((connectionEpoch: string) => void) | undefined;
  const connected = new Promise<string>((resolve) => {
    resolveConnected = resolve;
  });
  const client = new BridgeDeviceRealtimeClient({
    ...registration,
    onEvent: (event) => {
      if (event.reason === "resync") {
        const connectionEpoch = client.connectionEpoch();
        if (connectionEpoch) resolveConnected?.(connectionEpoch);
      }
    },
  });
  await client.start();
  try {
    const connectionEpoch = await Promise.race([
      connected,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("realtime_connection_timeout")),
          10_000,
        ),
      ),
    ]);
    return { client, connectionEpoch, result: { ok: true, status: "pass" } };
  } catch (error) {
    return {
      client,
      result: {
        detail: normalizeErrorDetail(error),
        ok: false,
        status: "fail",
      },
    };
  }
}

function parseFlags(args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function stringFlag(
  flags: Record<string, string | true>,
  key: string,
): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

async function readRegistrations(
  configPath: string,
): Promise<BridgeRegistration[]> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as
    | BridgeRegistration
    | { registrations?: BridgeRegistration[] };
  const registrations = Array.isArray(
    (raw as { registrations?: unknown }).registrations,
  )
    ? (raw as { registrations: BridgeRegistration[] }).registrations
    : [raw as BridgeRegistration];
  return registrations.filter(
    (registration) =>
      registration &&
      typeof registration.appUrl === "string" &&
      typeof registration.bridgeToken === "string" &&
      typeof registration.deviceId === "string",
  );
}

export function selectRegistrations(
  registrations: BridgeRegistration[],
  flags: Pick<CloudSmokeFlags, "deviceId">,
): BridgeRegistration[] {
  if (!flags.deviceId) {
    return registrations;
  }
  return registrations.filter(
    (registration) => registration.deviceId === flags.deviceId,
  );
}

async function probe(
  run: () => Promise<unknown>,
): Promise<SmokeEndpointResult> {
  try {
    await run();
    return { ok: true, status: "pass" };
  } catch (error) {
    return {
      detail: normalizeErrorDetail(error),
      ok: false,
      status: "fail",
    };
  }
}

function normalizeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Bridge device credentials are invalid/i.test(message)) {
    return "bridge_credentials_invalid";
  }
  if (/Bridge device is not paired/i.test(message)) {
    return "bridge_device_not_paired";
  }
  return message
    .replace(/[A-Za-z0-9_=-]{24,}/g, "<redacted>")
    .replace(/Bearer\s+[^\s,}]+/gi, "Bearer <redacted>")
    .slice(0, 240);
}

function summarize(rows: SmokeRow[]) {
  const failed = rows.filter(
    (row) => !row.realtime.ok || row.claim?.ok === false,
  ).length;
  return {
    fail: failed,
    pass: rows.length - failed,
    total: rows.length,
  };
}

export function cloudSmokeExitCode(rows: SmokeRow[]): 0 | 1 {
  return rows.some(
    (row) => !row.realtime.ok || row.claim?.ok === false,
  )
    ? 1
    : 0;
}

function printTextReport(rows: SmokeRow[], includeClaim: boolean) {
  const summary = summarize(rows);
  writeStdout(
    `Bridge cloud smoke: ${summary.pass} pass, ${summary.fail} fail, ${summary.total} total\n`,
  );
  writeStdout("| Device | Ticket / realtime | Claim |\n");
  writeStdout("| --- | --- | --- |\n");
  for (const row of rows) {
    const label = row.deviceName
      ? `${row.deviceName} (${row.deviceId})`
      : row.deviceId;
    writeStdout(
      `| ${escapeCell(label)} | ${formatEndpoint(row.realtime)} | ${
        includeClaim ? formatEndpoint(row.claim) : "skipped"
      } |\n`,
    );
  }
}

function formatEndpoint(result?: SmokeEndpointResult): string {
  if (!result) {
    return "skipped";
  }
  return result.ok ? "pass" : `fail: ${escapeCell(result.detail ?? "unknown")}`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function writeStdout(message: string) {
  process.stdout.write(message);
}

function writeStderr(message: string) {
  process.stderr.write(message);
}

if (import.meta.main) {
  main().catch((error) => {
    writeStderr(`${normalizeErrorDetail(error)}\n`);
    process.exit(1);
  });
}
