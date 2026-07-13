import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { RuntimeConformanceRecord } from "./runtime-conformance"
import type { BridgeRuntimeKind, BridgeRuntimeProfile } from "./runtime-profiles"

export const RUNTIME_CATALOG_CACHE_SCHEMA_VERSION = 1
export const RUNTIME_PROFILE_CACHE_SCHEMA_VERSION = 1
export const RUNTIME_CONFORMANCE_CACHE_SCHEMA_VERSION = 1
export const DEFAULT_RUNTIME_CATALOG_CACHE_PATH = join(
  homedir(),
  ".0000",
  "runtime-catalog-cache.json",
)

const PRIVATE_FILE_MODE = 0o600
const SECRETISH_KEY = /(authorization|bridge[-_]?token|credentials?|password|secret|token|api[-_]?key)/i
const SECRETISH_VALUE =
  /\b(authorization|password|secret|token|api[-_]?key)\s*[:=]\s*[^,\s"'}\]]+/gi

type RuntimeCatalogCacheFile = {
  cacheKey: string
  generatedAt: number
  schemaVersion: number
  conformanceSchemaVersion: number
  profileSchemaVersion: number
  profiles: BridgeRuntimeProfile[]
  conformanceRecords: Record<string, RuntimeConformanceRecord>
}

export type RuntimeCatalogCacheLoadResult = {
  cacheKey: string
  conformanceRecords: Record<string, RuntimeConformanceRecord>
  generatedAt: number
  profiles: BridgeRuntimeProfile[]
}

export function runtimeCatalogCacheKey(input: {
  bridgeVersion: string
  runtimeCommandKeys: string[][]
}): string {
  const runtimeCommandKeys = input.runtimeCommandKeys
    .map((command) => command.filter((part) => typeof part === "string"))
    .sort(compareStringArrays)
  return createHash("sha256")
    .update(
      JSON.stringify({
        bridgeVersion: input.bridgeVersion,
        conformanceSchemaVersion: RUNTIME_CONFORMANCE_CACHE_SCHEMA_VERSION,
        profileSchemaVersion: RUNTIME_PROFILE_CACHE_SCHEMA_VERSION,
        runtimeCommandKeys,
        schemaVersion: RUNTIME_CATALOG_CACHE_SCHEMA_VERSION,
      }),
    )
    .digest("hex")
}

export async function loadRuntimeCatalogCache(input: {
  bridgeVersion: string
  cachePath?: string
  now: number
  runtimeCommandKeys: string[][]
  ttlMs: number
}): Promise<RuntimeCatalogCacheLoadResult | null> {
  const cachePath = input.cachePath ?? DEFAULT_RUNTIME_CATALOG_CACHE_PATH
  if (!existsSync(cachePath)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(cachePath, "utf8"))
  } catch {
    return null
  }
  const file = parseCacheFile(parsed)
  if (!file) {
    return null
  }
  const expectedKey = runtimeCatalogCacheKey(input)
  if (file.cacheKey !== expectedKey) {
    return null
  }
  if (input.now - file.generatedAt > input.ttlMs) {
    return null
  }
  const profiles: BridgeRuntimeProfile[] = []
  const conformanceRecords: Record<string, RuntimeConformanceRecord> = {}
  for (const profile of file.profiles) {
    profiles.push(profile)
    const record = file.conformanceRecords[profile.id]
    if (!isSafeCachedConformanceRecord(record, profile.id, input.now, input.ttlMs)) {
      continue
    }
    conformanceRecords[profile.id] = record
  }
  if (profiles.length === 0) {
    return null
  }
  return {
    cacheKey: file.cacheKey,
    conformanceRecords,
    generatedAt: file.generatedAt,
    profiles,
  }
}

