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
}

export type HermesAcpPromptOptions = {
  systemPrompt?: string
  threadHistory?: string
  autoApprovePermissionRequests?: boolean
}

export type HermesAcpSessionOptions = {
  agentCommand?: string | string[]
  cwd?: string
  initialSessionId?: string
  mcpServers?: HermesAcpMcpServer[]
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

export const HIDDEN_ZERO_CHAT_SYSTEM_PROMPT = buildZeroChatHiddenSystemPrompt()

export class HermesAcpProcessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HermesAcpProcessError"
  }
}

export class HermesAcpSession {
  readonly command: string[]
  readonly cwd?: string
  readonly initialSessionId?: string
  readonly mcpServers: HermesAcpMcpServer[]
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
  private externalContinuityFallback = false
  private externalContinuityFallbackNotified = false
  private closed = false
  private started = false
  sessionId?: string
  capabilities?: HermesAcpRuntimeCapabilities

  constructor(options: HermesAcpSessionOptions = {}) {
    this.command = Array.isArray(options.agentCommand)
      ? [...options.agentCommand]
      : splitCommand(options.agentCommand ?? "hermes acp")
    this.cwd = options.cwd
    this.initialSessionId = options.initialSessionId
    this.mcpServers = options.mcpServers ?? []
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
      throw new Error("Hermes ACP command cannot be empty")
    }

    this.closed = false
    this.lifecyclePhase = "starting"
    const [executable, ...args] = this.command
    this.child = this.spawnProcess(executable, args, this.cwd)
    this.attachProcessHandlers(this.child)

    const initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "0000-chat-hermes-bridge", version: "0.1.0" },
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
    const result = await this.request("session/new", {
      cwd: this.cwd ?? process.cwd(),
      mcpServers: this.mcpServers,
    })
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
      throw new Error("Cannot send an empty Hermes ACP user message")
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
      if (!this.closed) {
        this.lifecyclePhase = "idle"
      }
    }
    const events = this.promptEvents.slice(eventStart)
    return {
      sessionId,
      rawResult,
      stopReason: extractStopReason(rawResult),
      text: events
        .filter((event) => event.source === "hermes_acp" && event.part?.type === "text")
        .map((event) => event.part?.text ?? "")
        .join(""),
      events,
      capabilities: this.capabilities,
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
    this.child?.kill()
    this.lifecyclePhase = "closed"
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
      try {
        const loaded = await this.request(method, { sessionId: this.initialSessionId })
        this.sessionId = extractSessionId(loaded, this.initialSessionId)
        this.started = true
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

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child || this.closed) {
      return Promise.reject(new HermesAcpProcessError("Hermes ACP process is not running"))
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
            reject(new Error(`ACP ${method} failed: ${JSON.stringify(message.error)}`))
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
        new HermesAcpProcessError(`Hermes ACP process exited with ${reason}`),
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
