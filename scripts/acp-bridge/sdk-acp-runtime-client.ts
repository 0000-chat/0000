import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { Readable, Writable } from "node:stream"
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type ClientConnection,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type InitializeRequest,
  type InitializeResponse,
  type JsonRpcId,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type Stream,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk"

import type {
  BridgeAcpInitializeResult,
  BridgeAcpRawUpdate,
  BridgeAcpRuntimeClient,
  BridgeAcpSessionRef,
  BridgeAuthenticateParams,
  BridgeAuthenticateResult,
  BridgeCancelParams,
  BridgeCloseSessionParams,
  BridgeCreateSessionParams,
  BridgeDeleteSessionParams,
  BridgeListSessionsParams,
  BridgeLoadSessionParams,
  BridgePromptParams,
  BridgePromptResult,
  BridgeRemoteSession,
  BridgeResumeSessionParams,
  BridgeSetConfigOptionParams,
  BridgeSetConfigOptionResult,
  BridgeSetModeParams,
  BridgeSetModeResult,
} from "./acp-runtime-client"
import {
  type TerminalHandle,
  type TerminalHandleRecord,
  TerminalHandleRegistry,
  type TerminalHandleScope,
} from "./terminal-handles"
import {
  authorizeZeroChatFilesystemPath,
  buildZeroChatFilesystemDiagnostic,
  type ZeroChatFilesystemDiagnostic,
} from "./zero-chat-policy"

export type SdkAcpRuntimeFilesystemPolicy = {
  onWriteApprovalRequired?: (
    diagnostic: ZeroChatFilesystemDiagnostic,
    params: WriteTextFileRequest,
  ) => Promise<boolean>
  workspaceRoots: string[]
  writeApprovalRequired?: boolean
}

export type SdkAcpRuntimeTerminalHandle = TerminalHandle & {
  currentOutput: () => Promise<TerminalOutputResponse> | TerminalOutputResponse
  terminalId?: string
  waitForExit: () => Promise<WaitForTerminalExitResponse> | WaitForTerminalExitResponse
}

export type SdkAcpRuntimeTerminalAdapter = {
  createTerminal: (params: CreateTerminalRequest) => Promise<SdkAcpRuntimeTerminalHandle>
  registry: TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>
  scope: TerminalHandleScope
}

export type SdkAcpRuntimeFilesystemActivity = {
  type: "filesystem_activity"
  operation: "read" | "write"
  sessionId: string
  requestedPath: string
  resolvedPath?: string
  matchedWorkspaceRoot?: string
  allowed: boolean
  status: "allowed" | "denied" | "error"
  approval: {
    required: boolean
    outcome?: "approved" | "denied"
    reason?: string
  }
  reason?: string
  error?: string
  contentLength?: number
  contentOmitted: true
}

export type SdkAcpRuntimeTerminalActivity = {
  type: "terminal_activity"
  action: "created" | "output" | "exit" | "killed" | "released" | "fenced"
  terminalId: string
  sessionId?: string
  command?: string
  scope?: TerminalHandleScope
  handleKey?: string
  generation?: number
  status:
    | "running"
    | "output"
    | "exited"
    | "killed"
    | "released"
    | "stale"
    | "fenced"
  output?: string
  outputTruncated?: boolean
  exitCode?: number
  reason?: string
}

export type SdkAcpRuntimeActivity =
  | SdkAcpRuntimeFilesystemActivity
  | SdkAcpRuntimeTerminalActivity

export type SdkAcpRuntimeRequestContext = {
  requestId?: JsonRpcId
}

