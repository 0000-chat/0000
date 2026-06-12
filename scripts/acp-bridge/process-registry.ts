import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

const REGISTRY_VERSION = 1
const REGISTRY_FILE_MODE = 0o600
const DEFAULT_PROCESS_EXIT_GRACE_MS = 2_500

export type AcpBridgeProcessRegistryEntry = {
  args: string[]
  command: string
  cwd?: string
  id: string
  pid: number
  pgid?: number
  queueItemId?: string
  claimId?: string
  sessionKey?: string
  runtimeProfileId?: string
  hermesProfileName?: string
  bridgeDeviceId?: string
  processIdentity?: AcpBridgeStoredProcessIdentity
  startedAt: string
  updatedAt: string
}

export type AcpBridgeProcessRegistrationInput = Omit<
  AcpBridgeProcessRegistryEntry,
  "id" | "startedAt" | "updatedAt"
>

export type AcpBridgeProcessHealthStatus =
  | "healthy"
  | "corrupt"
  | "newer_version"
  | "ambiguous"
  | "cap_exceeded"

export type AcpBridgeProcessHealth = {
  ambiguousProcessCount: number
  canClaim: boolean
  childCount: number
  childCountsByRuntimeProfile: Record<string, number>
  lastReconciledAt?: string
  processCap?: number
  processCapExceeded: boolean
  startupReconciliation: AcpBridgeStartupReconciliation
  status: AcpBridgeProcessHealthStatus
}

export type AcpBridgeProcessRegistryLike = {
  getProcessHealth(): AcpBridgeProcessHealth
  reconcileBeforeClaiming(): Promise<void>
  registerProcess(
    input: AcpBridgeProcessRegistrationInput,
  ): Promise<AcpBridgeProcessRegistryEntry>
  terminateProcess(
    entry: AcpBridgeProcessRegistryEntry,
    child?: ChildProcessWithoutNullStreams,
    options?: { graceMs?: number },
  ): Promise<void>
}

type RegistryFile = {
  entries: AcpBridgeProcessRegistryEntry[]
  version: number
}

export type AcpBridgeProcessIdentity = {
  argv?: string[]
  commandLine?: string
  source: string
  startTime?: string
}

export type AcpBridgeStoredProcessIdentity = {
  capturedAt: string
  fingerprint: string
  fingerprintSource: "argv" | "commandLine"
  source: string
  startTime?: string
}

export type AcpBridgeStartupReconciliation = {
  ambiguousProcessCount: number
  lastReconciledAt?: string
  removedDeadProcessCount: number
  retainedProcessCount: number
  status: "not_run" | "healthy" | "ambiguous" | "blocked"
  terminatedProcessCount: number
  reason?: "corrupt" | "newer_version"
}

export type AcpBridgeProcessRegistryOptions = {
  beforePersistWrite?: () => Promise<void> | void
  isProcessAlive?: (pid: number) => boolean
  maxProcesses?: number
  now?: () => Date
  path: string
  readProcessCommand?: (pid: number) => string | undefined
  readProcessIdentity?: (pid: number) => AcpBridgeProcessIdentity | undefined
}

export class AcpBridgeProcessRegistry implements AcpBridgeProcessRegistryLike {
  private readonly beforePersistWrite?: () => Promise<void> | void
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly maxProcesses?: number
  private readonly now: () => Date
  private readonly path: string
  private readonly readProcessIdentity: (pid: number) => AcpBridgeProcessIdentity | undefined
  private entries = new Map<string, AcpBridgeProcessRegistryEntry>()
  private loaded = false
  private unsafeStatus: Extract<AcpBridgeProcessHealthStatus, "corrupt" | "newer_version" | "ambiguous"> | undefined
  private ambiguousProcessCount = 0
  private lastReconciledAt: string | undefined
  private mutationQueue = Promise.resolve()
  private startupReconciliation: AcpBridgeStartupReconciliation = emptyStartupReconciliation()

  constructor(options: AcpBridgeProcessRegistryOptions) {
    this.path = options.path
    this.beforePersistWrite = options.beforePersistWrite
    this.maxProcesses = options.maxProcesses
    this.now = options.now ?? (() => new Date())
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
    this.readProcessIdentity =
      options.readProcessIdentity ??
      (options.readProcessCommand
        ? (pid) => {
            const commandLine = options.readProcessCommand?.(pid)
            return commandLine ? { commandLine, source: "command" } : undefined
          }
        : defaultReadProcessIdentity)
  }

