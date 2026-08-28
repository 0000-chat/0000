import { z } from "zod";
import {
  CommunicatorIdSchema,
  TimestampSchema,
  type ConversationPageResult,
  type ConversationSummary,
} from "@communicator/contracts";

const CursorSchema = z.object({
  last_activity_at: TimestampSchema,
  conversation_id: CommunicatorIdSchema,
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

export function paginateConversations(
  source: ConversationSummary[],
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