export async function writeRuntimeCatalogCache(input: {
  bridgeVersion: string
  cachePath?: string
  conformanceRecords: Record<string, RuntimeConformanceRecord | undefined>
  now: number
  profiles: BridgeRuntimeProfile[]
  runtimeCommandKeys: string[][]
  ttlMs: number
}): Promise<void> {
  const cachePath = input.cachePath ?? DEFAULT_RUNTIME_CATALOG_CACHE_PATH
  const profiles: BridgeRuntimeProfile[] = []
  const conformanceRecords: Record<string, RuntimeConformanceRecord> = {}
  for (const profile of input.profiles) {
    if (hasSecretishCommand(profile.command)) {
      continue
    }
    const sanitizedProfile = sanitizeRuntimeProfile(profile)
    profiles.push(sanitizedProfile)
    const record = sanitizeConformanceRecord(input.conformanceRecords[sanitizedProfile.id])
    if (!record || !isSafeCachedConformanceRecord(record, sanitizedProfile.id, input.now, input.ttlMs)) {
      continue
    }
    conformanceRecords[sanitizedProfile.id] = record
  }
  const payload: RuntimeCatalogCacheFile = {
    cacheKey: runtimeCatalogCacheKey(input),
    conformanceRecords,
    conformanceSchemaVersion: RUNTIME_CONFORMANCE_CACHE_SCHEMA_VERSION,
    generatedAt: input.now,
    profileSchemaVersion: RUNTIME_PROFILE_CACHE_SCHEMA_VERSION,
    profiles,
    schemaVersion: RUNTIME_CATALOG_CACHE_SCHEMA_VERSION,
  }
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  })
  await chmod(tmpPath, PRIVATE_FILE_MODE)
  await rename(tmpPath, cachePath)
  await chmod(cachePath, PRIVATE_FILE_MODE).catch(() => undefined)
}

function parseCacheFile(raw: unknown): RuntimeCatalogCacheFile | null {
  if (!isRecord(raw)) {
    return null
  }
  if (
    raw.schemaVersion !== RUNTIME_CATALOG_CACHE_SCHEMA_VERSION ||
    raw.profileSchemaVersion !== RUNTIME_PROFILE_CACHE_SCHEMA_VERSION ||
    raw.conformanceSchemaVersion !== RUNTIME_CONFORMANCE_CACHE_SCHEMA_VERSION ||
    typeof raw.cacheKey !== "string" ||
    typeof raw.generatedAt !== "number" ||
    !Array.isArray(raw.profiles) ||
    !isRecord(raw.conformanceRecords)
  ) {
    return null
  }
  const profiles = raw.profiles.map(parseRuntimeProfile).filter(isRuntimeProfile)
  const conformanceRecords: Record<string, RuntimeConformanceRecord> = {}
  for (const [key, value] of Object.entries(raw.conformanceRecords)) {
    const record = parseConformanceRecord(value)
    if (record && key === record.runtimeId) {
      conformanceRecords[key] = record
    }
  }
  return {
    cacheKey: raw.cacheKey,
    conformanceRecords,
    conformanceSchemaVersion: RUNTIME_CONFORMANCE_CACHE_SCHEMA_VERSION,
    generatedAt: raw.generatedAt,
    profileSchemaVersion: RUNTIME_PROFILE_CACHE_SCHEMA_VERSION,
    profiles,
    schemaVersion: RUNTIME_CATALOG_CACHE_SCHEMA_VERSION,
  }
}

function parseRuntimeProfile(raw: unknown): BridgeRuntimeProfile | null {
  if (!isRecord(raw)) {
    return null
  }
  if (
    typeof raw.id !== "string" ||
    !isBridgeRuntimeKind(raw.kind) ||
    typeof raw.label !== "string" ||
    !Array.isArray(raw.command) ||
    !raw.command.every((part) => typeof part === "string") ||
    (raw.status !== "available" && raw.status !== "unavailable") ||
    !isRecord(raw.capabilities)
  ) {
    return null
  }
  if (hasSecretishCommand(raw.command)) {
    return null
  }
  return sanitizeRuntimeProfile(raw as BridgeRuntimeProfile)
}

