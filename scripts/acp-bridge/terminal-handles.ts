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
}

export type TerminalHandleCreateInput<THandle extends TerminalHandle = TerminalHandle> = {
  handle: THandle
  scope: TerminalHandleScope
}

export type TerminalHandleOperationOptions = {
  generation?: number
  signal?: string
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
  private readonly now: () => number

  constructor(options: TerminalHandleRegistryOptions = {}) {
    this.now = options.now ?? Date.now
  }

  create(input: TerminalHandleCreateInput<THandle>): TerminalHandleRecord<THandle> {
    const scope = { ...input.scope }
    const key = terminalHandleKey(scope)
    const generation = (this.generations.get(key) ?? 0) + 1
    const record: TerminalHandleRecord<THandle> = {
      createdAtMs: this.now(),
      generation,
      handle: input.handle,
      key,
      scope,
    }

    this.generations.set(key, generation)
    this.handles.set(key, record)

    return record
  }

  lookup(scope: TerminalHandleScope): TerminalHandleRecord<THandle> | undefined {
    return this.handles.get(terminalHandleKey(scope))
  }

  async kill(
    scope: TerminalHandleScope,
    options: TerminalHandleOperationOptions = {},
  ): Promise<TerminalHandleOperationResult> {
    const key = terminalHandleKey(scope)
    const record = this.handles.get(key)
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
    const key = terminalHandleKey(scope)
    const record = this.handles.get(key)
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

    return Promise.all(records.map((record) => this.kill(record.scope, options)))
  }

  async releaseSession(
    scope: TerminalHandleScope,
    options: TerminalHandleOperationOptions = {},
  ): Promise<TerminalHandleOperationResult[]> {
    const records = this.recordsForSession(scope)

    return Promise.all(records.map((record) => this.release(record.scope, options)))
  }

  list(): TerminalHandleRecord<THandle>[] {
    return [...this.handles.values()]
  }

  private recordsForSession(scope: TerminalHandleScope): TerminalHandleRecord<THandle>[] {
    return this.list().filter((record) => sameTerminalSession(record.scope, scope))
  }
}

export function terminalHandleKey(scope: TerminalHandleScope): string {
  return [
    scope.organizationId,
    scope.bridgeDeviceId,
    scope.runtimeProfileId,
    scope.threadId,
    scope.agentSessionId,
  ]
    .map(encodeKeyPart)
    .join(":")
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
