export const DEFAULT_BRIDGE_PATHS = {
  heartbeat: "/api/agent-bridge/heartbeat",
  queuePoll: "/api/agent-bridge/queue/poll",
  queueClaim: "/api/agent-bridge/queue/claim",
  queueCleanupStale: "/api/agent-bridge/queue/cleanup-stale",
  queueResult: "/api/agent-bridge/queue/result",
  events: "/api/agent-bridge/events",
  eventPayloads: "/api/agent-event-payloads",
  agentAttachments: "/api/agent-attachments",
  agentToolsInvoke: "/api/agent-tools/invoke",
} as const

type BridgeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type BridgeCloudClientOptions = {
  appUrl: string
  deviceId: string
  bridgeToken: string
  bridgeApiUrl?: string
  logIngestUrl?: string
  paths?: Partial<typeof DEFAULT_BRIDGE_PATHS>
  fetch?: BridgeFetch
  requestTimeoutMs?: number
}

export type BridgeHeartbeatInput = {
  bridgeInstanceId?: string
  status: unknown
  capabilities?: unknown
  version?: string
}

export type BridgeQueuePollInput = {
  limit?: number
  cursor?: string
}

export type BridgeQueueClaimInput = {
  limit?: number
  queueItemIds?: string[]
}

export type BridgeQueueCleanupInput = {
  activeGraceMs?: number
  dryRun?: boolean
  limit?: number
  staleAfterMs?: number
}

export type BridgeQueueCommand = Record<string, unknown> & {
  id: string
  type?: string
  kind?: string
  threadId?: string
  agentSessionId?: string
}

export type BridgeQueuePollResponse = Record<string, unknown> & {
  available?: number
  nextPollMs?: number
}

export type BridgeQueueClaimResponse = Record<string, unknown> & {
  command?: BridgeQueueCommand
  commands?: BridgeQueueCommand[]
}

export type BridgeQueueResult = Record<string, unknown>

export type BridgeEventInput = Record<string, unknown> & {
  threadId: string
  eventType: string
  sequence: number
  rawPayload: unknown
  agentSessionId?: string
  messageId?: string
  messagePartId?: string
  normalizedPayload?: unknown
  source?: string
  externalEventId?: string
  externalRequestId?: string
  createdAt?: number
}

export type AgentAttachmentUploadInput = {
  threadId: string
  agentSessionId?: string
  filename: string
  mediaType?: string
  bytes: Uint8Array
}

export type AgentAttachmentUploadResponse = {
  file: Record<string, unknown>
}

export type AgentAttachmentDeleteInput = {
  threadId: string
  agentSessionId?: string
  objectKey: string
}

export type AgentAttachmentDeleteResponse = {
  deletedAt?: string
  key?: string
  ok?: boolean
  status?: string
}

const EVENT_PAYLOAD_INLINE_THRESHOLD_BYTES = 64 * 1024

export type AgentToolInvokeInput = {
  agentSessionId: string
  input: unknown
  tool: string
}

export class BridgeCloudHttpError extends Error {
  readonly status: number
  readonly url: string
  readonly responseBody: string

  constructor(method: string, url: string, status: number, responseBody: string) {
    super(`${method} ${url} failed (${status}): ${responseBody}`)
    this.name = "BridgeCloudHttpError"
    this.status = status
    this.url = url
    this.responseBody = responseBody
  }
}

export class BridgeCloudRequestTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number
  readonly url: string

  constructor(method: string, url: string, timeoutMs: number) {
    super(`${method} ${url} timed out after ${timeoutMs}ms`)
    this.name = "BridgeCloudRequestTimeoutError"
    this.method = method
    this.timeoutMs = timeoutMs
    this.url = url
  }
}

export class ConvexBridgeCloudClient {
  readonly appUrl: string
  readonly bridgeApiUrl?: string
  readonly deviceId: string

  private readonly bridgeToken: string
  private readonly logIngestUrl?: string
  private readonly paths: typeof DEFAULT_BRIDGE_PATHS
  private readonly fetchImpl: BridgeFetch
  private readonly requestTimeoutMs?: number

  constructor(options: BridgeCloudClientOptions) {
    this.appUrl = options.appUrl
    this.bridgeApiUrl = options.bridgeApiUrl
    this.deviceId = options.deviceId
    this.bridgeToken = options.bridgeToken
    this.logIngestUrl = options.logIngestUrl
    this.paths = { ...DEFAULT_BRIDGE_PATHS, ...options.paths }
    this.fetchImpl = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs
  }