function parseConformanceRecord(raw: unknown): RuntimeConformanceRecord | null {
  if (!isRecord(raw)) {
    return null
  }
  if (
    typeof raw.checkedAt !== "number" ||
    typeof raw.runtimeId !== "string" ||
    !["passing", "failing", "quarantined"].includes(String(raw.state)) ||
    !["none", "init_only", "prompt_smoke"].includes(String(raw.strength)) ||
    !Array.isArray(raw.diagnostics)
  ) {
    return null
  }
  return sanitizeConformanceRecord(raw as RuntimeConformanceRecord)
}

function sanitizeRuntimeProfile(profile: BridgeRuntimeProfile): BridgeRuntimeProfile {
  return compactObject({
    availableCommands: sanitizeValue(profile.availableCommands),
    capabilities: sanitizeValue(profile.capabilities) ?? {},
    capabilityProvenance: sanitizeValue(profile.capabilityProvenance),
    command: profile.command.filter((part) => typeof part === "string"),
    compatibility: sanitizeValue(profile.compatibility),
    diagnostics: sanitizeValue(profile.diagnostics),
    hermesProfileName:
      typeof profile.hermesProfileName === "string" ? profile.hermesProfileName : undefined,
    id: profile.id,
    identityRules: sanitizeValue(profile.identityRules),
    kind: profile.kind,
    label: profile.label,
    maxSessions: typeof profile.maxSessions === "number" ? profile.maxSessions : undefined,
    models: sanitizeStringArray(profile.models),
    modes: sanitizeStringArray(profile.modes),
    runtimeConfigOptions: sanitizeValue(profile.runtimeConfigOptions),
    status: profile.status,
    thoughtLevels: sanitizeStringArray(profile.thoughtLevels),
  }) as BridgeRuntimeProfile
}

function hasSecretishCommand(command: string[]): boolean {
  return command.some((part) => SECRETISH_KEY.test(part))
}

function sanitizeConformanceRecord(
  record: RuntimeConformanceRecord | null | undefined,
): RuntimeConformanceRecord | null {
  if (!record) {
    return null
  }
  return {
    checkedAt: record.checkedAt,
    diagnostics: Array.isArray(record.diagnostics)
      ? record.diagnostics.map((diagnostic) =>
          compactObject({
            message:
              typeof diagnostic.message === "string"
                ? redactSecretishString(diagnostic.message)
                : undefined,
            reasonCode: diagnostic.reasonCode,
          }),
        )
      : [],
    runtimeId: record.runtimeId,
    state: record.state,
    strength: record.strength,
  }
}

function isSafeCachedConformanceRecord(
  record: RuntimeConformanceRecord | null | undefined,
  profileId: string,
  now: number,
  ttlMs: number,
): record is RuntimeConformanceRecord {
  return (
    !!record &&
    record.runtimeId === profileId &&
    record.state === "passing" &&
    record.strength !== "none" &&
    now - record.checkedAt <= ttlMs
  )
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined
  }
  if (typeof value === "string") {
    return redactSecretishString(value)
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((entry) => entry !== undefined)
  }
  if (!isRecord(value)) {
    return undefined
  }
  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (SECRETISH_KEY.test(key)) {
      continue
    }
    const sanitizedEntry = sanitizeValue(entry)
    if (sanitizedEntry !== undefined) {
      sanitized[key] = sanitizedEntry
    }
  }
  return sanitized
}

function redactSecretishString(value: string): string {
  return value.replace(SECRETISH_VALUE, "$1=[redacted]")
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

function isRuntimeProfile(value: BridgeRuntimeProfile | null): value is BridgeRuntimeProfile {
  return value !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBridgeRuntimeKind(value: unknown): value is BridgeRuntimeKind {
  return (
    value === "hermes" ||
    value === "codex" ||
    value === "claude-code" ||
    value === "openclaw" ||
    value === "unknown-acp"
  )
}

function compareStringArrays(left: string[], right: string[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right))
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T
}
