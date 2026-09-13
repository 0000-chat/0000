import type {
  Command,
  AccountGrant,
  AccountGrantMutation,
  AccountGrantTarget,
  ConnectedAccount,
  ChannelSummary,
  Connection,
  ConversationSummary,
  Identity,
  MessagePageResult,
  SessionResponse,
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
  private resetAt = this.state.fixture_reset_at;

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
    this.resetAt = new Date().toISOString();
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
      identities: this.state.identities.map((identity) => ({
        identity_id: identity.id,
        kind: identity.kind,
        display_name: identity.display_name,
        scopes: [
          "conversation.read",
          "connection.read",
          "message.send",
        ] as const,
      })),
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
    options: { limit?: number; cursor?: string } = {},
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
    const result = paginateMessages(
      this.state.messages.filter(
        (item) =>
          item.conversation_id === conversationId &&
          item.identity_id === identityId,
      ),
      options,
    );
    return result.ok ? clone(result.page) : null;
  }

  commands(identityId: string): Command[] {
    return clone([
      ...this.state.commands.filter((item) => item.identity_id === identityId),
      ...Array.from(this.idempotency.values()).filter(
        (item) => item.identity_id === identityId,
      ),
    ]);
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
