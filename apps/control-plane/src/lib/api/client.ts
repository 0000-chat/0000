import { z } from "zod";
import {
  ApiErrorResponseSchema,
  ChannelSummarySchema,
  CommandSchema,
  ConnectionSchema,
  AccountGrantMutationSchema,
  AccountGrantPageSchema,
  AccountGrantSchema,
  AccountGrantTargetPageSchema,
  AccountGrantUpdateSchema,
  ConnectedAccountPageSchema,
  GroupManagementEvidenceSchema,
  GroupManagementPageSchema,
  HistoryImportAdvanceRequestSchema,
  HistoryImportDetailSchema,
  HistoryImportPageSchema,
  HistoryImportStartRequestSchema,
  PermissionRequestCreateSchema,
  PermissionRequestSchema,
  ProviderCapabilitySchema,
  ConversationPageResultSchema,
  ConversationSummarySchema,
  IdentitySchema,
  LinkSessionActionRequestSchema,
  LinkSessionSchema,
  LinkSessionStartSchema,
  MAX_IDENTITY_CONNECTIONS,
  MessagePageResultSchema,
  OutboundDecisionResultSchema,
  OutboundEvidenceRecordSchema,
  RealtimeTicketRequestSchema,
  RealtimeTicketResponseSchema,
  SessionResponseSchema,
  type Command,
  type AccountGrant,
  type AccountGrantPage,
  type AccountGrantTargetPage,
  type AccountGrantMutation,
  type AccountGrantUpdate,
  type ConnectedAccountPage,
  type GroupManagementEvidence,
  type GroupManagementPage,
  type HistoryImportAdvanceRequest,
  type HistoryImportDetail,
  type HistoryImportPage,
  type HistoryImportStartRequest,
  type PermissionRequestCreate,
  type PermissionRequest,
  type ChannelSummary,
  type Connection,
  type ConversationPageResult,
  type ConversationSummary,
  type Identity,
  type LinkSession,
  type LinkSessionActionRequest,
  type LinkSessionStart,
  type MessagePageResult,
  type ConfirmationDecision,
  type OutboundAction,
  type OutboundEvidenceRecord,
  type RealtimeTicketRequest,
  type RealtimeTicketResponse,
  type SessionResponse,
  type ProviderCapability,
} from "@communicator/contracts";

const ResetResponseSchema = z
  .object({
    status: z.literal("reset"),
    scenario: z.enum(["ready", "attention_required"]),
    fixture_reset_at: z.string().datetime({ offset: true }),
  })
  .strict();

const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("communicator-control-plane"),
    data_mode: z.enum(["unconfigured", "simulated", "live"]),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ResetResponse = z.infer<typeof ResetResponseSchema>;

