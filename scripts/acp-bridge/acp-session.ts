import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildZeroChatHiddenSystemPrompt } from "./zero-chat-policy"
import {
  classifyRuntimeLogLine,
  type NormalizedBridgeEvent,
  normalizeAcpNotification,
  normalizeBridgeError,
  normalizeRuntimeDiagnostic,
  shouldSuppressRuntimeDiagnostic,
} from "./event-normalizer"
import type {
  BridgeAcpRawUpdate,
  BridgeAcpRuntimeClient,
  BridgeCreateSessionParams,
  BridgeMcpServer,
  BridgePermissionRequest,
  BridgePermissionResponse,
  BridgePromptContentBlock,
} from "./acp-runtime-client"
import {
  SdkAcpRuntimeClient,
  type SdkAcpRuntimeActivity,
  type SdkAcpRuntimeTerminalAdapter,
} from "./sdk-acp-runtime-client"

export type HermesAcpRuntimeCapabilities = {
  loadSession: boolean
  promptCapabilities?: {
    audio: boolean
    embeddedContext: boolean
    image: boolean
  }
  supportsPromptResourceLinks: boolean
  sdkProtocolVersion?: string
  supportsAuth: boolean
  supportsLogout: boolean
  supportsSessionLoad: boolean
  supportsSessionResume: boolean
  supportsSessionClose: boolean
  supportsSessionDelete: boolean
  supportsSessionFork: boolean
  supportsPerSessionMcpServers: boolean
  supportsSessionList: boolean
  raw?: unknown
}

export type HermesAcpPromptResult = {
  sessionId: string
  rawResult: unknown
  stopReason?: string
  text: string
  events: NormalizedBridgeEvent[]
  capabilities?: HermesAcpRuntimeCapabilities
  finalText?: HermesAcpFinalTextDiagnostics
  attachmentDeliveryMode?: HermesAcpAttachmentDeliveryMode
}

export type HermesAcpFinalTextDiagnostics = {
  answerChunkCount: number
  answerTextLength: number
  reason?: "codex_unclassified_message_chunks" | "untrusted_message_chunks"
  runtimeId: "claude-code" | "codex" | "other"
  thoughtChunkCount: number
  toolEventCount: number
  trustedFinalResultText: boolean
  withheld: boolean
}

export type HermesAcpPromptOptions = {
  systemPrompt?: string
  threadHistory?: string
  attachmentReferenceText?: string
  attachments?: HermesAcpPromptAttachment[]
  autoApprovePermissionRequests?: boolean
  runtimeConfig?: Record<string, string>
}

export type HermesAcpAttachmentDeliveryMode = "resource_links" | "text_references"

export type HermesAcpPromptAttachment = {
  access?: {
    mode?: string
    url?: string
  }
  checksumSha256?: string
  filename?: string
  mediaType?: string
  sizeBytes?: number
  url?: string
}

export type AcpAdapterCapabilityUsed =
  | "probeRuntime"
  | "createSession"
  | "loadSession"
  | "sendPrompt"
  | "cancelTurn"
  | "closeSession"
  | "sendInteractionResponse"
  | "applyRuntimeConfig"
  | "restoreRuntimeConfig"

export type AcpAdapterResult<T = {}> =
  | ({
      ok: true
      capabilityUsed: AcpAdapterCapabilityUsed
      nativeMethod?: string
      diagnosticReasonCode?: string
    } & T)
  | {
      ok: false
      capabilityUsed: AcpAdapterCapabilityUsed
      nativeMethod?: string
      diagnosticReasonCode: string
      error: Error
    }

export type RuntimeConfigApplicationInput = {
  requested: Record<string, string | undefined>
  supportedOptions: Record<string, string[] | undefined>
}

export type RuntimeConfigApplicationResult = {
  applied: Record<string, string>
  diagnostics: Array<{ option: string; reasonCode: string; value: string }>
  ok: true
  policy: "omit_unavailable"
}

export type AcpRuntimeAdapterSessionFactory = (
  options: HermesAcpSessionOptions,
) => HermesAcpSession

export type AcpRuntimeAdapterCreateSessionInput = HermesAcpSessionOptions

export type AcpRuntimeAdapterInteractionResponse = {
  approved: boolean
  externalRequestId: string
  reason?: string
}

export type HermesAcpSessionOptions = {
  agentCommand?: string | string[]
  cwd?: string
  initialSessionId?: string
  mcpServers?: HermesAcpMcpServer[]
  processExitGraceMs?: number
  requestTimeoutMs?: number
  resumeEnabled?: boolean
  onEvent?: (event: NormalizedBridgeEvent) => void | Promise<void>
  onError?: (error: Error) => void | Promise<void>
  runtimeClient?: BridgeAcpRuntimeClient
  spawnProcess?: (command: string, args: string[], cwd?: string) => ChildProcessWithoutNullStreams
  terminalAdapter?: SdkAcpRuntimeTerminalAdapter
}

export type HermesAcpMcpServer = {
  args?: string[]
  command: string
  env?: Array<{ name: string; value: string }>
  name: string
}

export type HermesAcpPromptTimeoutDiagnostics = {
  deferredPromptEventCount: number
  eventTypeCounts: Record<string, number>
  externalContinuity: {
    attempted: boolean
    fallback: boolean
    loaded: boolean
  }
  lastPromptEventType?: string
  lifecyclePhase: string
  pendingPermissionRequestCount: number
  promptEventCount: number
  requestTimeoutMs: number
}

type PermissionRequestOption = {
  kind?: string
  name?: string
  optionId: string
}
type PendingPermissionRequest = {
  options: PermissionRequestOption[]
  resolve: (response: BridgePermissionResponse) => void
}

export const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_ACP_PROCESS_EXIT_GRACE_MS = 2_500

export const HIDDEN_ZERO_CHAT_SYSTEM_PROMPT = buildZeroChatHiddenSystemPrompt()

export class HermesAcpProcessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HermesAcpProcessError"
  }
}

export class HermesAcpJsonRpcError extends Error {
  readonly code?: number
  readonly errorKind?: string
  readonly method: string