  async heartbeat<TResponse = Record<string, unknown>>(
    input: BridgeHeartbeatInput,
  ): Promise<TResponse> {
    return await this.post<TResponse>(this.paths.heartbeat, {
      deviceId: this.deviceId,
      ...compact(input),
    })
  }

  async pollQueue<TResponse = BridgeQueuePollResponse>(
    input: BridgeQueuePollInput = {},
  ): Promise<TResponse> {
    return await this.post<TResponse>(this.paths.queuePoll, {
      deviceId: this.deviceId,
      ...compact(input),
    })
  }

  async claimWork<TResponse = BridgeQueueClaimResponse>(
    input: BridgeQueueClaimInput = {},
  ): Promise<TResponse> {
    return await this.post<TResponse>(this.paths.queueClaim, {
      deviceId: this.deviceId,
      ...compact(input),
    })
  }

  async cleanupStaleClaims<TResponse = Record<string, unknown>>(
    input: BridgeQueueCleanupInput = {},
  ): Promise<TResponse> {
    return await this.post<TResponse>(this.paths.queueCleanupStale, {
      deviceId: this.deviceId,
      ...compact(input),
    })
  }

  async markResult<TResponse = Record<string, unknown>>(
    commandId: string,
    result: BridgeQueueResult,
    claimId?: string,
  ): Promise<TResponse> {
    if (commandId.length === 0) {
      throw new Error("commandId is required")
    }
    const resultClaimId = typeof result.claimId === "string" ? result.claimId : undefined
    const resolvedClaimId = claimId ?? resultClaimId
    if (!resolvedClaimId) {
      throw new Error("claimId is required")
    }

    return await this.post<TResponse>(this.paths.queueResult, {
      deviceId: this.deviceId,
      claimId: resolvedClaimId,
      commandId,
      result,
    })
  }

  async appendEvents<TResponse = Record<string, unknown>>(
    events: BridgeEventInput[],
  ): Promise<TResponse> {
    if (events.length === 0) {
      return {} as TResponse
    }

    const preparedEvents = await Promise.all(events.map((event) => this.offloadEventPayloads(event)))
    return await this.post<TResponse>(this.paths.events, {
      deviceId: this.deviceId,
      events: preparedEvents,
    })
  }

