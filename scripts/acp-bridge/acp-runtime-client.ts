import type {
  AgentCapabilities,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  ContentBlock,
  DeleteSessionRequest,
  InitializeResponse,
  ListSessionsRequest,
  LoadSessionRequest,
  McpServer,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionConfigOption,
  SessionId,
  SessionInfo,
  SessionModeState,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk"

export type BridgeAcpInitializeResult = {
  capabilities?: AgentCapabilities
  raw: InitializeResponse
}

export type BridgeAcpSessionRef = {
  configOptions?: Array<SessionConfigOption> | null
  modes?: SessionModeState | null
  raw: unknown
  sessionId: SessionId
}

export type BridgeCreateSessionParams = NewSessionRequest
export type BridgeLoadSessionParams = LoadSessionRequest
export type BridgeResumeSessionParams = ResumeSessionRequest
export type BridgeCloseSessionParams = CloseSessionRequest
export type BridgeListSessionsParams = ListSessionsRequest
export type BridgeRemoteSession = SessionInfo
export type BridgeDeleteSessionParams = DeleteSessionRequest
export type BridgePromptParams = PromptRequest
export type BridgePromptContentBlock = ContentBlock
export type BridgeMcpServer = McpServer

export type BridgePromptResult = {
  raw: PromptResponse
  stopReason: PromptResponse["stopReason"]
}

export type BridgeCancelParams = CancelNotification
export type BridgeSetModeParams = SetSessionModeRequest
export type BridgeSetConfigOptionParams = SetSessionConfigOptionRequest
export type BridgeSetModeResult = SetSessionModeResponse
export type BridgeSetConfigOptionResult = SetSessionConfigOptionResponse
export type BridgeAuthenticateParams = AuthenticateRequest
export type BridgeAuthenticateResult = AuthenticateResponse
export type BridgeAcpRawUpdate = SessionNotification
export type BridgePermissionRequest = RequestPermissionRequest
export type BridgePermissionResponse = RequestPermissionResponse

export interface BridgeAcpRuntimeClient {
  initialize(): Promise<BridgeAcpInitializeResult>
  createSession(params: BridgeCreateSessionParams): Promise<BridgeAcpSessionRef>
  loadSession(params: BridgeLoadSessionParams): Promise<BridgeAcpSessionRef>
  resumeSession?(params: BridgeResumeSessionParams): Promise<BridgeAcpSessionRef>
  closeSession?(params: BridgeCloseSessionParams): Promise<void>
  listSessions?(params: BridgeListSessionsParams): Promise<BridgeRemoteSession[]>
  deleteSession?(params: BridgeDeleteSessionParams): Promise<void>
  prompt(params: BridgePromptParams): Promise<BridgePromptResult>
  cancel(params: BridgeCancelParams): Promise<boolean>
  setMode?(params: BridgeSetModeParams): Promise<BridgeSetModeResult>
  setConfigOption?(params: BridgeSetConfigOptionParams): Promise<BridgeSetConfigOptionResult>
  authenticate?(params: BridgeAuthenticateParams): Promise<BridgeAuthenticateResult>
  logout?(): Promise<void>
  onUpdate(callback: (event: BridgeAcpRawUpdate) => void): () => void
  close(): Promise<void>
}