export function identitiesFromSession(session: SessionResponse): Identity[] {
  return session.identities.map((identity) =>
    IdentitySchema.parse({
      id: identity.identity_id,
      tenant_id: session.tenant.id,
      kind: identity.kind,
      display_name: identity.display_name,
    }),
  );
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isDefinitiveRequestRejection(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export class ApiClient {
  constructor(
    private readonly fetcher?: typeof fetch,
    private readonly baseUrl = "",
  ) {}

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    const url = this.baseUrl
      ? `${this.baseUrl}${path}`
      : new URL(
          path,
          globalThis.location?.origin ?? "http://example.test",
        ).toString();
    const response = await (this.fetcher ?? globalThis.fetch)(url, init);
    if (!response.ok) {
      let code: string | undefined;
      let message = `Communicator API request failed with ${response.status}`;
      try {
        const errorBody = ApiErrorResponseSchema.parse(
          await response.clone().json(),
        );
        code = errorBody.error.code;
        message = errorBody.error.message;
      } catch {
        // Keep the generic status message for non-contract failures.
      }
      throw new ApiError(response.status, message, code);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(502, "Communicator API returned an invalid response");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(502, "Communicator API returned an invalid response");
    }
    return parsed.data;
  }

  getSession(): Promise<SessionResponse> {
    return this.request("/api/v1/session", SessionResponseSchema);
  }

  getConnections(identityId: string): Promise<Connection[]> {
    return this.request(
      `/api/v1/connections?identity_id=${encodeURIComponent(identityId)}`,
      ConnectionSchema.array().max(MAX_IDENTITY_CONNECTIONS),
    );
  }

  startLinkSession(
    identityId: string,
    input: LinkSessionStart,
    idempotencyKey: string,
  ): Promise<LinkSession> {
    return this.request(
      `/api/v1/identities/${encodeURIComponent(identityId)}/link-sessions`,
      LinkSessionSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(LinkSessionStartSchema.parse(input)),
      },
    );
  }

  getLinkSession(sessionId: string): Promise<LinkSession> {
    return this.request(
      `/api/v1/link-sessions/${encodeURIComponent(sessionId)}`,
      LinkSessionSchema,
    );
  }

  actLinkSession(
    sessionId: string,
    input: LinkSessionActionRequest,
    idempotencyKey: string,
  ): Promise<LinkSession> {
    return this.request(
      `/api/v1/link-sessions/${encodeURIComponent(sessionId)}/actions`,
      LinkSessionSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(LinkSessionActionRequestSchema.parse(input)),
      },
    );
  }

  cancelLinkSession(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<LinkSession> {
    return this.request(
      `/api/v1/link-sessions/${encodeURIComponent(sessionId)}`,
      LinkSessionSchema,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  getConnectedAccounts(
    identityId?: string,
    cursor?: string,
    limit = 50,
  ): Promise<ConnectedAccountPage> {
    const search = new URLSearchParams({ limit: String(limit) });
    if (identityId !== undefined) search.set("identity_id", identityId);
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.request(
      `/api/v1/accounts?${search}`,
      ConnectedAccountPageSchema,
    );
  }

  getProviderCapabilities(
    accountId: string,
    identityId: string,
  ): Promise<ProviderCapability[]> {
    const search = new URLSearchParams({ identity_id: identityId });
    return this.request(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/capabilities?${search}`,
      ProviderCapabilitySchema.array().max(20),
    );
  }

  getHistoryImports(
    accountId: string,
    identityId: string,
    cursor?: string,
    limit = 50,
  ): Promise<HistoryImportPage> {
    const search = new URLSearchParams({
      identity_id: identityId,
      limit: String(limit),
    });
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.request(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/history-imports?${search}`,
      HistoryImportPageSchema,
    );
  }

  getHistoryImport(
    importId: string,
    identityId: string,
  ): Promise<HistoryImportDetail> {
    const search = new URLSearchParams({ identity_id: identityId });
    return this.request(
      `/api/v1/history-imports/${encodeURIComponent(importId)}?${search}`,
      HistoryImportDetailSchema,
    );
  }

  startHistoryImport(
    accountId: string,
    input: HistoryImportStartRequest,
    idempotencyKey: string,
  ): Promise<HistoryImportDetail> {
    return this.request(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/history-imports`,
      HistoryImportDetailSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(HistoryImportStartRequestSchema.parse(input)),
      },
    );
  }

  advanceHistoryImport(
    importId: string,
    input: HistoryImportAdvanceRequest,
    idempotencyKey: string,
  ): Promise<HistoryImportDetail> {
    return this.request(
      `/api/v1/history-imports/${encodeURIComponent(importId)}/advance`,
      HistoryImportDetailSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(HistoryImportAdvanceRequestSchema.parse(input)),
      },
    );
  }

  getAccountGrants(cursor?: string, limit = 50): Promise<AccountGrantPage> {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.request(`/api/v1/grants?${search}`, AccountGrantPageSchema);
  }

  getGroupManagementOperations(options?: {
    identityId?: string;
    accountId?: string;
    status?: "pending" | "succeeded" | "failed" | "human_action_required";
    cursor?: string;
    limit?: number;
  }): Promise<GroupManagementPage> {
    const search = new URLSearchParams();
    if (options?.identityId !== undefined)
      search.set("identity_id", options.identityId);
    if (options?.accountId !== undefined)
      search.set("account_id", options.accountId);
    if (options?.status !== undefined) search.set("status", options.status);
    if (options?.cursor !== undefined) search.set("cursor", options.cursor);
    if (options?.limit !== undefined)
      search.set("limit", String(options.limit));
    const suffix = search.toString().length > 0 ? `?${search}` : "";
    return this.request(
      `/api/v1/group-management/operations${suffix}`,
      GroupManagementPageSchema,
    );
  }

  getGroupManagementEvidence(
    operationId: string,
  ): Promise<GroupManagementEvidence[]> {
    return this.request(
      `/api/v1/group-management/operations/${encodeURIComponent(operationId)}/evidence`,
      GroupManagementEvidenceSchema.array().max(100),
    );
  }

  getGrantTargets(
    cursor?: string,
    limit = 50,
  ): Promise<AccountGrantTargetPage> {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.request(
      `/api/v1/grant-targets?${search}`,
      AccountGrantTargetPageSchema,
    );
  }

  createAccountGrant(input: AccountGrantMutation): Promise<AccountGrant> {
    return this.request("/api/v1/grants", AccountGrantSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AccountGrantMutationSchema.parse(input)),
    });
  }

  updateAccountGrant(
    grantId: string,
    input: AccountGrantUpdate,
  ): Promise<AccountGrant> {
    return this.request(
      `/api/v1/grants/${encodeURIComponent(grantId)}`,
      AccountGrantSchema,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(AccountGrantUpdateSchema.parse(input)),
      },
    );
  }

  revokeAccountGrant(
    grantId: string,
    idempotencyKey: string,
  ): Promise<AccountGrant> {
    return this.request(
      `/api/v1/grants/${encodeURIComponent(grantId)}`,
      AccountGrantSchema,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  createPermissionRequest(
    input: PermissionRequestCreate,
  ): Promise<PermissionRequest> {
    return this.request(
      "/api/v1/permission-requests",
      PermissionRequestSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PermissionRequestCreateSchema.parse(input)),
      },
    );
  }

  getChannels(identityId: string): Promise<ChannelSummary[]> {
    return this.request(
      `/api/v1/identities/${encodeURIComponent(identityId)}/channels`,
      ChannelSummarySchema.array().max(MAX_IDENTITY_CONNECTIONS),
    );
  }

  getConversations(
    identityId: string,
    channelId?: string,
    cursor?: string,
    limit = 50,
  ): Promise<ConversationPageResult> {
    const search = new URLSearchParams({ limit: String(limit) });
    if (channelId !== undefined) search.set("channel_id", channelId);
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.request(
      `/api/v1/identities/${encodeURIComponent(identityId)}/conversations?${search}`,
      ConversationPageResultSchema,
    );
  }

  getAccountConversations(
    accountId: string,
    identityId: string,
    cursor?: string,
    limit = 50,
  ): Promise<ConversationPageResult> {
    const search = new URLSearchParams({
      identity_id: identityId,
      limit: String(limit),
    });
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.request(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/conversations?${search}`,
      ConversationPageResultSchema,
    );
  }

  getConversation(
    identityId: string,
    conversationId: string,
  ): Promise<ConversationSummary> {
    return this.request(
      `/api/v1/identities/${encodeURIComponent(identityId)}/conversations/${encodeURIComponent(conversationId)}`,
      ConversationSummarySchema,
    );
  }

  getMessages(
    conversationId: string,
    identityId: string,
    cursor?: string,
    limit = 50,
    messageId?: string,
  ): Promise<MessagePageResult> {
    const search = new URLSearchParams({
      identity_id: identityId,
      limit: String(limit),
    });
    if (cursor !== undefined) search.set("cursor", cursor);
    if (messageId !== undefined) search.set("message_id", messageId);
    return this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?${search}`,
      MessagePageResultSchema,
    );
  }

  getCommands(identityId?: string): Promise<Command[]> {
    const search =
      identityId === undefined
        ? ""
        : `?identity_id=${encodeURIComponent(identityId)}`;
    return this.request(`/api/v1/commands${search}`, CommandSchema.array());
  }

  decideCommand(
    commandId: string,
    decision: ConfirmationDecision | OutboundAction,
    idempotencyKey: string,
    duplicateRiskAcknowledged = false,
  ) {
    return this.request(
      `/api/v1/commands/${encodeURIComponent(commandId)}/${decision}`,
      OutboundDecisionResultSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          ...(decision === "resend"
            ? { duplicate_risk_acknowledged: duplicateRiskAcknowledged }
            : {}),
        }),
      },
    );
  }

  getCommandEvidence(commandId: string): Promise<OutboundEvidenceRecord[]> {
    return this.request(
      `/api/v1/commands/${encodeURIComponent(commandId)}/evidence`,
      OutboundEvidenceRecordSchema.array().max(100),
    );
  }

  sendMessage({
    conversationId,
    identityId,
    body,
    deliveryMode,
    idempotencyKey,
  }: {
    conversationId: string;
    identityId: string;
    body: string;
    deliveryMode: "direct" | "paced";
    idempotencyKey: string;
  }): Promise<Command> {
    return this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      CommandSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          identity_id: identityId,
          body,
          delivery_mode: deliveryMode,
        }),
      },
    );
  }

  resetSimulation(
    scenario: "ready" | "attention_required" = "ready",
  ): Promise<ResetResponse> {
    return this.request("/api/v1/testing/reset", ResetResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario }),
    });
  }

  getHealth(): Promise<HealthResponse> {
    return this.request("/api/v1/health", HealthResponseSchema);
  }

  createRealtimeTicket(
    request: RealtimeTicketRequest,
  ): Promise<RealtimeTicketResponse> {
    const parsedRequest = RealtimeTicketRequestSchema.parse(request);
    return this.request(
      "/api/v1/realtime/tickets",
      RealtimeTicketResponseSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedRequest),
      },
    );
  }
}

export const apiClient = new ApiClient();