type SdkAcpRuntimeAgentConnection = {
  authenticate: (params: BridgeAuthenticateParams) => Promise<BridgeAuthenticateResult>
  cancel: (params: BridgeCancelParams) => Promise<void>
  closeSession: (params: BridgeCloseSessionParams) => Promise<unknown>
  deleteSession: (params: BridgeDeleteSessionParams) => Promise<unknown>
  initialize: (params: InitializeRequest) => Promise<InitializeResponse>
  listSessions: (params: BridgeListSessionsParams) => Promise<ListSessionsResponse>
  loadSession: (params: BridgeLoadSessionParams) => Promise<LoadSessionResponse>
  logout: (params: Record<string, never>) => Promise<unknown>
  newSession: (params: BridgeCreateSessionParams) => Promise<NewSessionResponse>
  prompt: (params: BridgePromptParams) => Promise<BridgePromptResult["raw"]>
  resumeSession: (params: BridgeResumeSessionParams) => Promise<ResumeSessionResponse>
  setSessionConfigOption: (
    params: BridgeSetConfigOptionParams,
  ) => Promise<BridgeSetConfigOptionResult>
  setSessionMode: (params: BridgeSetModeParams) => Promise<BridgeSetModeResult>
}

export type SdkAcpRuntimeClientOptions = {
  connection?: SdkAcpRuntimeAgentConnection
  onActivity?: (activity: SdkAcpRuntimeActivity) => Promise<void> | void
  onPermissionRequest?: (
    params: RequestPermissionRequest,
    context?: SdkAcpRuntimeRequestContext,
  ) => Promise<RequestPermissionResponse>
  readTextFile?: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>
  filesystemPolicy?: SdkAcpRuntimeFilesystemPolicy
  stream?: Stream
  terminalAdapter?: SdkAcpRuntimeTerminalAdapter
  writeTextFile?: (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>
}

export class SdkAcpRuntimeClient implements BridgeAcpRuntimeClient {
  private readonly connection: SdkAcpRuntimeAgentConnection
  private readonly onActivity:
    | ((activity: SdkAcpRuntimeActivity) => Promise<void> | void)
    | undefined
  private readonly onPermissionRequest:
    | ((
        params: RequestPermissionRequest,
        context?: SdkAcpRuntimeRequestContext,
      ) => Promise<RequestPermissionResponse>)
    | undefined
  private readonly terminalAdapter: SdkAcpRuntimeTerminalAdapter | undefined
  private readonly terminalRecords = new Map<
    string,
    TerminalHandleRecord<SdkAcpRuntimeTerminalHandle>
  >()
  private readonly readTextFile:
    | ((params: ReadTextFileRequest) => Promise<ReadTextFileResponse>)
    | undefined
  private readonly updates = new Set<(event: BridgeAcpRawUpdate) => void>()
  private readonly writeTextFile:
    | ((params: WriteTextFileRequest) => Promise<WriteTextFileResponse>)
    | undefined

  constructor(options: SdkAcpRuntimeClientOptions) {
    this.onActivity = options.onActivity
    this.onPermissionRequest = options.onPermissionRequest
    this.terminalAdapter = options.terminalAdapter
    this.readTextFile =
      options.readTextFile ??
      buildPolicyBackedReadTextFileCallback(options.filesystemPolicy, (activity) =>
        this.emitActivity(activity),
      )
    this.writeTextFile =
      options.writeTextFile ??
      buildPolicyBackedWriteTextFileCallback(options.filesystemPolicy, (activity) =>
        this.emitActivity(activity),
      )

    if (options.connection) {
      this.connection = options.connection
      return
    }

    if (!options.stream) {
      throw new Error("ACP SDK runtime client requires a connection or stream")
    }

    this.connection = this.createAppConnection(options.stream)
  }

  static fromChildProcess(
    child: ChildProcessWithoutNullStreams,
    options: Omit<SdkAcpRuntimeClientOptions, "connection" | "stream"> = {},
  ): SdkAcpRuntimeClient {
    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>

    return new SdkAcpRuntimeClient({
      ...options,
      stream: ndJsonStream(input, output),
    })
  }

  async initialize(): Promise<BridgeAcpInitializeResult> {
    const raw = await this.connection.initialize({
      clientCapabilities: this.clientCapabilities(),
      protocolVersion: PROTOCOL_VERSION,
    })
    return { capabilities: raw.agentCapabilities, raw }
  }

  async createSession(params: BridgeCreateSessionParams): Promise<BridgeAcpSessionRef> {
    const raw = await this.connection.newSession(params)
    return {
      configOptions: raw.configOptions,
      modes: raw.modes,
      raw,
      sessionId: raw.sessionId,
    }
  }

  async loadSession(params: BridgeLoadSessionParams): Promise<BridgeAcpSessionRef> {
    const raw = await this.connection.loadSession(params)
    return {
      configOptions: raw.configOptions,
      modes: raw.modes,
      raw,
      sessionId: params.sessionId,
    }
  }

  async resumeSession(params: BridgeResumeSessionParams): Promise<BridgeAcpSessionRef> {
    const raw = await this.connection.resumeSession(params)
    return { raw, sessionId: params.sessionId }
  }

  async closeSession(params: BridgeCloseSessionParams): Promise<void> {
    await this.connection.closeSession(params)
  }

  async listSessions(params: BridgeListSessionsParams): Promise<BridgeRemoteSession[]> {
    const raw = await this.connection.listSessions(params)
    return raw.sessions
  }

  async deleteSession(params: BridgeDeleteSessionParams): Promise<void> {
    await this.connection.deleteSession(params)
  }

  async prompt(params: BridgePromptParams): Promise<BridgePromptResult> {
    const raw = await this.connection.prompt(params)
    return { raw, stopReason: raw.stopReason }
  }

  async cancel(params: BridgeCancelParams): Promise<boolean> {
    await this.connection.cancel(params)
    return true
  }

  async setMode(params: BridgeSetModeParams): Promise<BridgeSetModeResult> {
    return await this.connection.setSessionMode(params)
  }

  async setConfigOption(
    params: BridgeSetConfigOptionParams,
  ): Promise<BridgeSetConfigOptionResult> {
    return await this.connection.setSessionConfigOption(params)
  }

  async authenticate(params: BridgeAuthenticateParams): Promise<BridgeAuthenticateResult> {
    return await this.connection.authenticate(params)
  }

  async logout(): Promise<void> {
    await this.connection.logout({})
  }

  onUpdate(callback: (event: BridgeAcpRawUpdate) => void): () => void {
    this.updates.add(callback)
    return () => {
      this.updates.delete(callback)
    }
  }

  async close(): Promise<void> {
    return
  }

  private createAppConnection(stream: Stream): SdkAcpRuntimeAgentConnection {
    const app = createClientApp({ name: "0000-bridge" })
      .onRequest(methods.client.session.requestPermission, (context) =>
        this.requestPermission(context.params, { requestId: context.requestId }),
      )
      .onNotification(methods.client.session.update, async (context) => {
        for (const callback of this.updates) {
          callback(context.params)
        }
      })

    const readTextFile = this.readTextFile
    if (readTextFile) {
      app.onRequest(methods.client.fs.readTextFile, (context) =>
        readTextFile(context.params),
      )
    }
    const writeTextFile = this.writeTextFile
    if (writeTextFile) {
      app.onRequest(methods.client.fs.writeTextFile, async (context) =>
        (await writeTextFile(context.params)) ?? {},
      )
    }
    if (this.terminalAdapter) {
      app
        .onRequest(methods.client.terminal.create, (context) =>
          this.createTerminal(context.params),
        )
        .onRequest(methods.client.terminal.output, (context) =>
          this.terminalOutput(context.params),
        )
        .onRequest(methods.client.terminal.waitForExit, (context) =>
          this.waitForTerminalExit(context.params),
        )
        .onRequest(methods.client.terminal.kill, async (context) =>
          (await this.killTerminal(context.params)) ?? {},
        )
        .onRequest(methods.client.terminal.release, async (context) =>
          (await this.releaseTerminal(context.params)) ?? {},
        )
    }

    return agentConnectionFromClientApp(app.connect(stream))
  }

  private async requestPermission(
    params: RequestPermissionRequest,
    context?: SdkAcpRuntimeRequestContext,
  ): Promise<RequestPermissionResponse> {
    if (this.onPermissionRequest) {
      return await this.onPermissionRequest(params, context)
    }
    return { outcome: { outcome: "cancelled" } }
  }

  private clientCapabilities(): ClientCapabilities {
    return {
      fs: {
        readTextFile: this.readTextFile !== undefined,
        writeTextFile: this.writeTextFile !== undefined,
      },
      terminal: this.terminalAdapter !== undefined,
    }
  }

  private async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const adapter = this.requireTerminalAdapter()
    const handle = await adapter.createTerminal(params)
    const record = adapter.registry.create({
      handle,
      scope: adapter.scope,
    })
    const terminalId = handle.terminalId ?? `${record.key}:${record.generation}`
    this.terminalRecords.set(terminalId, record)
    await this.emitActivity({
      type: "terminal_activity",
      action: "created",
      command: truncateText(params.command, 300).text,
      generation: record.generation,
      handleKey: record.key,
      scope: record.scope,
      sessionId: params.sessionId,
      status: "running",
      terminalId,
    })
    return { terminalId }
  }

  private async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const record = await this.requireTerminalRecord(params.terminalId, "output")
    const output = await record.handle.currentOutput()
    const bounded = truncateText(output.output, 4096)
    await this.emitActivity({
      type: "terminal_activity",
      action: "output",
      generation: record.generation,
      handleKey: record.key,
      output: bounded.text,
      outputTruncated: output.truncated || bounded.truncated,
      scope: record.scope,
      status: "output",
      terminalId: params.terminalId,
    })
    return output
  }

  private async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const record = await this.requireTerminalRecord(params.terminalId, "exit")
    const exit = await record.handle.waitForExit()
    await this.emitActivity({
      type: "terminal_activity",
      action: "exit",
      exitCode: exit.exitCode ?? undefined,
      generation: record.generation,
      handleKey: record.key,
      scope: record.scope,
      status: "exited",
      terminalId: params.terminalId,
    })
    return exit
  }

  private async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const adapter = this.requireTerminalAdapter()
    const record = await this.requireTerminalRecord(params.terminalId, "kill")
    const result = await adapter.registry.kill(record.scope, { generation: record.generation })
    if (result.status !== "stale") {
      this.terminalRecords.delete(params.terminalId)
    }
    await this.emitActivity({
      type: "terminal_activity",
      action: result.status === "stale" ? "fenced" : "killed",
      generation: record.generation,
      handleKey: record.key,
      reason: result.status === "stale" ? "stale_generation" : undefined,
      scope: record.scope,
      status: result.status === "stale" ? "stale" : "killed",
      terminalId: params.terminalId,
    })
    return {}
  }

  private async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    const adapter = this.requireTerminalAdapter()
    const record = await this.requireTerminalRecord(params.terminalId, "release")
    const result = await adapter.registry.release(record.scope, { generation: record.generation })
    if (result.status !== "stale") {
      this.terminalRecords.delete(params.terminalId)
    }
    await this.emitActivity({
      type: "terminal_activity",
      action: result.status === "stale" ? "fenced" : "released",
      generation: record.generation,
      handleKey: record.key,
      reason: result.status === "stale" ? "stale_generation" : undefined,
      scope: record.scope,
      status: result.status === "stale" ? "stale" : "released",
      terminalId: params.terminalId,
    })
    return {}
  }

  private requireTerminalAdapter(): SdkAcpRuntimeTerminalAdapter {
    if (!this.terminalAdapter) {
      throw new Error("ACP terminal callback requested without terminal adapter")
    }
    return this.terminalAdapter
  }

  private async requireTerminalRecord(
    terminalId: string,
    action: "exit" | "kill" | "output" | "release",
  ): Promise<TerminalHandleRecord<SdkAcpRuntimeTerminalHandle>> {
    const record = this.terminalRecords.get(terminalId)
    if (!record) {
      throw new Error(`Unknown ACP terminal handle: ${terminalId}`)
    }
    const currentRecord = this.terminalAdapter?.registry.lookup(record.scope)
    if (currentRecord !== record || currentRecord.generation !== record.generation) {
      this.terminalRecords.delete(terminalId)
      await this.emitActivity({
        type: "terminal_activity",
        action: "fenced",
        generation: record.generation,
        handleKey: record.key,
        reason: `stale_${action}`,
        scope: record.scope,
        status: "fenced",
        terminalId,
      })
      throw new Error(`Stale ACP terminal handle: ${terminalId}`)
    }
    return Promise.resolve(record)
  }

  private async emitActivity(activity: SdkAcpRuntimeActivity): Promise<void> {
    await this.onActivity?.(activity)
  }
}

