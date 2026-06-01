import {
  type HermesAcpMcpServer,
  type HermesAcpPromptResult,
  HermesAcpSession,
} from "./acp-session"
import { type BridgeLogEntry, type BridgeLogger, redactLogValue } from "./bridge-log"
import type { BridgeEventInput, ConvexBridgeCloudClient } from "./convex-http"
import type { NormalizedBridgeEvent } from "./event-normalizer"
import { type BridgeRuntimeProfile, findRuntimeProfile } from "./runtime-profiles"

export type BridgeSessionQueueItem = {
  id: string
  type?: string
  kind?: string
  threadId?: string
  sessionId?: string
  agentSessionId?: string
  cwd?: string
  prompt?: string
  threadHistory?: string
  systemPrompt?: string
  approvalId?: string
  approvalOutcome?: string
  approvalReason?: string
  approvalLevel?: "ask" | "full_permissions"
  externalRequestId?: string
  externalSessionId?: string
  agentName?: string
  bridgeProfileId?: string
  hermesProfileName?: string
}

export type ManagedAcpSession = {
  readonly sessionId?: string
  sendUserMessage(
    text: string,
    options?: {
      systemPrompt?: string
      threadHistory?: string
      autoApprovePermissionRequests?: boolean
    },
  ): Promise<HermesAcpPromptResult>
  cancel(): Promise<void>
  close(): Promise<void>
  respondToPermissionRequest?(
    externalRequestId: string,
    response: { approved: boolean; reason?: string },
  ): Promise<boolean>
  hasPendingPermissionRequests?(): boolean
}

export type BridgeSessionContext = {
  agentCommand?: string | string[]
  bridgeProfileId?: string
  runtimeProfile?: BridgeRuntimeProfile
  sessionKey: string
  threadId: string
  cwd?: string
  hermesProfileName?: string
  mcpServers: HermesAcpMcpServer[]
  initialSessionId?: string
  onEvent: (event: NormalizedBridgeEvent) => void
  onError: (error: Error) => void
}

type BridgeSessionRecord = {
  sessionKey: string
  threadId: string
  cwd?: string
  acp: ManagedAcpSession
  agentName?: string
  runtimeProfile?: BridgeRuntimeProfile
  hermesProfileName?: string
  generation: number
  idleTimer?: ReturnType<typeof setTimeout>
  lastUsedAt: number
}

type BridgeSessionCloudClient = Pick<ConvexBridgeCloudClient, "appendEvents" | "markResult">

type EventWriteOutcome = { ok: true; count: number } | { ok: false; count: number; error: Error }

const EVENT_BATCH_MAX_SIZE = 25
const EVENT_BATCH_FLUSH_MS = 300
const APPROVAL_RESPONSE_SESSION_WAIT_MS = 250
const APPROVAL_RESPONSE_SESSION_POLL_MS = 10

export type BridgeSessionManagerOptions = {
  cloudClient: BridgeSessionCloudClient
  deviceId?: string
  agentCommand?: string | string[]
  runtimeProfiles?: BridgeRuntimeProfile[]
  requestTimeoutMs?: number
  createMcpServers?: (
    context: Pick<BridgeSessionContext, "cwd" | "sessionKey" | "threadId">,
  ) => HermesAcpMcpServer[]
  createSession?: (context: BridgeSessionContext) => ManagedAcpSession
  idleSessionTtlMs?: number
  allowRemoteCwd?: boolean
  resumeEnabled?: boolean
  log?: BridgeLogger
}

export type BridgeSessionManagerStatus = {
  activeSessions: string[]
  sessions: Array<{
    sessionKey: string
    threadId: string
    queueDepth: number
    runningQueueItemId?: string
    lastUsedAt: number
  }>
}

export type BridgeSessionLogEntry = BridgeLogEntry

export function resolveHermesProfileAgentCommand(
  baseCommand: string | string[] | undefined,
  hermesProfileName: string | undefined,
): string[] {
  const command = Array.isArray(baseCommand)
    ? [...baseCommand]
    : splitCommand(baseCommand ?? "hermes acp")
  const profileName = hermesProfileName?.trim()
  if (!profileName) {
    return command
  }
  const acpIndex = command.findIndex((part) => part === "acp")
  if (acpIndex < 0) {
    return [...command, "-p", profileName, "acp"]
  }
  return [...command.slice(0, acpIndex), "-p", profileName, ...command.slice(acpIndex)]
}

