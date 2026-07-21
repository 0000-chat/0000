import type {
  BridgeEventInput,
  BridgeQueueClaimInput,
  BridgeQueueCommand,
  BridgeQueueResult,
} from "./convex-http"

export type BridgeClaimLease = {
  claimId: string
  hostIssuedAt?: number
  leaseUntil?: number
}

export type BridgeHostWorkItem = {
  agentSessionId?: string
  claimId?: string
  command: BridgeQueueCommand
  effectiveSessionCap?: number
  hostIssuedAt?: number
  id: string
  kind?: string
  leaseUntil?: number
  runtimeConfig?: unknown
  targetResourceState?: string
  threadId?: string
}

export type BridgeClaimWorkResult = {
  raw: Record<string, unknown>
  workItems: BridgeHostWorkItem[]
}

export type BridgeAppendEventsResult = Record<string, unknown>
export type BridgeAppendDiagnosticsResult = Record<string, unknown>

export type BridgeDiagnosticInput = {
  details?: unknown
  message: string
  reasonCode: string
  traceId?: string
}

export type BridgeCompleteWorkInput = {
  claimId?: string
  result: BridgeQueueResult
  workItem: BridgeHostWorkItem
}

export type BridgeReleaseWorkInput = {
  claimId?: string
  reason: string
  retryable?: boolean
  workItem: BridgeHostWorkItem
}

export type BridgeAnswerInteractionInput = {
  approved: boolean
  claimId: string
  externalRequestId?: string
  interactionId: string
  reason?: string
  threadId: string
}

export interface BridgeHostAdapter {
  appendDiagnostics(input: { diagnostics: BridgeDiagnosticInput[] }): Promise<BridgeAppendDiagnosticsResult>
  appendEvents(input: { events: BridgeEventInput[] }): Promise<BridgeAppendEventsResult>
  answerInteraction(input: BridgeAnswerInteractionInput): Promise<Record<string, unknown>>
  claimWork(input?: BridgeQueueClaimInput): Promise<BridgeClaimWorkResult>
  completeWork(input: BridgeCompleteWorkInput): Promise<Record<string, unknown>>
  releaseWork(input: BridgeReleaseWorkInput): Promise<Record<string, unknown>>
}

type ConvexBridgeTransport = {
  appendEvents(events: BridgeEventInput[]): Promise<Record<string, unknown>>
  claimWork(input?: BridgeQueueClaimInput): Promise<Record<string, unknown>>
  cleanupStaleClaims(input?: Record<string, unknown>): Promise<Record<string, unknown>>
  markResult(
    commandId: string,
    result: BridgeQueueResult,
    claimId?: string,
  ): Promise<Record<string, unknown>>
}

export class ConvexBridgeHostAdapter implements BridgeHostAdapter {
  constructor(private readonly transport: Partial<ConvexBridgeTransport>) {}

  async claimWork(input: BridgeQueueClaimInput = {}): Promise<BridgeClaimWorkResult> {
    const raw = await this.callTransport("claimWork", input)
    return {
      raw,
      workItems: queueCommandsFromClaimResponse(raw).map(toHostWorkItem),
    }
  }

  async appendEvents(input: { events: BridgeEventInput[] }): Promise<BridgeAppendEventsResult> {
    return await this.callTransport("appendEvents", input.events)
  }

  async appendDiagnostics(input: {
    diagnostics: BridgeDiagnosticInput[]
  }): Promise<BridgeAppendDiagnosticsResult> {
    if (input.diagnostics.length === 0) {
      return {}
    }
    return { ok: true, skipped: input.diagnostics.length }
  }

  async completeWork(input: BridgeCompleteWorkInput): Promise<Record<string, unknown>> {
    return await this.markResult(input.workItem, {
      ...input.result,
      claimId: input.claimId ?? input.workItem.claimId,
    })
  }

  async releaseWork(input: BridgeReleaseWorkInput): Promise<Record<string, unknown>> {
    return await this.markResult(input.workItem, {
      claimId: input.claimId ?? input.workItem.claimId,
      error: input.reason,
      ok: false,
      retryable: input.retryable ?? true,
    })
  }

  async answerInteraction(input: BridgeAnswerInteractionInput): Promise<Record<string, unknown>> {
    return await this.markResult(
      {
        id: input.interactionId,
      },
      {
        approved: input.approved,
        claimId: input.claimId,
        externalRequestId: input.externalRequestId,
        ok: true,
        reason: input.reason,
      },
    )
  }

  private async markResult(
    workItem: Pick<BridgeHostWorkItem, "id">,
    result: BridgeQueueResult,
  ): Promise<Record<string, unknown>> {
    const claimId = typeof result.claimId === "string" ? result.claimId : undefined
    return await this.callTransport("markResult", workItem.id, result, claimId)
  }

  private async callTransport(
    method: keyof ConvexBridgeTransport,
    ...args: unknown[]
  ): Promise<Record<string, unknown>> {
    const fn = required(this.transport[method], method)
    return await (fn as (...values: unknown[]) => Promise<Record<string, unknown>>).apply(
      this.transport,
      args,
    )
  }
}

function queueCommandsFromClaimResponse(response: Record<string, unknown>): BridgeQueueCommand[] {
  const commands = response.commands
  if (Array.isArray(commands)) {
    return commands.filter(isBridgeQueueCommand)
  }
  return isBridgeQueueCommand(response.command) ? [response.command] : []
}

function toHostWorkItem(command: BridgeQueueCommand): BridgeHostWorkItem {
  return {
    agentSessionId: stringFromUnknown(command.agentSessionId),
    claimId: stringFromUnknown(command.claimId),
    command,
    effectiveSessionCap: numberFromUnknown(command.effectiveSessionCap),
    hostIssuedAt: numberFromUnknown(command.hostIssuedAt),
    id: command.id,
    kind: stringFromUnknown(command.kind ?? command.type),
    leaseUntil: numberFromUnknown(command.leaseUntil),
    runtimeConfig: command.runtimeConfig,
    targetResourceState: stringFromUnknown(command.targetResourceState),
    threadId: stringFromUnknown(command.threadId),
  }
}

function isBridgeQueueCommand(value: unknown): value is BridgeQueueCommand {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string")
}

function required<TFunction extends (...args: never[]) => unknown>(
  fn: TFunction | undefined,
  name: string | number | symbol,
): TFunction {
  if (!fn) {
    throw new Error(`Bridge host adapter transport is missing ${String(name)}`)
  }
  return fn
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