  constructor(method: string, error: unknown) {
    const diagnostic = formatAcpJsonRpcError(error)
    super(`ACP ${method} failed: ${diagnostic}`)
    this.name = "HermesAcpJsonRpcError"
    this.method = method
    this.code = readJsonRpcErrorCode(error)
    this.errorKind = readJsonRpcErrorKind(error)
  }
}

export class HermesAcpSession {
  readonly command: string[]
  readonly cwd?: string
  readonly initialSessionId?: string
  readonly mcpServers: HermesAcpMcpServer[]
  readonly processExitGraceMs: number
  readonly requestTimeoutMs: number
  readonly resumeEnabled: boolean

  private readonly onEvent?: (event: NormalizedBridgeEvent) => void | Promise<void>
  private readonly onError?: (error: Error) => void | Promise<void>
  private readonly providedRuntimeClient?: BridgeAcpRuntimeClient
  private readonly terminalAdapter?: SdkAcpRuntimeTerminalAdapter
  private readonly spawnProcess: (
    command: string,
    args: string[],
    cwd?: string,
  ) => ChildProcessWithoutNullStreams
  private child?: ChildProcessWithoutNullStreams
  private nextEventSequence = 1
  private promptEvents: NormalizedBridgeEvent[] = []
  private deferredPromptEvents: NormalizedBridgeEvent[] = []
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequest>()
  private runtimeClient?: BridgeAcpRuntimeClient
  private unsubscribeRuntimeUpdates?: () => void
  private autoApprovePermissionRequests = false
  private lifecyclePhase: "starting" | "loading" | "livePrompt" | "idle" | "closing" | "closed" =
    "closed"
  private externalContinuityAttempted = false
  private externalContinuityLoaded = false
  private externalContinuityFallback = false
  private externalContinuityFallbackNotified = false
  private closed = false
  private started = false
  private currentConfigOptions = new Map<string, string>()
  private lastRequestActivityAt = Date.now()
  sessionId?: string
  capabilities?: HermesAcpRuntimeCapabilities

  constructor(options: HermesAcpSessionOptions = {}) {
    this.command = Array.isArray(options.agentCommand)
      ? [...options.agentCommand]
      : splitCommand(options.agentCommand ?? "hermes acp")
    this.cwd = options.cwd
    this.initialSessionId = options.initialSessionId
    this.mcpServers = options.mcpServers ?? []
    this.processExitGraceMs = options.processExitGraceMs ?? DEFAULT_ACP_PROCESS_EXIT_GRACE_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS
    this.resumeEnabled = options.resumeEnabled === true
    this.onEvent = options.onEvent
    this.onError = options.onError
    this.providedRuntimeClient = options.runtimeClient
    this.terminalAdapter = options.terminalAdapter
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess
  }

  async start(): Promise<string> {
    if (this.started && this.sessionId) {
      return this.sessionId
    }
    if (this.command.length === 0) {
      throw new Error("ACP runtime command cannot be empty")
    }

    this.closed = false
    this.lifecyclePhase = "starting"
    this.runtimeClient = this.createRuntimeClient()

    const initializeResult = await this.withRequestTimeout("initialize", () =>
      this.requireRuntimeClient().initialize(),
    )
    this.capabilities = extractCapabilities(initializeResult.raw)

    if (this.resumeEnabled && this.initialSessionId) {
      const resumedSessionId = await this.tryExternalSessionContinuity()
      if (resumedSessionId) {
        return resumedSessionId
      }
      this.externalContinuityFallback = true
    }

    this.lifecyclePhase = "starting"
    const result = await this.createNewSession()
    this.storeConfigOptions(result)
    this.sessionId = extractSessionId(result)
    this.started = true
    this.lifecyclePhase = "idle"
    return this.sessionId
  }

  async sendUserMessage(
    text: string,
    options: HermesAcpPromptOptions = {},
  ): Promise<HermesAcpPromptResult> {
    if (text.length === 0) {
      throw new Error("Cannot send an empty ACP runtime user message")
    }
    const sessionId = await this.start()
    if (this.externalContinuityFallback && !this.externalContinuityFallbackNotified) {
      this.externalContinuityFallbackNotified = true
      void this.onError?.(
        new Error(
          "external ACP session continuity unavailable; using fresh session with thread history fallback",
        ),
      )
    }
    this.lifecyclePhase = "livePrompt"
    const eventStart = this.promptEvents.length
    const previousAutoApprove = this.autoApprovePermissionRequests
    this.autoApprovePermissionRequests = options.autoApprovePermissionRequests === true
    const restoreRuntimeConfig = await this.applyRuntimeConfigOverrides(
      sessionId,
      options.runtimeConfig,
    )
    const attachmentBlocks =
      this.capabilities?.supportsPromptResourceLinks === false
        ? []
        : buildAttachmentResourceLinkBlocks(options.attachments)
    const attachmentDeliveryMode =
      attachmentBlocks.length > 0
        ? "resource_links"
        : options.attachments && options.attachments.length > 0
          ? "text_references"
          : undefined
    const promptText =
      attachmentBlocks.length > 0 || !options.attachmentReferenceText
        ? text
        : `${text}\n\n${options.attachmentReferenceText}`
    let rawResult: unknown
    try {
      const promptResult = await this.withRequestTimeout("session/prompt", () =>
        this.requireRuntimeClient().prompt({
          sessionId,
          prompt: buildPromptContentBlocks(promptText, options.systemPrompt, {
            attachmentBlocks,
            includeContinuityFallbackNote: this.externalContinuityFallback,
            threadHistory: options.threadHistory,
          }) as BridgePromptContentBlock[],
        }),
      )
      rawResult = promptResult.raw
    } catch (error) {
      this.discardDeferredPromptEventsSince(eventStart)
      throw error
    } finally {
      this.autoApprovePermissionRequests = previousAutoApprove
      await restoreRuntimeConfig()
      if (!this.closed) {
        this.lifecyclePhase = "idle"
      }
    }
    const events = this.promptEvents.slice(eventStart)
    const stopReason = extractStopReason(rawResult)
    const finalText = extractFinalText({
      command: this.command,
      events,
      rawResult,
      stopReason,
    })
    const processedEvents = reclassifyUntrustedMessageChunks(events, finalText.diagnostics)
    await this.flushDeferredPromptEvents(events, processedEvents)
    return {
      sessionId,
      rawResult,
      stopReason,
      text: finalText.text,
      events: processedEvents,
      capabilities: this.capabilities,
      finalText: finalText.diagnostics,
      attachmentDeliveryMode,
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) {
      return
    }
    await this.withRequestTimeout("session/cancel", () =>
      this.requireRuntimeClient().cancel({ sessionId: this.sessionId ?? "" }),
    )
  }