export class BridgeSessionManager {
  private readonly cloudClient: BridgeSessionCloudClient
  private readonly deviceId?: string
  private readonly agentCommand?: string | string[]
  private readonly runtimeProfiles: BridgeRuntimeProfile[]
  private readonly requestTimeoutMs?: number
  private readonly createMcpServers: (
    context: Pick<BridgeSessionContext, "cwd" | "sessionKey" | "threadId">,
  ) => HermesAcpMcpServer[]
  private readonly log?: BridgeLogger
  private readonly idleSessionTtlMs: number
  private readonly allowRemoteCwd: boolean
  private readonly resumeEnabled: boolean
  private readonly createSession: (context: BridgeSessionContext) => ManagedAcpSession
  private readonly sessions = new Map<string, BridgeSessionRecord>()
  private readonly promptQueues = new Map<string, Promise<void>>()
  private readonly sessionQueueState = new Map<
    string,
    { pendingQueueItemIds: string[]; runningQueueItemId?: string }
  >()
  private readonly eventBatch: BridgeEventInput[] = []
  private readonly pendingEventWrites: Promise<EventWriteOutcome>[] = []
  private eventBatchTimer: ReturnType<typeof setTimeout> | undefined
  private nextSequence = 1
  private nextGeneration = 1

  constructor(options: BridgeSessionManagerOptions) {
    this.cloudClient = options.cloudClient
    this.deviceId = options.deviceId
    this.agentCommand = options.agentCommand
    this.runtimeProfiles = options.runtimeProfiles ?? []
    this.requestTimeoutMs = options.requestTimeoutMs
    this.log = options.log
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? 0
    this.allowRemoteCwd = options.allowRemoteCwd === true
    this.resumeEnabled = options.resumeEnabled === true
    this.createMcpServers = options.createMcpServers ?? (() => [])
    this.createSession =
      options.createSession ??
      ((context) =>
        new HermesAcpSession({
          agentCommand: context.agentCommand,
          cwd: context.cwd,
          initialSessionId: context.initialSessionId,
          mcpServers: context.mcpServers,
          requestTimeoutMs: this.requestTimeoutMs,
          resumeEnabled: this.resumeEnabled,
          onEvent: context.onEvent,
          onError: context.onError,
        }))
  }

  getStatus(): BridgeSessionManagerStatus {
    return {
      activeSessions: Array.from(this.sessions.keys()),
      sessions: Array.from(this.sessions.values()).map((session) => {
        const queueState = this.sessionQueueState.get(session.sessionKey)
        return {
          sessionKey: session.sessionKey,
          threadId: session.threadId,
          queueDepth:
            (queueState?.pendingQueueItemIds.length ?? 0) +
            (queueState?.runningQueueItemId ? 1 : 0),
          runningQueueItemId: queueState?.runningQueueItemId,
          lastUsedAt: session.lastUsedAt,
        }
      }),
    }
  }

  async handleQueueItem(item: BridgeSessionQueueItem): Promise<void> {
    const type = normalizeType(item)
    this.writeLog({
      level: "info",
      event: "bridge.queue_item.start",
      queueId: item.id,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
    })
    try {
      if (type === "ping") {
        await this.cloudClient.markResult(item.id, { ok: true, kind: "pong" })
        this.writeQueueCompleteLog(item, type)
        return
      }

      if (type === "start-session") {
        await this.handleStartSession(item)
        this.writeQueueCompleteLog(item, type)
        return
      }

      if (type === "prompt") {
        this.writeAgentTurnLog("agent.turn.started", item, type)
        await this.handlePrompt(item)
        this.writeAgentTurnLog("agent.turn.completed", item, type)
        this.writeQueueCompleteLog(item, type)
        return
      }

      if (type === "cancel") {
        await this.handleCancel(item)
        this.writeQueueCompleteLog(item, type)
        return
      }

      if (isApprovalResponseType(type)) {
        await this.handleApprovalResponse(item, type)
        this.writeQueueCompleteLog(item, type)
        return
      }

      await this.cloudClient.markResult(item.id, {
        ok: false,
        error: `unsupported command type: ${type}`,
      })
      this.writeQueueCompleteLog(item, type)
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = String(redactLogValue(rawMessage))
      this.writeLog({
        level: "error",
        event: "bridge.queue_item.error",
        queueId: item.id,
        queueType: type,
        threadId: item.threadId,
        sessionId: item.sessionId,
        agentSessionId: item.agentSessionId,
        error: message,
      })
      if (type === "prompt") {
        this.writeAgentTurnLog("agent.turn.failed", item, type, message)
      }
      await this.drainEventWrites()
      const terminal = isTerminalQueueItemError(type, message)
      await this.cloudClient.markResult(
        item.id,
        terminal
          ? {
              ok: false,
              error: message,
              terminal,
            }
          : {
              ok: false,
              error: message,
            },
      )
    }
  }

