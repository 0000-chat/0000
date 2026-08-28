import { describe, expect, it } from "vitest";
import { paginateConversations } from "./conversation-pagination";

const items = [
  {
    id: "conversation_a",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    connection_id: "connection_human_whatsapp",
    title: "A",
    last_message_preview: "A",
    last_activity_at: "2026-08-28T00:03:00.000Z",
    unread_count: 0,
  },
  {
    id: "conversation_b",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    connection_id: "connection_human_whatsapp",
    title: "B",
    last_message_preview: "B",
    last_activity_at: "2026-08-28T00:02:00.000Z",
    unread_count: 0,
  },
] as const;

describe("paginateConversations", () => {
  it("continues from an opaque cursor without exposing ownership fields", () => {
    const first = paginateConversations(items, { limit: 1 });
    const second = paginateConversations(items, {
      limit: 1,
      ...(first.ok && first.page.next_cursor ? { cursor: first.page.next_cursor } : {}),
    });

    expect(first.ok && first.page.items.map((item) => item.id)).toEqual(["conversation_a"]);
    expect(first.ok && first.page.next_cursor).toEqual(expect.any(String));
    expect(second.ok && second.page.items.map((item) => item.id)).toEqual(["conversation_b"]);
  });

  it("rejects a cursor that is not in the authorized result", () => {
    const page = paginateConversations(items, { limit: 1, cursor: "not-a-valid-cursor" });
    expect(page).toEqual({ ok: false });
  });
});
