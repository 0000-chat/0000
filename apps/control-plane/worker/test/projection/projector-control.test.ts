import { env, runInDurableObject } from "cloudflare:test";
import type {
  ApplyProjectionBatchInput,
  ProjectionAuthorizationContext,
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import type { TenantProjectionDO } from "../../projection/tenant-projection";
import {
  auth,
  bindingFor,
  commandUpdated,
  created,
  deleted,
  deletionTombstone,
  deliveryUpdated,
  event,
  eventMarker,
  expectCode,
  input,
  initialize,
  rows,
} from "./projector-test-support";

describe("tenant projection control", () => {
  it("materializes Stage C control and deletion event families", async () => {
    const tenant = "tenant_projector_stage_c_smoke";
    const stub = await initialize(tenant);
    const events = [
      commandUpdated("stage_c_command"),
      deliveryUpdated("stage_c_delivery"),
      eventMarker("stage_c_replay_marker", "replay.tombstone"),
      eventMarker("stage_c_correction_marker", "correction.applied", "target_event_b"),
      deletionTombstone("stage_c_deletion", "conversation", "conversation_a"),
    ].map((nextEvent) => ({ ...nextEvent, tenant_id: tenant }));

    await stub.applyBatch(input(events, {
      tenant_id: tenant,
      connections: [bindingFor("account_a", "connection_a")],
    }));

    await expect(rows(stub, "SELECT id, status, failure_code FROM commands")).resolves.toEqual([{
      id: "command_a",
      status: "failed",
      failure_code: null,
    }]);
    await expect(rows(stub, "SELECT message_id, delivery_status, failure_code FROM message_delivery_updates")).resolves.toEqual([{
      message_id: "message_delivery_a",
      delivery_status: "failed",
      failure_code: null,
    }]);
    await expect(rows(stub, "SELECT target_event_id, tombstone_event_id, tombstone_type FROM event_tombstones ORDER BY target_event_id")).resolves.toEqual([
      { target_event_id: "target_event_a", tombstone_event_id: "stage_c_replay_marker", tombstone_type: "replay.tombstone" },
      { target_event_id: "target_event_b", tombstone_event_id: "stage_c_correction_marker", tombstone_type: "correction.applied" },
    ]);
    await expect(rows(stub, "SELECT resource_type, resource_id, reason_code FROM resource_tombstones")).resolves.toEqual([{
      resource_type: "conversation",
      resource_id: "conversation_a",
      reason_code: "retention",
    }]);
    await expect(rows(stub, "SELECT COUNT(*) AS count FROM applied_events")).resolves.toEqual([{ count: 5 }]);
    await expect(rows(stub, "SELECT COUNT(*) AS count FROM projection_changes")).resolves.toEqual([{ count: 5 }]);
  });

  it("projects command observations with observed LWW and earliest occurrence", async () => {
    const tenant = "tenant_projector_stage_c_commands";
    const stub = await initialize(tenant);
    await stub.applyBatch(input([commandUpdated("command_newer", "command_lww", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
    })], { tenant_id: tenant }));
    await stub.applyBatch(input([commandUpdated("command_older", "command_lww", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T01:00:00.000Z",
      observed_at: "2026-09-07T02:00:01.000Z",
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT operation, delivery_mode, status, failure_code, created_at, updated_at, last_event_id FROM commands WHERE id = ?", "command_lww")).resolves.toEqual([{
      operation: "message.send",
      delivery_mode: "direct",
      status: "failed",
      failure_code: "temporary",
      created_at: "2026-09-07T01:00:00.000Z",
      updated_at: "2026-09-07T03:00:00.000Z",
      last_event_id: "command_newer",
    }]);

    await stub.applyBatch(input([commandUpdated("command_cleared", "command_lww", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T04:00:00.000Z",
      observed_at: "2026-09-07T04:00:01.000Z",
      payload: {
        command_id: "command_lww",
        operation: "message.send",
        delivery_mode: "paced",
        status: "scheduled",
        failure_code: "must-clear",
      },
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT delivery_mode, status, failure_code, created_at, updated_at, last_event_id FROM commands WHERE id = ?", "command_lww")).resolves.toEqual([{
      delivery_mode: "paced",
      status: "scheduled",
      failure_code: null,
      created_at: "2026-09-07T01:00:00.000Z",
      updated_at: "2026-09-07T04:00:00.000Z",
      last_event_id: "command_cleared",
    }]);

    await stub.applyBatch(input([
      commandUpdated("command_tie", "command_lww", {
        tenant_id: tenant,
        observed_at: "2026-09-07T05:00:01.000Z",
        payload: {
          command_id: "command_lww",
          operation: "message.send",
          delivery_mode: "direct",
          status: "scheduled",
          failure_code: "tie-short",
        },
      }),
      commandUpdated("command_tie_long", "command_lww", {
        tenant_id: tenant,
        observed_at: "2026-09-07T05:00:01.000Z",
        payload: {
          command_id: "command_lww",
          operation: "message.send",
          delivery_mode: "paced",
          status: "failed",
          failure_code: "tie-long",
        },
      }),
    ], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT delivery_mode, status, failure_code, last_event_id FROM commands WHERE id = ?", "command_lww")).resolves.toEqual([{
      delivery_mode: "paced",
      status: "failed",
      failure_code: "tie-long",
      last_event_id: "command_tie_long",
    }]);

    await stub.applyBatch(input([commandUpdated("command_failed_after_delete", "command_lww", {
      tenant_id: tenant,
      observed_at: "2026-09-07T05:00:01.000Z",
    })], { tenant_id: tenant }));
    await stub.applyBatch(input([deletionTombstone("command_conversation_delete", "conversation", "conversation_a", {
      tenant_id: tenant,
      observed_at: "2026-09-07T06:00:01.000Z",
    })], { tenant_id: tenant }));
    await stub.applyBatch(input([commandUpdated("command_failed_post_delete", "command_lww", {
      tenant_id: tenant,
      observed_at: "2026-09-07T07:00:01.000Z",
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT status, failure_code FROM commands WHERE id = ?", "command_lww")).resolves.toEqual([{
      status: "failed",
      failure_code: null,
    }]);
  });

  it("reconciles delivery observations before and after message creation", async () => {
    const tenant = "tenant_projector_stage_c_delivery";
    const stub = await initialize(tenant);
    await stub.applyBatch(input([deliveryUpdated("delivery_before", "message_delivery_before", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T02:00:00.000Z",
      observed_at: "2026-09-07T02:00:01.000Z",
    })], { tenant_id: tenant }));
    await stub.applyBatch(input([created("delivery_message", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T01:00:00.000Z",
      observed_at: "2026-09-07T01:00:01.000Z",
      payload: {
        message_id: "message_delivery_before",
        direction: "outbound",
        sender_participant_id: null,
        sender_label: "Alice",
        body: "delivery",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT delivery_status, delivery_failure_code, delivery_observed_ms, delivery_event_id FROM messages WHERE id = ?", "message_delivery_before")).resolves.toEqual([{
      delivery_status: "failed",
      delivery_failure_code: "bridge_failed",
      delivery_observed_ms: Date.parse("2026-09-07T02:00:01.000Z"),
      delivery_event_id: "delivery_before",
    }]);

    await stub.applyBatch(input([deliveryUpdated("delivery_nonfailed", "message_delivery_before", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
      payload: {
        message_id: "message_delivery_before",
        delivery_status: "delivered",
        failure_code: "clear-me",
      },
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT delivery_status, delivery_failure_code FROM messages WHERE id = ?", "message_delivery_before")).resolves.toEqual([{
      delivery_status: "delivered",
      delivery_failure_code: null,
    }]);

    await stub.applyBatch(input([
      deliveryUpdated("delivery_tie", "message_delivery_before", {
        tenant_id: tenant,
        observed_at: "2026-09-07T04:00:01.000Z",
        payload: {
          message_id: "message_delivery_before",
          delivery_status: "sent",
          failure_code: "tie-short",
        },
      }),
      deliveryUpdated("delivery_tie_long", "message_delivery_before", {
        tenant_id: tenant,
        observed_at: "2026-09-07T04:00:01.000Z",
        payload: {
          message_id: "message_delivery_before",
          delivery_status: "failed",
          failure_code: "tie-long",
        },
      }),
    ], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT delivery_status, delivery_failure_code, delivery_event_id FROM messages WHERE id = ?", "message_delivery_before")).resolves.toEqual([{
      delivery_status: "failed",
      delivery_failure_code: "tie-long",
      delivery_event_id: "delivery_tie_long",
    }]);

    await stub.applyBatch(input([deleted("delivery_message_delete", "message_delivery_before", "gone", {
      tenant_id: tenant,
      observed_at: "2026-09-07T05:00:01.000Z",
    })], { tenant_id: tenant }));
    await stub.applyBatch(input([deliveryUpdated("delivery_after_delete", "message_delivery_before", {
      tenant_id: tenant,
      observed_at: "2026-09-07T06:00:01.000Z",
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT delivery_status, failure_code FROM message_delivery_updates WHERE message_id = ?", "message_delivery_before")).resolves.toEqual([{
      delivery_status: "failed",
      failure_code: null,
    }]);
    await expect(rows(stub, "SELECT delivery_failure_code FROM messages WHERE id = ?", "message_delivery_before")).resolves.toEqual([{ delivery_failure_code: null }]);
  });

  it("keeps event markers audit-only and resolves repeated winners by observed tuple", async () => {
    const tenant = "tenant_projector_stage_c_markers";
    const stub = await initialize(tenant);
    const markerOld = eventMarker("marker_old", "replay.tombstone", "marker_target", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T01:00:00.000Z",
      observed_at: "2026-09-07T01:00:01.000Z",
    });
    const markerNew = eventMarker("marker_new", "correction.applied", "marker_target", {
      tenant_id: tenant,
      occurred_at: "2026-09-07T03:00:00.000Z",
      observed_at: "2026-09-07T03:00:01.000Z",
      payload: {
        target_event_id: "marker_target",
        reason_code: "new-reason",
      },
    });
    await stub.applyBatch(input([markerNew, markerOld].map((item) => ({ ...item, tenant_id: tenant })), { tenant_id: tenant }));
    await stub.applyBatch(input([created("marker_target", {
      tenant_id: tenant,
      payload: {
        message_id: "message_marker_target",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Visible",
        body: "still visible",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    })], { tenant_id: tenant }));
    await expect(rows(stub, "SELECT body FROM messages WHERE id = ?", "message_marker_target")).resolves.toEqual([{ body: "still visible" }]);
    await expect(rows(stub, "SELECT target_event_id, tombstone_event_id, tombstone_type, reason_code, occurred_at FROM event_tombstones")).resolves.toEqual([{
      target_event_id: "marker_target",
      tombstone_event_id: "marker_new",
      tombstone_type: "correction.applied",
      reason_code: "new-reason",
      occurred_at: "2026-09-07T03:00:00.000Z",
    }]);
    await expect(rows(stub, "SELECT event_id FROM applied_events ORDER BY event_id")).resolves.toHaveLength(3);
    await expect(rows(stub, "SELECT event_id FROM projection_changes ORDER BY sequence")).resolves.toHaveLength(3);
  });

  it("rejects Stage C owner reuse atomically across commands, delivery, markers, and deletions", async () => {
    const tenant = "tenant_projector_stage_c_owner_conflicts";
    const stub = await initialize(tenant);
    const ownerB = (eventId: string, payload: Record<string, unknown>, eventType: ProjectionEventEnvelope["event_type"]): ProjectionEventEnvelope => event(eventId, payload, eventType, {
      tenant_id: tenant,
      identity_id: "identity_b",
      account_id: "account_b",
      conversation_id: "conversation_b",
    } as Partial<ProjectionEventEnvelope>);
    const bindingB = bindingFor("account_b", "connection_b", "identity_b");
    const inputB = (events: ProjectionEventEnvelope[]) => input(events, {
      tenant_id: tenant,
      authorization: auth(["projection.write"], ["identity_a", "identity_b"], tenant),
      connections: [bindingB],
    });

    await stub.applyBatch(input([commandUpdated("owner_command_a", "owner_command", { tenant_id: tenant })], { tenant_id: tenant }));
    await expectCode(stub, inputB([ownerB("owner_command_b", {
      command_id: "owner_command",
      operation: "message.send",
      delivery_mode: "direct",
      status: "failed",
      failure_code: "cross-owner",
    }, "command.updated")]), "projection_conflict");

    await stub.applyBatch(input([deliveryUpdated("owner_delivery_a", "owner_delivery_message", { tenant_id: tenant })], { tenant_id: tenant }));
    await expectCode(stub, inputB([ownerB("owner_delivery_b", {
      message_id: "owner_delivery_message",
      delivery_status: "failed",
      failure_code: "cross-owner",
    }, "bridge.delivery.updated")]), "projection_conflict");

    await stub.applyBatch(input([eventMarker("owner_marker_a", "replay.tombstone", "owner_marker_target", { tenant_id: tenant })], { tenant_id: tenant }));
    await expectCode(stub, inputB([ownerB("owner_marker_b", {
      target_event_id: "owner_marker_target",
      reason_code: "cross-owner",
    }, "correction.applied")]), "projection_conflict");

    await stub.applyBatch(input([created("owner_message_create", { tenant_id: tenant })], { tenant_id: tenant }));
    await expectCode(stub, inputB([ownerB("owner_message_delete", {
      resource_type: "message",
      resource_id: "message_a",
      reason_code: "cross-owner",
    }, "deletion.tombstone")]), "projection_conflict");

    await expect(rows(stub, "SELECT COUNT(*) AS count FROM applied_events")).resolves.toEqual([{ count: 4 }]);
    await expect(rows(stub, "SELECT COUNT(*) AS count FROM projection_changes")).resolves.toEqual([{ count: 4 }]);
    await expect(rows(stub, "SELECT failure_code FROM commands WHERE id = ?", "owner_command")).resolves.toEqual([{ failure_code: "temporary" }]);
  });

  it("rejects pending delivery IDs reused by commands", async () => {
    const tenant = "tenant_projector_stage_c_pending_delivery_id";
    const stub = await initialize(tenant);
    await stub.applyBatch(input([deliveryUpdated("pending_delivery_id", "shared_resource_id", { tenant_id: tenant })], { tenant_id: tenant }));
    await expectCode(stub, input([commandUpdated("pending_delivery_command", "shared_resource_id", { tenant_id: tenant })], { tenant_id: tenant }), "projection_conflict");
    await expect(rows(stub, "SELECT COUNT(*) AS count FROM commands")).resolves.toEqual([{ count: 0 }]);
    await expect(rows(stub, "SELECT message_id FROM message_delivery_updates")).resolves.toEqual([{ message_id: "shared_resource_id" }]);
  });

  it("rejects marker ownership mismatch both before and after its target", async () => {
    const beforeTenant = "tenant_projector_stage_c_marker_before_owner";
    const beforeStub = await initialize(beforeTenant);
    await beforeStub.applyBatch(input([eventMarker("marker_before_owner", "replay.tombstone", "marker_before_target", {
      tenant_id: beforeTenant,
    })], { tenant_id: beforeTenant }));
    const beforeTarget = created("marker_before_target", {
      tenant_id: beforeTenant,
      account_id: "account_b",
      conversation_id: "conversation_b",
      identity_id: "identity_b",
      payload: {
        message_id: "marker_before_message",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "wrong owner",
        body: "wrong owner",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    await expectCode(beforeStub, input([beforeTarget], {
      tenant_id: beforeTenant,
      authorization: auth(["projection.write"], ["identity_a", "identity_b"], beforeTenant),
      connections: [bindingFor("account_b", "connection_b", "identity_b")],
    }), "projection_conflict");
    await expect(rows(beforeStub, "SELECT COUNT(*) AS count FROM applied_events")).resolves.toEqual([{ count: 1 }]);

    const afterTenant = "tenant_projector_stage_c_marker_after_owner";
    const afterStub = await initialize(afterTenant);
    await afterStub.applyBatch(input([created("marker_after_target", {
      tenant_id: afterTenant,
      payload: {
        message_id: "marker_after_message",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "target",
        body: "target",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    })], { tenant_id: afterTenant }));
    const afterMarker = eventMarker("marker_after_owner", "correction.applied", "marker_after_target", {
      tenant_id: afterTenant,
      account_id: "account_b",
      conversation_id: "conversation_b",
      identity_id: "identity_b",
    });
    await expectCode(afterStub, input([afterMarker], {
      tenant_id: afterTenant,
      authorization: auth(["projection.write"], ["identity_a", "identity_b"], afterTenant),
      connections: [bindingFor("account_b", "connection_b", "identity_b")],
    }), "projection_conflict");
    await expect(rows(afterStub, "SELECT COUNT(*) AS count FROM event_tombstones")).resolves.toEqual([{ count: 0 }]);
  });
});