  async close(): Promise<void> {
    await this.drainEventWrites()
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    await Promise.all(
      sessions.map((session) => {
        this.clearIdleTimer(session)
        return session.acp.close()
      }),
    )
  }

  private async handlePrompt(item: BridgeSessionQueueItem): Promise<void> {
    if (!item.prompt) {
      throw new Error(`prompt command ${item.id} is missing prompt text`)
    }
    const threadId = item.threadId ?? item.sessionId
    if (!threadId) {
      throw new Error(`queue item ${item.id} is missing threadId`)
    }
    const sessionKey = sessionKeyForItem(item) ?? threadId
    const prompt = item.prompt
    const threadHistory = normalizeThreadHistory(item.threadHistory)
    const systemPrompt = normalizeSystemPrompt(item.systemPrompt)
    const autoApprovePermissionRequests = item.approvalLevel === "full_permissions"
    await this.runSerializedPrompt(sessionKey, item.id, () =>
      this.handlePromptNow(item, prompt, {
        autoApprovePermissionRequests,
        systemPrompt,
        threadHistory,
      }),
    )
  }

  private async handlePromptNow(
    item: BridgeSessionQueueItem,
    prompt: string,
    options: {
      systemPrompt?: string
      threadHistory?: string
      autoApprovePermissionRequests?: boolean
    } = {},
  ): Promise<void> {
    const session = this.ensureSession(item)
    session.lastUsedAt = Date.now()
    this.clearIdleTimer(session)
    this.enqueueEventWrite(session, {
      externalEventId: `${item.id}:message_started`,
      source: "bridge",
      eventType: "message_started",
      payload: { queueId: item.id, queueType: normalizeType(item) },
      part: {
        type: "event",
        text: `${displayNameForSessionStart(session)} started this run.`,
        status: "streaming",
      },
    })
    let result: HermesAcpPromptResult
    try {
      result = await session.acp.sendUserMessage(prompt, options)
    } catch (error) {
      await this.closeSession(session.sessionKey)
      throw error
    }
    if (!this.isCurrentSessionRecord(session)) {
      throw new Error(`ACP session ${session.sessionKey} was replaced before prompt completed`)
    }
    this.enqueueEventWrite(session, {
      externalEventId: `${item.id}:message_completed`,
      source: "bridge",
      eventType: "message_completed",
      payload: {
        queueId: item.id,
        stopReason: result.stopReason,
        text: result.text,
      },
      part: {
        type: "event",
        text: result.text,
        json: { stopReason: result.stopReason },
        status: "complete",
      },
    })
    await this.drainEventWrites()
    await this.cloudClient.markResult(item.id, {
      ok: true,
      agentSessionId: session.sessionKey,
      acpSessionId: result.sessionId,
      acpCapabilities: result.capabilities,
      stopReason: result.stopReason,
      text: result.text,
      result: result.rawResult,
    })
    session.lastUsedAt = Date.now()
    this.scheduleIdleClose(session)
    this.writeLog({
      level: "info",
      event: "bridge.session.ready",
      queueId: item.id,
      queueType: normalizeType(item),
      threadId: session.threadId,
      sessionId: item.sessionId,
      agentSessionId: session.sessionKey,
      acpSessionId: result.sessionId,
    })
  }