  async load(): Promise<void> {
    await this.withRegistryMutation(() => this.loadUnsafe())
  }

  private async loadUnsafe(): Promise<void> {
    if (!existsSync(this.path)) {
      this.entries.clear()
      this.loaded = true
      this.unsafeStatus = undefined
      this.ambiguousProcessCount = 0
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"))
    } catch {
      this.markUnsafe("corrupt")
      this.loaded = true
      return
    }
    const normalized = normalizeRegistryFile(raw)
    if (!normalized.ok) {
      this.markUnsafe(normalized.reason)
      this.loaded = true
      return
    }
    this.entries = new Map(normalized.file.entries.map((entry) => [entry.id, entry]))
    this.unsafeStatus = undefined
    this.ambiguousProcessCount = 0
    this.loaded = true
  }

  async registerProcess(
    input: AcpBridgeProcessRegistrationInput,
  ): Promise<AcpBridgeProcessRegistryEntry> {
    return await this.withRegistryMutation(async () => {
      await this.ensureLoaded()
      const now = this.now().toISOString()
      const processIdentity = storedIdentityFromProcessIdentity(
        this.readProcessIdentity(input.pid),
        now,
      )
      const entry: AcpBridgeProcessRegistryEntry = {
        ...input,
        args: [...input.args],
        id: randomUUID(),
        ...(processIdentity ? { processIdentity } : {}),
        startedAt: now,
        updatedAt: now,
      }
      this.entries.set(entry.id, entry)
      await this.persist()
      return entry
    })
  }

  async terminateProcess(
    entry: AcpBridgeProcessRegistryEntry,
    child?: ChildProcessWithoutNullStreams,
    options: { graceMs?: number } = {},
  ): Promise<void> {
    await this.withRegistryMutation(async () => {
      await this.ensureLoaded()
      const graceMs = options.graceMs ?? DEFAULT_PROCESS_EXIT_GRACE_MS
      if (child) {
        await terminateChildHandle(child, graceMs)
        await this.unregisterProcess(entry.id)
        return
      }
      if (!this.isProcessAlive(entry.pid)) {
        await this.unregisterProcess(entry.id)
        return
      }
      const identity = this.readProcessIdentity(entry.pid)
      if (!processIdentityMatchesEntry(identity, entry)) {
        this.unsafeStatus = "ambiguous"
        this.ambiguousProcessCount = Math.max(1, this.ambiguousProcessCount)
        return
      }
      await terminatePid(entry.pid, graceMs, this.isProcessAlive)
      await this.unregisterProcess(entry.id)
    })
  }

  async reconcileBeforeClaiming(): Promise<void> {
    await this.withRegistryMutation(async () => {
      await this.ensureLoaded()
      if (this.unsafeStatus === "corrupt" || this.unsafeStatus === "newer_version") {
        this.lastReconciledAt = this.now().toISOString()
        this.startupReconciliation = {
          ...emptyStartupReconciliation(),
          ambiguousProcessCount: this.ambiguousProcessCount,
          lastReconciledAt: this.lastReconciledAt,
          reason: this.unsafeStatus,
          status: "blocked",
        }
        return
      }
      let ambiguous = 0
      let removedDead = 0
      let terminated = 0
      for (const entry of Array.from(this.entries.values())) {
        if (!this.isProcessAlive(entry.pid)) {
          this.entries.delete(entry.id)
          removedDead += 1
          continue
        }
        const identity = this.readProcessIdentity(entry.pid)
        if (!processIdentityMatchesEntry(identity, entry)) {
          ambiguous += 1
          continue
        }
        await terminatePid(entry.pid, DEFAULT_PROCESS_EXIT_GRACE_MS, this.isProcessAlive)
        terminated += 1
        this.entries.delete(entry.id)
      }
      this.ambiguousProcessCount = ambiguous
      this.unsafeStatus = ambiguous > 0 ? "ambiguous" : undefined
      this.lastReconciledAt = this.now().toISOString()
      this.startupReconciliation = {
        ambiguousProcessCount: ambiguous,
        lastReconciledAt: this.lastReconciledAt,
        removedDeadProcessCount: removedDead,
        retainedProcessCount: ambiguous,
        status: ambiguous > 0 ? "ambiguous" : "healthy",
        terminatedProcessCount: terminated,
      }
      await this.persist()
    })
  }