function agentConnectionFromClientApp(
  connection: ClientConnection,
): SdkAcpRuntimeAgentConnection {
  const { agent } = connection
  return {
    authenticate: (params) =>
      withEmptyObjectFallback(agent.request(methods.agent.authenticate, params)),
    cancel: (params) => agent.notify(methods.agent.session.cancel, params),
    closeSession: (params) =>
      withEmptyObjectFallback(agent.request(methods.agent.session.close, params)),
    deleteSession: (params) =>
      withEmptyObjectFallback(agent.request(methods.agent.session.delete, params)),
    initialize: (params) => agent.request(methods.agent.initialize, params),
    listSessions: (params) => agent.request(methods.agent.session.list, params),
    loadSession: (params) =>
      withEmptyObjectFallback(agent.request(methods.agent.session.load, params)),
    logout: (params) => withEmptyObjectFallback(agent.request(methods.agent.logout, params)),
    newSession: (params) => agent.request(methods.agent.session.new, params),
    prompt: (params) => agent.request(methods.agent.session.prompt, params),
    resumeSession: (params) => agent.request(methods.agent.session.resume, params),
    setSessionConfigOption: (params) =>
      agent.request(methods.agent.session.setConfigOption, params),
    setSessionMode: (params) =>
      withEmptyObjectFallback(agent.request(methods.agent.session.setMode, params)),
  }
}