  async respondToPermissionRequest(
    externalRequestId: string,
    response: { approved: boolean; reason?: string },
  ): Promise<boolean> {
    const request = this.pendingPermissionRequests.get(externalRequestId)
    if (request === undefined) {
      return false
    }
    this.pendingPermissionRequests.delete(externalRequestId)
    const optionId = selectPermissionOptionId(request.options, response.approved)
    request.resolve(
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    return true
  }

  hasPendingPermissionRequests(): boolean {
    return this.pendingPermissionRequests.size > 0
  }

  getPromptTimeoutDiagnostics(): HermesAcpPromptTimeoutDiagnostics {
    return {
      deferredPromptEventCount: this.deferredPromptEvents.length,
      eventTypeCounts: countPromptEventTypes(this.promptEvents),
      externalContinuity: this.getExternalContinuityState(),
      lastPromptEventType: this.promptEvents.at(-1)?.eventType,
      lifecyclePhase: this.lifecyclePhase,
      pendingPermissionRequestCount: this.pendingPermissionRequests.size,
      promptEventCount: this.promptEvents.length,
      requestTimeoutMs: this.requestTimeoutMs,
    }
  }

  getExternalContinuityState(): { attempted: boolean; fallback: boolean; loaded: boolean } {
    return {
      attempted: this.externalContinuityAttempted,
      fallback: this.externalContinuityFallback,
      loaded: this.externalContinuityLoaded,
    }
  }

  async close(): Promise<void> {
    this.lifecyclePhase = "closing"
    if (this.sessionId && this.capabilities?.supportsSessionClose && !this.closed) {
      try {
        await this.withRequestTimeout("session/close", () =>
          this.requireRuntimeClient().closeSession?.({ sessionId: this.sessionId ?? "" }) ??
          Promise.resolve(),
        )
      } catch (error) {
        void this.onError?.(
          error instanceof Error
            ? new Error(`ACP session/close failed before process kill: ${error.message}`)
            : new Error(`ACP session/close failed before process kill: ${String(error)}`),
        )
      }
    }
    this.closed = true
    this.pendingPermissionRequests.clear()
    this.unsubscribeRuntimeUpdates?.()
    this.unsubscribeRuntimeUpdates = undefined
    await this.runtimeClient?.close()
    this.runtimeClient = undefined
    await this.terminateChildProcess()
    this.lifecyclePhase = "closed"
  }

  private async createNewSession(): Promise<unknown> {
    return await this.withRequestTimeout("session/new", () =>
      this.requireRuntimeClient().createSession(this.buildSessionNewParams()),
    )
  }

  private buildSessionNewParams(): BridgeCreateSessionParams {
    return {
      cwd: this.cwd ?? process.cwd(),
      mcpServers: this.mcpServers as BridgeMcpServer[],
    }
  }

  private async terminateChildProcess(): Promise<void> {
    const child = this.child
    if (!child) {
      return
    }
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
      }, this.processExitGraceMs)
    })
    if (this.child === child) {
      this.child = undefined
    }
  }

  private async tryExternalSessionContinuity(): Promise<string | undefined> {
    const methods: string[] = []
    if (this.capabilities?.supportsSessionLoad) {
      methods.push("session/load")
    }
    if (this.capabilities?.supportsSessionResume) {
      methods.push("session/resume")
    }
    if (methods.length === 0) {
      return undefined
    }

    for (const method of methods) {
      this.lifecyclePhase = "loading"
      this.externalContinuityAttempted = true
      try {
        const loaded =
          method === "session/load"
            ? await this.withRequestTimeout(method, () =>
                this.requireRuntimeClient().loadSession({
                  cwd: this.cwd ?? process.cwd(),
                  mcpServers: this.mcpServers as BridgeMcpServer[],
                  sessionId: this.initialSessionId ?? "",
                }),
              )
            : await this.withRequestTimeout(method, () =>
                this.requireRuntimeClient().resumeSession?.({
                  cwd: this.cwd ?? process.cwd(),
                  mcpServers: this.mcpServers as BridgeMcpServer[],
                  sessionId: this.initialSessionId ?? "",
                }) ?? Promise.reject(new Error("ACP runtime does not support session/resume")),
              )
        this.sessionId = extractSessionId(loaded, this.initialSessionId)
        this.storeConfigOptions(loaded)
        this.started = true
        this.externalContinuityLoaded = true
        this.lifecyclePhase = "idle"
        return this.sessionId
      } catch (error) {
        void this.onError?.(
          error instanceof Error
            ? new Error(`ACP ${method} failed; falling back to session/new: ${error.message}`)
            : new Error(`ACP ${method} failed; falling back to session/new: ${String(error)}`),
        )
      } finally {
        if (this.lifecyclePhase === "loading") {
          this.lifecyclePhase = "starting"
        }
      }
    }

    return undefined
  }

  private async applyRuntimeConfigOverrides(
    sessionId: string,
    runtimeConfig: Record<string, string> | undefined,
  ): Promise<() => Promise<void>> {
    const entries = Object.entries(runtimeConfig ?? {}).filter(([, value]) => value.length > 0)
    if (entries.length === 0) {
      return async () => {}
    }

    const previousValues = new Map<string, string | undefined>()
    for (const [configId, value] of entries) {
      const previous = this.currentConfigOptions.get(configId)
      previousValues.set(configId, previous)
      if (previous === value) {
        continue
      }
      await this.setRuntimeConfigOption(sessionId, configId, value)
    }

    return async () => {
      for (const [configId, value] of previousValues.entries()) {
        if (value === undefined || this.currentConfigOptions.get(configId) === value) {
          continue
        }
        try {
          await this.setRuntimeConfigOption(sessionId, configId, value)
        } catch (error) {
          void this.onError?.(
            error instanceof Error
              ? new Error(`ACP session/set_config_option restore failed: ${error.message}`)
              : new Error(`ACP session/set_config_option restore failed: ${String(error)}`),
          )
        }
      }
    }
  }

  private async setRuntimeConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    try {
      const result = await this.withRequestTimeout("session/set_config_option", () =>
        this.requireRuntimeClient().setConfigOption?.({ configId, sessionId, value }) ??
        Promise.reject(new Error("ACP runtime does not support session/set_config_option")),
      )
      this.storeConfigOptions(result)
      if (!this.currentConfigOptions.has(configId)) {
        this.currentConfigOptions.set(configId, value)
      }
    } catch (error) {
      void this.onError?.(
        error instanceof Error
          ? new Error(`ACP session/set_config_option failed: ${error.message}`)
          : new Error(`ACP session/set_config_option failed: ${String(error)}`),
      )
    }
  }

  private storeConfigOptions(result: unknown): void {
    const record = recordFromUnknown(result)
    const configOptions = Array.isArray(record.configOptions) ? record.configOptions : []
    for (const option of configOptions) {
      const optionRecord = recordFromUnknown(option)
      const id = readString(optionRecord.id)
      const currentValue = readString(optionRecord.currentValue)
      if (id && currentValue) {
        this.currentConfigOptions.set(id, currentValue)
      }
    }
  }

  private createRuntimeClient(): BridgeAcpRuntimeClient {
    if (this.providedRuntimeClient) {
      this.unsubscribeRuntimeUpdates?.()
      this.unsubscribeRuntimeUpdates = this.providedRuntimeClient.onUpdate((event) => {
        this.handleSessionUpdate(event)
      })
      return this.providedRuntimeClient
    }

    const [executable, ...args] = this.command
    this.child = this.spawnProcess(executable, args, this.cwd)
    this.attachProcessHandlers(this.child)
    const runtimeClient = SdkAcpRuntimeClient.fromChildProcess(this.child, {
      ...(this.cwd && isAbsolute(this.cwd)
        ? { filesystemPolicy: { workspaceRoots: [this.cwd] } }
        : {}),
      onActivity: (activity) => this.handleRuntimeActivity(activity),
      onPermissionRequest: (params) => this.handlePermissionRequest(params),
      ...(this.terminalAdapter ? { terminalAdapter: this.terminalAdapter } : {}),
    })
    this.unsubscribeRuntimeUpdates = runtimeClient.onUpdate((event) => {
      this.handleSessionUpdate(event)
    })
    return runtimeClient
  }

  private requireRuntimeClient(): BridgeAcpRuntimeClient {
    if (!this.runtimeClient || this.closed) {
      throw new HermesAcpProcessError("ACP runtime process is not running")
    }
    return this.runtimeClient
  }

  private async withRequestTimeout<T>(method: string, run: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      this.markRequestActivity()
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          const checkTimeout = () => {
            const idleForMs = Date.now() - this.lastRequestActivityAt
            const remainingMs = this.requestTimeoutMs - idleForMs
            if (remainingMs <= 0) {
              reject(new Error(`ACP request timed out: ${method}`))
              return
            }
            timeout = setTimeout(checkTimeout, remainingMs)
          }
          timeout = setTimeout(checkTimeout, this.requestTimeoutMs)
        }),
      ])
    } catch (error) {
      throw normalizeAcpRuntimeError(method, error)
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  private markRequestActivity(): void {
    this.lastRequestActivityAt = Date.now()
  }

  private attachProcessHandlers(child: ChildProcessWithoutNullStreams): void {
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/)
      for (const line of lines) {
        void this.handleRuntimeLogLine(line)
      }
    })
    child.on("error", (error) => {
      void this.emitError(error)
    })
    child.on("exit", (code, signal) => {
      if (this.closed) {
        return
      }
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
      void this.emitError(new HermesAcpProcessError(`ACP runtime process exited with ${reason}`))
    })
  }

  private handleSessionUpdate(update: BridgeAcpRawUpdate): void {
    this.markRequestActivity()
    const event = normalizeAcpNotification(
      { method: "session/update", params: update },
      this.nextEventSequence,
    )
    this.nextEventSequence += 1
    if (this.shouldSuppressAcpNotification()) {
      return
    }
    this.promptEvents.push(event)
    if (this.shouldDeferAcpNotification(event)) {
      this.deferredPromptEvents.push(event)
      return
    }
    void this.onEvent?.(event)
  }

  private async handleRuntimeActivity(activity: SdkAcpRuntimeActivity): Promise<void> {
    this.markRequestActivity()
    if (this.shouldSuppressAcpNotification()) {
      return
    }
    const activitySessionId =
      typeof activity.sessionId === "string" && activity.sessionId.length > 0
        ? activity.sessionId
        : this.sessionId
    const event: NormalizedBridgeEvent = {
      eventType: activity.type,
      externalEventId: `${activitySessionId ?? "no-session"}:${this.nextEventSequence}:${activity.type}`,
      payload: activity,
      part: {
        json: activity,
        status: "streaming",
        type: "event",
      },
      sessionId: activitySessionId,
      source: "bridge",
    }
    this.nextEventSequence += 1
    this.promptEvents.push(event)
    await this.onEvent?.(event)
  }

  private async handlePermissionRequest(
    request: BridgePermissionRequest,
  ): Promise<BridgePermissionResponse> {
    this.markRequestActivity()
    let event = normalizeAcpNotification(
      { method: "session/request_permission", params: request },
      this.nextEventSequence,
    )
    this.nextEventSequence += 1
    event = {
      ...event,
      externalRequestId: event.externalRequestId ?? event.externalEventId,
    }
    if (this.shouldSuppressAcpNotification()) {
      return { outcome: { outcome: "cancelled" } }
    }
    if (this.autoApprovePermissionRequests && event.part?.type === "approval_request") {
      event.part = {
        ...event.part,
        json: { ...recordFromUnknown(event.part.json), autoApproved: true },
      }
    }
    this.promptEvents.push(event)
    await this.onEvent?.(event)
    if (this.autoApprovePermissionRequests) {
      return permissionResponseFromApproval(extractPermissionOptions(request), true)
    }
    return await new Promise<BridgePermissionResponse>((resolve) => {
      this.pendingPermissionRequests.set(event.externalRequestId ?? "", {
        options: extractPermissionOptions(request),
        resolve,
      })
    })
  }

  private shouldSuppressAcpNotification(): boolean {
    return (
      this.lifecyclePhase === "loading" ||
      this.lifecyclePhase === "closed" ||
      this.lifecyclePhase === "closing"
    )
  }

  private async emitError(
    error: Error,
    options: { forwardToErrorHandler?: boolean } = {},
  ): Promise<void> {
    this.markRequestActivity()
    if (this.sessionId) {
      const event = normalizeBridgeError(error, this.nextEventSequence, this.sessionId)
      this.nextEventSequence += 1
      this.promptEvents.push(event)
      await this.onEvent?.(event)
    }
    if (options.forwardToErrorHandler !== false) {
      await this.onError?.(error)
    }
  }

  private async handleRuntimeLogLine(line: string): Promise<void> {
    const diagnostic = classifyRuntimeLogLine(line)
    if (!diagnostic || shouldSuppressRuntimeDiagnostic(diagnostic)) {
      return
    }
    if (diagnostic.severity === "warn") {
      if (this.sessionId && !this.shouldSuppressAcpNotification()) {
        const event = normalizeRuntimeDiagnostic(
          diagnostic,
          this.nextEventSequence,
          this.sessionId,
        )
        this.nextEventSequence += 1
        this.promptEvents.push(event)
        await this.onEvent?.(event)
      }
      return
    }
    await this.emitError(new Error(diagnostic.text), { forwardToErrorHandler: false })
  }

  private shouldDeferAcpNotification(event: NormalizedBridgeEvent): boolean {
    return (
      this.lifecyclePhase === "livePrompt" &&
      usesDeferredMessageChunkPolicy(this.command) &&
      event.source === "acp_bridge" &&
      event.eventType === "agent_message_chunk" &&
      event.part?.type === "text"
    )
  }

  private async flushDeferredPromptEvents(
    originalEvents: NormalizedBridgeEvent[],
    processedEvents: NormalizedBridgeEvent[],
  ): Promise<void> {
    this.markRequestActivity()
    if (this.deferredPromptEvents.length === 0) {
      return
    }
    const originalEventSet = new Set(originalEvents)
    const deferredEvents = this.deferredPromptEvents.filter((event) => originalEventSet.has(event))
    this.deferredPromptEvents = this.deferredPromptEvents.filter(
      (event) => !originalEventSet.has(event),
    )
    for (const originalEvent of deferredEvents) {
      const index = originalEvents.indexOf(originalEvent)
      await this.onEvent?.(processedEvents[index] ?? originalEvent)
    }
  }

  private discardDeferredPromptEventsSince(eventStart: number): void {
    if (this.deferredPromptEvents.length === 0) {
      return
    }
    const originalEventSet = new Set(this.promptEvents.slice(eventStart))
    this.deferredPromptEvents = this.deferredPromptEvents.filter(
      (event) => !originalEventSet.has(event),
    )
  }
}

