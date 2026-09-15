import {
  ChannelSummary,
  ConversationPageResult,
  MessageCreatedDataSchema,
  RealtimeEvent,
} from "@communicator/contracts";
import { compareConversationRecency } from "@/mocks/conversation-pagination";
import type { RealtimeClientEvent } from "@/lib/realtime/client";

export type ActiveScope = {
  tenantId: string;
  identityId: string;
  lastSequence: number;
  channels: ChannelSummary[];
};

export type ConversationCacheUpdate = {
  acceptedSequence: number;
  channelId: string;
  conversationId: string;
  updatePages: (
    pages: ConversationPageResult[] | undefined,
  ) => ConversationPageResult[] | undefined;
  updateChannels: (
    items: ChannelSummary[] | undefined,
  ) => ChannelSummary[] | undefined;
};

export type ConversationInvalidation = {
  identityId: string;
  channelIds: string[];
  conversationIds: string[];
  invalidateIdentity: boolean;
  resetRequired: boolean;
};

export function prepareConversationInvalidation(
  scope: Pick<ActiveScope, "tenantId" | "identityId">,
  event: RealtimeClientEvent,
): ConversationInvalidation | null {
  if (event.type === "connected") return null;
  if (
    event.tenant_id !== scope.tenantId ||
    event.identity_id !== scope.identityId
  )
    return null;

  if (event.type === "reset_required") {
    return {
      identityId: scope.identityId,
      channelIds: [],
      conversationIds: [],
      invalidateIdentity: true,
      resetRequired: true,
    };
  }

  if (event.type === "projection.changes") {
    const changes = event.changes as Array<{
      connection_id?: string;
      conversation_id?: string;
    }>;
    if (
      changes.some((change) => !change.connection_id || !change.conversation_id)
    ) {
      return {
        identityId: scope.identityId,
        channelIds: [],
        conversationIds: [],
        invalidateIdentity: true,
        resetRequired: false,
      };
    }
    return {
      identityId: scope.identityId,
      channelIds: [...new Set(changes.map((change) => change.connection_id!))],
      conversationIds: [
        ...new Set(changes.map((change) => change.conversation_id!)),
      ],
      invalidateIdentity: false,
      resetRequired: false,
    };
  }

  if (
    (event.type === "message.created" || event.type === "connection.updated") &&
    (!event.connection_id || !event.conversation_id)
  ) {
    return {
      identityId: scope.identityId,
      channelIds: [],
      conversationIds: [],
      invalidateIdentity: true,
      resetRequired: false,
    };
  }

  return null;
}

export function prepareConversationEvent(
  scope: ActiveScope,
  event: RealtimeEvent,
): ConversationCacheUpdate | null {
  if (event.sequence <= scope.lastSequence || event.type !== "message.created")
    return null;
  if (
    event.tenant_id !== scope.tenantId ||
    event.identity_id !== scope.identityId
  )
    return null;
  if (!event.connection_id || !event.conversation_id) return null;
  const channel = scope.channels.find(
    (item) =>
      item.id === event.connection_id &&
      item.identity_id === event.identity_id &&
      item.tenant_id === event.tenant_id,
  );
  if (!channel) return null;
  const parsed = MessageCreatedDataSchema.safeParse(event.data);
  if (!parsed.success) return null;

  const data = parsed.data;
  return {
    acceptedSequence: event.sequence,
    channelId: event.connection_id,
    conversationId: event.conversation_id,
    updatePages: (pages) => {
      if (!pages || pages.length !== 1 || pages[0]?.next_cursor !== null)
        return pages;
      const page = pages[0];
      let changed = false;
      const items = page.items.map((item) => {
        if (
          item.id !== event.conversation_id ||
          item.connection_id !== event.connection_id ||
          item.identity_id !== event.identity_id ||
          item.tenant_id !== event.tenant_id
        ) {
          return item;
        }
        changed = true;
        return {
          ...item,
          last_message_preview: data.last_message_preview,
          last_activity_at: data.last_activity_at,
          unread_count: Math.max(0, item.unread_count + data.unread_delta),
        };
      });
      if (!changed) return pages;
      return [{ ...page, items: items.toSorted(compareConversationRecency) }];
    },
    updateChannels: (items) => {
      if (!items) return items;
      let changed = false;
      const updated = items.map((item) => {
        if (
          item.id !== event.connection_id ||
          item.identity_id !== event.identity_id ||
          item.tenant_id !== event.tenant_id
        ) {
          return item;
        }
        changed = true;
        return {
          ...item,
          unread_count: Math.max(0, item.unread_count + data.unread_delta),
          last_activity_at: data.last_activity_at,
        };
      });
      return changed ? updated : items;
    },
  };
}