  getProcessHealth(): AcpBridgeProcessHealth {
    const childCount = this.entries.size
    const processCapExceeded =
      this.maxProcesses !== undefined && childCount >= this.maxProcesses
    const status =
      this.unsafeStatus ??
      (processCapExceeded ? "cap_exceeded" : "healthy")
    const childCountsByRuntimeProfile: Record<string, number> = {}
    for (const entry of this.entries.values()) {
      const key = entry.runtimeProfileId ?? entry.hermesProfileName ?? "default"
      childCountsByRuntimeProfile[key] = (childCountsByRuntimeProfile[key] ?? 0) + 1
    }
    return {
      ambiguousProcessCount: this.ambiguousProcessCount,
      canClaim: status === "healthy",
      childCount,
      childCountsByRuntimeProfile,
      lastReconciledAt: this.lastReconciledAt,
      processCap: this.maxProcesses,
      processCapExceeded,
      startupReconciliation: this.startupReconciliation,
      status,
    }
  }

  private async unregisterProcess(id: string): Promise<void> {
    this.entries.delete(id)
    await this.persist()
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadUnsafe()
    }
  }

  private markUnsafe(status: "corrupt" | "newer_version"): void {
    this.entries.clear()
    this.unsafeStatus = status
    this.ambiguousProcessCount = 1
  }

  private async persist(): Promise<void> {
    if (this.unsafeStatus === "corrupt" || this.unsafeStatus === "newer_version") {
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    const tempPath = `${this.path}.${randomUUID()}.tmp`
    const file: RegistryFile = {
      entries: Array.from(this.entries.values()).sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      version: REGISTRY_VERSION,
    }
    await this.beforePersistWrite?.()
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: REGISTRY_FILE_MODE,
    })
    await chmod(tempPath, REGISTRY_FILE_MODE)
    await rename(tempPath, this.path)
    await chmod(this.path, REGISTRY_FILE_MODE)
  }

  private async withRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }
}

function normalizeRegistryFile(
  raw: unknown,
): { ok: true; file: RegistryFile } | { ok: false; reason: "corrupt" | "newer_version" } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "corrupt" }
  }
  const record = raw as Record<string, unknown>
  if (typeof record.version !== "number" || !Number.isInteger(record.version)) {
    return { ok: false, reason: "corrupt" }
  }
  if (record.version > REGISTRY_VERSION) {
    return { ok: false, reason: "newer_version" }
  }
  if (!Array.isArray(record.entries)) {
    return { ok: false, reason: "corrupt" }
  }
  const entries: AcpBridgeProcessRegistryEntry[] = []
  for (const rawEntry of record.entries) {
    const entry = normalizeEntry(rawEntry)
    if (!entry) {
      return { ok: false, reason: "corrupt" }
    }
    entries.push(entry)
  }
  return { ok: true, file: { entries, version: REGISTRY_VERSION } }
}

function normalizeEntry(raw: unknown): AcpBridgeProcessRegistryEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const id = stringFromUnknown(record.id)
  const command = stringFromUnknown(record.command)
  const pid = numberFromUnknown(record.pid)
  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === "string")
    : undefined
  const startedAt = stringFromUnknown(record.startedAt)
  const updatedAt = stringFromUnknown(record.updatedAt)
  if (!id || !command || !args || pid === undefined || !startedAt || !updatedAt) {
    return undefined
  }
  return compact({
    args,
    bridgeDeviceId: stringFromUnknown(record.bridgeDeviceId),
    claimId: stringFromUnknown(record.claimId),
    command,
    cwd: stringFromUnknown(record.cwd),
    hermesProfileName: stringFromUnknown(record.hermesProfileName),
    id,
    pgid: numberFromUnknown(record.pgid),
    pid,
    processIdentity: normalizeStoredProcessIdentity(record.processIdentity),
    queueItemId: stringFromUnknown(record.queueItemId),
    runtimeProfileId: stringFromUnknown(record.runtimeProfileId),
    sessionKey: stringFromUnknown(record.sessionKey),
    startedAt,
    updatedAt,
  })
}

async function terminateChildHandle(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      child.off("exit", finish)
      child.off("close", finish)
      resolve()
    }
    child.once("exit", finish)
    child.once("close", finish)
    child.kill("SIGTERM")
    timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL")
        finish()
      }
    }, graceMs)
  })
}

async function terminatePid(
  pid: number,
  graceMs: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<void> {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The process exited after the grace period check.
  }
}