export class HermesAcpRuntimeAdapter {
  private readonly createRuntimeSession: AcpRuntimeAdapterSessionFactory

  constructor(options: { createSession?: AcpRuntimeAdapterSessionFactory } = {}) {
    this.createRuntimeSession = options.createSession ?? ((input) => new HermesAcpSession(input))
  }

  async probeRuntime(
    input: HermesAcpSessionOptions = {},
  ): Promise<AcpAdapterResult<{ capabilities?: HermesAcpRuntimeCapabilities }>> {
    const session = this.createRuntimeSession(input)
    try {
      await session.start()
      const capabilities = session.capabilities
      await session.close()
      return {
        ok: true,
        capabilityUsed: "probeRuntime",
        nativeMethod: "initialize",
        capabilities,
      }
    } catch (error) {
      return adapterError("probeRuntime", "acp_session_create_failed", error, "initialize")
    }
  }

  async createSession(
    input: AcpRuntimeAdapterCreateSessionInput,
  ): Promise<AcpAdapterResult<{ session: HermesAcpSession; sessionId: string }>> {
    const session = this.createRuntimeSession(input)
    try {
      const sessionId = await session.start()
      return {
        ok: true,
        capabilityUsed: "createSession",
        nativeMethod: "session/new",
        session,
        sessionId,
      }
    } catch (error) {
      return adapterError("createSession", "acp_session_create_failed", error, "session/new")
    }
  }