  private async runSerializedPrompt(
    sessionKey: string,
    queueItemId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const queueState = this.getSessionQueueState(sessionKey)
    queueState.pendingQueueItemIds.push(queueItemId)
    const previous = this.promptQueues.get(sessionKey) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        queueState.pendingQueueItemIds = queueState.pendingQueueItemIds.filter(
          (id) => id !== queueItemId,
        )
        queueState.runningQueueItemId = queueItemId
        try {
          await task()
        } finally {
          if (queueState.runningQueueItemId === queueItemId) {
            queueState.runningQueueItemId = undefined
          }
          this.deleteEmptySessionQueueState(sessionKey)
        }
      })
    const tracked = current.then(
      () => undefined,
      () => undefined,
    )
    this.promptQueues.set(sessionKey, tracked)
    try {
      await current
    } finally {
      if (this.promptQueues.get(sessionKey) === tracked) {
        this.promptQueues.delete(sessionKey)
      }
      queueState.pendingQueueItemIds = queueState.pendingQueueItemIds.filter(
        (id) => id !== queueItemId,
      )
      this.deleteEmptySessionQueueState(sessionKey)
    }
  }

  private getSessionQueueState(sessionKey: string) {
    const existing = this.sessionQueueState.get(sessionKey)
    if (existing) {
      return existing
    }
    const next: { pendingQueueItemIds: string[]; runningQueueItemId?: string } = {
      pendingQueueItemIds: [],
    }
    this.sessionQueueState.set(sessionKey, next)
    return next
  }

  private deleteEmptySessionQueueState(sessionKey: string): void {
    const state = this.sessionQueueState.get(sessionKey)
    if (state && state.pendingQueueItemIds.length === 0 && !state.runningQueueItemId) {
      this.sessionQueueState.delete(sessionKey)
    }
  }

  private async handleApprovalResponse(item: BridgeSessionQueueItem, type: string): Promise<void> {
    const key = sessionKeyForItem(item)
    let session = key ? this.sessions.get(key) : undefined
    if (!session && key && this.sessionQueueState.has(key)) {
      session = await this.waitForSession(key)
    }
    if (!session) {
      throw new Error(`approval response ${item.id} does not match an active ACP session`)
    }
    if (type === "choice-response") {
      const choiceId = item.approvalOutcome?.trim()
      if (!choiceId) {
        throw new Error(`choice response ${item.id} is missing choice id`)
      }
      await session.acp.sendUserMessage(`Selected choice: ${choiceId}`)
      session.lastUsedAt = Date.now()
      this.scheduleIdleClose(session)
      await this.cloudClient.markResult(item.id, { ok: true, choiceId })
      return
    }
    const externalRequestId = item.externalRequestId ?? item.approvalId
    if (!externalRequestId) {
      throw new Error(`approval response ${item.id} is missing external request id`)
    }
    const approved = item.approvalOutcome === "approved" || item.approvalOutcome === "allow"
    const handled = await session.acp.respondToPermissionRequest?.(externalRequestId, {
      approved,
      reason: item.approvalReason,
    })
    if (!handled) {
      throw new Error(`approval response ${item.id} did not match a pending ACP permission request`)
    }
    session.lastUsedAt = Date.now()
    this.scheduleIdleClose(session)
    await this.cloudClient.markResult(item.id, { ok: true, approved })
  }

  private async waitForSession(sessionKey: string): Promise<BridgeSessionRecord | undefined> {
    const deadline = Date.now() + APPROVAL_RESPONSE_SESSION_WAIT_MS
    while (Date.now() < deadline) {
      const session = this.sessions.get(sessionKey)
      if (session) {
        return session
      }
      const queueState = this.sessionQueueState.get(sessionKey)
      const hasQueuedPrompt =
        (queueState?.pendingQueueItemIds.length ?? 0) > 0 || Boolean(queueState?.runningQueueItemId)
      if (!hasQueuedPrompt) {
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, APPROVAL_RESPONSE_SESSION_POLL_MS))
    }
    return this.sessions.get(sessionKey)
  }

  private async handleStartSession(item: BridgeSessionQueueItem): Promise<void> {
    const session = this.ensureSession(item)
    session.lastUsedAt = Date.now()
    this.scheduleIdleClose(session)
    await this.cloudClient.markResult(item.id, {
      ok: true,
      started: true,
      agentSessionId: session.sessionKey,
    })
  }

  private async handleCancel(item: BridgeSessionQueueItem): Promise<void> {
    const key = sessionKeyForItem(item)
    const session = key ? this.sessions.get(key) : undefined
    if (session) {
      await session.acp.cancel()
    }
    await this.cloudClient.markResult(item.id, { ok: true, cancelled: Boolean(session) })
  }

  private async closeSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) {
      return
    }
    this.sessions.delete(sessionKey)
    this.clearIdleTimer(session)
    await this.drainEventWrites()
    await session.acp.close()
  }

  private ensureSession(item: BridgeSessionQueueItem): BridgeSessionRecord {
    const threadId = item.threadId ?? item.sessionId
    if (!threadId) {
      throw new Error(`queue item ${item.id} is missing threadId`)
    }
    const sessionKey = sessionKeyForItem(item) ?? threadId
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      existing.agentName = normalizeAgentName(item.agentName) ?? existing.agentName
      return existing
    }

    const generation = this.nextGeneration
    this.nextGeneration += 1
    const runtimeProfile = this.resolveRuntimeProfileForItem(item)
    const agentCommand = runtimeProfile
      ? runtimeProfile.command
      : resolveHermesProfileAgentCommand(this.agentCommand, item.hermesProfileName)
    const cwd = this.allowRemoteCwd ? item.cwd : undefined
    const record: BridgeSessionRecord = {
      sessionKey,
      threadId,
      cwd,
      agentName: normalizeAgentName(item.agentName),
      generation,
      lastUsedAt: Date.now(),
      acp: this.createSession({
        agentCommand,
        bridgeProfileId: item.bridgeProfileId,
        runtimeProfile,
        sessionKey,
        threadId,
        cwd,
        hermesProfileName: item.hermesProfileName,
        initialSessionId: item.externalSessionId,
        mcpServers: this.createMcpServers({ cwd: item.cwd, sessionKey, threadId }),
        onEvent: (event) => {
          if (this.isCurrentSessionRecord(record)) {
            this.enqueueEventWrite(record, event)
          }
        },
        onError: (error) => {
          if (this.isCurrentSessionRecord(record)) {
            this.enqueueErrorWrite(record, error)
          }
        },
      }),
      runtimeProfile,
      hermesProfileName: item.hermesProfileName,
    }
    this.sessions.set(sessionKey, record)
    return record
  }

  private resolveRuntimeProfileForItem(
    item: BridgeSessionQueueItem,
  ): BridgeRuntimeProfile | undefined {
    if (item.bridgeProfileId) {
      const selected = this.runtimeProfiles.find((profile) => profile.id === item.bridgeProfileId)
      if (!selected) {
        throw new Error(`Bridge runtime profile is unavailable: ${item.bridgeProfileId}`)
      }
      if (selected.status !== "available") {
        const reason = selected.diagnostics?.reason ? `: ${selected.diagnostics.reason}` : ""
        throw new Error(`Bridge runtime profile is unavailable: ${item.bridgeProfileId}${reason}`)
      }
      return selected
    }
    if (item.hermesProfileName) {
      return undefined
    }
    return findRuntimeProfile(this.runtimeProfiles, undefined)
  }

  private isCurrentSessionRecord(record: BridgeSessionRecord): boolean {
    const current = this.sessions.get(record.sessionKey)
    return current === record && current.generation === record.generation
  }

  private clearIdleTimer(record: BridgeSessionRecord): void {
    if (record.idleTimer !== undefined) {
      clearTimeout(record.idleTimer)
      record.idleTimer = undefined
    }
  }

  private scheduleIdleClose(record: BridgeSessionRecord): void {
    if (this.idleSessionTtlMs <= 0 || !this.isCurrentSessionRecord(record)) {
      return
    }
    this.clearIdleTimer(record)
    record.idleTimer = setTimeout(() => {
      void this.closeSessionIfIdle(record.sessionKey, record.generation)
    }, this.idleSessionTtlMs)
  }

  private async closeSessionIfIdle(sessionKey: string, generation: number): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session || session.generation !== generation) {
      return
    }
    const queueState = this.sessionQueueState.get(sessionKey)
    const hasQueueWork =
      (queueState?.pendingQueueItemIds.length ?? 0) > 0 || Boolean(queueState?.runningQueueItemId)
    const hasEventWrites =
      this.eventBatch.length > 0 ||
      this.pendingEventWrites.length > 0 ||
      this.eventBatchTimer !== undefined
    const hasPendingPermissions = session.acp.hasPendingPermissionRequests?.() === true
    if (hasQueueWork || hasEventWrites || hasPendingPermissions) {
      this.scheduleIdleClose(session)
      return
    }
    this.writeLog({
      level: "info",
      event: "bridge.session.idle_close",
      threadId: session.threadId,
      agentSessionId: session.sessionKey,
    })
    await this.closeSession(sessionKey)
  }

  private enqueueEventWrite(record: BridgeSessionRecord, event: NormalizedBridgeEvent): void {
    const sequence = this.nextSequence
    this.nextSequence += 1
    this.writeBridgeActivityLog(record, event, sequence)
    this.enqueueBridgeEvent(toBridgeEvent(record, event, sequence))
  }

  private writeBridgeActivityLog(
    record: BridgeSessionRecord,
    event: NormalizedBridgeEvent,
    sequence: number,
  ): void {
    const queueId = this.sessionQueueState.get(record.sessionKey)?.runningQueueItemId
    const base = {
      agentSessionId: record.sessionKey,
      queueId,
      threadId: record.threadId,
      timelineSequence: sequence,
      turnId: queueId,
    }

    if (event.part?.type === "thinking") {
      this.writeLog({
        ...base,
        event: "agent.reasoning.chunk",
        level: "debug",
        textLength: event.part.text?.length ?? 0,
      })
      return
    }

    if (event.part?.type === "tool_call") {
      const tool = readToolLogFields(event.part.json)
      this.writeLog({
        ...base,
        event: "agent.tool.requested",
        level: "info",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
      })
      return
    }

    if (event.part?.type === "tool_result") {
      const tool = readToolLogFields(event.part.json)
      this.writeLog({
        ...base,
        event: event.part.status === "error" ? "agent.tool.failed" : "agent.tool.completed",
        level: event.part.status === "error" ? "error" : "info",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
      })
    }
  }

  private enqueueErrorWrite(record: BridgeSessionRecord, error: Error): void {
    const sequence = this.nextSequence
    this.nextSequence += 1
    const message = String(redactLogValue(error.message))
    this.enqueueBridgeEvent({
      threadId: record.threadId,
      agentSessionId: record.sessionKey,
      eventType: "bridge_error",
      sequence,
      rawPayload: { message },
      normalizedPayload: { type: "error", text: message, status: "error" },
      source: "bridge",
      externalEventId: `${record.sessionKey}:${sequence}:bridge_error`,
      createdAt: Date.now(),
    })
  }

  private async drainEventWrites(): Promise<void> {
    this.flushEventBatch()
    const pending = this.pendingEventWrites.splice(0, this.pendingEventWrites.length)
    const outcomes = await Promise.all(pending)
    const failures = outcomes.filter((outcome) => !outcome.ok)
    if (failures.length > 0) {
      const firstFailure = failures[0]
      throw new Error(
        `bridge event upload failed for ${failures.reduce((total, failure) => total + failure.count, 0)} event(s): ${firstFailure.error.message}`,
      )
    }
  }

  private enqueueBridgeEvent(event: BridgeEventInput): void {
    this.eventBatch.push(event)
    if (this.eventBatch.length >= EVENT_BATCH_MAX_SIZE) {
      this.flushEventBatch()
      return
    }
    this.scheduleEventBatchFlush()
  }

  private scheduleEventBatchFlush(): void {
    if (this.eventBatchTimer !== undefined) {
      return
    }
    this.eventBatchTimer = setTimeout(() => {
      this.eventBatchTimer = undefined
      this.flushEventBatch()
    }, EVENT_BATCH_FLUSH_MS)
  }

  private flushEventBatch(): void {
    if (this.eventBatchTimer !== undefined) {
      clearTimeout(this.eventBatchTimer)
      this.eventBatchTimer = undefined
    }
    if (this.eventBatch.length === 0) {
      return
    }
    const events = this.eventBatch.splice(0, this.eventBatch.length)
    this.trackEventWrite(this.appendEventBatchWithFallback(events))
  }

  private trackEventWrite(write: Promise<EventWriteOutcome>): void {
    this.pendingEventWrites.push(write)
    const forgetWrite = () => {
      const index = this.pendingEventWrites.indexOf(write)
      if (index >= 0) {
        this.pendingEventWrites.splice(index, 1)
      }
    }
    void write.then(forgetWrite, forgetWrite)
  }

  private async appendEventBatchWithFallback(
    events: BridgeEventInput[],
  ): Promise<EventWriteOutcome> {
    try {
      await this.cloudClient.appendEvents(events)
      this.writeLog({ level: "debug", event: "bridge.events.appended", eventCount: events.length })
      return { ok: true, count: events.length }
    } catch (error) {
      const message = String(redactLogValue(error instanceof Error ? error.message : String(error)))
      this.writeLog({
        level: "error",
        event: "bridge.events.append_failed",
        eventCount: events.length,
        error: message,
      })
      if (events.length <= 1) {
        return { ok: false, count: events.length, error: new Error(message) }
      }

      let failedCount = 0
      let firstError: Error | undefined
      for (const event of events) {
        try {
          await this.cloudClient.appendEvents([event])
          this.writeLog({
            level: "debug",
            event: "bridge.events.appended_single",
            eventType: event.eventType,
            threadId: event.threadId,
          })
        } catch (singleError) {
          failedCount += 1
          const singleMessage = String(
            redactLogValue(
              singleError instanceof Error ? singleError.message : String(singleError),
            ),
          )
          firstError = firstError ?? new Error(singleMessage)
          this.writeLog({
            level: "error",
            event: "bridge.events.append_single_failed",
            eventType: event.eventType,
            threadId: event.threadId,
            externalEventId: event.externalEventId,
            error: singleMessage,
          })
        }
      }

      if (failedCount > 0) {
        return {
          ok: false,
          count: failedCount,
          error: firstError ?? new Error(`bridge event upload failed for ${failedCount} event(s)`),
        }
      }
      return { ok: true, count: events.length }
    }
  }

  private writeQueueCompleteLog(item: BridgeSessionQueueItem, type: string): void {
    this.writeLog({
      level: "info",
      event: "bridge.queue_item.complete",
      queueId: item.id,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
      activeSessionCount: this.sessions.size,
    })
  }

  private writeAgentTurnLog(
    event: "agent.turn.completed" | "agent.turn.failed" | "agent.turn.started",
    item: BridgeSessionQueueItem,
    type: string,
    error?: string,
  ): void {
    this.writeLog({
      level: event === "agent.turn.failed" ? "error" : "info",
      event,
      queueId: item.id,
      queueType: type,
      threadId: item.threadId,
      sessionId: item.sessionId,
      agentSessionId: item.agentSessionId,
      error,
    })
  }

  private writeLog(entry: BridgeLogEntry): void {
    this.log?.(redactLogValue({ deviceId: this.deviceId, ...entry }) as BridgeLogEntry)
  }
}

