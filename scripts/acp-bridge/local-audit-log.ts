import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BridgeLogEntry, FlushableBridgeLogger } from "./bridge-log";

const AUDIT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const AUDIT_DIRECTORY_MODE = 0o700;
const AUDIT_FILE_MODE = 0o600;
const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|prompt|stdout|stderr|body|payload|content|messageText|rawCommand|commandLine|cmdline|argv)$/i;
const LOCAL_ID_KEY_PATTERN =
  /(?:threadId|sessionId|agentSessionId|acpSessionId|queueId|deviceId|registrationKey|bridgeDeviceId)$/i;
const SAFE_PREVIEW_KEY_PATTERN = /(?:exe|executable|comm|basename|method|unit|sender|service|event|level|reason|signal|cwd|status|serviceResult|exitCode|exitSignal)$/i;

export type LocalAuditLogOptions = {
  env?: Record<string, string | undefined>;
  maxBytes?: number;
  maxFiles?: number;
  path?: string;
  stderr?: Pick<typeof process.stderr, "write">;
};

export type LocalBridgeAuditEntry = BridgeLogEntry & {
  caller?: Record<string, unknown>;
  cwd?: string;
  exitCode?: number | string | null;
  exitSignal?: string | null;
  invocationId?: string;
  pid?: number;
  ppid?: number;
  reason?: string;
  schemaVersion?: number;
  service?: string;
  serviceResult?: string;
  signal?: NodeJS.Signals | string;
  ts?: string;
  uid?: number;
  unit?: string;
};

export function getDefaultBridgeAuditPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.ZERO_CHAT_BRIDGE_AUDIT_LOG?.trim() || join(homedir(), ".0000", "bridge-audit.jsonl");
}

export function sanitizeBridgeAuditEntry(entry: LocalBridgeAuditEntry): Record<string, unknown> {
  return sanitizeValue(entry) as Record<string, unknown>;
}

export function appendLocalBridgeAudit(
  entry: LocalBridgeAuditEntry,
  options: LocalAuditLogOptions = {},
): void {
  const env = options.env ?? process.env;
  if (env.ZERO_CHAT_BRIDGE_AUDIT_DISABLED === "1") {
    return;
  }
  const path = options.path ?? getDefaultBridgeAuditPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: AUDIT_DIRECTORY_MODE });
  chmodSync(dirname(path), AUDIT_DIRECTORY_MODE);
  rotateAuditLog(path, options.maxBytes ?? DEFAULT_MAX_BYTES, options.maxFiles ?? DEFAULT_MAX_FILES);
  const enriched = sanitizeBridgeAuditEntry({
    ...entry,
    cwd: entry.cwd ?? safeCwd(),
    pid: entry.pid ?? process.pid,
    ppid: entry.ppid ?? process.ppid,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    service: entry.service ?? "acp-bridge",
    ts: entry.ts ?? new Date().toISOString(),
    uid: entry.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
  });
  appendFileSync(path, `${JSON.stringify(enriched)}\n`, { mode: AUDIT_FILE_MODE });
  chmodSync(path, AUDIT_FILE_MODE);
}

export function createLocalAuditBridgeLogger(
  options: LocalAuditLogOptions = {},
): FlushableBridgeLogger {
  const stderr = options.stderr ?? process.stderr;
  const logger = ((entry: BridgeLogEntry) => {
    try {
      appendLocalBridgeAudit(entry, options);
    } catch (error) {
      stderr.write(
        `${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "bridge.audit.write_failed",
          level: "warn",
          service: "acp-bridge",
          ts: new Date().toISOString(),
        })}\n`,
      );
    }
  }) as FlushableBridgeLogger;

  logger.flush = async () => {};

  return logger;
}

function rotateAuditLog(path: string, maxBytes: number, maxFiles: number): void {
  if (maxBytes <= 0 || maxFiles <= 0 || !existsSync(path)) {
    return;
  }
  if (statSync(path).size < maxBytes) {
    return;
  }
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    const target = `${path}.${index + 1}`;
    if (existsSync(source)) {
      renameSync(source, target);
    }
  }
  renameSync(path, `${path}.1`);
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return REDACTED;
    }
    if (LOCAL_ID_KEY_PATTERN.test(key)) {
      return hashedToken(value);
    }
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, key));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(childKey)) {
      redacted[childKey] = REDACTED;
      continue;
    }
    if (typeof childValue === "string" && LOCAL_ID_KEY_PATTERN.test(childKey)) {
      redacted[childKey] = hashedToken(childValue);
      continue;
    }
    if (typeof childValue === "string" && SAFE_PREVIEW_KEY_PATTERN.test(childKey)) {
      redacted[childKey] = redactSensitiveString(childValue);
      continue;
    }
    redacted[childKey] = sanitizeValue(childValue, childKey);
  }
  return redacted;
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,}\]]+/gi, "Bearer [redacted]")
    .replace(
      /("?authorization"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    )
    .replace(
      /("?(?:bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|prompt)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    );
}

function hashedToken(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `[sha256:${hash}]`;
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
