import { z } from "zod";
import {
  CommandSchema,
  ConnectionSchema,
  ConversationSummarySchema,
  IdentitySchema,
  MessageSchema,
  TimestampSchema,
  type Connection,
  type ConversationSummary,
  type Message,
} from "@communicator/contracts";

const tenantId = "tenant_pilot" as const;
const humanIdentityId = "identity_human" as const;
const agentIdentityId = "identity_agent" as const;
const agentConnectionId = "connection_agent_whatsapp" as const;

const identities = [
  {
    id: humanIdentityId,
    tenant_id: tenantId,
    kind: "human" as const,
    display_name: "Human",
  },
  {
    id: agentIdentityId,
    tenant_id: tenantId,
    kind: "agent" as const,
    display_name: "Agent",
  },
];

const humanConnections: Connection[] = [
  {
    id: "connection_human_whatsapp",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "whatsapp" as const,
    display_label: "Personal WhatsApp",
    status: "ready" as const,
    capabilities: ["message.send", "reaction.add", "receipt.read", "typing.send"],
    last_synced_at: "2026-08-28T00:06:00.000Z",
  },
  {
    id: "connection_human_telegram",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "telegram",
    display_label: "Telegram",
    status: "ready",
    capabilities: ["message.send", "reaction.add", "receipt.read", "typing.send"],
    last_synced_at: "2026-08-28T00:05:00.000Z",
  },
  {
    id: "connection_human_messenger",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "messenger",
    display_label: "Messenger",
    status: "ready",
    capabilities: ["message.send", "reaction.add", "typing.send"],
    last_synced_at: "2026-08-28T00:04:00.000Z",
  },
];

const agentConnection: Connection = {
  id: agentConnectionId,
  tenant_id: tenantId,
  identity_id: agentIdentityId,
  provider: "whatsapp",
  display_label: "Agent WhatsApp",
  status: "ready",
  capabilities: ["message.send", "receipt.read"],
  last_synced_at: "2026-08-27T00:14:00.000Z",
};

const readyConnections: Connection[] = [
  ...humanConnections,
  agentConnection,
];

const attentionConnections: Connection[] = [
  humanConnections[0]!,
  humanConnections[1]!,
  {
    ...humanConnections[2]!,
    status: "attention_required",
    attention_code: "reauth_required",
  },
  agentConnection,
];

const humanConversations: ConversationSummary[] = [
  {
    id: "conversation_human_telegram_alex",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: "connection_human_telegram",
    title: "Alex Rivera",
    last_message_preview: "I sent the outline",
    last_activity_at: "2026-08-28T00:06:00.000Z",
    unread_count: 3,
  },
  {
    id: "conversation_human_whatsapp_family",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: "connection_human_whatsapp",
    title: "Family",
    last_message_preview: "Dinner at seven",
    last_activity_at: "2026-08-28T00:05:00.000Z",
    unread_count: 4,
  },
  {
    id: "conversation_human_messenger_studio",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: "connection_human_messenger",
    title: "Studio Team",
    last_message_preview: "The render is ready",
    last_activity_at: "2026-08-28T00:04:00.000Z",
    unread_count: 2,
  },
  {
    id: "conversation_human_whatsapp_alex",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: "connection_human_whatsapp",
    title: "Alex Rivera",
    last_message_preview: "See you tomorrow",
    last_activity_at: "2026-08-28T00:03:00.000Z",
    unread_count: 1,
  },
  {
    id: "conversation_human_telegram_product",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: "connection_human_telegram",
    title: "Product Group",
    last_message_preview: "Ship the pilot",
    last_activity_at: "2026-08-28T00:02:00.000Z",
    unread_count: 0,
  },
  {
    id: "conversation_human_messenger_archive",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: "connection_human_messenger",
    title: "Old Client",
    last_message_preview: "Thanks again",
    last_activity_at: "2026-08-28T00:01:00.000Z",
    unread_count: 0,
  },
];

