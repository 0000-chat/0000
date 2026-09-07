import { env, runInDurableObject } from "cloudflare:test";
import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import {
  auth,
  conversationUpdated,
  createMessage,
  created,
  edited,
  initialize,
  input,
  participantUpdated,
  rows,
  tenantId,
} from "./projector-test-support";

describe("tenant projection core", () => {
  it("projects a created message and recomputes its conversation summary", async () => {
    const stub = env.TENANT_PROJECTION.getByName(tenantId);
    await stub.initialize({
      schema_version: 1,
      tenant_id: tenantId,
      initialized_at: "2026-09-07T00:00:00.000Z",
      authorization: auth(["projection.initialize"], []),
    });

    await stub.applyBatch(input([createMessage()]));

    const result = await runInDurableObject(stub, async (_instance, state) => ({
      message: state.storage.sql
        .exec<{ body: string; unread: number }>(
          "SELECT body, unread FROM messages WHERE id = ?",
          "message_a",
        )
        .toArray(),
      conversation: state.storage.sql
        .exec<{ last_message_preview: string; unread_count: number }>(
          "SELECT last_message_preview, unread_count FROM conversations WHERE id = ?",
          "conversation_a",
        )
        .toArray(),
    }));

    expect(result.message).toEqual([{ body: "hello", unread: 1 }]);
    expect(result.conversation).toEqual([{ last_message_preview: "hello", unread_count: 1 }]);
  });

  it("applies conversation and participant metadata by the observed tuple", async () => {
    const tenant = "tenant_projector_metadata";
    const stub = await initialize(tenant);
    const newerConversation = conversationUpdated("conversation_new", undefined, {
      tenant_id: tenant,
      observed_at: "2026-09-07T03:00:01.000Z",
      occurred_at: "2026-09-07T03:00:00.000Z",
    });
    const olderConversation = conversationUpdated("conversation_old", {
      title: "Older title",
      archived: false,
      muted: false,
    }, {
      tenant_id: tenant,
      observed_at: "2026-09-07T04:00:01.000Z",
      occurred_at: "2026-09-07T02:00:00.000Z",
    });
    await stub.applyBatch(input([newerConversation], { tenant_id: tenant }));
    await stub.applyBatch(input([olderConversation], { tenant_id: tenant }));

    const newerParticipant = participantUpdated("participant_new", "participant_a", {
      tenant_id: tenant,
      observed_at: "2026-09-07T05:00:01.000Z",
    });
    const olderParticipant = participantUpdated("participant_old", "participant_a", {
      tenant_id: tenant,
      observed_at: "2026-09-07T04:00:01.000Z",
    });
    await stub.applyBatch(input([newerParticipant], { tenant_id: tenant }));
    await stub.applyBatch(input([olderParticipant], { tenant_id: tenant }));

    await expect(rows<{ title: string; archived: number; muted: number; shell_activity_at: string }>(
      stub,
      "SELECT title, archived, muted, shell_activity_at FROM conversations WHERE id = ?",
      "conversation_a",
    )).resolves.toEqual([{ title: "Older title", archived: 0, muted: 0, shell_activity_at: "2026-09-07T03:00:00.000Z" }]);
    await expect(rows<{ display_name: string; remote_id: string; avatar_url: string }>(
      stub,
      "SELECT display_name, remote_id, avatar_url FROM participants WHERE id = ?",
      "participant_a",
    )).resolves.toEqual([{
      display_name: "Alice Updated",
      remote_id: "remote-a",
      avatar_url: "https://example.test/avatar.png",
    }]);
  });

  it("reconciles winning create metadata independently from a newer edit", async () => {
    const createOne = created("message_create_one", {
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T01:00:01.000Z",
      matrix_room_id: "!room_one:example.test",
      matrix_event_id: "$event_one:example.test",
      remote_message_id: "remote_one",
      payload: {
        message_id: "message_create_replay",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Sender one",
        body: "body one",
        reply_to_message_id: null,
        delivery_status: "accepted",
        unread: true,
      },
    });
    const createTwo = created("message_create_two", {
      occurred_at: "2026-09-07T04:00:00.000Z",
      observed_at: "2026-09-07T02:00:01.000Z",
      matrix_room_id: "!room_two:example.test",
      matrix_event_id: "$event_two:example.test",
      remote_message_id: "remote_two",
      payload: {
        message_id: "message_create_replay",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Sender two",
        body: "body two",
        reply_to_message_id: null,
        delivery_status: "delivered",
        unread: false,
      },
    });
    const newerEdit = edited("message_create_edit", "message_create_replay", "edited body", {
      occurred_at: "2026-09-07T05:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
    });

    const project = async (tenant: string, order: ProjectionEventEnvelope[]) => {
      const stub = await initialize(tenant);
      for (const nextEvent of order) {
        await stub.applyBatch(input([{
          ...nextEvent,
          tenant_id: tenant,
        }], { tenant_id: tenant }));
      }
      return rows<{
        direction: string;
        sender_label: string;
        body: string;
        delivery_status: string;
        unread: number;
        occurred_at: string;
        occurred_ms: number;
        observed_at: string;
        current_event_id: string;
        matrix_room_id: string | null;
        matrix_event_id: string | null;
        remote_message_id: string | null;
        edited_at: string | null;
      }>(stub, "SELECT direction, sender_label, body, delivery_status, unread, occurred_at, occurred_ms, observed_at, current_event_id, matrix_room_id, matrix_event_id, remote_message_id, edited_at FROM messages WHERE id = ?", "message_create_replay");
    };

    const forward = await project("tenant_projector_create_forward", [createOne, createTwo, newerEdit]);
    const reverse = await project("tenant_projector_create_reverse", [createTwo, createOne, newerEdit]);

    expect(reverse).toEqual(forward);
    expect(forward).toEqual([{
      direction: "inbound",
      sender_label: "Sender two",
      body: "edited body",
      delivery_status: "delivered",
      unread: 0,
      occurred_at: createTwo.occurred_at,
      occurred_ms: Date.parse(createTwo.occurred_at),
      observed_at: newerEdit.observed_at,
      current_event_id: newerEdit.event_id,
      matrix_room_id: createTwo.matrix_room_id,
      matrix_event_id: createTwo.matrix_event_id,
      remote_message_id: createTwo.remote_message_id,
      edited_at: newerEdit.occurred_at,
    }]);
  });

  it("uses occurred tuples for presentation while message versions use observed LWW", async () => {
    const tenant = "tenant_projector_ordering";
    const stub = await initialize(tenant);
    const initial = created("message_create_order", {
      tenant_id: tenant,
      payload: {
        message_id: "message_order",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Alice",
        body: "initial",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: true,
      },
      occurred_at: "2026-09-07T01:00:00.000Z",
      observed_at: "2026-09-07T01:00:01.000Z",
    });
    await stub.applyBatch(input([initial], { tenant_id: tenant }));

    const latestEdit = edited("edit_z", "message_order", "latest", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T04:00:00.000Z",
      observed_at: "2026-09-07T04:00:01.000Z",
    });
    const olderEdit = edited("edit_a", "message_order", "older", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T05:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
    });
    await stub.applyBatch(input([latestEdit], { tenant_id: tenant }));
    await stub.applyBatch(input([olderEdit], { tenant_id: tenant }));

    await expect(rows<{ body: string; current_event_id: string }>(
      stub,
      "SELECT body, current_event_id FROM messages WHERE id = ?",
      "message_order",
    )).resolves.toEqual([{ body: "latest", current_event_id: "edit_z" }]);
    await expect(rows<{ last_message_preview: string; last_activity_at: string }>(
      stub,
      "SELECT last_message_preview, last_activity_at FROM conversations WHERE id = ?",
      "conversation_a",
    )).resolves.toEqual([{
      last_message_preview: "latest",
      last_activity_at: "2026-09-07T01:00:00.000Z",
    }]);

    const tieShort = edited("edit_tie", "message_order", "tie-short", {
      tenant_id: tenant,
      observed_at: "2026-09-07T06:00:01.000Z",
    });
    const tieLong = edited("edit_tie_long", "message_order", "tie-long", {
      tenant_id: tenant,
      observed_at: "2026-09-07T06:00:01.000Z",
    });
    await stub.applyBatch(input([tieLong, tieShort], { tenant_id: tenant }));
    await expect(rows<{ body: string; current_event_id: string }>(
      stub,
      "SELECT body, current_event_id FROM messages WHERE id = ?",
      "message_order",
    )).resolves.toEqual([{ body: "tie-long", current_event_id: "edit_tie_long" }]);

    const occurredLater = created("presentation_a", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T06:00:00.000Z",
      observed_at: "2026-09-07T07:00:01.000Z",
      payload: {
        message_id: "message_presentation_a",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Alice",
        body: "occurred-later",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    const occurredEarlier = created("presentation_b", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T05:00:00.000Z",
      observed_at: "2026-09-07T08:00:01.000Z",
      payload: {
        message_id: "message_presentation_b",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Alice",
        body: "occurred-earlier",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    await stub.applyBatch(input([occurredEarlier, occurredLater], { tenant_id: tenant }));
    await expect(rows<{ last_message_preview: string; last_activity_at: string }>(
      stub,
      "SELECT last_message_preview, last_activity_at FROM conversations WHERE id = ?",
      "conversation_a",
    )).resolves.toEqual([{
      last_message_preview: "occurred-later",
      last_activity_at: "2026-09-07T06:00:00.000Z",
    }]);
  });
});

