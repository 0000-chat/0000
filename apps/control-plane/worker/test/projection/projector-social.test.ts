import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  attachmentObserved,
  bindingFor,
  conversationUpdated,
  created,
  deleted,
  expectCode,
  initialize,
  input,
  reactionAdded,
  reactionRemoved,
  receipt,
  rows,
  typingStarted,
  typingStopped,
} from "./projector-test-support";

describe("tenant projection social", () => {
  it("recomputes attachment counts for every active message and its conversation", async () => {
    const tenant = "tenant_projector_attachment_counts";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          created("attachment_message_one", {
            tenant_id: tenant,
            payload: {
              message_id: "message_attachment_one",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Alice",
              body: "one",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: false,
            },
          }),
          created("attachment_message_two", {
            tenant_id: tenant,
            payload: {
              message_id: "message_attachment_two",
              direction: "outbound",
              sender_participant_id: null,
              sender_label: "Bob",
              body: "two",
              reply_to_message_id: null,
              delivery_status: "sent",
              unread: false,
            },
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (const [id, messageId] of [
        ["attachment_one_a", "message_attachment_one"],
        ["attachment_one_b", "message_attachment_one"],
        ["attachment_two_a", "message_attachment_two"],
      ]) {
        sql.exec(
          "INSERT INTO attachments (id, message_id, identity_id, account_id, connection_id, conversation_id, platform, file_name, mime_type, size_bytes, sha256, r2_key, observed_at, last_observed_ms, last_event_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
          id,
          messageId,
          "identity_a",
          "account_a",
          "connection_a",
          "conversation_a",
          "whatsapp",
          `${id}.txt`,
          "text/plain",
          12,
          null,
          null,
          "2026-09-07T01:00:00.000Z",
          Date.parse("2026-09-07T01:00:01.000Z"),
          `${id}_event`,
        );
      }
    });
    await stub.applyBatch(
      input(
        [
          conversationUpdated(
            "attachment_recompute",
            {
              title: "Attachments",
              archived: false,
              muted: false,
            },
            { tenant_id: tenant },
          ),
        ],
        { tenant_id: tenant },
      ),
    );

    await expect(
      rows<{ id: string; attachment_count: number }>(
        stub,
        "SELECT id, attachment_count FROM messages ORDER BY id",
      ),
    ).resolves.toEqual([
      { id: "message_attachment_one", attachment_count: 2 },
      { id: "message_attachment_two", attachment_count: 1 },
    ]);
    await expect(
      rows<{ attachment_count: number }>(
        stub,
        "SELECT attachment_count FROM conversations WHERE id = ?",
        "conversation_a",
      ),
    ).resolves.toEqual([{ attachment_count: 3 }]);
  });

  it("projects all Stage B families and reconciles pending rows when the message arrives", async () => {
    const tenant = "tenant_projector_stage_b_families";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          reactionRemoved(
            "stage_b_reaction_removed",
            "reaction_stage_b",
            "message_stage_b",
            {
              tenant_id: tenant,
              conversation_id: "conversation_stage_b",
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:01.000Z",
            },
          ),
          receipt(
            "stage_b_read",
            "read",
            "message_stage_b",
            "participant_read",
            true,
            {
              tenant_id: tenant,
              conversation_id: "conversation_stage_b",
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:02.000Z",
            },
          ),
          receipt(
            "stage_b_delivered",
            "delivered",
            "message_stage_b",
            "participant_delivery",
            true,
            {
              tenant_id: tenant,
              conversation_id: "conversation_stage_b",
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:03.000Z",
            },
          ),
          typingStarted(
            "stage_b_typing_started",
            "participant_typing",
            "2026-09-07T00:00:00.000Z",
            {
              tenant_id: tenant,
              conversation_id: "conversation_stage_b",
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:04.000Z",
            },
          ),
          typingStopped("stage_b_typing_stopped", "participant_typing", {
            tenant_id: tenant,
            conversation_id: "conversation_stage_b",
            occurred_at: "2026-09-07T02:00:00.000Z",
            observed_at: "2026-09-07T02:00:05.000Z",
          }),
          attachmentObserved(
            "stage_b_attachment",
            "attachment_stage_b",
            "message_stage_b",
            {
              tenant_id: tenant,
              conversation_id: "conversation_stage_b",
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:06.000Z",
            },
          ),
        ],
        {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
        },
      ),
    );

    await stub.applyBatch(
      input(
        [
          created("stage_b_message", {
            tenant_id: tenant,
            conversation_id: "conversation_stage_b",
            observed_at: "2026-09-07T01:00:01.000Z",
            payload: {
              message_id: "message_stage_b",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Alice",
              body: "hello stage b",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: true,
            },
          }),
        ],
        {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
        },
      ),
    );

    await expect(
      rows(stub, "SELECT participant_id, emoji, removed_at FROM reactions"),
    ).resolves.toEqual([
      {
        participant_id: null,
        emoji: null,
        removed_at: "2026-09-07T02:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT receipt_type, participant_id, local_identity FROM receipts ORDER BY receipt_type",
      ),
    ).resolves.toEqual([
      {
        receipt_type: "delivered",
        participant_id: "participant_delivery",
        local_identity: 1,
      },
      {
        receipt_type: "read",
        participant_id: "participant_read",
        local_identity: 1,
      },
    ]);
    await expect(
      rows(stub, "SELECT is_typing, expires_at FROM typing_states"),
    ).resolves.toEqual([
      {
        is_typing: 0,
        expires_at: null,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, sha256, r2_key FROM attachments",
      ),
    ).resolves.toEqual([
      {
        file_name: "photo.jpg",
        mime_type: "image/jpeg",
        size_bytes: 42,
        sha256: null,
        r2_key: null,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT unread, attachment_count, local_read_at FROM messages WHERE id = ?",
        "message_stage_b",
      ),
    ).resolves.toEqual([
      {
        unread: 0,
        attachment_count: 1,
        local_read_at: "2026-09-07T02:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT unread_count, attachment_count FROM conversations WHERE id = ?",
        "conversation_stage_b",
      ),
    ).resolves.toEqual([
      {
        unread_count: 0,
        attachment_count: 1,
      },
    ]);
  });

  it("keeps reaction removal-before-add and exact observed UTF-8 LWW ties", async () => {
    const tenant = "tenant_projector_stage_b_reaction_lww";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          reactionRemoved(
            "reaction_remove_first",
            "reaction_lww",
            "message_lww",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          reactionAdded(
            "reaction_add_older",
            "reaction_lww",
            "message_lww",
            "participant_lww",
            "older",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T01:00:00.000Z",
              observed_at: "2026-09-07T01:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT participant_id, emoji, removed_at, last_event_id FROM reactions",
      ),
    ).resolves.toEqual([
      {
        participant_id: null,
        emoji: null,
        removed_at: "2026-09-07T02:00:00.000Z",
        last_event_id: "reaction_remove_first",
      },
    ]);

    await stub.applyBatch(
      input(
        [
          reactionAdded(
            "reaction_add_newer",
            "reaction_lww",
            "message_lww",
            "participant_lww",
            "newer",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T03:00:00.000Z",
              observed_at: "2026-09-07T03:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          reactionAdded(
            "tie-long",
            "reaction_lww",
            "message_lww",
            "participant_lww",
            "long",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T04:00:01.000Z",
            },
          ),
          reactionAdded(
            "tie",
            "reaction_lww",
            "message_lww",
            "participant_lww",
            "short",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T04:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT participant_id, emoji, removed_at, last_event_id FROM reactions",
      ),
    ).resolves.toEqual([
      {
        participant_id: "participant_lww",
        emoji: "long",
        removed_at: null,
        last_event_id: "tie-long",
      },
    ]);
    await expect(
      rows(stub, "SELECT event_id FROM applied_events ORDER BY event_id"),
    ).resolves.toHaveLength(5);
    await expect(
      rows(stub, "SELECT event_id FROM projection_changes ORDER BY sequence"),
    ).resolves.toHaveLength(5);
  });

  it("keeps local read state while newer remote and delivered receipts cannot regress it", async () => {
    const tenant = "tenant_projector_stage_b_receipt_lww";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          receipt(
            "receipt_local",
            "read",
            "message_receipt_local",
            "participant_local",
            true,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          created("receipt_message", {
            tenant_id: tenant,
            payload: {
              message_id: "message_receipt_local",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Alice",
              body: "read before arrival",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: true,
            },
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          receipt(
            "receipt_remote_newer",
            "read",
            "message_receipt_local",
            "participant_remote",
            false,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T03:00:01.000Z",
            },
          ),
          receipt(
            "receipt_delivered_newer",
            "delivered",
            "message_receipt_local",
            "participant_remote",
            false,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T04:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT unread, local_read_at FROM messages WHERE id = ?",
        "message_receipt_local",
      ),
    ).resolves.toEqual([
      {
        unread: 0,
        local_read_at: "2026-09-07T01:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT receipt_type, local_identity, last_event_id FROM receipts ORDER BY receipt_type, participant_id",
      ),
    ).resolves.toEqual([
      {
        receipt_type: "delivered",
        local_identity: 0,
        last_event_id: "receipt_delivered_newer",
      },
      {
        receipt_type: "read",
        local_identity: 1,
        last_event_id: "receipt_local",
      },
      {
        receipt_type: "read",
        local_identity: 0,
        last_event_id: "receipt_remote_newer",
      },
    ]);
  });

  it("rejects contradictory receipt classification atomically and preserves pending local/remote semantics", async () => {
    const tenant = "tenant_projector_stage_b_receipt_classification";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          receipt(
            "classification_local",
            "read",
            "message_classification",
            "participant_local",
            true,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          created("classification_message", {
            tenant_id: tenant,
            payload: {
              message_id: "message_classification",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Alice",
              body: "born read",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: true,
            },
          }),
        ],
        { tenant_id: tenant },
      ),
    );

    const before = await runInDurableObject(stub, async (_instance, state) => ({
      receipts: state.storage.sql.exec("SELECT * FROM receipts").toArray(),
      messages: state.storage.sql.exec("SELECT * FROM messages").toArray(),
      conversations: state.storage.sql
        .exec("SELECT * FROM conversations")
        .toArray(),
      applied: state.storage.sql.exec("SELECT * FROM applied_events").toArray(),
      changes: state.storage.sql
        .exec("SELECT * FROM projection_changes")
        .toArray(),
      checkpoints: state.storage.sql
        .exec("SELECT * FROM projection_checkpoints")
        .toArray(),
    }));
    await expectCode(
      stub,
      input(
        [
          receipt(
            "classification_remote_older",
            "read",
            "message_classification",
            "participant_local",
            false,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T01:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
      "projection_conflict",
    );
    const after = await runInDurableObject(stub, async (_instance, state) => ({
      receipts: state.storage.sql.exec("SELECT * FROM receipts").toArray(),
      messages: state.storage.sql.exec("SELECT * FROM messages").toArray(),
      conversations: state.storage.sql
        .exec("SELECT * FROM conversations")
        .toArray(),
      applied: state.storage.sql.exec("SELECT * FROM applied_events").toArray(),
      changes: state.storage.sql
        .exec("SELECT * FROM projection_changes")
        .toArray(),
      checkpoints: state.storage.sql
        .exec("SELECT * FROM projection_checkpoints")
        .toArray(),
    }));
    expect(after).toEqual(before);

    await stub.applyBatch(
      input(
        [
          receipt(
            "classification_remote_pending",
            "read",
            "message_remote_pending",
            "participant_remote_only",
            false,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T03:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          created("classification_remote_message", {
            tenant_id: tenant,
            payload: {
              message_id: "message_remote_pending",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Bob",
              body: "born unread",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: true,
            },
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT unread, local_read_at FROM messages WHERE id = ?",
        "message_remote_pending",
      ),
    ).resolves.toEqual([
      {
        unread: 1,
        local_read_at: null,
      },
    ]);
  });

  it("retains expired typing starts as data and applies a newer stop", async () => {
    const tenant = "tenant_projector_stage_b_typing";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          typingStarted(
            "typing_expired",
            "participant_expired",
            "2020-01-01T00:00:00.000Z",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T01:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT is_typing, expires_at, last_event_id FROM typing_states",
      ),
    ).resolves.toEqual([
      {
        is_typing: 1,
        expires_at: "2020-01-01T00:00:00.000Z",
        last_event_id: "typing_expired",
      },
    ]);
    await stub.applyBatch(
      input(
        [
          typingStopped("typing_stop", "participant_expired", {
            tenant_id: tenant,
            observed_at: "2026-09-07T02:00:01.000Z",
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT is_typing, expires_at, last_event_id FROM typing_states",
      ),
    ).resolves.toEqual([
      {
        is_typing: 0,
        expires_at: null,
        last_event_id: "typing_stop",
      },
    ]);
  });

  it("stores attachment metadata before a message, reconciles counts, and redacts after a tombstone", async () => {
    const tenant = "tenant_projector_stage_b_attachment";
    const stub = await initialize(tenant);
    const attachment = attachmentObserved(
      "attachment_pending",
      "attachment_pending",
      "message_attachment_pending",
      {
        tenant_id: tenant,
        observed_at: "2026-09-07T02:00:01.000Z",
      },
    );
    await stub.applyBatch(input([attachment], { tenant_id: tenant }));
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, deleted_at FROM attachments",
      ),
    ).resolves.toEqual([
      {
        file_name: "photo.jpg",
        mime_type: "image/jpeg",
        size_bytes: 42,
        deleted_at: null,
      },
    ]);
    await stub.applyBatch(
      input(
        [
          created("attachment_pending_message", {
            tenant_id: tenant,
            payload: {
              message_id: "message_attachment_pending",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Alice",
              body: "has attachment",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: false,
            },
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT attachment_count FROM messages WHERE id = ?",
        "message_attachment_pending",
      ),
    ).resolves.toEqual([{ attachment_count: 1 }]);
    await stub.applyBatch(
      input(
        [
          deleted(
            "attachment_message_deleted",
            "message_attachment_pending",
            "gone",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T03:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          attachmentObserved(
            "attachment_after_delete",
            "attachment_after_delete",
            "message_attachment_pending",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T04:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments ORDER BY id",
      ),
    ).resolves.toEqual([
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
        deleted_at: "2026-09-07T01:00:00.000Z",
      },
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
        deleted_at: "2026-09-07T01:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT attachment_count FROM conversations WHERE id = ?",
        "conversation_a",
      ),
    ).resolves.toEqual([{ attachment_count: 0 }]);
  });
});