  async loadSession(
    input: AcpRuntimeAdapterCreateSessionInput & { initialSessionId: string },
  ): Promise<AcpAdapterResult<{ session: HermesAcpSession; sessionId: string }>> {
    const session = this.createRuntimeSession({ ...input, resumeEnabled: true })
    try {
      const sessionId = await session.start()
      return {
        ok: true,
        capabilityUsed: "loadSession",
        nativeMethod: "session/load",
        session,
        sessionId,
      }
    } catch (error) {
      return adapterError("loadSession", "acp_session_resume_failed", error, "session/load")
    }
  }

  async sendPrompt(
    session: HermesAcpSession,
    text: string,
    options: HermesAcpPromptOptions = {},
  ): Promise<AcpAdapterResult<{ result: HermesAcpPromptResult }>> {
    try {
      const result = await session.sendUserMessage(text, options)
      return { ok: true, capabilityUsed: "sendPrompt", nativeMethod: "session/prompt", result }
    } catch (error) {
      return adapterError("sendPrompt", "prompt_send_failed", error, "session/prompt")
    }
  }

  async cancelTurn(session: HermesAcpSession): Promise<AcpAdapterResult> {
    try {
      await session.cancel()
      return { ok: true, capabilityUsed: "cancelTurn", nativeMethod: "session/cancel" }
    } catch (error) {
      return adapterError("cancelTurn", "cancel_not_acknowledged", error, "session/cancel")
    }
  }

