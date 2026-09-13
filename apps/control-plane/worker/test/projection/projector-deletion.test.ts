import { runInDurableObject } from "cloudflare:test";
import type {
  ApplyProjectionBatchInput,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import type { TenantProjectionDO } from "../../projection/tenant-projection";
import {
  attachmentObserved,
  auth,
  bindingFor,
  commandUpdated,
  conversationUpdated,
  created,
  deleted,
  deletionTombstone,
  deliveryUpdated,
  edited,
  eventMarker,
  expectCode,
  initialize,
  input,
  ownerBOverrides,
  participantUpdated,
  reactionAdded,
  receipt,
  rows,
  typingStarted,
} from "./projector-test-support";

type UnresolvedClaimCase = {
  name: string;
  claimId: string;
  setup: (tenant: string) => ProjectionEventEnvelope[];
  ownerB: (tenant: string) => ProjectionEventEnvelope;
  sameOwner: (tenant: string) => ProjectionEventEnvelope;
};

const unresolvedClaimCases: UnresolvedClaimCase[] = [
  {
    name: "message_versions.message_id",
    claimId: "claim_edit_message",
    setup: (tenant) => [
      edited("claim_edit_before_create", "claim_edit_message", "pending body", {
        tenant_id: tenant,
      }),
    ],
    ownerB: (tenant) =>
      created("claim_edit_owner_b", {
        ...ownerBOverrides(tenant),
        payload: {
          message_id: "claim_edit_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner B",
          body: "owner B",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      } as Partial<ProjectionEventEnvelope>),
    sameOwner: (tenant) =>
      created("claim_edit_same_owner", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_edit_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner A",
          body: "owner A",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
  },
  {
    name: "messages.reply_to_message_id",
    claimId: "claim_reply_target",
    setup: (tenant) => [
      created("claim_reply_source", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_reply_source_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "source",
          body: "source",
          reply_to_message_id: "claim_reply_target",
          delivery_status: "unknown",
          unread: false,
        },
      }),
    ],
    ownerB: (tenant) =>
      created("claim_reply_owner_b", {
        ...ownerBOverrides(tenant),
        payload: {
          message_id: "claim_reply_target",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner B",
          body: "owner B",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      } as Partial<ProjectionEventEnvelope>),
    sameOwner: (tenant) =>
      created("claim_reply_same_owner", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_reply_target",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner A",
          body: "owner A",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
  },
  {
    name: "messages.sender_participant_id",
    claimId: "claim_sender_participant",
    setup: (tenant) => [
      created("claim_sender_source", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_sender_source_message",
          direction: "inbound",
          sender_participant_id: "claim_sender_participant",
          sender_label: "sender",
          body: "sender claim",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
    ],
    ownerB: (tenant) =>
      participantUpdated(
        "claim_sender_owner_b",
        "claim_sender_participant",
        ownerBOverrides(tenant),
      ),
    sameOwner: (tenant) =>
      participantUpdated(
        "claim_sender_same_owner",
        "claim_sender_participant",
        { tenant_id: tenant },
      ),
  },
  {
    name: "message_versions.editor_participant_id",
    claimId: "claim_editor_participant",
    setup: (tenant) => [
      edited("claim_editor_setup", "claim_editor_message", "editor claim", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_editor_message",
          body: "editor claim",
          editor_participant_id: "claim_editor_participant",
        },
      }),
    ],
    ownerB: (tenant) =>
      participantUpdated(
        "claim_editor_owner_b",
        "claim_editor_participant",
        ownerBOverrides(tenant),
      ),
    sameOwner: (tenant) =>
      participantUpdated(
        "claim_editor_same_owner",
        "claim_editor_participant",
        { tenant_id: tenant },
      ),
  },
  {
    name: "reactions.message_id",
    claimId: "claim_reaction_message",
    setup: (tenant) => [
      reactionAdded(
        "claim_reaction_message_setup",
        "claim_reaction_message_row",
        "claim_reaction_message",
        "claim_reaction_message_participant",
        "🔒",
        { tenant_id: tenant },
      ),
    ],
    ownerB: (tenant) =>
      created("claim_reaction_message_owner_b", {
        ...ownerBOverrides(tenant),
        payload: {
          message_id: "claim_reaction_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner B",
          body: "owner B",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      } as Partial<ProjectionEventEnvelope>),
    sameOwner: (tenant) =>
      created("claim_reaction_message_same_owner", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_reaction_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner A",
          body: "owner A",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
  },
  {
    name: "reactions.participant_id",
    claimId: "claim_reaction_participant",
    setup: (tenant) => [
      reactionAdded(
        "claim_reaction_participant_setup",
        "claim_reaction_participant_row",
        "claim_reaction_participant_message",
        "claim_reaction_participant",
        "🔒",
        { tenant_id: tenant },
      ),
    ],
    ownerB: (tenant) =>
      participantUpdated(
        "claim_reaction_participant_owner_b",
        "claim_reaction_participant",
        ownerBOverrides(tenant),
      ),
    sameOwner: (tenant) =>
      participantUpdated(
        "claim_reaction_participant_same_owner",
        "claim_reaction_participant",
        { tenant_id: tenant },
      ),
  },
  {
    name: "receipts.message_id",
    claimId: "claim_receipt_message",
    setup: (tenant) => [
      receipt(
        "claim_receipt_message_setup",
        "read",
        "claim_receipt_message",
        "claim_receipt_message_participant",
        false,
        { tenant_id: tenant },
      ),
    ],
    ownerB: (tenant) =>
      created("claim_receipt_message_owner_b", {
        ...ownerBOverrides(tenant),
        payload: {
          message_id: "claim_receipt_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner B",
          body: "owner B",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      } as Partial<ProjectionEventEnvelope>),
    sameOwner: (tenant) =>
      created("claim_receipt_message_same_owner", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_receipt_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner A",
          body: "owner A",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
  },
  {
    name: "receipts.participant_id",
    claimId: "claim_receipt_participant",
    setup: (tenant) => [
      receipt(
        "claim_receipt_participant_setup",
        "read",
        "claim_receipt_participant_message",
        "claim_receipt_participant",
        false,
        { tenant_id: tenant },
      ),
    ],
    ownerB: (tenant) =>
      participantUpdated(
        "claim_receipt_participant_owner_b",
        "claim_receipt_participant",
        ownerBOverrides(tenant),
      ),
    sameOwner: (tenant) =>
      participantUpdated(
        "claim_receipt_participant_same_owner",
        "claim_receipt_participant",
        { tenant_id: tenant },
      ),
  },
  {
    name: "typing_states.participant_id",
    claimId: "claim_typing_participant",
    setup: (tenant) => [
      typingStarted(
        "claim_typing_setup",
        "claim_typing_participant",
        "2026-09-07T01:30:00.000Z",
        { tenant_id: tenant },
      ),
    ],
    ownerB: (tenant) =>
      participantUpdated(
        "claim_typing_owner_b",
        "claim_typing_participant",
        ownerBOverrides(tenant),
      ),
    sameOwner: (tenant) =>
      participantUpdated(
        "claim_typing_same_owner",
        "claim_typing_participant",
        { tenant_id: tenant },
      ),
  },
  {
    name: "attachments.message_id",
    claimId: "claim_attachment_message",
    setup: (tenant) => [
      attachmentObserved(
        "claim_attachment_setup",
        "claim_attachment_row",
        "claim_attachment_message",
        { tenant_id: tenant },
      ),
    ],
    ownerB: (tenant) =>
      created("claim_attachment_message_owner_b", {
        ...ownerBOverrides(tenant),
        payload: {
          message_id: "claim_attachment_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner B",
          body: "owner B",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      } as Partial<ProjectionEventEnvelope>),
    sameOwner: (tenant) =>
      created("claim_attachment_message_same_owner", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_attachment_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner A",
          body: "owner A",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
  },
  {
    name: "message_delivery_updates.message_id",
    claimId: "claim_delivery_message",
    setup: (tenant) => [
      deliveryUpdated("claim_delivery_setup", "claim_delivery_message", {
        tenant_id: tenant,
      }),
    ],
    ownerB: (tenant) =>
      created("claim_delivery_message_owner_b", {
        ...ownerBOverrides(tenant),
        payload: {
          message_id: "claim_delivery_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner B",
          body: "owner B",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      } as Partial<ProjectionEventEnvelope>),
    sameOwner: (tenant) =>
      created("claim_delivery_message_same_owner", {
        tenant_id: tenant,
        payload: {
          message_id: "claim_delivery_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "owner A",
          body: "owner A",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
  },
];

describe("tenant projection deletion", () => {
  it("maps reused tombstone event IDs to projection_conflict", async () => {
    const tenant = "tenant_projector_stage_c_reused_tombstone_event_id";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          eventMarker(
            "shared_marker_event",
            "replay.tombstone",
            "marker_target_one",
            {
              tenant_id: tenant,
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expectCode(
      stub,
      input(
        [
          eventMarker(
            "shared_marker_event",
            "correction.applied",
            "marker_target_two",
            {
              tenant_id: tenant,
              payload: {
                target_event_id: "marker_target_two",
                reason_code: "reused",
              },
            },
          ),
        ],
        { tenant_id: tenant },
      ),
      "projection_conflict",
    );

    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "shared_deletion_event",
            "message",
            "reused_message_one",
            {
              tenant_id: tenant,
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expectCode(
      stub,
      input(
        [
          deletionTombstone(
            "shared_deletion_event",
            "message",
            "reused_message_two",
            {
              tenant_id: tenant,
            },
          ),
        ],
        { tenant_id: tenant },
      ),
      "projection_conflict",
    );
    await expect(
      rows(stub, "SELECT target_event_id FROM event_tombstones"),
    ).resolves.toEqual([{ target_event_id: "marker_target_one" }]);
    await expect(
      rows(stub, "SELECT resource_id FROM resource_tombstones"),
    ).resolves.toEqual([{ resource_id: "reused_message_one" }]);
  });

  it.each([
    [
      "message",
      "owner_target_message",
      async (
        stub: DurableObjectStub<TenantProjectionDO>,
        tenant: string,
      ): Promise<number> => {
        await stub.applyBatch(
          input(
            [created("owner_target_message_create", { tenant_id: tenant })],
            { tenant_id: tenant },
          ),
        );
        return 1;
      },
      (tenant: string) =>
        deletionTombstone(
          "owner_target_message_delete",
          "message",
          "message_a",
          { tenant_id: tenant },
        ),
    ],
    [
      "conversation",
      "conversation_a",
      async (
        stub: DurableObjectStub<TenantProjectionDO>,
        tenant: string,
      ): Promise<number> => {
        await stub.applyBatch(
          input(
            [
              conversationUpdated(
                "owner_target_conversation_create",
                undefined,
                { tenant_id: tenant },
              ),
            ],
            { tenant_id: tenant },
          ),
        );
        return 1;
      },
      (tenant: string) =>
        deletionTombstone(
          "owner_target_conversation_delete",
          "conversation",
          "conversation_a",
          { tenant_id: tenant },
        ),
    ],
    [
      "participant",
      "owner_target_participant",
      async (
        stub: DurableObjectStub<TenantProjectionDO>,
        tenant: string,
      ): Promise<number> => {
        await stub.applyBatch(
          input(
            [
              participantUpdated(
                "owner_target_participant_create",
                "owner_target_participant",
                { tenant_id: tenant },
              ),
            ],
            { tenant_id: tenant },
          ),
        );
        return 1;
      },
      (tenant: string) =>
        deletionTombstone(
          "owner_target_participant_delete",
          "participant",
          "owner_target_participant",
          { tenant_id: tenant },
        ),
    ],
    [
      "attachment",
      "owner_target_attachment",
      async (
        stub: DurableObjectStub<TenantProjectionDO>,
        tenant: string,
      ): Promise<number> => {
        await stub.applyBatch(
          input(
            [created("owner_target_attachment_message", { tenant_id: tenant })],
            { tenant_id: tenant },
          ),
        );
        await stub.applyBatch(
          input(
            [
              attachmentObserved(
                "owner_target_attachment_create",
                "owner_target_attachment",
                "message_a",
                { tenant_id: tenant },
              ),
            ],
            { tenant_id: tenant },
          ),
        );
        return 2;
      },
      (tenant: string) =>
        deletionTombstone(
          "owner_target_attachment_delete",
          "attachment",
          "owner_target_attachment",
          { tenant_id: tenant },
        ),
    ],
  ] as const)(
    "rejects %s target ownership mismatch atomically",
    async (_resourceType, _resourceId, setup, makeDeletion) => {
      const tenant = `tenant_projector_stage_c_delete_owner_${String(_resourceType)}`;
      const stub = await initialize(tenant);
      const setupCount = await setup(stub, tenant);
      const ownerBEvent = makeDeletion(tenant);
      const conflicting = {
        ...ownerBEvent,
        identity_id: "identity_b",
        account_id: "account_b",
        conversation_id: "conversation_b",
      } as ProjectionEventEnvelope;
      await expectCode(
        stub,
        input([conflicting], {
          tenant_id: tenant,
          authorization: auth(
            ["projection.write"],
            ["identity_a", "identity_b"],
            tenant,
          ),
          connections: [bindingFor("account_b", "connection_b", "identity_b")],
        }),
        "projection_conflict",
      );
      await expect(
        rows(stub, "SELECT COUNT(*) AS count FROM applied_events"),
      ).resolves.toEqual([{ count: setupCount }]);
      await expect(
        rows(stub, "SELECT COUNT(*) AS count FROM resource_tombstones"),
      ).resolves.toEqual([{ count: 0 }]);
    },
  );

  it("preserves child tombstone winners through a conversation cascade", async () => {
    const tenant = "tenant_projector_stage_c_child_tombstone_winners";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          participantUpdated(
            "child_tombstone_participant",
            "child_tombstone_participant",
            { tenant_id: tenant },
          ),
          created("child_tombstone_message_create", {
            tenant_id: tenant,
            payload: {
              message_id: "child_tombstone_message",
              direction: "inbound",
              sender_participant_id: "child_tombstone_participant",
              sender_label: "child sender",
              body: "child body",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: false,
            },
          }),
          attachmentObserved(
            "child_tombstone_attachment_observed",
            "child_tombstone_attachment",
            "child_tombstone_message",
            { tenant_id: tenant },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          deleted(
            "child_tombstone_message_delete",
            "child_tombstone_message",
            "message-reason",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T02:00:00.000Z",
              observed_at: "2026-09-07T02:00:01.000Z",
            },
          ),
          deletionTombstone(
            "child_tombstone_participant_delete",
            "participant",
            "child_tombstone_participant",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T03:00:00.000Z",
              observed_at: "2026-09-07T03:00:01.000Z",
            },
          ),
          deletionTombstone(
            "child_tombstone_attachment_delete",
            "attachment",
            "child_tombstone_attachment",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T04:00:00.000Z",
              observed_at: "2026-09-07T04:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "child_tombstone_conversation_delete",
            "conversation",
            "conversation_a",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T05:00:00.000Z",
              // The child tombstones have newer observed tuples and must retain their
              // own deletion metadata through the parent cascade.
              observed_at: "2026-09-07T01:00:01.000Z",
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
            "child_tombstone_attachment_late",
            "child_tombstone_attachment",
            "child_tombstone_message",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T06:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT deleted_at, deletion_reason FROM messages WHERE id = ?",
        "child_tombstone_message",
      ),
    ).resolves.toEqual([
      {
        deleted_at: "2026-09-07T02:00:00.000Z",
        deletion_reason: "message-reason",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT deleted_at FROM participants WHERE id = ?",
        "child_tombstone_participant",
      ),
    ).resolves.toEqual([{ deleted_at: "2026-09-07T03:00:00.000Z" }]);
    await expect(
      rows(
        stub,
        "SELECT deleted_at FROM attachments WHERE id = ?",
        "child_tombstone_attachment",
      ),
    ).resolves.toEqual([{ deleted_at: "2026-09-07T04:00:00.000Z" }]);
  });

  it("uses the tuple-maximal attachment, message, and conversation tombstone for redaction", async () => {
    const history = [
      created("attachment_tuple_message_create", {
        payload: {
          message_id: "attachment_tuple_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "attachment sender",
          body: "attachment body",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
        occurred_at: "2026-09-07T01:00:00.000Z",
        observed_at: "2026-09-07T01:00:01.000Z",
      }),
      attachmentObserved(
        "attachment_tuple_initial",
        "attachment_tuple_attachment",
        "attachment_tuple_message",
        {
          occurred_at: "2026-09-07T02:00:00.000Z",
          observed_at: "2026-09-07T02:00:01.000Z",
        },
      ),
      deletionTombstone(
        "attachment_tuple_attachment_delete",
        "attachment",
        "attachment_tuple_attachment",
        {
          occurred_at: "2026-09-07T02:30:00.000Z",
          observed_at: "2026-09-07T02:30:01.000Z",
        },
      ),
      deleted(
        "attachment_tuple_message_delete",
        "attachment_tuple_message",
        "message-retention",
        {
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
      deletionTombstone(
        "attachment_tuple_conversation_delete",
        "conversation",
        "conversation_a",
        {
          occurred_at: "2026-09-07T04:00:00.000Z",
          observed_at: "2026-09-07T04:00:01.000Z",
        },
      ),
      attachmentObserved(
        "attachment_tuple_late",
        "attachment_tuple_attachment",
        "attachment_tuple_message",
        {
          occurred_at: "2026-09-07T05:00:00.000Z",
          observed_at: "2026-09-07T05:00:01.000Z",
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
        message: state.storage.sql
          .exec("SELECT body, deleted_at, deletion_reason FROM messages")
          .toArray(),
        attachment: state.storage.sql
          .exec(
            "SELECT file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments",
          )
          .toArray(),
        tombstones: state.storage.sql
          .exec(
            "SELECT resource_type, resource_id, tombstone_event_id, reason_code, occurred_at, observed_ms FROM resource_tombstones ORDER BY resource_type, resource_id",
          )
          .toArray(),
      }));
    };

    const forward = await project(
      "tenant_projector_stage_c_attachment_tuple_forward",
      history,
    );
    const reverse = await project(
      "tenant_projector_stage_c_attachment_tuple_reverse",
      [...history].reverse(),
    );
    expect(reverse).toEqual(forward);
    expect(forward.message).toEqual([
      {
        body: "",
        deleted_at: "2026-09-07T04:00:00.000Z",
        deletion_reason: "retention",
      },
    ]);
    expect(forward.attachment).toEqual([
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
        deleted_at: "2026-09-07T04:00:00.000Z",
      },
    ]);
  });

  it("keeps the parent message tombstone winner through a conversation attachment cascade", async () => {
    const setup = [
      created("attachment_cascade_tuple_message_create", {
        payload: {
          message_id: "attachment_cascade_tuple_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "cascade sender",
          body: "cascade body",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
        occurred_at: "2026-09-07T00:00:00.000Z",
        observed_at: "2026-09-07T00:00:01.000Z",
      }),
      attachmentObserved(
        "attachment_cascade_tuple_attachment_create",
        "attachment_cascade_tuple_attachment",
        "attachment_cascade_tuple_message",
        {
          occurred_at: "2026-09-07T00:00:01.000Z",
          observed_at: "2026-09-07T00:00:02.000Z",
        },
      ),
    ];
    const attachmentDelete = deletionTombstone(
      "attachment_cascade_tuple_attachment_delete",
      "attachment",
      "attachment_cascade_tuple_attachment",
      {
        occurred_at: "2026-09-07T01:00:00.000Z",
        observed_at: "2026-09-07T01:00:01.000Z",
      },
    );
    const conversationDelete = deletionTombstone(
      "attachment_cascade_tuple_conversation_delete",
      "conversation",
      "conversation_a",
      {
        occurred_at: "2026-09-07T02:00:00.000Z",
        observed_at: "2026-09-07T02:00:01.000Z",
      },
    );
    const messageDelete = deleted(
      "attachment_cascade_tuple_message_delete",
      "attachment_cascade_tuple_message",
      "message-winner",
      {
        occurred_at: "2026-09-07T04:00:00.000Z",
        observed_at: "2026-09-07T03:00:01.000Z",
      },
    );
    const project = async (
      tenant: string,
      deletions: ProjectionEventEnvelope[],
    ) => {
      const stub = await initialize(tenant);
      await stub.applyBatch(
        input(
          setup.map((nextEvent) => ({ ...nextEvent, tenant_id: tenant })),
          { tenant_id: tenant },
        ),
      );
      for (const deletion of deletions) {
        await stub.applyBatch(
          input([{ ...deletion, tenant_id: tenant }], { tenant_id: tenant }),
        );
      }
      return runInDurableObject(stub, async (_instance, state) => ({
        attachment: state.storage.sql
          .exec(
            "SELECT file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments",
          )
          .toArray(),
        message: state.storage.sql
          .exec("SELECT body, deleted_at, deletion_reason FROM messages")
          .toArray(),
      }));
    };

    const messageAttachmentConversation = await project(
      "tenant_projector_stage_c_attachment_cascade_tuple_forward",
      [messageDelete, attachmentDelete, conversationDelete],
    );
    const attachmentConversationMessage = await project(
      "tenant_projector_stage_c_attachment_cascade_tuple_reverse",
      [attachmentDelete, conversationDelete, messageDelete],
    );
    expect(attachmentConversationMessage).toEqual(
      messageAttachmentConversation,
    );
    expect(messageAttachmentConversation.attachment).toEqual([
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
        deleted_at: "2026-09-07T04:00:00.000Z",
      },
    ]);
    expect(messageAttachmentConversation.message).toEqual([
      {
        body: "",
        deleted_at: "2026-09-07T04:00:00.000Z",
        deletion_reason: "message-winner",
      },
    ]);
  });

  it.each(unresolvedClaimCases)(
    "rejects owner-B and cross-family command claims for unresolved references",
    async (claim) => {
      const tenant = `tenant_projector_stage_c_unresolved_claim_${claim.name.replace(/[^a-z0-9]+/gi, "_")}`;
      const stub = await initialize(tenant);
      const ownerBInput = (
        nextEvent: ProjectionEventEnvelope,
      ): ApplyProjectionBatchInput =>
        input([nextEvent], {
          tenant_id: tenant,
          authorization: auth(
            ["projection.write"],
            ["identity_a", "identity_b"],
            tenant,
          ),
          connections: [bindingFor("account_b", "connection_b", "identity_b")],
        });
      const snapshot = async () =>
        runInDurableObject(stub, async (_instance, state) => {
          const tables = [
            "connection_bindings",
            "conversations",
            "participants",
            "messages",
            "message_versions",
            "reactions",
            "receipts",
            "typing_states",
            "attachments",
            "commands",
            "message_delivery_updates",
            "event_tombstones",
            "resource_tombstones",
            "applied_events",
            "projection_changes",
          ] as const;
          return tables.map((table) => ({
            table,
            rows: state.storage.sql
              .exec(`SELECT * FROM ${table} ORDER BY rowid`)
              .toArray(),
          }));
        });

      await stub.applyBatch(input(claim.setup(tenant), { tenant_id: tenant }));
      const beforeOwnerB = await snapshot();
      await expectCode(
        stub,
        ownerBInput(claim.ownerB(tenant)),
        "projection_conflict",
      );
      expect(await snapshot()).toEqual(beforeOwnerB);

      const beforeCommand = await snapshot();
      await expectCode(
        stub,
        input(
          [
            commandUpdated(`claim_command_${claim.name}`, claim.claimId, {
              tenant_id: tenant,
            }),
          ],
          { tenant_id: tenant },
        ),
        "projection_conflict",
      );
      expect(await snapshot()).toEqual(beforeCommand);

      await stub.applyBatch(
        input([claim.sameOwner(tenant)], { tenant_id: tenant }),
      );
    },
  );

  it("redacts each resource type before and after its target arrives", async () => {
    const tenant = "tenant_projector_stage_c_resource_tombstones";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "delete_message_first",
            "message",
            "message_deleted_first",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T01:00:00.000Z",
              observed_at: "2026-09-07T01:00:01.000Z",
            },
          ),
          deletionTombstone(
            "delete_participant_first",
            "participant",
            "participant_deleted_first",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T01:00:00.000Z",
              observed_at: "2026-09-07T01:00:02.000Z",
            },
          ),
          deletionTombstone(
            "delete_attachment_first",
            "attachment",
            "attachment_deleted_first",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T01:00:00.000Z",
              observed_at: "2026-09-07T01:00:03.000Z",
            },
          ),
        ].map((item) => ({ ...item, tenant_id: tenant })),
        { tenant_id: tenant },
      ),
    );

    await stub.applyBatch(
      input(
        [
          created("create_message_after_delete", {
            tenant_id: tenant,
            observed_at: "2026-09-07T02:00:01.000Z",
            payload: {
              message_id: "message_deleted_first",
              direction: "inbound",
              sender_participant_id: null,
              sender_label: "Secret sender",
              body: "secret body",
              reply_to_message_id: null,
              delivery_status: "sent",
              unread: true,
            },
          }),
          participantUpdated(
            "participant_after_delete",
            "participant_deleted_first",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:02.000Z",
            },
          ),
          attachmentObserved(
            "attachment_after_delete",
            "attachment_deleted_first",
            "message_deleted_first",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:03.000Z",
            },
          ),
        ].map((item) => ({ ...item, tenant_id: tenant })),
        { tenant_id: tenant },
      ),
    );

    await expect(
      rows(
        stub,
        "SELECT body, sender_label, deleted_at, deletion_reason FROM messages WHERE id = ?",
        "message_deleted_first",
      ),
    ).resolves.toEqual([
      {
        body: "",
        sender_label: "Deleted sender",
        deleted_at: "2026-09-07T01:00:00.000Z",
        deletion_reason: "retention",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT display_name, remote_id, avatar_url, deleted_at FROM participants WHERE id = ?",
        "participant_deleted_first",
      ),
    ).resolves.toEqual([
      {
        display_name: "Deleted participant",
        remote_id: null,
        avatar_url: null,
        deleted_at: "2026-09-07T01:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments WHERE id = ?",
        "attachment_deleted_first",
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
    ]);

    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "delete_message_loser",
            "message",
            "message_deleted_first",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T04:00:00.000Z",
              observed_at: "2026-09-07T04:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "delete_message_winner",
            "message",
            "message_deleted_first",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T05:00:00.000Z",
              observed_at: "2026-09-07T05:00:01.000Z",
              payload: {
                resource_type: "message",
                resource_id: "message_deleted_first",
                reason_code: "new-retention-reason",
              },
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT tombstone_event_id, reason_code, occurred_at FROM resource_tombstones WHERE resource_type = 'message' AND resource_id = ?",
        "message_deleted_first",
      ),
    ).resolves.toEqual([
      {
        tombstone_event_id: "delete_message_winner",
        reason_code: "new-retention-reason",
        occurred_at: "2026-09-07T05:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT body, deleted_at, deletion_reason FROM messages WHERE id = ?",
        "message_deleted_first",
      ),
    ).resolves.toEqual([
      {
        body: "",
        deleted_at: "2026-09-07T05:00:00.000Z",
        deletion_reason: "new-retention-reason",
      },
    ]);
  });

  it("scrubs participant references and blocks later identity updates", async () => {
    const tenant = "tenant_projector_stage_c_participant_delete";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          participantUpdated(
            "participant_identity",
            "participant_identity_deleted",
            { tenant_id: tenant },
          ),
          created("participant_message", {
            tenant_id: tenant,
            payload: {
              message_id: "participant_message",
              direction: "inbound",
              sender_participant_id: "participant_identity_deleted",
              sender_label: "Secret participant",
              body: "visible message",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: false,
            },
          }),
          edited("participant_edit", "participant_message", "edited message", {
            tenant_id: tenant,
            payload: {
              message_id: "participant_message",
              body: "edited message",
              editor_participant_id: "participant_identity_deleted",
            },
          }),
          reactionAdded(
            "participant_reaction",
            "participant_reaction",
            "participant_message",
            "participant_identity_deleted",
            "🔒",
            { tenant_id: tenant },
          ),
          receipt(
            "participant_receipt",
            "read",
            "participant_message",
            "participant_identity_deleted",
            false,
            { tenant_id: tenant },
          ),
          typingStarted(
            "participant_typing",
            "participant_identity_deleted",
            "2026-09-07T02:00:00.000Z",
            { tenant_id: tenant },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "participant_delete",
            "participant",
            "participant_identity_deleted",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T03:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT display_name, remote_id, avatar_url FROM participants WHERE id = ?",
        "participant_identity_deleted",
      ),
    ).resolves.toEqual([
      {
        display_name: "Deleted participant",
        remote_id: null,
        avatar_url: null,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT sender_participant_id, sender_label FROM messages WHERE id = ?",
        "participant_message",
      ),
    ).resolves.toEqual([
      {
        sender_participant_id: null,
        sender_label: "Deleted sender",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT body, editor_participant_id FROM message_versions WHERE message_id = ? ORDER BY event_id",
        "participant_message",
      ),
    ).resolves.toEqual([
      { body: "edited message", editor_participant_id: null },
      { body: "visible message", editor_participant_id: null },
    ]);
    await expect(rows(stub, "SELECT * FROM reactions")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM receipts")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM typing_states")).resolves.toEqual(
      [],
    );

    await stub.applyBatch(
      input(
        [
          participantUpdated(
            "participant_identity_later",
            "participant_identity_deleted",
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
        "SELECT display_name, remote_id, avatar_url FROM participants WHERE id = ?",
        "participant_identity_deleted",
      ),
    ).resolves.toEqual([
      {
        display_name: "Deleted participant",
        remote_id: null,
        avatar_url: null,
      },
    ]);
  });

  it("cascades conversation deletion and keeps summaries redacted for future events", async () => {
    const tenant = "tenant_projector_stage_c_conversation_delete";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          participantUpdated("cascade_participant", "cascade_participant", {
            tenant_id: tenant,
          }),
          created("cascade_message_create", {
            tenant_id: tenant,
            payload: {
              message_id: "cascade_message",
              direction: "inbound",
              sender_participant_id: "cascade_participant",
              sender_label: "Cascade secret",
              body: "cascade body",
              reply_to_message_id: null,
              delivery_status: "unknown",
              unread: true,
            },
          }),
          edited("cascade_message_edit", "cascade_message", "cascade edited", {
            tenant_id: tenant,
            payload: {
              message_id: "cascade_message",
              body: "cascade edited",
              editor_participant_id: "cascade_participant",
            },
          }),
          reactionAdded(
            "cascade_reaction",
            "cascade_reaction",
            "cascade_message",
            "cascade_participant",
            "💣",
            { tenant_id: tenant },
          ),
          receipt(
            "cascade_receipt",
            "read",
            "cascade_message",
            "cascade_participant",
            true,
            { tenant_id: tenant },
          ),
          typingStarted(
            "cascade_typing",
            "cascade_participant",
            "2026-09-07T03:00:00.000Z",
            { tenant_id: tenant },
          ),
          attachmentObserved(
            "cascade_attachment",
            "cascade_attachment",
            "cascade_message",
            { tenant_id: tenant },
          ),
          commandUpdated("cascade_command", "cascade_command", {
            tenant_id: tenant,
          }),
          deliveryUpdated("cascade_delivery", "cascade_message", {
            tenant_id: tenant,
          }),
        ],
        { tenant_id: tenant },
      ),
    );

    await stub.applyBatch(
      input(
        [
          deletionTombstone(
            "cascade_delete",
            "conversation",
            "conversation_a",
            {
              tenant_id: tenant,
              occurred_at: "2026-09-07T05:00:00.000Z",
              observed_at: "2026-09-07T05:00:01.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(
        stub,
        "SELECT title, last_message_preview, unread_count, message_count, attachment_count FROM conversations WHERE id = ?",
        "conversation_a",
      ),
    ).resolves.toEqual([
      {
        title: "Deleted conversation",
        last_message_preview: "",
        unread_count: 0,
        message_count: 0,
        attachment_count: 0,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT body, sender_participant_id, sender_label, deleted_at, delivery_failure_code FROM messages WHERE id = ?",
        "cascade_message",
      ),
    ).resolves.toEqual([
      {
        body: "",
        sender_participant_id: null,
        sender_label: "Deleted sender",
        deleted_at: "2026-09-07T05:00:00.000Z",
        delivery_failure_code: null,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT body, editor_participant_id FROM message_versions WHERE message_id = ? ORDER BY event_id",
        "cascade_message",
      ),
    ).resolves.toEqual([
      { body: "", editor_participant_id: null },
      { body: "", editor_participant_id: null },
    ]);
    await expect(
      rows(
        stub,
        "SELECT display_name, remote_id, avatar_url FROM participants",
      ),
    ).resolves.toEqual([
      {
        display_name: "Deleted participant",
        remote_id: null,
        avatar_url: null,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments",
      ),
    ).resolves.toEqual([
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
        deleted_at: "2026-09-07T05:00:00.000Z",
      },
    ]);
    await expect(rows(stub, "SELECT * FROM reactions")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM receipts")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM typing_states")).resolves.toEqual(
      [],
    );
    await expect(
      rows(
        stub,
        "SELECT failure_code FROM commands WHERE id = ?",
        "cascade_command",
      ),
    ).resolves.toEqual([{ failure_code: null }]);
    await expect(
      rows(
        stub,
        "SELECT failure_code FROM message_delivery_updates WHERE message_id = ?",
        "cascade_message",
      ),
    ).resolves.toEqual([{ failure_code: null }]);

    await stub.applyBatch(
      input(
        [
          conversationUpdated(
            "cascade_metadata_after",
            {
              title: "Leaked conversation",
              archived: true,
              muted: true,
            },
            { tenant_id: tenant, observed_at: "2026-09-07T06:00:01.000Z" },
          ),
          edited("cascade_edit_after", "cascade_message", "leaked body", {
            tenant_id: tenant,
            observed_at: "2026-09-07T06:00:02.000Z",
          }),
          participantUpdated(
            "cascade_participant_after",
            "cascade_participant",
            { tenant_id: tenant, observed_at: "2026-09-07T06:00:03.000Z" },
          ),
          attachmentObserved(
            "cascade_attachment_after",
            "cascade_attachment_after",
            "cascade_message",
            { tenant_id: tenant, observed_at: "2026-09-07T06:00:04.000Z" },
          ),
          commandUpdated("cascade_command_after", "cascade_command", {
            tenant_id: tenant,
            observed_at: "2026-09-07T06:00:05.000Z",
          }),
          deliveryUpdated("cascade_delivery_after", "cascade_message", {
            tenant_id: tenant,
            observed_at: "2026-09-07T06:00:06.000Z",
          }),
          created("cascade_message_after", {
            tenant_id: tenant,
            observed_at: "2026-09-07T06:00:07.000Z",
            payload: {
              message_id: "cascade_message_after",
              direction: "inbound",
              sender_participant_id: "cascade_participant",
              sender_label: "Leaked sender",
              body: "leaked body",
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
        "SELECT title, last_message_preview, unread_count, message_count, attachment_count FROM conversations WHERE id = ?",
        "conversation_a",
      ),
    ).resolves.toEqual([
      {
        title: "Deleted conversation",
        last_message_preview: "",
        unread_count: 0,
        message_count: 0,
        attachment_count: 0,
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT body, sender_label, deleted_at FROM messages ORDER BY id",
      ),
    ).resolves.toEqual([
      {
        body: "",
        sender_label: "Deleted sender",
        deleted_at: "2026-09-07T05:00:00.000Z",
      },
      {
        body: "",
        sender_label: "Deleted sender",
        deleted_at: "2026-09-07T05:00:00.000Z",
      },
    ]);
    await expect(
      rows(
        stub,
        "SELECT failure_code FROM commands WHERE id = ?",
        "cascade_command",
      ),
    ).resolves.toEqual([{ failure_code: null }]);
    await expect(
      rows(
        stub,
        "SELECT failure_code FROM message_delivery_updates WHERE message_id = ?",
        "cascade_message",
      ),
    ).resolves.toEqual([{ failure_code: null }]);
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, sha256, r2_key FROM attachments ORDER BY id",
      ),
    ).resolves.toEqual([
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
      },
      {
        file_name: null,
        mime_type: null,
        size_bytes: null,
        sha256: null,
        r2_key: null,
      },
    ]);
  });

  it("rejects participant ownership reuse and rolls back the conflicting event", async () => {
    const tenant = "tenant_projector_owner_conflict";
    const stub = await initialize(tenant);
    const first = participantUpdated(
      "participant_owner_first",
      "participant_owner",
      {
        tenant_id: tenant,
      },
    );
    await stub.applyBatch(input([first], { tenant_id: tenant }));
    const conflicting = participantUpdated(
      "participant_owner_conflict",
      "participant_owner",
      {
        tenant_id: tenant,
        conversation_id: "conversation_other",
      },
    );
    await expectCode(
      stub,
      input([conflicting], { tenant_id: tenant }),
      "projection_conflict",
    );
    await expect(
      rows<{ event_id: string }>(
        stub,
        "SELECT event_id FROM applied_events ORDER BY event_id",
      ),
    ).resolves.toEqual([{ event_id: first.event_id }]);
    await expect(
      rows<{ conversation_id: string }>(
        stub,
        "SELECT conversation_id FROM participants WHERE id = ?",
        "participant_owner",
      ),
    ).resolves.toEqual([{ conversation_id: "conversation_a" }]);
  });

  it("rejects unresolved participant references across connections and rolls back the transaction", async () => {
    const tenant = "tenant_projector_pending_participant_owner";
    const stub = await initialize(tenant);
    const first = created("pending_participant_first", {
      tenant_id: tenant,
      account_id: "account_a",
      conversation_id: "conversation_a",
      payload: {
        message_id: "message_pending_participant_a",
        direction: "inbound",
        sender_participant_id: "participant_pending_owner",
        sender_label: "Alice",
        body: "first",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    const second = created("pending_participant_second", {
      tenant_id: tenant,
      account_id: "account_b",
      conversation_id: "conversation_b",
      payload: {
        message_id: "message_pending_participant_b",
        direction: "inbound",
        sender_participant_id: "participant_pending_owner",
        sender_label: "Bob",
        body: "second",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    await expectCode(
      stub,
      input([first, second], {
        tenant_id: tenant,
        connections: [
          bindingFor("account_a", "connection_a"),
          bindingFor("account_b", "connection_b"),
        ],
      }),
      "projection_conflict",
    );

    for (const table of [
      "conversations",
      "participants",
      "messages",
      "message_versions",
      "resource_tombstones",
      "applied_events",
      "projection_changes",
      "projection_change_floors",
      "projection_checkpoints",
    ]) {
      await expect(rows(stub, `SELECT * FROM ${table}`)).resolves.toEqual([]);
    }
  });

  it.each(["message.edited", "message.deleted"] as const)(
    "rejects %s target IDs previously claimed as unresolved replies by another owner",
    async (eventType) => {
      const tenant = `tenant_projector_pending_reply_${eventType.replace(".", "_")}`;
      const stub = await initialize(tenant);
      const source = created("pending_reply_source", {
        tenant_id: tenant,
        account_id: "account_a",
        conversation_id: "conversation_a",
        payload: {
          message_id: "message_reply_source",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Source",
          body: "source",
          reply_to_message_id: "message_unresolved_target",
          delivery_status: "unknown",
          unread: false,
        },
      });
      const target =
        eventType === "message.edited"
          ? edited(
              "pending_reply_target",
              "message_unresolved_target",
              "target",
              {
                tenant_id: tenant,
                account_id: "account_b",
                conversation_id: "conversation_b",
              },
            )
          : deleted(
              "pending_reply_target",
              "message_unresolved_target",
              "gone",
              {
                tenant_id: tenant,
                account_id: "account_b",
                conversation_id: "conversation_b",
              },
            );
      await expectCode(
        stub,
        input([source, target], {
          tenant_id: tenant,
          connections: [
            bindingFor("account_a", "connection_a"),
            bindingFor("account_b", "connection_b"),
          ],
        }),
        "projection_conflict",
      );
      for (const table of [
        "conversations",
        "messages",
        "message_versions",
        "resource_tombstones",
        "applied_events",
        "projection_changes",
        "projection_change_floors",
        "projection_checkpoints",
      ]) {
        await expect(rows(stub, `SELECT * FROM ${table}`)).resolves.toEqual([]);
      }
    },
  );

  it("rejects two unresolved reply references to the same target across owners", async () => {
    const tenant = "tenant_projector_pending_reply_sources";
    const stub = await initialize(tenant);
    const first = created("pending_reply_source_first", {
      tenant_id: tenant,
      account_id: "account_a",
      conversation_id: "conversation_a",
      payload: {
        message_id: "message_reply_source_first",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "First",
        body: "first",
        reply_to_message_id: "message_unresolved_target_sources",
        delivery_status: "unknown",
        unread: false,
      },
    });
    const second = created("pending_reply_source_second", {
      tenant_id: tenant,
      account_id: "account_b",
      conversation_id: "conversation_b",
      payload: {
        message_id: "message_reply_source_second",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Second",
        body: "second",
        reply_to_message_id: "message_unresolved_target_sources",
        delivery_status: "unknown",
        unread: false,
      },
    });
    await expectCode(
      stub,
      input([first, second], {
        tenant_id: tenant,
        connections: [
          bindingFor("account_a", "connection_a"),
          bindingFor("account_b", "connection_b"),
        ],
      }),
      "projection_conflict",
    );
    await expect(rows(stub, "SELECT * FROM messages")).resolves.toEqual([]);
  });

  it.each(["message.deleted", "message.created", "message.edited"] as const)(
    "fails before mutating owner-A child rows when owner-B claims a message via %s",
    async (eventType) => {
      const tenant = `tenant_projector_child_owner_${eventType.replace(".", "_")}`;
      const stub = await initialize(tenant);
      await runInDurableObject(stub, async (_instance, state) => {
        const sql = state.storage.sql;
        sql.exec(
          "INSERT INTO reactions (id, message_id, identity_id, account_id, connection_id, conversation_id, platform, participant_id, emoji, occurred_at, last_observed_ms, last_event_id, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
          "reaction_owned",
          "message_child_owned",
          "identity_a",
          "account_a",
          "connection_a",
          "conversation_a",
          "whatsapp",
          "participant_a",
          "thumbsup",
          "2026-09-07T01:00:00.000Z",
          Date.parse("2026-09-07T01:00:01.000Z"),
          "reaction_event",
        );
        sql.exec(
          "INSERT INTO receipts (message_id, participant_id, receipt_type, identity_id, account_id, connection_id, conversation_id, platform, local_identity, occurred_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "message_child_owned",
          "participant_a",
          "read",
          "identity_a",
          "account_a",
          "connection_a",
          "conversation_a",
          "whatsapp",
          1,
          "2026-09-07T01:00:00.000Z",
          Date.parse("2026-09-07T01:00:01.000Z"),
          "receipt_event",
        );
        sql.exec(
          "INSERT INTO attachments (id, message_id, identity_id, account_id, connection_id, conversation_id, platform, file_name, mime_type, size_bytes, sha256, r2_key, observed_at, last_observed_ms, last_event_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
          "attachment_owned",
          "message_child_owned",
          "identity_a",
          "account_a",
          "connection_a",
          "conversation_a",
          "whatsapp",
          "file.txt",
          "text/plain",
          12,
          null,
          null,
          "2026-09-07T01:00:00.000Z",
          Date.parse("2026-09-07T01:00:01.000Z"),
          "attachment_event",
        );
        sql.exec(
          "INSERT INTO message_delivery_updates (message_id, identity_id, account_id, connection_id, conversation_id, platform, delivery_status, failure_code, occurred_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "message_child_owned",
          "identity_a",
          "account_a",
          "connection_a",
          "conversation_a",
          "whatsapp",
          "failed",
          "temporary",
          "2026-09-07T01:00:00.000Z",
          Date.parse("2026-09-07T01:00:01.000Z"),
          "delivery_event",
        );
      });
      const childRowsBefore = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          reactions: state.storage.sql
            .exec("SELECT * FROM reactions")
            .toArray(),
          receipts: state.storage.sql.exec("SELECT * FROM receipts").toArray(),
          attachments: state.storage.sql
            .exec("SELECT * FROM attachments")
            .toArray(),
          delivery: state.storage.sql
            .exec("SELECT * FROM message_delivery_updates")
            .toArray(),
        }),
      );

      const claim =
        eventType === "message.deleted"
          ? deleted("child_owner_claim", "message_child_owned", "gone", {
              tenant_id: tenant,
              account_id: "account_b",
              conversation_id: "conversation_b",
            })
          : eventType === "message.created"
            ? created("child_owner_claim", {
                tenant_id: tenant,
                account_id: "account_b",
                conversation_id: "conversation_b",
                payload: {
                  message_id: "message_child_owned",
                  direction: "inbound",
                  sender_participant_id: null,
                  sender_label: "Bob",
                  body: "body",
                  reply_to_message_id: null,
                  delivery_status: "unknown",
                  unread: false,
                },
              })
            : edited("child_owner_claim", "message_child_owned", "body", {
                tenant_id: tenant,
                account_id: "account_b",
                conversation_id: "conversation_b",
              });

      await expectCode(
        stub,
        input([claim], {
          tenant_id: tenant,
          connections: [bindingFor("account_b", "connection_b")],
        }),
        "projection_conflict",
      );

      for (const table of [
        "conversations",
        "participants",
        "messages",
        "message_versions",
        "resource_tombstones",
        "applied_events",
        "projection_changes",
        "projection_change_floors",
        "projection_checkpoints",
      ]) {
        await expect(rows(stub, `SELECT * FROM ${table}`)).resolves.toEqual([]);
      }
      const childRowsAfter = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          reactions: state.storage.sql
            .exec("SELECT * FROM reactions")
            .toArray(),
          receipts: state.storage.sql.exec("SELECT * FROM receipts").toArray(),
          attachments: state.storage.sql
            .exec("SELECT * FROM attachments")
            .toArray(),
          delivery: state.storage.sql
            .exec("SELECT * FROM message_delivery_updates")
            .toArray(),
        }),
      );
      expect(childRowsAfter).toEqual(childRowsBefore);
    },
  );

  it.each([
    [
      "reaction",
      reactionAdded(
        "owner_reaction_a",
        "owner_reaction",
        "owner_message",
        "owner_participant",
        "👍",
      ),
      reactionAdded(
        "owner_reaction_b",
        "owner_reaction",
        "owner_message",
        "owner_participant",
        "👎",
        {
          account_id: "account_b",
          conversation_id: "conversation_b",
          identity_id: "identity_b",
        },
      ),
    ],
    [
      "receipt",
      receipt(
        "owner_receipt_a",
        "read",
        "owner_receipt_message",
        "owner_receipt_participant",
        false,
      ),
      receipt(
        "owner_receipt_b",
        "read",
        "owner_receipt_message",
        "owner_receipt_participant",
        false,
        {
          account_id: "account_b",
          conversation_id: "conversation_b",
          identity_id: "identity_b",
        },
      ),
    ],
    [
      "typing",
      typingStarted("owner_typing_a", "owner_typing_participant"),
      typingStarted(
        "owner_typing_b",
        "owner_typing_participant",
        "2026-09-07T02:00:00.000Z",
        {
          account_id: "account_b",
          conversation_id: "conversation_b",
          identity_id: "identity_b",
        },
      ),
    ],
    [
      "attachment",
      attachmentObserved(
        "owner_attachment_a",
        "owner_attachment",
        "owner_attachment_message",
      ),
      attachmentObserved(
        "owner_attachment_b",
        "owner_attachment",
        "owner_attachment_message",
        {
          account_id: "account_b",
          conversation_id: "conversation_b",
          identity_id: "identity_b",
        },
      ),
    ],
  ] as const)(
    "rejects %s resource reuse across owners atomically",
    async (_family, first, conflicting) => {
      const tenant = `tenant_projector_stage_b_owner_${String(_family)}`;
      const stub = await initialize(tenant);
      await stub.applyBatch(
        input([{ ...first, tenant_id: tenant }], {
          tenant_id: tenant,
          authorization: auth(
            ["projection.write"],
            ["identity_a", "identity_b"],
            tenant,
          ),
        }),
      );
      const before = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          conversations: state.storage.sql
            .exec("SELECT * FROM conversations")
            .toArray(),
          children: state.storage.sql.exec("SELECT * FROM reactions").toArray(),
          applied: state.storage.sql
            .exec("SELECT * FROM applied_events")
            .toArray(),
          changes: state.storage.sql
            .exec("SELECT * FROM projection_changes")
            .toArray(),
        }),
      );
      await expectCode(
        stub,
        input([{ ...conflicting, tenant_id: tenant }], {
          tenant_id: tenant,
          authorization: auth(
            ["projection.write"],
            ["identity_a", "identity_b"],
            tenant,
          ),
          connections: [bindingFor("account_b", "connection_b", "identity_b")],
        }),
        "projection_conflict",
      );
      const after = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          conversations: state.storage.sql
            .exec("SELECT * FROM conversations")
            .toArray(),
          applied: state.storage.sql
            .exec("SELECT * FROM applied_events")
            .toArray(),
          changes: state.storage.sql
            .exec("SELECT * FROM projection_changes")
            .toArray(),
        }),
      );
      expect(after).toEqual({
        conversations: before.conversations,
        applied: before.applied,
        changes: before.changes,
      });
    },
  );

  it("does not resurrect reaction, receipt, or attachment content after a message tombstone", async () => {
    const tenant = "tenant_projector_stage_b_tombstone_gate";
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          deleted("stage_b_delete", "message_tombstone_gate", "gone", {
            tenant_id: tenant,
            observed_at: "2026-09-07T01:00:01.000Z",
          }),
        ],
        { tenant_id: tenant },
      ),
    );
    await stub.applyBatch(
      input(
        [
          reactionAdded(
            "stage_b_reaction_after_delete",
            "reaction_after_delete",
            "message_tombstone_gate",
            "participant_secret",
            "secret",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:01.000Z",
            },
          ),
          receipt(
            "stage_b_receipt_after_delete",
            "read",
            "message_tombstone_gate",
            "participant_secret",
            true,
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:02.000Z",
            },
          ),
          attachmentObserved(
            "stage_b_attachment_after_delete",
            "attachment_after_tombstone",
            "message_tombstone_gate",
            {
              tenant_id: tenant,
              observed_at: "2026-09-07T02:00:03.000Z",
            },
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    await expect(
      rows(stub, "SELECT participant_id, emoji FROM reactions"),
    ).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM receipts")).resolves.toEqual([]);
    await expect(
      rows(
        stub,
        "SELECT file_name, mime_type, size_bytes, sha256, r2_key, deleted_at FROM attachments",
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
    ]);
  });
});