async function withEmptyObjectFallback<T>(request: Promise<T | void>): Promise<T> {
  return ((await request) ?? {}) as T
}

function buildPolicyBackedReadTextFileCallback(
  policy: SdkAcpRuntimeFilesystemPolicy | undefined,
  onActivity?: (activity: SdkAcpRuntimeFilesystemActivity) => Promise<void> | void,
): ((params: ReadTextFileRequest) => Promise<ReadTextFileResponse>) | undefined {
  if (!policy) {
    return undefined
  }
  return async (params) => {
    const decision = await authorizeZeroChatFilesystemPath({
      operation: "read",
      requestedPath: params.path,
      workspaceRoots: policy.workspaceRoots,
      writeApprovalRequired: policy.writeApprovalRequired,
    })
    if (!decision.allowed) {
      await emitFilesystemActivity(onActivity, params, buildZeroChatFilesystemDiagnostic(decision), {
        status: "denied",
      })
      throw filesystemPolicyError(decision)
    }
    const content = await readFile(decision.resolvedPath, "utf8")
    await emitFilesystemActivity(onActivity, params, buildZeroChatFilesystemDiagnostic(decision), {
      contentLength: content.length,
      status: "allowed",
    })
    return { content: sliceFileContent(content, params.line ?? undefined, params.limit ?? undefined) }
  }
}