  async closeSession(session: HermesAcpSession): Promise<AcpAdapterResult> {
    const nativeMethod = session.capabilities?.supportsSessionClose ? "session/close" : "process.kill"
    try {
      await session.close()
      return { ok: true, capabilityUsed: "closeSession", nativeMethod }
    } catch (error) {
      return adapterError("closeSession", "session_close_failed", error, nativeMethod)
    }
  }

  async sendInteractionResponse(
    session: HermesAcpSession,
    response: AcpRuntimeAdapterInteractionResponse,
  ): Promise<AcpAdapterResult<{ delivered: boolean }>> {
    try {
      const delivered = await session.respondToPermissionRequest(response.externalRequestId, response)
      if (!delivered) {
        return {
          ok: false,
          capabilityUsed: "sendInteractionResponse",
          nativeMethod: "permission/response",
          diagnosticReasonCode: "permission_response_unmatched",
          error: new Error(`No pending ACP interaction matched ${response.externalRequestId}`),
        }
      }
      return {
        ok: true,
        capabilityUsed: "sendInteractionResponse",
        nativeMethod: "permission/response",
        delivered,
      }
    } catch (error) {
      return adapterError(
        "sendInteractionResponse",
        "interaction_delivery_failed",
        error,
        "permission/response",
      )
    }
  }

  async applyRuntimeConfig(
    input: RuntimeConfigApplicationInput,
  ): Promise<AcpAdapterResult<{ application: RuntimeConfigApplicationResult }>> {
    return {
      ok: true,
      capabilityUsed: "applyRuntimeConfig",
      nativeMethod: "adapter/runtime-config",
      application: resolveRuntimeConfigApplication(input),
    }
  }

  async restoreRuntimeConfig(): Promise<AcpAdapterResult> {
    return {
      ok: true,
      capabilityUsed: "restoreRuntimeConfig",
      nativeMethod: "adapter/runtime-config",
    }
  }
}

export function resolveRuntimeConfigApplication(
  input: RuntimeConfigApplicationInput,
): RuntimeConfigApplicationResult {
  const applied: Record<string, string> = {}
  const diagnostics: RuntimeConfigApplicationResult["diagnostics"] = []
  for (const [option, value] of Object.entries(input.requested)) {
    if (!value) {
      continue
    }
    const supported = input.supportedOptions[option]
    if (supported?.includes(value)) {
      applied[option] = value
      continue
    }
    diagnostics.push({ option, reasonCode: "runtime_config_option_unavailable", value })
  }
  return { applied, diagnostics, ok: true, policy: "omit_unavailable" }
}

function adapterError<T = {}>(
  capabilityUsed: AcpAdapterCapabilityUsed,
  diagnosticReasonCode: string,
  error: unknown,
  nativeMethod?: string,
): AcpAdapterResult<T> {
  return {
    ok: false,
    capabilityUsed,
    nativeMethod,
    diagnosticReasonCode,
    error: error instanceof Error ? error : new Error(String(error)),
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function extractPermissionOptions(request: unknown): PermissionRequestOption[] {
  const params = recordFromUnknown(request)
  const options = Array.isArray(params.options) ? params.options : []
  return options
    .map((option) => {
      const record = recordFromUnknown(option)
      const optionId =
        readString(record.optionId) ?? readString(record.id) ?? readString(record.value)
      if (!optionId) {
        return undefined
      }
      const permissionOption: PermissionRequestOption = { optionId }
      const kind = readString(record.kind)
      const name = readString(record.name)
      if (kind) {
        permissionOption.kind = kind
      }
      if (name) {
        permissionOption.name = name
      }
      return permissionOption
    })
    .filter((option): option is PermissionRequestOption => option !== undefined)
}

function permissionResponseFromApproval(
  options: PermissionRequestOption[],
  approved: boolean,
): BridgePermissionResponse {
  const optionId = selectPermissionOptionId(options, approved)
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } }
}

function selectPermissionOptionId(
  options: PermissionRequestOption[],
  approved: boolean,
): string | undefined {
  if (approved) {
    return (
      findPermissionOption(options, ["allow", "approve", "continue", "confirm", "yes"])
        ?.optionId ??
      findNonRejectPermissionOption(options)?.optionId ??
      "allow_once"
    )
  }

  return undefined
}

function findPermissionOption(
  options: PermissionRequestOption[],
  prefixes: string[],
): PermissionRequestOption | undefined {
  return options.find((option) => {
    const candidates = [option.kind, option.optionId, option.name].filter(
      (value): value is string => typeof value === "string",
    )
    return candidates.some((candidate) => {
      const normalized = candidate.toLowerCase()
      return prefixes.some((prefix) => normalized.startsWith(prefix))
    })
  })
}

function findNonRejectPermissionOption(
  options: PermissionRequestOption[],
): PermissionRequestOption | undefined {
  return options.find((option) => {
    const candidates = [option.kind, option.optionId, option.name].filter(
      (value): value is string => typeof value === "string",
    )
    return candidates.every((candidate) => {
      const normalized = candidate.toLowerCase()
      return !["cancel", "deny", "reject", "stop"].some((prefix) =>
        normalized.startsWith(prefix),
      )
    })
  })
}

export function buildPromptContentBlocks(
  text: string,
  systemPrompt?: string,
  continuity?: {
    attachmentBlocks?: Array<Record<string, unknown>>
    includeContinuityFallbackNote?: boolean
    threadHistory?: string
  },
) {
  const normalizedSystemPrompt = systemPrompt?.trim()
  const normalizedThreadHistory = continuity?.threadHistory?.trim()
  const userBlock = { type: "text", text }
  const appSystemPromptBase = normalizedSystemPrompt
    ? `${HIDDEN_ZERO_CHAT_SYSTEM_PROMPT}\n\nSpace instructions from the user:\n${normalizedSystemPrompt}`
    : HIDDEN_ZERO_CHAT_SYSTEM_PROMPT
  const appSystemPrompt =
    continuity?.includeContinuityFallbackNote && normalizedThreadHistory
      ? `${appSystemPromptBase}\n\nExternal ACP session continuity is unavailable for this turn, so a fresh ACP session is being used. Preserve app-level continuity using the Recent thread history below. Do not treat the history as a new user request; answer the final user message.\n\nRecent thread history:\n${normalizedThreadHistory}`
      : appSystemPromptBase

  return [
    {
      _meta: { "0000.chat/role": "system" },
      annotations: { audience: ["assistant"] },
      type: "text",
      text: appSystemPrompt,
    },
    userBlock,
    ...(continuity?.attachmentBlocks ?? []),
  ]
}

