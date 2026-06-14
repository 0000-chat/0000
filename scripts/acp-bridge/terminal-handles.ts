export type TerminalHandleScope = {
  organizationId: string
  bridgeDeviceId: string
  runtimeProfileId: string
  threadId: string
  agentSessionId: string
}

export type TerminalHandle = {
  kill?: (signal?: string) => void | Promise<void>
  release?: () => void | Promise<void>
}

export type TerminalHandleRecord<THandle extends TerminalHandle = TerminalHandle> = {
  createdAtMs: number
  generation: number
  handle: THandle
  key: string
  scope: TerminalHandleScope
  terminalId: string
}

export type TerminalHandleCreateInput<THandle extends TerminalHandle = TerminalHandle> = {
  handle: THandle
  scope: TerminalHandleScope
  terminalId?: string
}

export type TerminalHandleOperationOptions = {
  generation?: number
  signal?: string
  terminalId?: string
}

export type TerminalHandleOperationResult =
  | {
      generation: number
      key: string
      status: "killed" | "released"
    }
  | {
      key: string
      status: "missing"
    }
  | {
      currentGeneration: number
      generation: number
      key: string
      status: "stale"
    }

export type TerminalHandleRegistryOptions = {
  now?: () => number
}

const defaultKillSignal = "SIGTERM"

export class TerminalHandleRegistry<THandle extends TerminalHandle = TerminalHandle> {
  private readonly handles = new Map<string, TerminalHandleRecord<THandle>>()
  private readonly generations = new Map<string, number>()
  private readonly terminalCounters = new Map<string, number>()
  private readonly now: () => number

  constructor(options: TerminalHandleRegistryOptions = {}) {
    this.now = options.now ?? Date.now
  }

  create(input: TerminalHandleCreateInput<THandle>): TerminalHandleRecord<THandle> {
    const scope = { ...input.scope }
    const terminalId = input.terminalId ?? this.nextTerminalId(scope)
    const key = terminalHandleKey(scope, terminalId)
    const generation = (this.generations.get(key) ?? 0) + 1
    const record: TerminalHandleRecord<THandle> = {
      createdAtMs: this.now(),
      generation,
      handle: input.handle,
      key,
      scope,
      terminalId,
    }

    this.generations.set(key, generation)
    this.handles.set(key, record)

    return record
  }

  lookup(
    scope: TerminalHandleScope,
    terminalId?: string,
  ): TerminalHandleRecord<THandle> | undefined {
    if (terminalId !== undefined) {
      return this.handles.get(terminalHandleKey(scope, terminalId))
    }
    const records = this.recordsForSession(scope)
    return records.length === 1 ? records[0] : undefined
  }

  async kill(
    scope: TerminalHandleScope,
    options: TerminalHandleOperationOptions = {},
  ): Promise<TerminalHandleOperationResult> {
    if (options.generation !== undefined && options.terminalId === undefined) {
      return { key: terminalHandleKey(scope), status: "missing" }
    }
    const record = this.lookup(scope, options.terminalId)
    const key = record?.key ?? terminalHandleKey(scope, options.terminalId)
    const fenced = fencedOperationResult(key, record, options.generation)

    if (fenced) {
      return fenced
    }
    if (!record) {
      return { key, status: "missing" }
    }

    await record.handle.kill?.(options.signal ?? defaultKillSignal)
    this.handles.delete(key)

    return {
      generation: record.generation,
      key,
      status: "killed",
    }
  }

  async release(
    scope: TerminalHandleScope,
    options: TerminalHandleOperationOptions = {},
  ): Promise<TerminalHandleOperationResult> {
    if (options.generation !== undefined && options.terminalId === undefined) {
      return { key: terminalHandleKey(scope), status: "missing" }
    }
    const record = this.lookup(scope, options.terminalId)
    const key = record?.key ?? terminalHandleKey(scope, options.terminalId)
    const fenced = fencedOperationResult(key, record, options.generation)

    if (fenced) {
      return fenced
    }
    if (!record) {
      return { key, status: "missing" }
    }

    await record.handle.release?.()
    this.handles.delete(key)

    return {
      generation: record.generation,
      key,
      status: "released",
    }
  }

  async killSession(
    scope: TerminalHandleScope,
    options: TerminalHandleOperationOptions = {},
  ): Promise<TerminalHandleOperationResult[]> {
    const records = this.recordsForSession(scope)

    return Promise.all(
      records.map((record) =>
        this.kill(record.scope, { ...options, terminalId: record.terminalId }),
      ),
    )
  }

  async releaseSession(
    scope: TerminalHandleScope,
    options: TerminalHandleOperationOptions = {},
  ): Promise<TerminalHandleOperationResult[]> {
    const records = this.recordsForSession(scope)

    return Promise.all(
      records.map((record) =>
        this.release(record.scope, { ...options, terminalId: record.terminalId }),
      ),
    )
  }

  list(): TerminalHandleRecord<THandle>[] {
    return [...this.handles.values()]
  }

  private recordsForSession(scope: TerminalHandleScope): TerminalHandleRecord<THandle>[] {
    return this.list().filter((record) => sameTerminalSession(record.scope, scope))
  }

  private nextTerminalId(scope: TerminalHandleScope): string {
    const sessionKey = terminalHandleSessionKey(scope)
    const next = (this.terminalCounters.get(sessionKey) ?? 0) + 1
    this.terminalCounters.set(sessionKey, next)
    return `${sessionKey}:terminal-${next}`
  }
}

export function terminalHandleKey(scope: TerminalHandleScope, terminalId?: string): string {
  const parts = [
    ...terminalHandleSessionKeyParts(scope),
    ...(terminalId !== undefined ? [terminalId] : []),
  ]
  return parts.map(encodeKeyPart).join(":")
}

function terminalHandleSessionKey(scope: TerminalHandleScope): string {
  return terminalHandleSessionKeyParts(scope).map(encodeKeyPart).join(":")
}

function terminalHandleSessionKeyParts(scope: TerminalHandleScope): string[] {
  return [
    scope.organizationId,
    scope.bridgeDeviceId,
    scope.runtimeProfileId,
    scope.threadId,
    scope.agentSessionId,
  ]
}

function sameTerminalSession(left: TerminalHandleScope, right: TerminalHandleScope): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.bridgeDeviceId === right.bridgeDeviceId &&
    left.runtimeProfileId === right.runtimeProfileId &&
    left.threadId === right.threadId &&
    left.agentSessionId === right.agentSessionId
  )
}

function fencedOperationResult<THandle extends TerminalHandle>(
  key: string,
  record: TerminalHandleRecord<THandle> | undefined,
  generation: number | undefined,
): TerminalHandleOperationResult | undefined {
  if (!record) {
    return { key, status: "missing" }
  }

  if (generation !== undefined && generation !== record.generation) {
    return {
      currentGeneration: record.generation,
      generation,
      key,
      status: "stale",
    }
  }

  return undefined
}

function encodeKeyPart(part: string): string {
  return encodeURIComponent(part)
}
