import { describe, expect, it } from "vitest";
import type { Message } from "@communicator/contracts";
import {
  paginateConversations,
  paginateMessages,
} from "./conversation-pagination";

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
      ...(first.ok && first.page.next_cursor
        ? { cursor: first.page.next_cursor }
        : {}),
    });

    expect(first.ok && first.page.items.map((item) => item.id)).toEqual([
      "conversation_a",
    ]);
    expect(first.ok && first.page.next_cursor).toEqual(expect.any(String));
    expect(second.ok && second.page.items.map((item) => item.id)).toEqual([
      "conversation_b",
    ]);
  });

  it("rejects a cursor that is not in the authorized result", () => {
    const page = paginateConversations(items, {
      limit: 1,
      cursor: "not-a-valid-cursor",
    });
    expect(page).toEqual({ ok: false });
  });
});

describe("paginateMessages", () => {
  const messages: Message[] = [
    {
      id: "message_oldest",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      connection_id: "connection_human_whatsapp",
      conversation_id: "conversation_human_whatsapp_family",
      direction: "inbound" as const,
      sender_label: "Family",
      body: "Oldest",
      occurred_at: "2026-08-28T00:01:00.000Z",
      delivery_status: "delivered" as const,
      attachment_count: 0,
      attachments: [],
    },
    {
      id: "message_newest",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      connection_id: "connection_human_whatsapp",
      conversation_id: "conversation_human_whatsapp_family",
      direction: "outbound" as const,
      sender_label: "Human",
      body: "Newest",
      occurred_at: "2026-08-28T00:03:00.000Z",
      delivery_status: "sent" as const,
      attachment_count: 0,
      attachments: [],
    },
  ];

  it("returns newest-first pages and resumes from an opaque message cursor", () => {
    const first = paginateMessages(messages, { limit: 1 });
    expect(first.ok && first.page.items.map((item) => item.id)).toEqual([
      "message_newest",
    ]);
    expect(first.ok && first.page.next_cursor).toEqual(expect.any(String));

    const second = paginateMessages(messages, {
      limit: 1,
      ...(first.ok && first.page.next_cursor
        ? { cursor: first.page.next_cursor }
        : {}),
    });
    expect(second.ok && second.page.items.map((item) => item.id)).toEqual([
      "message_oldest",
    ]);
    expect(second.ok && second.page.next_cursor).toBeNull();
  });

  it("orders by epoch milliseconds, uses the id tie-break, and resumes from its opaque cursor", () => {
    const baseMessage = messages.at(0);
    if (baseMessage === undefined) throw new Error("fixture message missing");
    const offsetMessages = [
      {
        ...baseMessage,
        id: "message_tie_b",
        occurred_at: "2026-08-28T03:00:00.000+02:00",
      },
      {
        ...baseMessage,
        id: "message_tie_a",
        occurred_at: "2026-08-28T01:00:00.000Z",
      },
      {
        ...baseMessage,
        id: "message_newest",
        occurred_at: "2026-08-28T01:30:00.000Z",
      },
    ];
    const first = paginateMessages(offsetMessages, { limit: 2 });

    expect(first.ok && first.page.items.map((item) => item.id)).toEqual([
      "message_newest",
      "message_tie_a",
    ]);
    expect(first.ok && first.page.next_cursor).toEqual(expect.any(String));

    const second = paginateMessages(offsetMessages, {
      limit: 2,
      ...(first.ok && first.page.next_cursor
        ? { cursor: first.page.next_cursor }
        : {}),
    });
    expect(second.ok && second.page.items.map((item) => item.id)).toEqual([
      "message_tie_b",
    ]);
    expect(second.ok && second.page.next_cursor).toBeNull();
  });
});