function buildAttachmentResourceLinkBlocks(
  attachments: HermesAcpPromptAttachment[] | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(attachments)) {
    return []
  }
  const blocks: Array<Record<string, unknown>> = []
  attachments.forEach((attachment, index) => {
    const uri = (attachment.access?.url ?? attachment.url)?.trim()
    if (!uri) {
      return
    }
    const name = attachment.filename?.trim() || `Attachment ${index + 1}`
    const mediaType = attachment.mediaType?.trim() || "application/octet-stream"
    const block: Record<string, unknown> = {
      type: "resource_link",
      uri,
      name,
      mimeType: mediaType,
    }
    if (typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes)) {
      block.size = attachment.sizeBytes
    }
    blocks.push(block)
  })
  return blocks
}

export function splitCommand(command: string): string[] {
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

function defaultSpawnProcess(
  command: string,
  args: string[],
  cwd?: string,
): ChildProcessWithoutNullStreams {
  if (process.versions.bun) {
    return spawn(
      "node",
      [join(dirname(fileURLToPath(import.meta.url)), "acp-node-proxy.cjs"), command, ...args],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
  }
  return spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] })
}

function extractSessionId(result: unknown, fallback?: string): string {
  if (typeof result === "string") {
    return result
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>
    const sessionId = readString(record.sessionId ?? record.id)
    if (sessionId) {
      return sessionId
    }
  }
  if (fallback) {
    return fallback
  }
  throw new Error(`ACP session did not return a session id: ${JSON.stringify(result)}`)
}

function extractCapabilities(result: unknown): HermesAcpRuntimeCapabilities {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {}
  const agentCapabilities =
    record.agentCapabilities && typeof record.agentCapabilities === "object"
      ? (record.agentCapabilities as Record<string, unknown>)
      : {}
  const sessionCapabilities =
    agentCapabilities.sessionCapabilities &&
    typeof agentCapabilities.sessionCapabilities === "object"
      ? (agentCapabilities.sessionCapabilities as Record<string, unknown>)
      : {}
  const agentMeta =
    agentCapabilities._meta && typeof agentCapabilities._meta === "object"
      ? (agentCapabilities._meta as Record<string, unknown>)
      : {}
  const promptCapabilities =
    agentCapabilities.promptCapabilities &&
    typeof agentCapabilities.promptCapabilities === "object"
      ? (agentCapabilities.promptCapabilities as Record<string, unknown>)
      : {}
  const authCapabilities =
    agentCapabilities.auth && typeof agentCapabilities.auth === "object"
      ? (agentCapabilities.auth as Record<string, unknown>)
      : {}
  const loadSession = agentCapabilities.loadSession === true
  const sdkProtocolVersion =
    typeof record.protocolVersion === "string"
      ? record.protocolVersion
      : typeof record.protocolVersion === "number"
        ? String(record.protocolVersion)
        : undefined
  return {
    loadSession,
    promptCapabilities: {
      audio: promptCapabilities.audio === true,
      embeddedContext: promptCapabilities.embeddedContext === true,
      image: promptCapabilities.image === true,
    },
    supportsPromptResourceLinks: agentMeta["0000.chat/promptResourceLinks"] !== false,
    ...(sdkProtocolVersion ? { sdkProtocolVersion } : {}),
    supportsAuth: Object.keys(authCapabilities).length > 0,
    supportsLogout: Object.hasOwn(authCapabilities, "logout"),
    supportsSessionLoad: loadSession,
    supportsSessionResume: Object.hasOwn(sessionCapabilities, "resume"),
    supportsSessionClose: Object.hasOwn(sessionCapabilities, "close"),
    supportsSessionDelete: Object.hasOwn(sessionCapabilities, "delete"),
    supportsSessionFork: Object.hasOwn(sessionCapabilities, "fork"),
    supportsPerSessionMcpServers: true,
    supportsSessionList: Object.hasOwn(sessionCapabilities, "list"),
    raw: result,
  }
}

function extractStopReason(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined
  }
  const record = result as Record<string, unknown>
  return readString(record.stopReason)
}

function extractFinalText(input: {
  command: string[]
  events: NormalizedBridgeEvent[]
  rawResult: unknown
  stopReason?: string
}): { diagnostics: HermesAcpFinalTextDiagnostics; text: string } {
  const allAnswerEvents = input.events.filter(
    (event) => event.source === "acp_bridge" && event.part?.type === "text",
  )
  const thoughtEvents = input.events.filter(
    (event) =>
      event.source === "acp_bridge" &&
      (event.eventType === "agent_thought_chunk" || event.part?.type === "thinking"),
  )
  const toolEventCount = input.events.filter(
    (event) => event.part?.type === "tool_call" || event.part?.type === "tool_result",
  ).length
  const runtimeId = classifyAcpRuntimeId(input.command)
  const trustedFinalText = extractTrustedFinalResultText(input.rawResult)
  const trustedFinalResultText = trustedFinalText !== undefined
  const untrustedTextPolicy =
    shouldApplyUntrustedMessageChunkPolicy({
      allAnswerEvents,
      runtimeId,
      thoughtEvents,
      toolEventCount,
      trustedFinalResultText,
    })
      ? classifyUntrustedMessageChunks(input.events)
      : undefined
  const answerEvents = untrustedTextPolicy?.answerEvents ?? allAnswerEvents
  const answerText = answerEvents.map((event) => event.part?.text ?? "").join("")
  const shouldWithhold =
    untrustedTextPolicy !== undefined &&
    answerText.length === 0 &&
    untrustedTextPolicy.untrustedEvents.length > 0
  const diagnostics: HermesAcpFinalTextDiagnostics = {
    answerChunkCount: answerEvents.length,
    answerTextLength: answerText.length,
    runtimeId,
    thoughtChunkCount: thoughtEvents.length,
    toolEventCount,
    trustedFinalResultText,
    withheld: shouldWithhold,
  }
  if (untrustedTextPolicy?.untrustedEvents.length) {
    diagnostics.reason =
      runtimeId === "codex" ? "codex_unclassified_message_chunks" : "untrusted_message_chunks"
  }
  if (shouldWithhold) {
    return { diagnostics, text: "" }
  }
  return { diagnostics, text: trustedFinalText ?? answerText }
}

