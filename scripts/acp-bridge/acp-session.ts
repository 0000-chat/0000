import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildZeroChatHiddenSystemPrompt } from "./zero-chat-policy"
import {
  type NormalizedBridgeEvent,
  normalizeAcpNotification,
  normalizeBridgeError,
} from "./event-normalizer"

export type JsonRpcMessage = {
  jsonrpc: "2.0"
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export type HermesAcpRuntimeCapabilities = {
  loadSession: boolean
  supportsSessionLoad: boolean
  supportsSessionResume: boolean
  supportsSessionClose: boolean
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
}

export type HermesAcpFinalTextDiagnostics = {
  answerChunkCount: number
  answerTextLength: number
  reason?: "codex_unclassified_message_chunks"
  runtimeId: "codex" | "other"
  thoughtChunkCount: number
  toolEventCount: number
  trustedFinalResultText: boolean
  withheld: boolean
}

export type HermesAcpPromptOptions = {
  systemPrompt?: string
  threadHistory?: string
  autoApprovePermissionRequests?: boolean
  runtimeConfig?: Record<string, string>
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
  spawnProcess?: (command: string, args: string[], cwd?: string) => ChildProcessWithoutNullStreams
}

export type HermesAcpMcpServer = {
  args?: string[]
  command: string
  env?: Array<{ name: string; value: string }>
  name: string
}

type PendingRequest = {
  method: string
  resolve: (message: JsonRpcMessage) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
type PermissionRequestOption = {
  kind?: string
  name?: string
  optionId: string
}
type PendingPermissionRequest = {
  options: PermissionRequestOption[]
  requestId: string | number
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
  private readonly spawnProcess: (
    command: string,
    args: string[],
    cwd?: string,
  ) => ChildProcessWithoutNullStreams
  private child?: ChildProcessWithoutNullStreams
  private buffer = ""
  private nextId = 1
  private nextEventSequence = 1
  private pending = new Map<number, PendingRequest>()
  private promptEvents: NormalizedBridgeEvent[] = []
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequest>()
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
    const [executable, ...args] = this.command
    this.child = this.spawnProcess(executable, args, this.cwd)
    this.attachProcessHandlers(this.child)

    const initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "0000-chat-acp-bridge", version: "0.1.0" },
    })
    this.capabilities = extractCapabilities(initializeResult)

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
    let rawResult: unknown
    try {
      rawResult = await this.request("session/prompt", {
        sessionId,
        prompt: buildPromptContentBlocks(text, options.systemPrompt, {
          includeContinuityFallbackNote: this.externalContinuityFallback,
          threadHistory: options.threadHistory,
        }),
      })
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
    return {
      sessionId,
      rawResult,
      stopReason,
      text: finalText.text,
      events,
      capabilities: this.capabilities,
      finalText: finalText.diagnostics,
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) {
      return
    }
    await this.request("session/cancel", { sessionId: this.sessionId })
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
    this.writeResponse(
      request.requestId,
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    return true
  }

  hasPendingPermissionRequests(): boolean {
    return this.pendingPermissionRequests.size > 0
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
    if (this.sessionId && this.capabilities?.supportsSessionClose && this.child && !this.closed) {
      try {
        await this.request("session/close", { sessionId: this.sessionId })
      } catch (error) {
        void this.onError?.(
          error instanceof Error
            ? new Error(`ACP session/close failed before process kill: ${error.message}`)
            : new Error(`ACP session/close failed before process kill: ${String(error)}`),
        )
      }
    }
    this.closed = true
    for (const [id, request] of this.pending.entries()) {
      clearTimeout(request.timeout)
      request.reject(
        new HermesAcpProcessError(`ACP session closed before ${request.method} completed`),
      )
      this.pending.delete(id)
    }
    this.pendingPermissionRequests.clear()
    await this.terminateChildProcess()
    this.lifecyclePhase = "closed"
  }

  private async createNewSession(): Promise<unknown> {
    const params = this.buildSessionNewParams("configured")
    try {
      return await this.request("session/new", params)
    } catch (error) {
      if (this.mcpServers.length > 0) {
        void this.onError?.(
          new Error(
            "ACP session/new rejected configured MCP servers; retrying with an empty MCP server list",
          ),
        )
        try {
          return await this.request("session/new", this.buildSessionNewParams("empty"))
        } catch {
          void this.onError?.(
            new Error(
              "ACP session/new rejected empty MCP server list; retrying without MCP server field",
            ),
          )
          return await this.request("session/new", this.buildSessionNewParams("omitted"))
        }
      }
      void this.onError?.(
        new Error("ACP session/new rejected empty MCP server list; retrying without MCP server field"),
      )
      try {
        return await this.request("session/new", this.buildSessionNewParams("omitted"))
      } catch {
        throw error
      }
    }
  }

  private buildSessionNewParams(
    mcpMode: "configured" | "empty" | "omitted",
  ): { cwd: string; mcpServers?: HermesAcpMcpServer[] } {
    const params: { cwd: string; mcpServers?: HermesAcpMcpServer[] } = {
      cwd: this.cwd ?? process.cwd(),
    }
    if (mcpMode === "configured") {
      params.mcpServers = this.mcpServers
    } else if (mcpMode === "empty") {
      params.mcpServers = []
    }
    return params
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
        const loaded = await this.request(method, { sessionId: this.initialSessionId })
        this.sessionId = extractSessionId(loaded, this.initialSessionId)
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
      const result = await this.request("session/set_config_option", { configId, sessionId, value })
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

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child || this.closed) {
      return Promise.reject(new HermesAcpProcessError("ACP runtime process is not running"))
    }

    const id = this.nextId
    this.nextId += 1
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timed out: ${method}`))
      }, this.requestTimeoutMs)

      this.pending.set(id, {
        method,
        timeout,
	        resolve: (message) => {
	          if (message.error) {
	            reject(new HermesAcpJsonRpcError(method, message.error))
	            return
	          }
	          resolve(message.result)
	        },
        reject,
      })

      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return
        }
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(pending.timeout)
          this.pending.delete(id)
        }
        reject(error)
      })
    })
  }

  private attachProcessHandlers(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim()
      if (text.length > 0) {
        void this.onError?.(new Error(text))
      }
    })
    child.on("error", (error) => {
      void this.failAllPending(error)
    })
    child.on("exit", (code, signal) => {
      if (this.closed) {
        return
      }
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
      void this.failAllPending(
        new HermesAcpProcessError(`ACP runtime process exited with ${reason}`),
      )
    })
  }

  private handleStdout(text: string): void {
    this.buffer += text
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue
      }
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage)
      } catch (error) {
        void this.emitError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      pending.resolve(message)
      return
    }

    if (message.method === "session/update") {
      const event = normalizeAcpNotification(message, this.nextEventSequence)
      this.nextEventSequence += 1
      if (this.shouldSuppressAcpNotification()) {
        return
      }
      this.promptEvents.push(event)
      void this.onEvent?.(event)
      return
    }

    if (message.method === "session/request_permission") {
      const event = normalizeAcpNotification(message, this.nextEventSequence)
      this.nextEventSequence += 1
      if (this.shouldSuppressAcpNotification()) {
        if (message.id !== undefined) {
          this.writeResponse(message.id, { outcome: { outcome: "cancelled" } })
        }
        return
      }
      if (this.autoApprovePermissionRequests && event.part?.type === "approval_request") {
        event.part = {
          ...event.part,
          json: { ...recordFromUnknown(event.part.json), autoApproved: true },
        }
      }
      this.promptEvents.push(event)
      void this.onEvent?.(event)
      if (message.id !== undefined && event.externalRequestId) {
        this.pendingPermissionRequests.set(event.externalRequestId, {
          options: extractPermissionOptions(message),
          requestId: message.id,
        })
        if (this.autoApprovePermissionRequests) {
          void this.respondToPermissionRequest(event.externalRequestId, { approved: true })
        }
      }
      return
    }

    if (message.id !== undefined && message.method) {
      this.writeErrorResponse(
        message.id,
        -32601,
        `Unsupported ACP client method: ${message.method}`,
      )
    }
  }

  private shouldSuppressAcpNotification(): boolean {
    return (
      this.lifecyclePhase === "loading" ||
      this.lifecyclePhase === "closed" ||
      this.lifecyclePhase === "closing"
    )
  }

  private writeResponse(id: string | number, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
  }

  private writeErrorResponse(id: string | number, code: number, message: string): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`)
  }

  private async failAllPending(error: Error): Promise<void> {
    this.closed = true
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
    await this.emitError(error)
  }

  private async emitError(error: Error): Promise<void> {
    if (this.sessionId) {
      const event = normalizeBridgeError(error, this.nextEventSequence, this.sessionId)
      this.nextEventSequence += 1
      this.promptEvents.push(event)
      await this.onEvent?.(event)
    }
    await this.onError?.(error)
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

function extractPermissionOptions(message: JsonRpcMessage): PermissionRequestOption[] {
  const params = recordFromUnknown(message.params)
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
  continuity?: { includeContinuityFallbackNote?: boolean; threadHistory?: string },
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
  ]
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
  const loadSession = agentCapabilities.loadSession === true
  return {
    loadSession,
    supportsSessionLoad: loadSession,
    supportsSessionResume: Object.hasOwn(sessionCapabilities, "resume"),
    supportsSessionClose: Object.hasOwn(sessionCapabilities, "close"),
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
  const answerEvents = input.events.filter(
    (event) => event.source === "hermes_acp" && event.part?.type === "text",
  )
  const answerText = answerEvents.map((event) => event.part?.text ?? "").join("")
  const thoughtEvents = input.events.filter(
    (event) =>
      event.source === "hermes_acp" &&
      (event.eventType === "agent_thought_chunk" || event.part?.type === "thinking"),
  )
  const toolEventCount = input.events.filter(
    (event) => event.part?.type === "tool_call" || event.part?.type === "tool_result",
  ).length
  const runtimeId = isCodexAcpCommand(input.command) ? "codex" : "other"
  const trustedFinalText = extractTrustedFinalResultText(input.rawResult)
  const trustedFinalResultText = trustedFinalText !== undefined
  const shouldWithhold =
    runtimeId === "codex" &&
    !trustedFinalResultText &&
    thoughtEvents.length === 0 &&
    answerText.length > 0
  const diagnostics: HermesAcpFinalTextDiagnostics = {
    answerChunkCount: answerEvents.length,
    answerTextLength: answerText.length,
    runtimeId,
    thoughtChunkCount: thoughtEvents.length,
    toolEventCount,
    trustedFinalResultText,
    withheld: shouldWithhold,
  }
  if (shouldWithhold) {
    diagnostics.reason = "codex_unclassified_message_chunks"
    return { diagnostics, text: "" }
  }
  return { diagnostics, text: trustedFinalText ?? answerText }
}

function isCodexAcpCommand(command: string[]): boolean {
  return command.some((part) => part.toLowerCase().includes("codex-acp"))
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