function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaping = false

  for (const character of command) {
    if (escaping) {
      current += character
      escaping = false
      continue
    }
    if (character === "\\") {
      escaping = true
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else {
        current += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += character
  }

  if (current.length > 0) {
    parts.push(current)
  }
  return parts
}

function toBridgeEvent(
  record: BridgeSessionRecord,
  event: NormalizedBridgeEvent,
  sequence: number,
): BridgeEventInput {
  const shouldRedactPayload = event.eventType === "bridge_error" || event.part?.type === "error"
  return {
    threadId: record.threadId,
    agentSessionId: record.sessionKey,
    eventType: event.eventType,
    sequence,
    rawPayload: shouldRedactPayload ? redactLogValue(event.payload) : event.payload,
    normalizedPayload: shouldRedactPayload ? redactLogValue(event.part) : event.part,
    source: event.source,
    externalEventId: event.externalEventId,
    externalRequestId: event.externalRequestId,
    createdAt: Date.now(),
  }
}

function normalizeType(item: BridgeSessionQueueItem): string {
  return item.type ?? item.kind ?? "unknown"
}

function displayNameForSessionStart(session: BridgeSessionRecord): string {
  const agentName = normalizeAgentName(session.agentName)
  if (agentName) {
    return agentName
  }
  return "Agent"
}

function normalizeAgentName(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function isApprovalResponseType(type: string): boolean {
  return (
    type === "approval-response" || type === "permission-response" || type === "choice-response"
  )
}

function isTerminalQueueItemError(type: string, message: string): boolean {
  if (!isApprovalResponseType(type)) {
    return false
  }
  return (
    message.includes("does not match an active ACP session") ||
    message.includes("did not match a pending ACP permission request")
  )
}

function normalizeSystemPrompt(systemPrompt: string | undefined): string | undefined {
  const normalized = systemPrompt?.trim()
  return normalized ? normalized : undefined
}

function normalizeThreadHistory(threadHistory: string | undefined): string | undefined {
  const normalized = threadHistory?.trim()
  return normalized ? normalized : undefined
}

function sessionKeyForItem(item: BridgeSessionQueueItem): string | undefined {
  return item.agentSessionId ?? item.sessionId ?? item.threadId
}

function readToolLogFields(value: unknown): { toolCallId?: string; toolName: string } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    toolCallId: readString(record.toolCallId) ?? readString(record.tool_call_id) ?? readString(record.id),
    toolName:
      readString(record.toolName) ?? readString(record.name) ?? readString(record.tool) ?? "unknown",
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