function buildPolicyBackedWriteTextFileCallback(
  policy: SdkAcpRuntimeFilesystemPolicy | undefined,
  onActivity?: (activity: SdkAcpRuntimeFilesystemActivity) => Promise<void> | void,
): ((params: WriteTextFileRequest) => Promise<WriteTextFileResponse>) | undefined {
  if (!policy) {
    return undefined
  }
  return async (params) => {
    const decision = await authorizeZeroChatFilesystemPath({
      operation: "write",
      requestedPath: params.path,
      workspaceRoots: policy.workspaceRoots,
      writeApprovalRequired: policy.writeApprovalRequired,
    })
    if (!decision.allowed) {
      await emitFilesystemActivity(onActivity, params, buildZeroChatFilesystemDiagnostic(decision), {
        contentLength: params.content.length,
        status: "denied",
      })
      throw filesystemPolicyError(decision)
    }
    if (decision.approval.required) {
      const approved =
        (await policy.onWriteApprovalRequired?.(
          buildZeroChatFilesystemDiagnostic(decision),
          params,
        )) === true
      if (!approved) {
        await emitFilesystemActivity(onActivity, params, buildZeroChatFilesystemDiagnostic(decision), {
          approvalOutcome: "denied",
          contentLength: params.content.length,
          reason: "write_approval_denied",
          status: "denied",
        })
        throw new Error("ACP filesystem write denied: write approval was not granted")
      }
    }
    await writeFile(decision.resolvedPath, params.content, "utf8")
    await emitFilesystemActivity(onActivity, params, buildZeroChatFilesystemDiagnostic(decision), {
      approvalOutcome: decision.approval.required ? "approved" : undefined,
      contentLength: params.content.length,
      status: "allowed",
    })
    return {}
  }
}

