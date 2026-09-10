import { describe, expect, it } from "vitest";
import type { MessagePageResult } from "@communicator/contracts";
import { chronologicalMessages } from "./message-timeline";

const message = (id: string, occurredAt: string) => ({
  id,
  tenant_id: "tenant_pilot" as const,
  identity_id: "identity_human" as const,
  connection_id: "connection_human_whatsapp" as const,
  conversation_id: "conversation_human_whatsapp_family" as const,
  direction: "inbound" as const,
  sender_label: "Family",
  body: id,
  occurred_at: occurredAt,
  delivery_status: "delivered" as const,
  attachment_count: 0,
});

describe("chronologicalMessages", () => {
  it("reverses copied flattened newest-first pages without mutating cached arrays", () => {
    const newestPage: MessagePageResult = {
      items: [
        message("message_newest", "2026-08-28T00:03:00.000Z"),
        message("message_middle", "2026-08-28T00:02:00.000Z"),
      ],
      next_cursor: "opaque-older",
    };
    const olderPage: MessagePageResult = {
      items: [message("message_oldest", "2026-08-28T00:01:00.000Z")],
      next_cursor: null,
    };

    expect(chronologicalMessages([newestPage, olderPage]).map((item) => item.id)).toEqual([
      "message_oldest",
      "message_middle",
      "message_newest",
    ]);
    expect(newestPage.items.map((item) => item.id)).toEqual([
      "message_newest",
      "message_middle",
    ]);
    expect(olderPage.items.map((item) => item.id)).toEqual(["message_oldest"]);
  });

  it("deduplicates a repeated page-boundary message", () => {
    const newestPage: MessagePageResult = {
      items: [
        message("message_newest", "2026-08-28T00:03:00.000Z"),
        message("message_boundary", "2026-08-28T00:02:00.000Z"),
      ],
      next_cursor: "opaque-older",
    };
    const olderPage: MessagePageResult = {
      items: [
        message("message_boundary", "2026-08-28T00:02:00.000Z"),
        message("message_oldest", "2026-08-28T00:01:00.000Z"),
      ],
      next_cursor: null,
    };

    expect(chronologicalMessages([newestPage, olderPage]).map((item) => item.id)).toEqual([
      "message_oldest",
      "message_boundary",
      "message_newest",
    ]);
  });
});