function shouldApplyUntrustedMessageChunkPolicy(input: {
  allAnswerEvents: NormalizedBridgeEvent[]
  runtimeId: HermesAcpFinalTextDiagnostics["runtimeId"]
  thoughtEvents: NormalizedBridgeEvent[]
  toolEventCount: number
  trustedFinalResultText: boolean
}): boolean {
  if (
    input.trustedFinalResultText ||
    input.toolEventCount === 0 ||
    input.allAnswerEvents.length === 0
  ) {
    return false
  }
  if (input.runtimeId === "codex") {
    return input.thoughtEvents.length === 0
  }
  return input.runtimeId === "claude-code"
}

function reclassifyUntrustedMessageChunks(
  events: NormalizedBridgeEvent[],
  diagnostics: HermesAcpFinalTextDiagnostics,
): NormalizedBridgeEvent[] {
  if (
    diagnostics.reason !== "codex_unclassified_message_chunks" &&
    diagnostics.reason !== "untrusted_message_chunks"
  ) {
    return events
  }
  const untrustedEvents = new Set(classifyUntrustedMessageChunks(events).untrustedEvents)
  return events.map((event) =>
    untrustedEvents.has(event)
      ? reclassifyMessageChunkAsThinking(event)
      : event,
  )
}

function classifyUntrustedMessageChunks(events: NormalizedBridgeEvent[]): {
  answerEvents: NormalizedBridgeEvent[]
  untrustedEvents: NormalizedBridgeEvent[]
} {
  const lastToolEventIndex = events.reduce(
    (lastIndex, event, index) =>
      event.part?.type === "tool_call" || event.part?.type === "tool_result"
        ? index
        : lastIndex,
    -1,
  )
  const answerEvents: NormalizedBridgeEvent[] = []
  const untrustedEvents: NormalizedBridgeEvent[] = []
  events.forEach((event, index) => {
    if (event.source !== "acp_bridge" || event.part?.type !== "text") {
      return
    }
    if (index > lastToolEventIndex) {
      answerEvents.push(event)
      return
    }
    untrustedEvents.push(event)
  })
  return { answerEvents, untrustedEvents }
}

function reclassifyMessageChunkAsThinking(event: NormalizedBridgeEvent): NormalizedBridgeEvent {
  const payload = recordFromUnknown(event.payload)
  const normalizedPayload = recordFromUnknown(payload.normalized)
  return {
    ...event,
    eventType: "agent_thought_chunk",
    externalEventId: event.externalEventId.replace(
      /:agent_message_chunk$/,
      ":agent_thought_chunk",
    ),
    part: {
      ...event.part,
      reasoningVisibility: "hidden",
      type: "thinking",
    },
    payload: {
      ...payload,
      eventType: "agent_thought_chunk",
      normalized: {
        ...normalizedPayload,
        reasoningVisibility: "hidden",
        type: "thinking",
      },
    },
  }
}

function classifyAcpRuntimeId(command: string[]): HermesAcpFinalTextDiagnostics["runtimeId"] {
  if (isCodexAcpCommand(command)) {
    return "codex"
  }
  if (isClaudeCodeAcpCommand(command)) {
    return "claude-code"
  }
  return "other"
}

function usesDeferredMessageChunkPolicy(command: string[]): boolean {
  return isCodexAcpCommand(command) || isClaudeCodeAcpCommand(command)
}

function isCodexAcpCommand(command: string[]): boolean {
  return command.some((part) => part.toLowerCase().includes("codex-acp"))
}

function isClaudeCodeAcpCommand(command: string[]): boolean {
  return command.some((part) => part.toLowerCase().includes("claude-agent-acp"))
}

function extractTrustedFinalResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined
  }
  const record = result as Record<string, unknown>
  return (
    readString(record.text) ??
    readString(record.finalText) ??
    readString(record.outputText) ??
    readString(record.message)
  )
}

function formatAcpJsonRpcError(error: unknown): string {
  const errorKind = normalizeJsonRpcErrorKind(readJsonRpcErrorKind(error))
  const code = readJsonRpcErrorCode(error)
  if (errorKind) {
    return code === undefined ? errorKind : `${errorKind} (code ${code})`
  }
  const message = readJsonRpcErrorMessage(error)
  if (message) {
    return code === undefined ? message : `${message} (code ${code})`
  }
  return code === undefined ? "json_rpc_error" : `json_rpc_error (code ${code})`
}

function normalizeAcpRuntimeError(method: string, error: unknown): Error {
  if (error instanceof HermesAcpJsonRpcError) {
    return error
  }
  const formatted = formatAcpJsonRpcError(error)
  if (formatted !== "json_rpc_error") {
    return new HermesAcpJsonRpcError(method, error)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function countPromptEventTypes(events: NormalizedBridgeEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) {
    const eventType = event.eventType || "unknown"
    counts[eventType] = (counts[eventType] ?? 0) + 1
  }
  return counts
}

function normalizeJsonRpcErrorKind(errorKind: string | undefined): string | undefined {
  if (errorKind === "authentication_failed") {
    return "provider_login_failed"
  }
  return errorKind
}

function readJsonRpcErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }
  const code = (error as Record<string, unknown>).code
  return typeof code === "number" && Number.isFinite(code) ? code : undefined
}

function readJsonRpcErrorKind(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }
  const record = error as Record<string, unknown>
  const directKind = readString(record.errorKind)
  if (directKind) {
    return directKind
  }
  const data = record.data
  if (!data || typeof data !== "object") {
    return undefined
  }
  return readString((data as Record<string, unknown>).errorKind)
}

function readJsonRpcErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }
  const message = readString((error as Record<string, unknown>).message)
  if (!message) {
    return undefined
  }
  return message.length > 160 ? `${message.slice(0, 157)}...` : message
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
