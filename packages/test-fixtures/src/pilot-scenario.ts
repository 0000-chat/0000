import { z } from "zod";
import {
  CommandSchema,
  ConnectionSchema,
  ConversationSummarySchema,
  IdentitySchema,
  MessageSchema,
  TimestampSchema,
} from "@communicator/contracts";

const tenantId = "tenant_pilot" as const;
const humanIdentityId = "identity_human" as const;
const agentIdentityId = "identity_agent" as const;
const humanConnectionId = "connection_human_whatsapp" as const;
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

const readyConnections = [
  {
    id: humanConnectionId,
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "whatsapp" as const,
    display_label: "Personal WhatsApp",
    status: "ready" as const,
    capabilities: [
      "message.send" as const,
      "message.edit" as const,
      "reaction.add" as const,
      "receipt.read" as const,
      "typing.send" as const,
      "attachment.send" as const,
    ],
    last_synced_at: "2026-08-27T00:12:00.000Z",
  },
  {
    id: agentConnectionId,
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    provider: "whatsapp" as const,
    display_label: "Agent WhatsApp",
    status: "ready" as const,
    capabilities: ["message.send" as const, "receipt.read" as const],
    last_synced_at: "2026-08-27T00:14:00.000Z",
  },
];

const attentionConnections = [
  {
    ...readyConnections[0],
    status: "attention_required" as const,
    attention_code: "provider_attention_required",
  },
  readyConnections[1],
];

const conversations = [
  {
    id: "conversation_human_one",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    title: "Example Contact",
    last_message_preview: "Thanks, that works for me.",
    last_activity_at: "2026-08-27T00:10:00.000Z",
    unread_count: 1,
  },
  {
    id: "conversation_human_two",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    title: "Example Customer",
    last_message_preview: "I will check and reply shortly.",
    last_activity_at: "2026-08-27T00:08:00.000Z",
    unread_count: 0,
  },
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

const messages = [
  {
    id: "message_human_one_inbound",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    conversation_id: "conversation_human_one",
    direction: "inbound" as const,
    sender_label: "Example Contact",
    body: "Hello from the example contact.",
    occurred_at: "2026-08-27T00:04:00.000Z",
    delivery_status: "delivered" as const,
    attachment_count: 0,
  },
  {
    id: "message_human_one_outbound",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    conversation_id: "conversation_human_one",
    direction: "outbound" as const,
    sender_label: "Human",
    body: "Hello from the simulated Human identity.",
    occurred_at: "2026-08-27T00:06:00.000Z",
    delivery_status: "delivered" as const,
    attachment_count: 0,
  },
  {
    id: "message_human_one_inbound_two",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    conversation_id: "conversation_human_one",
    direction: "inbound" as const,
    sender_label: "Example Contact",
    body: "Thanks, that works for me.",
    occurred_at: "2026-08-27T00:10:00.000Z",
    delivery_status: "delivered" as const,
    attachment_count: 1,
  },
  {
    id: "message_human_two_inbound",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    conversation_id: "conversation_human_two",
    direction: "inbound" as const,
    sender_label: "Example Customer",
    body: "Could you confirm the example request?",
    occurred_at: "2026-08-27T00:03:00.000Z",
    delivery_status: "read" as const,
    attachment_count: 0,
  },
  {
    id: "message_human_two_outbound",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    conversation_id: "conversation_human_two",
    direction: "outbound" as const,
    sender_label: "Human",
    body: "I will check and reply shortly.",
    occurred_at: "2026-08-27T00:08:00.000Z",
    delivery_status: "sent" as const,
    attachment_count: 0,
  },
  {
    id: "message_human_two_inbound_two",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id: humanConnectionId,
    conversation_id: "conversation_human_two",
    direction: "inbound" as const,
    sender_label: "Example Customer",
    body: "No rush; thank you.",
    occurred_at: "2026-08-27T00:09:00.000Z",
    delivery_status: "read" as const,
    attachment_count: 0,
  },
  {
    id: "message_agent_one_inbound",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    conversation_id: "conversation_agent_one",
    direction: "inbound" as const,
    sender_label: "Agent Test Chat",
    body: "A simulated Agent conversation is available.",
    occurred_at: "2026-08-27T00:05:00.000Z",
    delivery_status: "delivered" as const,
    attachment_count: 0,
  },
  {
    id: "message_agent_one_outbound",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    conversation_id: "conversation_agent_one",
    direction: "outbound" as const,
    sender_label: "Agent",
    body: "The simulated Agent is ready.",
    occurred_at: "2026-08-27T00:07:00.000Z",
    delivery_status: "delivered" as const,
    attachment_count: 0,
  },
  {
    id: "message_agent_one_inbound_two",
    tenant_id: tenantId,
    identity_id: agentIdentityId,
    connection_id: agentConnectionId,
    conversation_id: "conversation_agent_one",
    direction: "inbound" as const,
    sender_label: "Agent Test Chat",
    body: "This fixture contains no live provider data.",
    occurred_at: "2026-08-27T00:11:00.000Z",
    delivery_status: "delivered" as const,
    attachment_count: 0,
  },
];

const commands = [
  {
    id: "command_human_direct",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    conversation_id: "conversation_human_one",
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