const conversations: ConversationSummary[] = [
  ...humanConversations,
  {
    id: "conversation_agent_one",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    title: "Agent Test Chat",
    last_message_preview: "The simulated Agent is ready.",
    last_activity_at: "2026-08-27T00:11:00.000Z",
    unread_count: 2,
  },
];

function messagesFor(conversation: ConversationSummary): Message[] {
  const common = {
    tenant_id: conversation.tenant_id,
    identity_id: conversation.identity_id,
    connection_id: conversation.connection_id,
    conversation_id: conversation.id,
    occurred_at: conversation.last_activity_at,
    delivery_status: "delivered" as const,
    attachment_count: 0,
  };
  return [
    {
      ...common,
      id: `message_${conversation.id}_inbound`,
      direction: "inbound" as const,
      sender_label: conversation.title,
      body: conversation.last_message_preview,
    },
    {
      ...common,
      id: `message_${conversation.id}_outbound`,
      direction: "outbound" as const,
      sender_label: "Human",
      body: "Thanks — noted for the simulated pilot.",
      delivery_status: "sent" as const,
    },
  ];
}

const humanMessages = humanConversations.flatMap(messagesFor);

const agentMessages: Message[] = [
  {
    id: "message_agent_one_inbound",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    conversation_id: "conversation_agent_one",
    direction: "inbound",
    sender_label: "Agent Test Chat",
    body: "A simulated Agent conversation is available.",
    occurred_at: "2026-08-27T00:05:00.000Z",
    delivery_status: "delivered",
    attachment_count: 0,
  },
  {
    id: "message_agent_one_outbound",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    conversation_id: "conversation_agent_one",
    direction: "outbound",
    sender_label: "Agent",
    body: "The simulated Agent is ready.",
    occurred_at: "2026-08-27T00:07:00.000Z",
    delivery_status: "delivered",
    attachment_count: 0,
  },
  {
    id: "message_agent_one_inbound_two",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    conversation_id: "conversation_agent_one",
    direction: "inbound",
    sender_label: "Agent Test Chat",
    body: "This fixture contains no live provider data.",
    occurred_at: "2026-08-27T00:11:00.000Z",
    delivery_status: "delivered",
    attachment_count: 0,
  },
];

const messages: Message[] = [
  ...humanMessages,
  ...agentMessages,
];

const commands = [
  {
    id: "command_human_direct",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    conversation_id: "conversation_human_whatsapp_alex",
    operation: "message.send" as const,
    delivery_mode: "direct" as const,
    status: "delivered" as const,
    created_at: "2026-08-27T00:06:00.000Z",
    updated_at: "2026-08-27T00:07:00.000Z",
  },
  {
    id: "command_agent_paced",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    conversation_id: "conversation_agent_one",
    operation: "message.send" as const,
    delivery_mode: "paced" as const,
    status: "scheduled" as const,
    created_at: "2026-08-27T00:11:30.000Z",
    updated_at: "2026-08-27T00:11:30.000Z",
  },
];

export const PilotScenarioSchema = z.object({
  tenant_id: z.literal(tenantId),
  identities: z.array(IdentitySchema),
  connections: z.array(ConnectionSchema),
  connection_variants: z.object({
    ready: z.array(ConnectionSchema),
    attention_required: z.array(ConnectionSchema),
  }).strict(),
  conversations: z.array(ConversationSummarySchema),
  messages: z.array(MessageSchema),
  commands: z.array(CommandSchema),
  fixture_reset_at: TimestampSchema,
}).strict();

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value as Readonly<T>;
};

export const pilotScenario = deepFreeze({
  tenant_id: tenantId,
  identities,
  connections: readyConnections,
  connection_variants: {
    ready: readyConnections,
    attention_required: attentionConnections,
  },
  conversations,
  messages,
  commands,
  fixture_reset_at: "2026-08-27T00:00:00.000Z",
});

export type PilotScenario = z.infer<typeof PilotScenarioSchema>;
