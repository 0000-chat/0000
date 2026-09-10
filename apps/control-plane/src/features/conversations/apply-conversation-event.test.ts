import type {
  ChannelSummary,
  ConversationPageResult,
  RealtimeProjectionChangesFrame,
  RealtimeResetRequiredFrame,
  RealtimeEvent,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import {
  prepareConversationEvent,
  prepareConversationInvalidation,
} from "./apply-conversation-event";

const channels: ChannelSummary[] = [
  {
    id: "connection_human_whatsapp",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "whatsapp",
    display_label: "Personal WhatsApp",
    status: "ready",
    capabilities: ["message.send"],
    unread_count: 5,
    last_activity_at: "2026-08-28T00:05:00.000Z",
    sort_position: 10,
  },
  {
    id: "connection_human_telegram",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "telegram",
    display_label: "Telegram",
    status: "ready",
    capabilities: ["message.send"],
    unread_count: 3,
    last_activity_at: "2026-08-28T00:06:00.000Z",
    sort_position: 20,
  },
];

const allPage: ConversationPageResult = {
  items: [
    {
      id: "conversation_human_whatsapp_family",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      connection_id: "connection_human_whatsapp",
      title: "Family",
      last_message_preview: "Dinner at seven",
      last_activity_at: "2026-08-28T00:05:00.000Z",
      unread_count: 4,
    },
    {
      id: "conversation_human_telegram_alex",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      connection_id: "connection_human_telegram",
      title: "Alex Rivera",
      last_message_preview: "I sent the outline",
      last_activity_at: "2026-08-28T00:04:00.000Z",
      unread_count: 3,
    },
  ],
  next_cursor: null,
};

const event: RealtimeEvent = {
  sequence: 7,
  type: "message.created",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  connection_id: "connection_human_telegram",
  conversation_id: "conversation_human_telegram_alex",
  occurred_at: "2026-08-28T00:07:00.000Z",
  data: {
    last_message_preview: "New reply",
    last_activity_at: "2026-08-28T00:07:00.000Z",
    unread_delta: 1,
  },
};

const scope = {
  tenantId: "tenant_pilot",
  identityId: "identity_human",
  lastSequence: 6,
  channels,
};

const projectionChanges: RealtimeProjectionChangesFrame = {
  schema_version: 1,
  type: "projection.changes",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  generation: 1,
  from_sequence: 7,
  to_sequence: 9,
  changes: [
    {
      sequence: 7,
      event_type: "message.created",
      connection_id: "connection_human_telegram",
      conversation_id: "conversation_human_telegram_alex",
      occurred_at: "2026-08-28T00:07:00.000Z",
    },
    {
      sequence: 8,
      event_type: "message.created",
      connection_id: "connection_human_whatsapp",
      conversation_id: "conversation_human_whatsapp_family",
      occurred_at: "2026-08-28T00:08:00.000Z",
    },
  ],
};

describe("prepareConversationEvent", () => {
  it("updates matching All and channel pages and preserves channel order", () => {
    const matchingPage: ConversationPageResult = {
      ...allPage,
      items: [
        ...allPage.items,
        {
          ...allPage.items[1]!,
          id: "conversation_human_telegram_alex",
        },
      ],
    };
    const update = prepareConversationEvent(scope, event);
    expect(update).not.toBeNull();
    if (!update) return;

    const allUpdated = update.updatePages([matchingPage]);
    const telegramUpdated = update.updatePages([matchingPage]);
    expect(allUpdated?.[0]?.items[0]?.id).toBe("conversation_human_telegram_alex");
    expect(allUpdated?.[0]?.items[0]).toMatchObject({
      last_message_preview: "New reply",
      last_activity_at: "2026-08-28T00:07:00.000Z",
      unread_count: 4,
    });
    expect(telegramUpdated?.[0]?.items[0]?.id).toBe("conversation_human_telegram_alex");

    const channelUpdated = update.updateChannels(channels);
    expect(channelUpdated?.map((channel) => channel.id)).toEqual(channels.map((channel) => channel.id));
    expect(channelUpdated?.[1]).toMatchObject({
      unread_count: 4,
      last_activity_at: "2026-08-28T00:07:00.000Z",
    });
  });

  it.each([
    ["wrong tenant", { tenant_id: "tenant_other" }],
    ["wrong identity", { identity_id: "identity_agent" }],
    ["wrong connection ownership", { connection_id: "connection_agent_whatsapp" }],
    ["repeated sequence", { sequence: 6 }],
  ])("rejects %s", (_label, changes) => {
    const changed = { ...event, ...changes } as RealtimeEvent;
    expect(prepareConversationEvent(scope, changed)).toBeNull();
  });

  it("rejects lower sequences and malformed message data", () => {
    expect(prepareConversationEvent(scope, { ...event, sequence: 5 })).toBeNull();
    expect(prepareConversationEvent(scope, {
      ...event,
      data: { last_message_preview: "missing fields" },
    } as RealtimeEvent)).toBeNull();
  });

  it("leaves paginated caches unchanged for unsafe local rewrites", () => {
    const pages = [allPage, { ...allPage, next_cursor: "next" }];
    const update = prepareConversationEvent(scope, event);
    expect(update?.updatePages(pages)).toBe(pages);
    expect(update?.updatePages([{ ...allPage, next_cursor: "next" }])).toEqual([
      { ...allPage, next_cursor: "next" },
    ]);
  });
});

describe("prepareConversationInvalidation", () => {
  it("returns every changed channel and conversation for one matching identity", () => {
    expect(prepareConversationInvalidation(scope, projectionChanges)).toEqual({
      identityId: "identity_human",
      channelIds: ["connection_human_telegram", "connection_human_whatsapp"],
      conversationIds: [
        "conversation_human_telegram_alex",
        "conversation_human_whatsapp_family",
      ],
      invalidateIdentity: false,
      resetRequired: false,
    });
  });

  it("uses a bounded identity fallback when a projection change lacks an identifier", () => {
    expect(prepareConversationInvalidation(scope, {
      ...projectionChanges,
      changes: [{
        ...projectionChanges.changes[0]!,
        conversation_id: undefined,
      }],
    } as unknown as RealtimeProjectionChangesFrame)).toEqual({
      identityId: "identity_human",
      channelIds: [],
      conversationIds: [],
      invalidateIdentity: true,
      resetRequired: false,
    });
  });

  it("marks every query for the identity after reset_required", () => {
    const reset: RealtimeResetRequiredFrame = {
      schema_version: 1,
      type: "reset_required",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      generation: 2,
      latest_sequence: 9,
      reason: "history_unavailable",
    };
    expect(prepareConversationInvalidation(scope, reset)).toEqual({
      identityId: "identity_human",
      channelIds: [],
      conversationIds: [],
      invalidateIdentity: true,
      resetRequired: true,
    });
  });

  it("ignores frames outside the active tenant and identity", () => {
    expect(prepareConversationInvalidation(scope, {
      ...projectionChanges,
      tenant_id: "tenant_other",
    })).toBeNull();
    expect(prepareConversationInvalidation(scope, {
      ...projectionChanges,
      identity_id: "identity_agent",
    })).toBeNull();
  });
});
