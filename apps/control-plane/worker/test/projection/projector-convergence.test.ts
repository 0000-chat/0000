import { runInDurableObject } from "cloudflare:test";
import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import {
  attachmentObserved,
  commandUpdated,
  conversationUpdated,
  created,
  deleted,
  deletionTombstone,
  deliveryUpdated,
  edited,
  eventMarker,
  input,
  initialize,
  participantUpdated,
  reactionAdded,
  receipt,
  rows,
  typingStarted,
  typingStopped,
} from "./projector-test-support";

describe("tenant projection convergence", () => {
  it("converges message observed_at with the effective current tombstone tuple", async () => {
    const create = created("observed_at_tuple_create", {
      tenant_id: "tenant_projector_stage_c_observed_at",
      occurred_at: "2026-09-07T01:00:00.000Z",
      observed_at: "2026-09-07T01:00:01.000Z",
    });
    const tombstone = deleted(
      "observed_at_tuple_delete",
      "message_a",
      "removed",
      {
        tenant_id: "tenant_projector_stage_c_observed_at",
        occurred_at: "2026-09-07T02:00:00.000Z",
        observed_at: "2026-09-07T05:00:01.000Z",
      },
    );
    const edit = edited("observed_at_tuple_edit", "message_a", "edited body", {
      tenant_id: "tenant_projector_stage_c_observed_at",
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
    });
    const project = async (
      tenant: string,
      order: ProjectionEventEnvelope[],
      asBatch: boolean,
    ) => {
      const stub = await initialize(tenant);
      const tenantEvents = order.map((nextEvent) => ({
        ...nextEvent,
        tenant_id: tenant,
      }));
      if (asBatch) {
        await stub.applyBatch(input(tenantEvents, { tenant_id: tenant }));
      } else {
        for (const nextEvent of tenantEvents) {
          await stub.applyBatch(input([nextEvent], { tenant_id: tenant }));
        }
      }
      return rows<{
        body: string;
        observed_at: string;
        current_observed_ms: number;
        current_event_id: string;
      }>(
        stub,
        "SELECT body, observed_at, current_observed_ms, current_event_id FROM messages",
      );
    };

    const forward = await project(
      "tenant_projector_stage_c_observed_at_forward",
      [create, tombstone, edit],
      false,
    );
    const reverse = await project(
      "tenant_projector_stage_c_observed_at_reverse",
      [edit, tombstone, create],
      false,
    );
    const batch = await project(
      "tenant_projector_stage_c_observed_at_batch",
      [create, tombstone, edit],
      true,
    );
    expect(reverse).toEqual(forward);
    expect(batch).toEqual(forward);
    expect(forward).toEqual([
      {
        body: "",
        observed_at: "2026-09-07T05:00:01.000Z",
        current_observed_ms: Date.parse(tombstone.observed_at),
        current_event_id: tombstone.event_id,
      },
    ]);
  });

  it("converges explicit and direct message deletion and preserves the winning tombstone", async () => {
    const direct = deleted(
      "direct_delete",
      "convergent_message",
      "same-reason",
      {
        occurred_at: "2026-09-07T02:00:00.000Z",
        observed_at: "2026-09-07T02:00:01.000Z",
      },
    );
    const explicit = deletionTombstone(
      "explicit_delete",
      "message",
      "convergent_message",
      {
        occurred_at: "2026-09-07T03:00:00.000Z",
        observed_at: "2026-09-07T03:00:01.000Z",
      },
    );
    const create = created("convergent_create", {
      payload: {
        message_id: "convergent_message",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "secret sender",
        body: "secret body",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: true,
      },
      occurred_at: "2026-09-07T01:00:00.000Z",
      observed_at: "2026-09-07T01:00:01.000Z",
    });
    const project = async (
      tenant: string,
      order: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      for (const nextEvent of order) {
        await stub.applyBatch(
          input([{ ...nextEvent, tenant_id: tenant }], { tenant_id: tenant }),
        );
      }
      return runInDurableObject(stub, async (_instance, state) => ({
        tombstone: state.storage.sql
          .exec(
            "SELECT resource_type, resource_id, tombstone_event_id, reason_code, occurred_at, observed_ms FROM resource_tombstones",
          )
          .toArray(),
        message: state.storage.sql
          .exec(
            "SELECT body, sender_label, deleted_at, deletion_reason, current_observed_ms, current_event_id FROM messages",
          )
          .toArray(),
      }));
    };
    const forward = await project("tenant_projector_stage_c_delete_forward", [
      create,
      direct,
      explicit,
    ]);
    const reverse = await project("tenant_projector_stage_c_delete_reverse", [
      explicit,
      create,
      direct,
    ]);
    expect(reverse).toEqual(forward);
    expect(forward.tombstone).toEqual([
      {
        resource_type: "message",
        resource_id: "convergent_message",
        tombstone_event_id: "explicit_delete",
        reason_code: "retention",
        occurred_at: "2026-09-07T03:00:00.000Z",
        observed_ms: Date.parse("2026-09-07T03:00:01.000Z"),
      },
    ]);
    expect(forward.message).toEqual([
      {
        body: "",
        sender_label: "Deleted sender",
        deleted_at: "2026-09-07T03:00:00.000Z",
        deletion_reason: "retention",
        current_observed_ms: Date.parse(explicit.observed_at),
        current_event_id: explicit.event_id,
      },
    ]);
  });

  it("converges a representative Stage C stream in forward and reverse order", async () => {
    const history = [
      conversationUpdated(
        "stage_c_convergence_metadata",
        {
          title: "Convergence conversation",
          archived: true,
          muted: true,
        },
        {
          occurred_at: "2026-09-07T01:00:00.000Z",
          observed_at: "2026-09-07T01:00:01.000Z",
        },
      ),
      participantUpdated(
        "stage_c_convergence_participant",
        "stage_c_convergence_participant",
        {
          occurred_at: "2026-09-07T02:00:00.000Z",
          observed_at: "2026-09-07T02:00:01.000Z",
        },
      ),
      created("stage_c_convergence_create", {
        occurred_at: "2026-09-07T03:00:00.000Z",
        observed_at: "2026-09-07T03:00:01.000Z",
        payload: {
          message_id: "stage_c_convergence_message",
          direction: "inbound",
          sender_participant_id: "stage_c_convergence_participant",
          sender_label: "convergence sender",
          body: "convergence body",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
      }),
      attachmentObserved(
        "stage_c_convergence_attachment",
        "stage_c_convergence_attachment",
        "stage_c_convergence_message",
        {
          occurred_at: "2026-09-07T04:00:00.000Z",
          observed_at: "2026-09-07T04:00:01.000Z",
        },
      ),
      deliveryUpdated(
        "stage_c_convergence_delivery",
        "stage_c_convergence_message",
        {
          occurred_at: "2026-09-07T05:00:00.000Z",
          observed_at: "2026-09-07T05:00:01.000Z",
        },
      ),
      commandUpdated(
        "stage_c_convergence_command",
        "stage_c_convergence_command",
        {
          occurred_at: "2026-09-07T06:00:00.000Z",
          observed_at: "2026-09-07T06:00:01.000Z",
        },
      ),
      eventMarker(
        "stage_c_convergence_marker",
        "correction.applied",
        "stage_c_convergence_create",
        {
          occurred_at: "2026-09-07T07:00:00.000Z",
          observed_at: "2026-09-07T07:00:01.000Z",
        },
      ),
      deletionTombstone(
        "stage_c_convergence_message_delete",
        "message",
        "stage_c_convergence_message",
        {
          occurred_at: "2026-09-07T08:00:00.000Z",
          observed_at: "2026-09-07T08:00:01.000Z",
        },
      ),
      deletionTombstone(
        "stage_c_convergence_conversation_delete",
        "conversation",
        "conversation_a",
        {
          occurred_at: "2026-09-07T09:00:00.000Z",
          observed_at: "2026-09-07T09:00:01.000Z",
        },
      ),
    ];
    const project = async (
      tenant: string,
      order: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      for (const nextEvent of order) {
        await stub.applyBatch(
          input([{ ...nextEvent, tenant_id: tenant }], { tenant_id: tenant }),
        );
      }
      return runInDurableObject(stub, async (_instance, state) => ({
        conversation: state.storage.sql
          .exec(
            "SELECT title, archived, muted, last_message_preview, unread_count, message_count, attachment_count, deleted_at, shell_activity_at, shell_activity_ms, shell_activity_event_id FROM conversations",
          )
          .toArray(),
        messages: state.storage.sql
          .exec(
            "SELECT id, body, sender_participant_id, sender_label, delivery_status, unread, deleted_at, deletion_reason, current_observed_ms, current_event_id FROM messages",
          )
          .toArray(),
        versions: state.storage.sql
          .exec(
            "SELECT event_id, body, editor_participant_id FROM message_versions ORDER BY event_id",
          )
          .toArray(),
        participants: state.storage.sql
          .exec(
            "SELECT id, display_name, remote_id, avatar_url, deleted_at FROM participants",
          )
          .toArray(),
        attachments: state.storage.sql
          .exec(
            "SELECT id, file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments",
          )
          .toArray(),
        commands: state.storage.sql
          .exec("SELECT id, status, failure_code FROM commands")
          .toArray(),
        deliveries: state.storage.sql
          .exec(
            "SELECT message_id, delivery_status, failure_code FROM message_delivery_updates",
          )
          .toArray(),
        markers: state.storage.sql
          .exec(
            "SELECT target_event_id, tombstone_event_id, tombstone_type, reason_code FROM event_tombstones",
          )
          .toArray(),
        tombstones: state.storage.sql
          .exec(
            "SELECT resource_type, resource_id, tombstone_event_id, reason_code FROM resource_tombstones ORDER BY resource_type, resource_id",
          )
          .toArray(),
      }));
    };
    const forward = await project(
      "tenant_projector_stage_c_convergence_forward",
      history,
    );
    const reverse = await project(
      "tenant_projector_stage_c_convergence_reverse",
      [...history].reverse(),
    );
    expect(reverse).toEqual(forward);
    expect(forward.conversation).toEqual([
      {
        title: "Deleted conversation",
        archived: 0,
        muted: 0,
        last_message_preview: "",
        unread_count: 0,
        message_count: 0,
        attachment_count: 0,
        deleted_at: "2026-09-07T09:00:00.000Z",
        shell_activity_at: "2026-09-07T09:00:00.000Z",
        shell_activity_ms: Date.parse("2026-09-07T09:00:00.000Z"),
        shell_activity_event_id: "stage_c_convergence_conversation_delete",
      },
    ]);
  });

  it("derives conversation updated_at from the effective shell activity tuple", async () => {
    const metadata = conversationUpdated(
      "conversation_updated_at_metadata",
      {
        title: "Observed metadata",
        archived: false,
        muted: false,
      },
      {
        occurred_at: "2026-09-07T01:00:00.000Z",
        observed_at: "2026-09-07T04:00:00.000Z",
      },
    );
    const child = created("conversation_updated_at_child", {
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T03:00:00.000Z",
      payload: {
        message_id: "conversation_updated_at_message",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "child sender",
        body: "child body",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    const project = async (
      tenant: string,
      groups: ProjectionEventEnvelope[][],
    ) => {
      const stub = await initialize(tenant);
      for (const group of groups) {
        await stub.applyBatch(
          input(
            group.map((nextEvent) => ({ ...nextEvent, tenant_id: tenant })),
            { tenant_id: tenant },
          ),
        );
      }
      return rows(
        stub,
        "SELECT title, archived, muted, updated_at, shell_activity_at, shell_activity_ms, shell_activity_event_id, metadata_observed_ms, metadata_event_id FROM conversations",
      );
    };

    const forward = await project(
      "tenant_projector_stage_c_updated_at_forward",
      [[metadata], [child]],
    );
    const reverse = await project(
      "tenant_projector_stage_c_updated_at_reverse",
      [[child], [metadata]],
    );
    const batched = await project(
      "tenant_projector_stage_c_updated_at_batched",
      [[metadata, child]],
    );
    expect(reverse).toEqual(forward);
    expect(batched).toEqual(forward);
    expect(forward).toEqual([
      {
        title: "Observed metadata",
        archived: 0,
        muted: 0,
        updated_at: "2026-09-07T03:00:00.000Z",
        shell_activity_at: "2026-09-07T03:00:00.000Z",
        shell_activity_ms: Date.parse("2026-09-07T03:00:00.000Z"),
        shell_activity_event_id: "conversation_updated_at_child",
        metadata_observed_ms: Date.parse("2026-09-07T04:00:00.000Z"),
        metadata_event_id: "conversation_updated_at_metadata",
      },
    ]);
  });

  it("converges conversation metadata when a child creates the shell first", async () => {
    const metadata = conversationUpdated(
      "conversation_metadata_winner",
      {
        title: "Metadata winner",
        archived: true,
        muted: true,
      },
      {
        observed_at: "2026-09-07T01:00:01.000Z",
        occurred_at: "2026-09-07T01:00:00.000Z",
      },
    );
    const child = created("message_metadata_child", {
      observed_at: "2026-09-07T02:00:01.000Z",
      occurred_at: "2026-09-07T03:00:00.000Z",
      payload: {
        message_id: "message_metadata_child",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Child",
        body: "child",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });

    const project = async (
      tenant: string,
      events: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      for (const nextEvent of events) {
        await stub.applyBatch(
          input(
            [
              {
                ...nextEvent,
                tenant_id: tenant,
              },
            ],
            { tenant_id: tenant },
          ),
        );
      }
      return rows<{
        title: string;
        archived: number;
        muted: number;
        metadata_observed_ms: number;
        metadata_event_id: string;
        shell_activity_at: string;
      }>(
        stub,
        "SELECT title, archived, muted, metadata_observed_ms, metadata_event_id, shell_activity_at FROM conversations WHERE id = ?",
        "conversation_a",
      );
    };

    const metadataFirst = await project("tenant_projector_metadata_first", [
      metadata,
      child,
    ]);
    const childFirst = await project("tenant_projector_child_first", [
      child,
      metadata,
    ]);

    expect(childFirst).toEqual(metadataFirst);
    expect(childFirst).toEqual([
      {
        title: "Metadata winner",
        archived: 1,
        muted: 1,
        metadata_observed_ms: Date.parse(metadata.observed_at),
        metadata_event_id: metadata.event_id,
        shell_activity_at: child.occurred_at,
      },
    ]);
  });

  it("converges pending edits and deletes without resurrecting message content", async () => {
    const tenant = "tenant_projector_pending";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          edited("edit_pending", "message_pending", "pending body", {
            tenant_id: tenant,
            observed_at: "2026-09-07T02:00:01.000Z",
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          created("create_pending", {
            tenant_id: tenant,
            observed_at: "2026-09-07T01:00:01.000Z",
            payload: {
              message_id: "message_pending",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Alice",
              body: "original body",
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
      rows<{ body: string; edited_at: string | null }>(
        stub,
        "SELECT body, edited_at FROM messages WHERE id = ?",
        "message_pending",
      ),
    ).resolves.toEqual([
      {
        body: "pending body",
        edited_at: "2026-09-07T01:00:00.000Z",
      },
    ]);

    await stub.applyBatch(
      input(
        [
          edited("edit_deleted_pending", "message_deleted", "pending secret", {
            tenant_id: tenant,
            observed_at: "2026-09-07T02:00:01.000Z",
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          deleted("delete_pending", "message_deleted", "gone", {
            tenant_id: tenant,
            observed_at: "2026-09-07T03:00:01.000Z",
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          created("create_deleted", {
            tenant_id: tenant,
            observed_at: "2026-09-07T01:00:01.000Z",
            payload: {
              message_id: "message_deleted",
              direction: "outbound",
              sender_participant_id: null,
              sender_label: "Bob",
              body: "secret body",
              reply_to_message_id: null,
              delivery_status: "sent",
              unread: false,
            },
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          edited("edit_deleted", "message_deleted", "new secret", {
            tenant_id: tenant,
            observed_at: "2026-09-07T04:00:01.000Z",
          }),
        ],
        { tenant_id: tenant },
      ),
    );

    await expect(
      rows<{
        body: string;
        sender_label: string;
        deleted_at: string | null;
        deletion_reason: string | null;
      }>(
        stub,
        "SELECT body, sender_label, deleted_at, deletion_reason FROM messages WHERE id = ?",
        "message_deleted",
      ),
    ).resolves.toEqual([
      {
        body: "",
        sender_label: "Deleted sender",
        deleted_at: "2026-09-07T01:00:00.000Z",
        deletion_reason: "gone",
      },
    ]);
    await expect(
      rows<{ body: string; editor_participant_id: string | null }>(
        stub,
        "SELECT body, editor_participant_id FROM message_versions WHERE message_id = ? ORDER BY observed_ms, event_id COLLATE BINARY",
        "message_deleted",
      ),
    ).resolves.toEqual([
      { body: "", editor_participant_id: null },
      { body: "", editor_participant_id: null },
      { body: "", editor_participant_id: null },
    ]);
  });

  it("recomputes each touched conversation summary once per batch", async () => {
    const tenant = "tenant_projector_summary_once";
    const stub = await initialize(tenant);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE summary_updates (id INTEGER PRIMARY KEY AUTOINCREMENT)",
      );
      state.storage.sql.exec(
        "CREATE TRIGGER summary_update_counter AFTER UPDATE OF last_message_preview ON conversations BEGIN INSERT INTO summary_updates (id) VALUES (NULL); END",
      );
    });
    const first = created("summary_first", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T02:00:00.000Z",
      observed_at: "2026-09-07T02:00:01.000Z",
      payload: {
        message_id: "message_summary_first",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Alice",
        body: "first",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: true,
      },
    });
    const second = created("summary_second", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
      payload: {
        message_id: "message_summary_second",
        direction: "outbound",
        sender_participant_id: null,
        sender_label: "Bob",
        body: "second",
        reply_to_message_id: null,
        delivery_status: "sent",
        unread: false,
      },
    });
    await stub.applyBatch(input([second, first], { tenant_id: tenant }));
    await expect(
      rows<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM summary_updates",
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      rows<{
        message_count: number;
        unread_count: number;
        last_message_preview: string;
      }>(
        stub,
        "SELECT message_count, unread_count, last_message_preview FROM conversations WHERE id = ?",
        "conversation_a",
      ),
    ).resolves.toEqual([
      { message_count: 2, unread_count: 1, last_message_preview: "second" },
    ]);
  });

  it("converges stable local and remote receipt keys around message creation", async () => {
    const history = [
      receipt(
        "receipt_convergence_local",
        "read",
        "message_receipt_convergence",
        "participant_local_convergence",
        true,
        {
          observed_at: "2026-09-07T02:00:01.000Z",
        },
      ),
      receipt(
        "receipt_convergence_remote",
        "read",
        "message_receipt_convergence",
        "participant_remote_convergence",
        false,
        {
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
      receipt(
        "receipt_convergence_delivered",
        "delivered",
        "message_receipt_convergence",
        "participant_remote_convergence",
        false,
        {
          observed_at: "2026-09-07T04:00:01.000Z",
        },
      ),
      created("receipt_convergence_message", {
        payload: {
          message_id: "message_receipt_convergence",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Alice",
          body: "receipt convergence",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
        observed_at: "2026-09-07T01:00:01.000Z",
      }),
    ];
    const project = async (
      tenant: string,
      events: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      for (const nextEvent of events) {
        await stub.applyBatch(
          input([{ ...nextEvent, tenant_id: tenant }], { tenant_id: tenant }),
        );
      }
      return runInDurableObject(stub, async (_instance, state) => ({
        message: state.storage.sql
          .exec("SELECT unread, local_read_at FROM messages ORDER BY id")
          .toArray(),
        receipts: state.storage.sql
          .exec(
            "SELECT message_id, participant_id, receipt_type, local_identity, last_observed_ms, last_event_id FROM receipts ORDER BY message_id, participant_id, receipt_type",
          )
          .toArray(),
      }));
    };
    const forward = await project(
      "tenant_projector_stage_b_receipt_forward",
      history,
    );
    const reverse = await project(
      "tenant_projector_stage_b_receipt_reverse",
      [...history].reverse(),
    );
    expect(reverse).toEqual(forward);
    expect(forward.message).toEqual([
      { unread: 0, local_read_at: "2026-09-07T01:00:00.000Z" },
    ]);
    expect(forward.receipts).toHaveLength(3);
  });

  it("converges child state when a message tombstone is replayed in reverse order", async () => {
    const history = [
      created("tombstone_convergence_message", {
        payload: {
          message_id: "message_tombstone_convergence",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Alice",
          body: "secret",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
        observed_at: "2026-09-07T01:00:01.000Z",
      }),
      reactionAdded(
        "tombstone_convergence_reaction",
        "reaction_tombstone_convergence",
        "message_tombstone_convergence",
        "participant_tombstone_convergence",
        "secret",
        {
          observed_at: "2026-09-07T02:00:01.000Z",
        },
      ),
      receipt(
        "tombstone_convergence_receipt",
        "read",
        "message_tombstone_convergence",
        "participant_tombstone_convergence",
        true,
        {
          observed_at: "2026-09-07T02:00:02.000Z",
        },
      ),
      attachmentObserved(
        "tombstone_convergence_attachment",
        "attachment_tombstone_convergence",
        "message_tombstone_convergence",
        {
          observed_at: "2026-09-07T02:00:03.000Z",
        },
      ),
      deleted(
        "tombstone_convergence_delete",
        "message_tombstone_convergence",
        "gone",
        {
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
    ];
    const project = async (
      tenant: string,
      events: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      for (const nextEvent of events) {
        await stub.applyBatch(
          input([{ ...nextEvent, tenant_id: tenant }], { tenant_id: tenant }),
        );
      }
      return runInDurableObject(stub, async (_instance, state) => ({
        message: state.storage.sql
          .exec(
            "SELECT body, deleted_at, attachment_count FROM messages ORDER BY id",
          )
          .toArray(),
        reactions: state.storage.sql
          .exec("SELECT id, participant_id, emoji FROM reactions ORDER BY id")
          .toArray(),
        receipts: state.storage.sql
          .exec(
            "SELECT message_id, participant_id, receipt_type FROM receipts ORDER BY message_id, participant_id, receipt_type",
          )
          .toArray(),
        attachments: state.storage.sql
          .exec(
            "SELECT id, file_name, mime_type, size_bytes, deleted_at FROM attachments ORDER BY id",
          )
          .toArray(),
      }));
    };
    await expect(
      project("tenant_projector_stage_b_tombstone_forward", history),
    ).resolves.toEqual(
      await project(
        "tenant_projector_stage_b_tombstone_reverse",
        [...history].reverse(),
      ),
    );
  });

  it("converges Stage B pending histories in forward and reverse order", async () => {
    const history = [
      created("convergence_message", {
        payload: {
          message_id: "message_convergence",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Alice",
          body: "convergent",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
      }),
      reactionAdded(
        "convergence_reaction",
        "reaction_convergence",
        "message_convergence",
        "participant_convergence",
      ),
      receipt(
        "convergence_receipt",
        "read",
        "message_convergence",
        "participant_convergence",
        true,
      ),
      typingStarted("convergence_typing", "participant_typing_convergence"),
      typingStopped(
        "convergence_typing_stop",
        "participant_typing_convergence",
        { observed_at: "2026-09-07T02:00:01.000Z" },
      ),
      attachmentObserved(
        "convergence_attachment",
        "attachment_convergence",
        "message_convergence",
      ),
    ];
    const project = async (
      tenant: string,
      events: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      for (const nextEvent of events) {
        await stub.applyBatch(
          input([{ ...nextEvent, tenant_id: tenant }], { tenant_id: tenant }),
        );
      }
      return runInDurableObject(stub, async (_instance, state) => ({
        conversations: state.storage.sql
          .exec(
            "SELECT id, last_message_preview, unread_count, attachment_count FROM conversations ORDER BY id",
          )
          .toArray(),
        messages: state.storage.sql
          .exec(
            "SELECT id, body, unread, local_read_at, attachment_count FROM messages ORDER BY id",
          )
          .toArray(),
        reactions: state.storage.sql
          .exec(
            "SELECT id, participant_id, emoji, removed_at, last_observed_ms, last_event_id FROM reactions ORDER BY id",
          )
          .toArray(),
        receipts: state.storage.sql
          .exec(
            "SELECT message_id, participant_id, receipt_type, local_identity, last_observed_ms, last_event_id FROM receipts ORDER BY message_id, receipt_type",
          )
          .toArray(),
        typing: state.storage.sql
          .exec(
            "SELECT conversation_id, participant_id, is_typing, expires_at, last_observed_ms, last_event_id FROM typing_states ORDER BY conversation_id, participant_id",
          )
          .toArray(),
        attachments: state.storage.sql
          .exec(
            "SELECT id, message_id, file_name, mime_type, size_bytes, deleted_at, last_observed_ms, last_event_id FROM attachments ORDER BY id",
          )
          .toArray(),
      }));
    };
    const forward = await project("tenant_projector_stage_b_forward", history);
    const reverse = await project(
      "tenant_projector_stage_b_reverse",
      [...history].reverse(),
    );
    expect(reverse).toEqual(forward);
  });
});
