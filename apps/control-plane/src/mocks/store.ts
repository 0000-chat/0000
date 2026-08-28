import type {
  Command,
  ChannelSummary,
  Connection,
  ConversationSummary,
  Identity,
  Message,
} from "@communicator/contracts";
import { pilotScenario, PilotScenarioSchema } from "@communicator/test-fixtures";
import { compareConversationRecency } from "./conversation-pagination";

export type SimulatedScenario = "ready" | "attention_required";

export type MeResponse = {
  tenant_id: "tenant_pilot";
  principal_id: "principal_pilot";
  display_name: "Pilot operator";
  authorized_identity_ids: ["identity_human", "identity_agent"];
};

const defaultSortPosition = new Map([
  ["connection_human_whatsapp", 10],
  ["connection_human_telegram", 20],
  ["connection_human_messenger", 30],
  ["connection_agent_whatsapp", 10],
]);

const notFound = {
  error: {
    code: "not_found" as const,
    message: "The requested resource is not available.",
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class SimulatedStore {
  private state = clone(PilotScenarioSchema.parse(pilotScenario));
  private scenario: SimulatedScenario = "ready";
  private idempotency = new Map<string, Command>();
  private commandCounter = 0;
  private resetAt = this.state.fixture_reset_at;

  reset(scenario: SimulatedScenario = "ready") {
    this.state = clone(PilotScenarioSchema.parse(pilotScenario));
    this.scenario = scenario;
    this.idempotency.clear();
    this.commandCounter = 0;
    this.resetAt = new Date().toISOString();
  }

  me(): MeResponse {
    return {
      tenant_id: "tenant_pilot",
      principal_id: "principal_pilot",
      display_name: "Pilot operator",
      authorized_identity_ids: ["identity_human", "identity_agent"],
    };
  }

  identities(): Identity[] {
    return clone(this.state.identities);
  }

  connections(identityId: string): Connection[] {
    const source = this.state.connection_variants[this.scenario];
    return clone(source.filter((item) => item.identity_id === identityId));
  }

  channels(identityId: string): ChannelSummary[] {
    const connections = this.connections(identityId);
    return connections
      .map((connection) => {
        const conversations = this.state.conversations.filter(
          (item) => item.identity_id === identityId && item.connection_id === connection.id,
        );
        return {
          id: connection.id,
          tenant_id: connection.tenant_id,
          identity_id: connection.identity_id,
          provider: connection.provider,
          display_label: connection.display_label,
          status: connection.status,
          capabilities: connection.capabilities,
          unread_count: conversations.reduce((sum, item) => sum + item.unread_count, 0),
          last_activity_at: conversations.toSorted(compareConversationRecency)[0]?.last_activity_at ?? null,
          sort_position: defaultSortPosition.get(connection.id) ?? 1_000,
          ...(connection.attention_code ? { attention_code: connection.attention_code } : {}),
        };
      })
      .toSorted((left, right) => left.sort_position - right.sort_position || left.id.localeCompare(right.id));
  }

  conversations(identityId: string, channelId?: string): ConversationSummary[] | null {
    if (!this.state.identities.some((item) => item.id === identityId)) return null;
    if (channelId && !this.connections(identityId).some((item) => item.id === channelId)) return null;
    return clone(this.state.conversations
      .filter((item) => item.identity_id === identityId && (!channelId || item.connection_id === channelId))
      .toSorted(compareConversationRecency));
  }

  conversation(identityId: string, conversationId: string): ConversationSummary | null {
    return clone(this.state.conversations.find(
      (item) => item.id === conversationId && item.identity_id === identityId
        && this.connections(identityId).some((connection) => connection.id === item.connection_id),
    ) ?? null);
  }

  messages(conversationId: string, identityId: string): Message[] | null {
    const conversation = this.state.conversations.find(
      (item) => item.id === conversationId && item.identity_id === identityId,
    );
    if (!conversation || !this.connections(identityId).some((item) => item.id === conversation.connection_id)) return null;
    return clone(this.state.messages.filter(
      (item) => item.conversation_id === conversationId && item.identity_id === identityId,
    ));
  }

  commands(identityId: string): Command[] {
    return clone([
      ...this.state.commands.filter((item) => item.identity_id === identityId),
      ...Array.from(this.idempotency.values()).filter((item) => item.identity_id === identityId),
    ]);
  }

  commandForMessage({
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
  }): Command | null {
    const conversation = this.state.conversations.find(
      (item) => item.id === conversationId && item.identity_id === identityId
        && this.connections(identityId).some((connection) => connection.id === item.connection_id),
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
}

export const simulatedStore = new SimulatedStore();
export { notFound };