async function emitFilesystemActivity(
  onActivity: ((activity: SdkAcpRuntimeFilesystemActivity) => Promise<void> | void) | undefined,
  params: ReadTextFileRequest | WriteTextFileRequest,
  diagnostic: ZeroChatFilesystemDiagnostic,
  extra: {
    approvalOutcome?: "approved" | "denied"
    contentLength?: number
    reason?: string
    status: "allowed" | "denied" | "error"
  },
): Promise<void> {
  await onActivity?.({
    type: "filesystem_activity",
    allowed: diagnostic.allowed && extra.status === "allowed",
    approval: {
      outcome: extra.approvalOutcome,
      reason: diagnostic.approvalReason,
      required: diagnostic.approvalRequired,
    },
    contentLength: extra.contentLength,
    contentOmitted: true,
    error: diagnostic.error,
    matchedWorkspaceRoot: diagnostic.matchedWorkspaceRoot,
    operation: diagnostic.operation,
    reason: extra.reason ?? diagnostic.reason,
    requestedPath: diagnostic.requestedPath,
    resolvedPath: diagnostic.resolvedPath,
    sessionId: params.sessionId,
    status: extra.status,
  })
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, limit), truncated: true }
}

function filesystemPolicyError(
  decision: Parameters<typeof buildZeroChatFilesystemDiagnostic>[0],
): Error {
  const diagnostic = buildZeroChatFilesystemDiagnostic(decision)
  const reason = diagnostic.reason ?? "filesystem_policy_denied"
  const details = [
    `operation=${diagnostic.operation}`,
    `path=${diagnostic.requestedPath}`,
    diagnostic.resolvedPath ? `resolvedPath=${diagnostic.resolvedPath}` : undefined,
    diagnostic.error ? `error=${diagnostic.error}` : undefined,
  ].filter(Boolean)
  return new Error(`ACP filesystem ${reason}: ${details.join(" ")}`)
}

function sliceFileContent(content: string, line: number | undefined, limit: number | undefined): string {
  let sliced = content
  if (line !== undefined) {
    sliced = content.split(/\r?\n/).slice(line).join("\n")
  }
  if (limit !== undefined) {
    sliced = sliced.slice(0, limit)
  }
  return sliced
}