function processIdentityMatchesEntry(
  identity: AcpBridgeProcessIdentity | undefined,
  entry: AcpBridgeProcessRegistryEntry,
): boolean {
  if (!identity || !entry.processIdentity || !hasBridgeOwnershipMetadata(entry)) {
    return false
  }
  const current = processIdentityFingerprint(identity)
  if (!current || current.fingerprint !== entry.processIdentity.fingerprint) {
    return false
  }
  if (!entry.processIdentity.startTime || !identity.startTime) {
    return false
  }
  return identity.startTime === entry.processIdentity.startTime
}

function hasBridgeOwnershipMetadata(entry: AcpBridgeProcessRegistryEntry): boolean {
  return Boolean(
    entry.bridgeDeviceId &&
      (entry.claimId || entry.queueItemId || entry.sessionKey || entry.runtimeProfileId),
  )
}

function storedIdentityFromProcessIdentity(
  identity: AcpBridgeProcessIdentity | undefined,
  capturedAt: string,
): AcpBridgeStoredProcessIdentity | undefined {
  const fingerprint = processIdentityFingerprint(identity)
  if (!identity || !fingerprint) {
    return undefined
  }
  return {
    capturedAt,
    fingerprint: fingerprint.fingerprint,
    fingerprintSource: fingerprint.source,
    source: identity.source,
    ...(identity.startTime ? { startTime: identity.startTime } : {}),
  }
}

function processIdentityFingerprint(
  identity: AcpBridgeProcessIdentity | undefined,
): { fingerprint: string; source: "argv" | "commandLine" } | undefined {
  if (identity?.argv && identity.argv.length > 0) {
    return {
      fingerprint: sha256Json(identity.argv),
      source: "argv",
    }
  }
  if (identity?.commandLine) {
    return {
      fingerprint: sha256Json(identity.commandLine),
      source: "commandLine",
    }
  }
  return undefined
}

function normalizeStoredProcessIdentity(
  raw: unknown,
): AcpBridgeStoredProcessIdentity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const capturedAt = stringFromUnknown(record.capturedAt)
  const fingerprint = stringFromUnknown(record.fingerprint)
  const source = stringFromUnknown(record.source)
  const fingerprintSource = stringFromUnknown(record.fingerprintSource)
  if (
    !capturedAt ||
    !fingerprint ||
    !source ||
    (fingerprintSource !== "argv" && fingerprintSource !== "commandLine")
  ) {
    return undefined
  }
  return compact({
    capturedAt,
    fingerprint,
    fingerprintSource: fingerprintSource as "argv" | "commandLine",
    source,
    startTime: stringFromUnknown(record.startTime),
  })
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function defaultReadProcessIdentity(pid: number): AcpBridgeProcessIdentity | undefined {
  return readProcProcessIdentity(pid) ?? readPsProcessIdentity(pid)
}

function readProcProcessIdentity(pid: number): AcpBridgeProcessIdentity | undefined {
  try {
    const rawCommand = readFileSync(`/proc/${pid}/cmdline`)
    const argv = rawCommand
      .toString("utf8")
      .split("\0")
      .filter((part) => part.length > 0)
    const startTime = readProcStartTime(pid)
    if (argv.length === 0 && !startTime) {
      return undefined
    }
    return compact({
      argv: argv.length > 0 ? argv : undefined,
      commandLine: argv.length > 0 ? argv.join(" ") : undefined,
      source: "proc",
      startTime,
    })
  } catch {
    return undefined
  }
}

function readProcStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2)
    const fields = afterCommand.trim().split(/\s+/)
    const startTicks = fields[19]
    return startTicks ? `proc:${startTicks}` : undefined
  } catch {
    return undefined
  }
}

function readPsProcessIdentity(pid: number): AcpBridgeProcessIdentity | undefined {
  try {
    const commandLine = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim()
    const startTime = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim()
    if (!commandLine && !startTime) {
      return undefined
    }
    return compact({
      commandLine: commandLine || undefined,
      source: "ps",
      startTime: startTime ? `ps:${startTime}` : undefined,
    })
  } catch {
    return undefined
  }
}

function emptyStartupReconciliation(): AcpBridgeStartupReconciliation {
  return {
    ambiguousProcessCount: 0,
    removedDeadProcessCount: 0,
    retainedProcessCount: 0,
    status: "not_run",
    terminatedProcessCount: 0,
  }
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}
