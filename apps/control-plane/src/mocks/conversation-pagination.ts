import { z } from "zod";
import {
  CommunicatorIdSchema,
  MessagePageResultSchema,
  TimestampSchema,
  type ConversationPageResult,
  type ConversationSummary,
  type Message,
  type MessagePageResult,
} from "@communicator/contracts";

const CursorSchema = z.object({
  last_activity_at: TimestampSchema,
  conversation_id: CommunicatorIdSchema,
}).strict();

const MessageCursorSchema = z.object({
  occurred_at: TimestampSchema,
  message_id: CommunicatorIdSchema,
}).strict();

export function compareConversationRecency(
  left: ConversationSummary,
  right: ConversationSummary,
) {
  return right.last_activity_at.localeCompare(left.last_activity_at)
    || left.id.localeCompare(right.id);
}

function encodeCursor(item: ConversationSummary) {
  return btoa(JSON.stringify({
    last_activity_at: item.last_activity_at,
    conversation_id: item.id,
  }));
}

function decodeCursor(cursor: string) {
  try {
    return CursorSchema.parse(JSON.parse(atob(cursor)));
  } catch {
    return null;
  }
}

const parseOccurredMilliseconds = (timestamp: string): number => {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("invalid message timestamp");
  }
  return milliseconds;
};

export function paginateConversations(
  source: readonly ConversationSummary[],
  options: { limit?: number; cursor?: string },
): { ok: true; page: ConversationPageResult } | { ok: false } {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false };

  const items = source.toSorted(compareConversationRecency);
  let start = 0;
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (!decoded) return { ok: false };
    const cursorIndex = items.findIndex((item) =>
      item.last_activity_at === decoded.last_activity_at
      && item.id === decoded.conversation_id);
    if (cursorIndex < 0) return { ok: false };
    start = cursorIndex + 1;
  }

  const pageItems = items.slice(start, start + limit);
  const hasMore = start + pageItems.length < items.length;
  return {
    ok: true,
    page: {
      items: pageItems,
      next_cursor: hasMore && pageItems.length > 0
        ? encodeCursor(pageItems.at(-1)!)
        : null,
    },
  };
}

export function paginateMessages(
  source: readonly Message[],
  options: { limit?: number; cursor?: string },
): { ok: true; page: MessagePageResult } | { ok: false } {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false };

  const items = source.toSorted((left, right) => {
    const leftOccurredMs = parseOccurredMilliseconds(left.occurred_at);
    const rightOccurredMs = parseOccurredMilliseconds(right.occurred_at);
    if (leftOccurredMs !== rightOccurredMs) return rightOccurredMs > leftOccurredMs ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
  let start = 0;
  if (options.cursor) {
    let decoded: z.infer<typeof MessageCursorSchema>;
    try {
      decoded = MessageCursorSchema.parse(JSON.parse(atob(options.cursor)));
    } catch {
      return { ok: false };
    }
    const cursorIndex = items.findIndex((item) =>
      item.occurred_at === decoded.occurred_at && item.id === decoded.message_id);
    if (cursorIndex < 0) return { ok: false };
    start = cursorIndex + 1;
  }

  const pageItems = items.slice(start, start + limit);
  const hasMore = start + pageItems.length < items.length;
  return {
    ok: true,
    page: MessagePageResultSchema.parse({
      items: pageItems,
      next_cursor: hasMore && pageItems.length > 0
        ? btoa(JSON.stringify({
          occurred_at: pageItems.at(-1)!.occurred_at,
          message_id: pageItems.at(-1)!.id,
        }))
        : null,
    }),
  };
}
