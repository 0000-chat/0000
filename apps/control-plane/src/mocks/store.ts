import type {
  Command,
  AccountGrant,
  AccountGrantMutation,
  AccountGrantTarget,
  ConnectedAccount,
  ChannelSummary,
  Connection,
  ConversationSummary,
  HistoryImportAdvanceRequest,
  HistoryImportDetail,
  HistoryImportRange,
  HistoryImportStartRequest,
  Identity,
  LinkSession,
  LinkSessionActionRequest,
  LinkSessionStart,
  MessagePageResult,
  OperationScope,
  ProviderCapability,
  SessionResponse,
  OutboundAction,
} from "@communicator/contracts";
import {
  pilotScenario,
  PilotScenarioSchema,
} from "@communicator/test-fixtures";
import {
  compareConversationRecency,
  paginateConversations,
  paginateMessages,
} from "./conversation-pagination";

export type SimulatedScenario = "ready" | "attention_required";
export type SimulatedMessageMode = "normal" | "pages" | "error";
export type SimulatedLinkScenario =
  | "connected"
  | "provider_error"
  | "duplicate"
  | "expired";

const defaultSortPosition = new Map([
  ["connection_human_whatsapp", 10],
  ["connection_human_telegram", 20],
  ["connection_human_messenger", 30],
  ["connection_agent_whatsapp", 10],
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class SimulatedStore {
  private state = clone(PilotScenarioSchema.parse(pilotScenario));
  private scenario: SimulatedScenario = "ready";
  private messageMode: SimulatedMessageMode = "normal";
  private idempotency = new Map<string, Command>();
  private commandCounter = 0;
  private grantCounter = 0;
  private grants: AccountGrant[] = [];
  private linkScenario: SimulatedLinkScenario = "connected";
  private linkSessionState: LinkSession | null = null;
  private linkQrCounter = 0;
  private linkActionDelayMs = 0;
  private linkActionExpiryMs = 60_000;
  private resetAt = this.state.fixture_reset_at;
  private historyImports = new Map<string, HistoryImportDetail[]>();
  private historyIdempotency = new Map<string, HistoryImportDetail>();
  private historyCounter = 0;

  reset(
    scenario: SimulatedScenario = "ready",
    messageMode: SimulatedMessageMode = "normal",
  ) {
    this.state = clone(PilotScenarioSchema.parse(pilotScenario));
    this.scenario = scenario;
    this.messageMode = messageMode;
    this.idempotency.clear();
    this.commandCounter = 0;
    this.grantCounter = 0;
    this.grants = [];
    this.linkScenario = "connected";
    this.linkSessionState = null;
    this.linkQrCounter = 0;
    this.linkActionDelayMs = 0;
    this.linkActionExpiryMs = 60_000;
    this.resetAt = new Date().toISOString();
    this.historyImports.clear();
    this.historyIdempotency.clear();
    this.historyCounter = 0;
    this.seedHistoryImports();
  }

  private seedHistoryImports() {
    for (const account of this.connectedAccounts()) {
      const now = "2026-08-29T00:00:00.000Z";
      const range = (
        rangeId: string,
        startAt: string,
        endAt: string,
        status: HistoryImportRange["status"],
        options: Pick<
          HistoryImportRange,
          "event_count" | "gap_code" | "error_code" | "completed_at"
        >,
      ): HistoryImportRange => ({
        range_id: rangeId,
        import_id: "import_seed_history",
        account_id: account.account_id,
        start_at: startAt,
        end_at: endAt,
        status,
        attempt_count: status === "failed" ? 3 : 0,
        event_count: options.event_count,
        source_cursor: null,
        gap_code: options.gap_code,
        error_code: options.error_code,
        updated_at: now,
        created_at: now,
        completed_at: options.completed_at,
      });

      const seeded =
        account.account_id === "account_connection_agent_whatsapp" ||
        account.account_id === "account_connection_human_messenger"
          ? {
              import_id:
                account.account_id === "account_connection_agent_whatsapp"
                  ? "import_agent_partial"
                  : "import_messenger_partial",
              status: "partial" as const,
              ranges: [
                range(
                  account.account_id === "account_connection_agent_whatsapp"
                    ? "range_agent_partial"
                    : "range_messenger_partial",
                  "2026-08-01T00:00:00.000Z",
                  "2026-08-15T00:00:00.000Z",
                  "partial",
                  {
                    event_count: 12,
                    gap_code: "provider_gap",
                    error_code: null,
                    completed_at: now,
                  },
                ),
              ],
              event_count: 12,
              completed_range_count: 0,
              total_range_count: 1,
              gap_count: 1,
              last_error_code: null,
              completed_at: now,
            }
          : account.account_id === "account_connection_human_telegram"
            ? {
                import_id: "import_telegram_failed",
                status: "failed" as const,
                ranges: [
                  range(
                    "range_telegram_failed",
                    "2026-08-01T00:00:00.000Z",
                    "2026-08-15T00:00:00.000Z",
                    "failed",
                    {
                      event_count: 0,
                      gap_code: null,
                      error_code: "bounded_retry_exhausted",
                      completed_at: now,
                    },
                  ),
                ],
                event_count: 0,
                completed_range_count: 0,
                total_range_count: 1,
                gap_count: 1,
                last_error_code: "bounded_retry_exhausted" as const,
                completed_at: now,
              }
            : account.account_id === "account_connection_human_whatsapp"
              ? {
                  import_id: "import_whatsapp_empty",
                  status: "completed" as const,
                  ranges: [
                    range(
                      "range_telegram_empty",
                      "2026-08-01T00:00:00.000Z",
                      "2026-08-15T00:00:00.000Z",
                      "completed",
                      {
                        event_count: 0,
                        gap_code: null,
                        error_code: null,
                        completed_at: now,
                      },
                    ),
                  ],
                  event_count: 0,
                  completed_range_count: 1,
                  total_range_count: 1,
                  gap_count: 0,
                  last_error_code: null,
                  completed_at: now,
                }
              : null;

      if (seeded === null) {
        this.historyImports.set(account.account_id, []);
        continue;
      }
      const detail: HistoryImportDetail = {
        import: {
          import_id: seeded.import_id,
          tenant_id: account.tenant_id,
          account_id: account.account_id,
          connection_id: account.connection_id,
          identity_id: account.identity_id,
          provider: account.provider,
          status: seeded.status,
          availability:
            seeded.status === "failed" ? "unavailable" : "available",
          requested_start_at: "2026-08-01T00:00:00.000Z",
          requested_end_at: "2026-08-15T00:00:00.000Z",
          source_start_at: "2026-08-01T00:00:00.000Z",
          source_end_at: "2026-08-15T00:00:00.000Z",
          max_events: 500,
          event_count: seeded.event_count,
          completed_range_count: seeded.completed_range_count,
          total_range_count: seeded.total_range_count,
          gap_count: seeded.gap_count,
          attempt_count: seeded.status === "failed" ? 3 : 0,
          max_attempts: 3,
          last_error_code: seeded.last_error_code,
          started_at: now,
          updated_at: now,
          completed_at: seeded.completed_at,
        },
        ranges: seeded.ranges.map((item) => ({
          ...item,
          import_id: seeded.import_id,
        })),
        capabilities: this.historyCapabilities(account.account_id),
      };
      this.historyImports.set(account.account_id, [detail]);
    }
  }

  historyCapabilities(accountId: string): ProviderCapability[] {
    const account = this.connectedAccounts().find(
      (candidate) => candidate.account_id === accountId,
    );
    if (!account) return [];
    const now = "2026-08-29T00:00:00.000Z";
    const capabilities: ProviderCapability["capability"][] = [
      "history.import",
      "media.read",
      "contact.lookup",
      "group.manage",
      "receipt.read",
    ];
    return capabilities.map((capability) => ({
      tenant_id: account.tenant_id,
      account_id: account.account_id,
      connection_id: account.connection_id,
      identity_id: account.identity_id,
      provider: account.provider,
      capability,
      status: capability === "history.import" ? "conditional" : "unverified",
      freshness: capability === "history.import" ? "fresh" : "unknown",
      provider_version: "simulated-provider-1",
      proof_source: "controlled provider fixture",
      provider_evidence: {
        provider_version: "simulated-provider-1",
        proof_source: "controlled provider fixture",
        summary:
          capability === "history.import"
            ? "The configured adapter reports bounded resumable history support."
            : "No deployment proof is recorded for this capability.",
        observed_at: now,
      },
      product_claim:
        capability === "history.import"
          ? "History imports remain conditional on the configured provider runtime."
          : "The capability is not proven for this account.",
      observed_at: now,
      updated_at: now,
    }));
  }

  historyImportPage(accountId: string, identityId: string) {
    const account = this.connectedAccounts().find(
      (candidate) =>
        candidate.account_id === accountId &&
        candidate.identity_id === identityId,
    );
    if (!account) return null;
    return clone(this.historyImports.get(accountId) ?? []);
  }

  historyImport(
    importId: string,
    identityId: string,
  ): HistoryImportDetail | null {
    for (const details of this.historyImports.values()) {
      const detail = details.find(
        (candidate) =>
          candidate.import.import_id === importId &&
          candidate.import.identity_id === identityId,
      );
      if (detail) return clone(detail);
    }
    return null;
  }

  startHistoryImport(
    accountId: string,
    input: HistoryImportStartRequest,
    idempotencyKey: string,
  ): HistoryImportDetail | null {
    const account = this.connectedAccounts().find(
      (candidate) =>
        candidate.account_id === accountId &&
        candidate.identity_id === input.identity_id,
    );
    if (!account) return null;
    const prior = this.historyIdempotency.get(`${accountId}:${idempotencyKey}`);
    if (prior) return clone(prior);
    this.historyCounter += 1;
    const now = new Date().toISOString();
    const importId = `import_ui_${this.historyCounter}`;
    const rangeId = `range_ui_${this.historyCounter}`;
    const detail: HistoryImportDetail = {
      import: {
        import_id: importId,
        tenant_id: account.tenant_id,
        account_id: account.account_id,
        connection_id: account.connection_id,
        identity_id: account.identity_id,
        provider: account.provider,
        status: "active",
        availability: "available",
        requested_start_at: input.start_at,
        requested_end_at: input.end_at,
        source_start_at: input.start_at,
        source_end_at: input.end_at,
        max_events: input.max_events,
        event_count: 0,
        completed_range_count: 0,
        total_range_count: 1,
        gap_count: 0,
        attempt_count: 0,
        max_attempts: 3,
        last_error_code: null,
        started_at: now,
        updated_at: now,
        completed_at: null,
      },
      ranges: [
        {
          range_id: rangeId,
          import_id: importId,
          account_id: account.account_id,
          start_at: input.start_at,
          end_at: input.end_at,
          status: "active",
          attempt_count: 0,
          event_count: 0,
          source_cursor: null,
          gap_code: null,
          error_code: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        },
      ],
      capabilities: this.historyCapabilities(accountId),
    };
    const existing = this.historyImports.get(accountId) ?? [];
    this.historyImports.set(accountId, [detail, ...existing]);
    this.historyIdempotency.set(`${accountId}:${idempotencyKey}`, detail);
    return clone(detail);
  }

  advanceHistoryImport(
    importId: string,
    input: HistoryImportAdvanceRequest,
  ): HistoryImportDetail | null {
    for (const [accountId, details] of this.historyImports.entries()) {
      const detail = details.find(
        (candidate) =>
          candidate.import.import_id === importId &&
          candidate.import.identity_id === input.identity_id,
      );
      if (!detail) continue;
      const range =
        (input.range_id
          ? detail.ranges.find(
              (candidate) => candidate.range_id === input.range_id,
            )
          : detail.ranges.find(
              (candidate) =>
                candidate.status === "active" || candidate.status === "pending",
            )) ?? null;
      if (!range || (range.status !== "active" && range.status !== "pending"))
        return clone(detail);
      const now = new Date().toISOString();
      range.status = "completed";
      range.event_count = 4;
      range.updated_at = now;
      range.completed_at = now;
      detail.import.status = "completed";
      detail.import.event_count = detail.ranges.reduce(
        (count, candidate) => count + candidate.event_count,
        0,
      );
      detail.import.completed_range_count = detail.ranges.filter(
        (candidate) => candidate.status === "completed",
      ).length;
      detail.import.gap_count = detail.ranges.filter(
        (candidate) =>
          candidate.status === "gap" ||
          candidate.status === "partial" ||
          candidate.status === "failed",
      ).length;
      detail.import.updated_at = now;
      detail.import.completed_at = now;
      this.historyImports.set(accountId, details);
      return clone(detail);
    }
    return null;
  }

  session(): SessionResponse {
    return {
      tenant: {
        id: "tenant_pilot",
        slug: "pilot",
        display_name: "Pilot tenant",
      },
      principal: {
        id: "principal_pilot",
        type: "operator",
        display_name: "Pilot operator",
      },
      membership: {
        id: "membership_pilot",
        role: "admin",
      },
      identities: this.state.identities.map((identity) => {
        const scopes: OperationScope[] =
          identity.kind === "human"
            ? [
                "conversation.read",
                "connection.read",
                "connection.manage",
                "message.send",
              ]
            : ["conversation.read", "connection.read", "message.send"];
        return {
          identity_id: identity.id,
          kind: identity.kind,
          display_name: identity.display_name,
          scopes,
        };
      }),
    };
  }

  identities(): Identity[] {
    return clone(this.state.identities);
  }

  connections(identityId: string): Connection[] {
    const source = this.state.connection_variants[this.scenario];
    return clone(source.filter((item) => item.identity_id === identityId));
  }

  connectedAccounts(identityId?: string): ConnectedAccount[] {
    return this.identities()
      .flatMap((identity) =>
        identityId !== undefined && identity.id !== identityId
          ? []
          : this.connections(identity.id).map((connection) => ({
              account_id: `account_${connection.id}`,
              tenant_id: connection.tenant_id,
              connection_id: connection.id,
              identity_id: connection.identity_id,
              provider: connection.provider,
              display_label: connection.display_label,
              status: connection.status,
              created_at: "2026-08-29T00:00:00.000Z",
              updated_at:
                connection.last_synced_at ?? "2026-08-29T00:00:00.000Z",
            })),
      )
      .toSorted((left, right) =>
        left.account_id.localeCompare(right.account_id),
      );
  }

  grantTargets(): AccountGrantTarget[] {
    return [
      {
        membership_id: "membership_human",
        principal_id: "principal_human",
        principal_type: "human",
        principal_display_name: "Human",
        role: "owner",
        identity_id: "identity_human",
        identity_kind: "human",
        identity_display_name: "Human",
      },
      {
        membership_id: "membership_agent",
        principal_id: "principal_agent",
        principal_type: "agent",
        principal_display_name: "Agent",
        role: "member",
        identity_id: "identity_agent",
        identity_kind: "agent",
        identity_display_name: "Agent",
      },
    ];
  }

  accountGrants(): AccountGrant[] {
    return clone(this.grants).toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  accountGrant(grantId: string): AccountGrant | null {
    return clone(this.grants.find((grant) => grant.id === grantId) ?? null);
  }

  createAccountGrant(input: AccountGrantMutation): AccountGrant | null {
    const account = this.connectedAccounts().find(
      (candidate) => candidate.account_id === input.account_id,
    );
    const target = this.grantTargets().find(
      (candidate) =>
        candidate.membership_id === input.membership_id &&
        candidate.identity_id === input.identity_id,
    );
    if (!account || !target) return null;
    const existing = this.grants.find(
      (grant) =>
        grant.membership_id === input.membership_id &&
        grant.identity_id === input.identity_id &&
        grant.account_id === input.account_id &&
        grant.operation_scope === input.operation_scope,
    );
    const timestamp = "2026-08-29T00:00:00.000Z";
    if (existing) {
      Object.assign(existing, {
        chat_scope: input.chat_scope,
        chat_ids: [...input.chat_ids].sort(),
        status: "active" as const,
        updated_at: timestamp,
        revoked_at: null,
      });
      return clone(existing);
    }
    this.grantCounter += 1;
    const grant: AccountGrant = {
      id: `grant_sim_${this.grantCounter}`,
      tenant_id: account.tenant_id,
      membership_id: input.membership_id,
      identity_id: input.identity_id,
      identity_display_name: target.identity_display_name,
      account_id: account.account_id,
      connection_id: account.connection_id,
      provider: account.provider,
      account_label: account.display_label,
      operation_scope: input.operation_scope,
      chat_scope: input.chat_scope,
      chat_ids: [...input.chat_ids].sort(),
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: null,
    };
    this.grants.push(grant);
    return clone(grant);
  }

  updateAccountGrant(
    grantId: string,
    input: Pick<AccountGrant, "operation_scope" | "chat_scope" | "chat_ids">,
  ): AccountGrant | null {
    const grant = this.grants.find((candidate) => candidate.id === grantId);
    if (!grant) return null;
    Object.assign(grant, {
      operation_scope: input.operation_scope,
      chat_scope: input.chat_scope,
      chat_ids: [...input.chat_ids].sort(),
      status: "active" as const,
      updated_at: "2026-08-29T00:00:00.000Z",
      revoked_at: null,
    });
    return clone(grant);
  }

  revokeAccountGrant(grantId: string): AccountGrant | null {
    const grant = this.grants.find((candidate) => candidate.id === grantId);
    if (!grant) return null;
    Object.assign(grant, {
      status: "revoked" as const,
      updated_at: "2026-08-29T00:00:00.000Z",
      revoked_at: "2026-08-29T00:00:00.000Z",
    });
    return clone(grant);
  }

  setLinkScenario(scenario: SimulatedLinkScenario) {
    this.linkScenario = scenario;
  }

  setLinkActionDelay(milliseconds: number) {
    this.linkActionDelayMs = milliseconds;
  }

  setLinkActionExpiry(milliseconds: number) {
    this.linkActionExpiryMs = milliseconds;
  }

  linkActionDelay() {
    return this.linkActionDelayMs;
  }

  startLinkSession(
    identityId: string,
    input: LinkSessionStart,
  ): LinkSession | null {
    const identity = this.identities().find((item) => item.id === identityId);
    if (!identity || identity.kind !== "human" || input.provider !== "whatsapp")
      return null;
    const existing = this.linkSessionState;
    if (
      existing &&
      (existing.status === "created" ||
        existing.status === "awaiting_user" ||
        existing.status === "authenticating")
    ) {
      return clone({ ...existing, qr: null });
    }
    this.linkQrCounter += 1;
    const now = Date.now();
    const session: LinkSession = {
      id: `link_sim_${this.linkQrCounter}`,
      identity_id: identityId,
      provider: "whatsapp",
      generation: 1,
      status: "awaiting_user",
      action: "scan_qr",
      expires_at: new Date(now + 10 * 60_000).toISOString(),
      action_expires_at: new Date(now + this.linkActionExpiryMs).toISOString(),
      qr: `WAPPAYLOAD-${this.linkQrCounter}`,
      connection_id: null,
      account_id: null,
      provider_label: null,
      error_code: null,
    };
    this.linkSessionState = session;
    return clone(session);
  }

  linkSession(sessionId: string): LinkSession | null {
    if (this.linkSessionState?.id !== sessionId) return null;
    return clone({ ...this.linkSessionState, qr: null });
  }

  actLinkSession(
    sessionId: string,
    input: LinkSessionActionRequest,
  ): { kind: "ok"; session: LinkSession } | { kind: "missing" | "stale" } {
    const current = this.linkSessionState;
    if (!current || current.id !== sessionId) return { kind: "missing" };
    if (current.generation !== input.generation) return { kind: "stale" };
    if (
      current.status === "connected" ||
      current.status === "expired" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "relink_required" ||
      current.status === "reconciliation_required"
    ) {
      return { kind: "stale" };
    }
    if (input.action === "refresh") {
      this.linkQrCounter += 1;
      const now = Date.now();
      this.linkSessionState = {
        ...current,
        generation: current.generation + 1,
        status: "awaiting_user",
        action: "scan_qr",
        action_expires_at: new Date(
          now + this.linkActionExpiryMs,
        ).toISOString(),
        qr: `WAPPAYLOAD-${this.linkQrCounter}`,
        error_code: null,
      };
      return { kind: "ok", session: clone(this.linkSessionState) };
    }
    const terminal =
      this.linkScenario === "connected"
        ? {
            status: "connected" as const,
            error_code: null,
            connection_id: "connection_linked_whatsapp",
            account_id: "account_linked_whatsapp",
            provider_label: "Linked WhatsApp",
          }
        : this.linkScenario === "duplicate"
          ? {
              status: "relink_required" as const,
              error_code: "relink_required" as const,
              connection_id: null,
              account_id: null,
              provider_label: null,
            }
          : this.linkScenario === "expired"
            ? {
                status: "expired" as const,
                error_code: "expired" as const,
                connection_id: null,
                account_id: null,
                provider_label: null,
              }
            : {
                status: "failed" as const,
                error_code: "provider_error" as const,
                connection_id: null,
                account_id: null,
                provider_label: null,
              };
    this.linkSessionState = {
      ...current,
      ...terminal,
      action: "none",
      action_expires_at: null,
      qr: null,
    };
    return { kind: "ok", session: clone(this.linkSessionState) };
  }

  cancelLinkSession(sessionId: string): LinkSession | null {
    const current = this.linkSessionState;
    if (!current || current.id !== sessionId) return null;
    this.linkSessionState = {
      ...current,
      status: "cancelled",
      action: "none",
      action_expires_at: null,
      qr: null,
      error_code: "cancelled",
    };
    return clone(this.linkSessionState);
  }

  channels(identityId: string): ChannelSummary[] {
    const connections = this.connections(identityId);
    return connections
      .map((connection) => {
        const conversations = this.state.conversations.filter(
          (item) =>
            item.identity_id === identityId &&
            item.connection_id === connection.id,
        );
        return {
          id: connection.id,
          tenant_id: connection.tenant_id,
          identity_id: connection.identity_id,
          provider: connection.provider,
          display_label: connection.display_label,
          status: connection.status,
          capabilities: connection.capabilities,
          unread_count: conversations.reduce(
            (sum, item) => sum + item.unread_count,
            0,
          ),
          last_activity_at:
            conversations.toSorted(compareConversationRecency)[0]
              ?.last_activity_at ?? null,
          sort_position: defaultSortPosition.get(connection.id) ?? 1_000,
          ...(connection.attention_code
            ? { attention_code: connection.attention_code }
            : {}),
        };
      })
      .toSorted(
        (left, right) =>
          left.sort_position - right.sort_position ||
          left.id.localeCompare(right.id),
      );
  }

  conversations(
    identityId: string,
    channelId?: string,
  ): ConversationSummary[] | null {
    if (!this.state.identities.some((item) => item.id === identityId))
      return null;
    if (
      channelId &&
      !this.connections(identityId).some((item) => item.id === channelId)
    )
      return null;
    return clone(
      this.state.conversations
        .filter(
          (item) =>
            item.identity_id === identityId &&
            (!channelId || item.connection_id === channelId),
        )
        .toSorted(compareConversationRecency),
    );
  }

  accountConversations(
    accountId: string,
    identityId: string,
    options: { limit?: number; cursor?: string } = {},
  ) {
    const account = this.connectedAccounts().find(
      (candidate) => candidate.account_id === accountId,
    );
    if (
      !account ||
      !this.state.identities.some((candidate) => candidate.id === identityId)
    )
      return null;
    // The selected grant target can be an agent while the connected account
    // remains owned by a human identity. The UI picker follows the account's
    // resource identity, while the target identity is only the authorization
    // subject.
    const conversations = this.conversations(
      account.identity_id,
      account.connection_id,
    );
    if (!conversations) return null;
    const result = paginateConversations(conversations, options);
    return result.ok ? clone(result.page) : null;
  }

  conversation(
    identityId: string,
    conversationId: string,
  ): ConversationSummary | null {
    return clone(
      this.state.conversations.find(
        (item) =>
          item.id === conversationId &&
          item.identity_id === identityId &&
          this.connections(identityId).some(
            (connection) => connection.id === item.connection_id,
          ),
      ) ?? null,
    );
  }

  messages(
    conversationId: string,
    identityId: string,
    options: { limit?: number; cursor?: string; messageId?: string } = {},
  ): MessagePageResult | null {
    const conversation = this.state.conversations.find(
      (item) => item.id === conversationId && item.identity_id === identityId,
    );
    if (
      !conversation ||
      !this.connections(identityId).some(
        (item) => item.id === conversation.connection_id,
      )
    )
      return null;
    const messages = this.state.messages.filter(
      (item) =>
        item.conversation_id === conversationId &&
        item.identity_id === identityId &&
        (options.messageId === undefined || item.id === options.messageId),
    );
    const result = paginateMessages(messages, options);
    return result.ok ? clone(result.page) : null;
  }

  commands(identityId?: string): Command[] {
    const commands = [
      ...this.state.commands,
      ...Array.from(this.idempotency.values()),
    ];
    return clone(
      identityId === undefined
        ? commands
        : commands.filter((item) => item.identity_id === identityId),
    );
  }

  decideCommand(
    commandId: string,
    decision: "confirm" | "cancel" | OutboundAction,
  ): Command | null {
    const command = [
      ...this.state.commands,
      ...Array.from(this.idempotency.values()),
    ].find((item) => item.id === commandId);
    if (!command) return null;
    Object.assign(command, {
      status:
        decision === "cancel"
          ? "cancelled"
          : decision === "continue"
            ? "delivery_uncertain"
            : decision === "resend"
              ? "accepted"
              : "accepted",
      updated_at: "2026-08-29T00:00:00.000Z",
      confirmation_decision: decision,
      confirmation_actor_principal_id: "principal_pilot",
      confirmation_actor_identity_id: "identity_human",
      confirmation_decided_at: "2026-08-29T00:00:00.000Z",
    });
    return clone(command);
  }

  commandForMessage({
    conversationId,
    identityId,
    body: _body,
    deliveryMode,
    idempotencyKey,
  }: {
    conversationId: string;
    identityId: string;
    body: string;
    deliveryMode: "direct" | "paced";
    idempotencyKey: string;
  }): Command | null {
    const conversation = this.state.conversations.find(
      (item) =>
        item.id === conversationId &&
        item.identity_id === identityId &&
        this.connections(identityId).some(
          (connection) => connection.id === item.connection_id,
        ),
    );
    if (!conversation) return null;

    const key = `${identityId}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) return clone(existing);

    this.commandCounter += 1;
    const timestamp = "2026-08-27T00:15:00.000Z";
    const command: Command = {
      id: `command_${identityId.replace("identity_", "")}_sim_${this.commandCounter}`,
      tenant_id: "tenant_pilot",
      identity_id: identityId as Command["identity_id"],
      conversation_id: conversationId as Command["conversation_id"],
      operation: "message.send",
      delivery_mode: deliveryMode,
      status: "accepted",
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.idempotency.set(key, command);
    return clone(command);
  }

  resetAtTime() {
    return this.resetAt;
  }

  selectedScenario() {
    return this.scenario;
  }

  selectedMessageMode() {
    return this.messageMode;
  }
}

export const simulatedStore = new SimulatedStore();