  async uploadAttachment<TResponse = AgentAttachmentUploadResponse>(
    input: AgentAttachmentUploadInput,
  ): Promise<TResponse> {
    if (input.threadId.length === 0) {
      throw new Error("threadId is required")
    }
    if (input.filename.length === 0) {
      throw new Error("filename is required")
    }

    const endpoint = buildBridgeEndpoint(this.appUrl, this.paths.agentAttachments)
    const form = new FormData()
    form.set("deviceId", this.deviceId)
    form.set("threadId", input.threadId)
    if (input.agentSessionId) {
      form.set("agentSessionId", input.agentSessionId)
    }
    const bytes = input.bytes.slice()
    const blob = new Blob([bytes.buffer], {
      type: input.mediaType ?? "application/octet-stream",
    })
    form.set("file", blob, input.filename)

    const response = await this.fetchWithTimeout("POST", endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bridgeToken}`,
      },
      body: form,
    })

    return await readJsonResponse<TResponse>("POST", endpoint, response)
  }

  async deleteAttachment<TResponse = AgentAttachmentDeleteResponse>(
    input: AgentAttachmentDeleteInput,
  ): Promise<TResponse> {
    if (input.threadId.length === 0) {
      throw new Error("threadId is required")
    }
    if (input.objectKey.length === 0) {
      throw new Error("objectKey is required")
    }

    const endpoint = buildBridgeEndpoint(this.appUrl, this.paths.agentAttachments)
    const response = await this.fetchWithTimeout("DELETE", endpoint, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${this.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        compact({
          agentSessionId: input.agentSessionId,
          deviceId: this.deviceId,
          objectKey: input.objectKey,
          threadId: input.threadId,
        }),
      ),
    })

    return await readJsonResponse<TResponse>("DELETE", endpoint, response)
  }

  private async offloadEventPayloads(event: BridgeEventInput): Promise<BridgeEventInput> {
    let next = event
    for (const field of ["rawPayload", "normalizedPayload"] as const) {
      if (!(field in next)) {
        continue
      }
      const payload = next[field]
      const serialized = stableJson(payload)
      if (serialized.length <= EVENT_PAYLOAD_INLINE_THRESHOLD_BYTES) {
        continue
      }
      try {
        const ref = await this.postToBase<Record<string, unknown>>(this.appUrl, this.paths.eventPayloads, {
          agentSessionId: next.agentSessionId,
          deviceId: this.deviceId,
          eventType: next.eventType,
          field,
          payload,
          sequence: next.sequence,
          threadId: next.threadId,
        })
        next = { ...next, [field]: ref }
      } catch {
        next = { ...next, [field]: compactOversizedPayload(payload) }
      }
    }
    return next
  }

  async invokeAgentTool<TResponse = Record<string, unknown>>(
    input: AgentToolInvokeInput,
  ): Promise<TResponse> {
    return await this.post<TResponse>(this.paths.agentToolsInvoke, {
      deviceId: this.deviceId,
      ...input,
    })
  }

  async forwardLogs<TResponse = Record<string, unknown>>(events: Array<Record<string, unknown>>) {
    if (events.length === 0) {
      return {} as TResponse
    }
    const endpoint = this.logIngestUrl
    if (!endpoint) {
      return {} as TResponse
    }
    const response = await this.fetchWithTimeout("POST", endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: this.deviceId,
        events,
      }),
    })

    return await readJsonResponse<TResponse>("POST", endpoint, response)
  }

  async post<TResponse>(path: string, body: unknown): Promise<TResponse> {
    return await this.postToBase<TResponse>(this.bridgeApiUrl ?? this.appUrl, path, body)
  }

  private async postToBase<TResponse>(
    baseUrl: string,
    path: string,
    body: unknown,
  ): Promise<TResponse> {
    const endpoint = buildBridgeEndpoint(baseUrl, path)
    const response = await this.fetchWithTimeout("POST", endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })

    return await readJsonResponse<TResponse>("POST", endpoint, response)
  }

  private async fetchWithTimeout(
    method: string,
    endpoint: string,
    init: RequestInit,
  ): Promise<Response> {
    const timeoutMs = this.requestTimeoutMs
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return await this.fetchImpl(endpoint, init)
    }

    const controller = new AbortController()
    const request = this.fetchImpl(endpoint, {
      ...init,
      signal: controller.signal,
    }).catch((error) => {
      if (controller.signal.aborted) {
        throw new BridgeCloudRequestTimeoutError(method, endpoint, timeoutMs)
      }
      throw error
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutResult = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new BridgeCloudRequestTimeoutError(method, endpoint, timeoutMs))
      }, timeoutMs)
    })

    try {
      return await Promise.race([request, timeoutResult])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }
}

export function buildBridgeEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}

function compactOversizedPayload(payload: unknown) {
  const serialized = stableJson(payload)
  return {
    omitted: "event payload omitted by bridge because external payload storage failed",
    preview: previewPayload(payload),
    serializedLength: serialized.length,
  }
}

function previewPayload(payload: unknown) {
  const text =
    typeof payload === "string"
      ? payload
      : readPreviewText(payload) ?? stableJson(payload).replace(/\s+/g, " ")
  return redactSecrets(text).slice(0, 4096)
}

function readPreviewText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined
  }
  const record = payload as Record<string, unknown>
  for (const key of ["text", "message", "content", "markdown", "output", "error"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value
    }
  }
  return undefined
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? "null"
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    )
  }
  return value
}

function redactSecrets(text: string) {
  return text
    .replace(/Bearer\s+[^\s,}\]]+/gi, "Bearer [REDACTED]")
    .replace(
      /("?(?:authorization|bridgeToken|token|secret|password|apiKey|api_key|x-api-key|x_api_key|accessToken|refreshToken|connectionString|connection_string|databaseUrl|database_url)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi,
      "$1[REDACTED]",
    )
}

async function readJsonResponse<TResponse>(
  method: string,
  url: string,
  response: Response,
): Promise<TResponse> {
  const text = await response.text()
  if (!response.ok) {
    throw new BridgeCloudHttpError(method, url, response.status, text)
  }
  if (text.length === 0) {
    return {} as TResponse
  }
  return JSON.parse(text) as TResponse
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K]
  } & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
  }
}
