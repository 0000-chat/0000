import { env } from "cloudflare:test";
import type {
  ProjectionEventEnvelope,
  WebhookMessage,
  WebhookSubscription,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deliverIncomingWebhookBatch,
  fanOutIncomingWebhookDeliveries,
  reconcileWebhookRemovalDeliveries,
  type WebhookProjection,
} from "../webhooks/delivery";
import { recordRemovalWithSuppression } from "../removals/service";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const fixedNow = new Date("2026-09-14T00:00:00.000Z");

const subscription = (input: {
  id: string;
  eventTypes?: string[];
  destinationVersion?: number;
  chatEnabled?: boolean;
  creatorPrincipalId?: string;
  creatorMembershipId?: string;
  creatorIdentityId?: string;
}): WebhookSubscription => ({
  id: input.id,
  tenant_id: "tenant_pilot",
  owner_installation_id: null,
  owner_principal_id: input.creatorPrincipalId ?? "principal_human",
  creator_principal_id: input.creatorPrincipalId ?? "principal_human",
  creator_membership_id: input.creatorMembershipId ?? "membership_human",
  creator_identity_id: input.creatorIdentityId ?? "identity_human",
  logical_agent_id: null,
  ownership_mode: "human_owner",
  destination: {
    url: "https://hooks.example.test/revisions",
    credential_ref: null,
  },
  destination_version: input.destinationVersion ?? 1,
  event_filter: {
    event_types: input.eventTypes ?? ["message.created"],
  },
  global_enabled: true,
  account_rules: [{ account_id: "account_human", enabled: true }],
  chat_rules:
    input.chatEnabled === undefined
      ? []
      : [
          {
            account_id: "account_human",
            chat_id: "conversation_one",
            enabled: input.chatEnabled,
          },
        ],
  status: "active",
  created_at: fixedNow.toISOString(),
  updated_at: fixedNow.toISOString(),
  revoked_at: null,
});

const insertSubscription = async (
  value: WebhookSubscription,
): Promise<void> => {
  const db = workerEnv.CONTROL_DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO webhook_subscriptions
         (id, tenant_id, creation_idempotency_key, owner_installation_id,
          owner_principal_id, creator_principal_id, creator_membership_id,
          creator_identity_id, logical_agent_id, ownership_mode,
          destination_url, destination_credential_ref, destination_version,
          event_filter_json, global_enabled, status, created_at, updated_at,
          revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        value.id,
        value.tenant_id,
        `${value.id}_creation`,
        value.owner_installation_id,
        value.owner_principal_id,
        value.creator_principal_id,
        value.creator_membership_id,
        value.creator_identity_id,
        value.logical_agent_id,
        value.ownership_mode,
        value.destination.url,
        value.destination.credential_ref,
        value.destination_version,
        JSON.stringify(value.event_filter),
        value.global_enabled ? 1 : 0,
        value.status,
        value.created_at,
        value.updated_at,
        value.revoked_at,
      ),
    db
      .prepare(
        `INSERT INTO webhook_subscription_account_rules
         (tenant_id, subscription_id, account_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        value.tenant_id,
        value.id,
        "account_human",
        1,
        value.created_at,
        value.updated_at,
      ),
    ...(value.chat_rules.length === 0
      ? []
      : [
          db
            .prepare(
              `INSERT INTO webhook_subscription_chat_rules
               (tenant_id, subscription_id, account_id, chat_id, enabled,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              value.tenant_id,
              value.id,
              "account_human",
              "conversation_one",
              value.chat_rules[0]?.enabled ? 1 : 0,
              value.created_at,
              value.updated_at,
            ),
        ]),
    db
      .prepare(
        `INSERT INTO account_grants
         (id, tenant_id, membership_id, identity_id, account_id,
          operation_scope, chat_scope, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'webhook.manage', 'all_chats', 'active', ?, ?)
         ON CONFLICT(tenant_id, membership_id, identity_id, account_id, operation_scope)
         DO NOTHING`,
      )
      .bind(
        `${value.id}_grant`,
        value.tenant_id,
        value.creator_membership_id,
        value.creator_identity_id,
        "account_human",
        value.created_at,
        value.updated_at,
      ),
  ]);
};

const createdEvent = (
  eventId = "event_revision_created",
): Extract<ProjectionEventEnvelope, { event_type: "message.created" }> => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "message.created",
  event_source: "live",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  platform: "whatsapp",
  account_id: "account_human",
  conversation_id: "conversation_one",
  matrix_room_id: "!room:example.test",
  matrix_event_id: "$event:example.test",
  remote_message_id: "remote_message_revision",
  occurred_at: fixedNow.toISOString(),
  observed_at: fixedNow.toISOString(),
  payload: {
    message_id: "message_revision_one",
    direction: "inbound",
    sender_participant_id: "participant_one",
    sender_label: "Alice",
    body: "before edit",
    reply_to_message_id: null,
    delivery_status: "delivered",
    unread: true,
  },
});

const editedEvent = (
  eventId = "event_revision_edit",
): Extract<ProjectionEventEnvelope, { event_type: "message.edited" }> => ({
  ...createdEvent("event_revision_created"),
  event_id: eventId,
  event_type: "message.edited",
  payload: {
    message_id: "message_revision_one",
    body: "after edit",
    editor_participant_id: "participant_one",
  },
});

const deletedEvent = (
  eventId = "event_revision_deleted",
): Extract<ProjectionEventEnvelope, { event_type: "message.deleted" }> => ({
  ...createdEvent("event_revision_created"),
  event_id: eventId,
  event_type: "message.deleted",
  event_source: "deletion",
  payload: {
    message_id: "message_revision_one",
    reason_code: "requested",
  },
});

const message = (
  body: string,
  revision: string,
  deletedAt: string | null = null,
  attachments: WebhookMessage["attachments"] = [],
): WebhookMessage => ({
  message_id: "message_revision_one",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  account_id: "account_human",
  connection_id: "connection_human_whatsapp",
  conversation_id: "conversation_one",
  platform: "whatsapp",
  direction: "inbound",
  sender_participant_id: deletedAt === null ? "participant_one" : null,
  sender_label: deletedAt === null ? "Alice" : "Deleted sender",
  body: deletedAt === null ? body : "",
  occurred_at: fixedNow.toISOString(),
  revision,
  remote_message_id: deletedAt === null ? "remote_message_revision" : null,
  matrix_room_id: deletedAt === null ? "!room:example.test" : null,
  matrix_event_id: deletedAt === null ? "$event:example.test" : null,
  deleted_at: deletedAt,
  attachments,
});

const attachment = (): WebhookMessage["attachments"][number] => ({
  attachment_id: "attachment_revision_one",
  message_id: "message_revision_one",
  identity_id: "identity_human",
  account_id: "account_human",
  connection_id: "connection_human_whatsapp",
  conversation_id: "conversation_one",
  platform: "whatsapp",
  file_name: "proof.txt",
  mime_type: "text/plain",
  size_bytes: 12,
  sha256: "a".repeat(64),
  revision: "event_revision_attachment",
  expires_at: null,
});

const projectionFor = (
  current: () => WebhookMessage | null,
): WebhookProjection => ({
  getWebhookMessage: async () => current(),
});

const rowFor = async (id: string) =>
  workerEnv.CONTROL_DB.prepare(
    `SELECT id, event_type, source_event_id, source_message_id, status,
            destination_version, payload_json, cancellation_reason
     FROM webhook_deliveries WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      event_type: string;
      source_event_id: string;
      source_message_id: string;
      status: string;
      destination_version: number;
      payload_json: string | null;
      cancellation_reason: string | null;
    }>();

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
});

describe("webhook revision and removal deliveries", () => {
  it("keeps edit delivery ids distinct while duplicate source edits converge", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_revision",
        eventTypes: ["message.created", "message.edited"],
      }),
    );
    const [createdId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent()],
      now: () => fixedNow,
    });
    const requests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("before edit", "event_revision_created"),
      ),
      deliveryIds: [createdId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });

    const firstEdit = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [editedEvent()],
      now: () => fixedNow,
    });
    const duplicateEdit = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [editedEvent()],
      now: () => fixedNow,
    });
    expect(firstEdit).toHaveLength(1);
    expect(firstEdit).toEqual(duplicateEdit);
    expect(firstEdit[0]).not.toBe(createdId);

    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("after edit", "event_revision_edit"),
      ),
      deliveryIds: firstEdit,
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });
    expect(requests).toHaveLength(2);
    const initialPayload = (await requests[0]?.json()) as Record<
      string,
      unknown
    >;
    const editPayload = (await requests[1]?.json()) as Record<string, unknown>;
    expect(initialPayload).toMatchObject({
      type: "message.created",
      source_message_id: "message_revision_one",
    });
    expect(editPayload).toMatchObject({
      type: "message.edited",
      source_event_id: "event_revision_edit",
      source_message_id: "message_revision_one",
      revision: "event_revision_edit",
      text: "after edit",
    });
    expect(editPayload.delivery_id).not.toBe(initialPayload.delivery_id);
    expect(await rowFor(firstEdit[0] ?? "")).toMatchObject({
      event_type: "message.edited",
      source_event_id: "event_revision_edit",
      status: "delivered",
    });

    const secondEdit = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [editedEvent("event_revision_edit_2")],
      now: () => fixedNow,
    });
    expect(secondEdit).toHaveLength(1);
    expect(secondEdit[0]).not.toBe(firstEdit[0]);
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("after second edit", "event_revision_edit_2"),
      ),
      deliveryIds: secondEdit,
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });
    expect(requests).toHaveLength(3);
    const secondEditPayload = (await requests[2]?.json()) as Record<
      string,
      unknown
    >;
    expect(secondEditPayload).toMatchObject({
      type: "message.edited",
      source_event_id: "event_revision_edit_2",
      revision: "event_revision_edit_2",
      text: "after second edit",
    });
  });

  it("sends content-free removal metadata only to a previously notified destination", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_notified",
        eventTypes: ["message.created", "message.deleted"],
      }),
    );
    await insertSubscription(
      subscription({
        id: "webhook_pending",
        eventTypes: ["message.created", "message.deleted"],
      }),
    );
    await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent("event_removal_created")],
      now: () => fixedNow,
    });
    const rows = await workerEnv.CONTROL_DB.prepare(
      "SELECT id, subscription_id FROM webhook_deliveries WHERE source_event_id = ? ORDER BY subscription_id",
    )
      .bind("event_removal_created")
      .all<{ id: string; subscription_id: string }>();
    const notified = rows.results.find(
      (row) => row.subscription_id === "webhook_notified",
    );
    const pending = rows.results.find(
      (row) => row.subscription_id === "webhook_pending",
    );
    expect(notified?.id).toBeDefined();
    expect(pending?.id).toBeDefined();
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("before edit", "event_removal_created"),
      ),
      deliveryIds: [notified?.id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    await recordRemovalWithSuppression(workerEnv.CONTROL_DB, {
      tenant_id: "tenant_pilot",
      resource_type: "message",
      resource_id: "message_revision_one",
      content_generation: "message_revision_one",
      account_id: "account_human",
      conversation_id: "conversation_one",
      source_event_id: "event_removal_deleted",
      source_object_key: null,
      reason: "requested",
      removed_at: fixedNow.toISOString(),
    });
    const removalIds = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [deletedEvent()],
      now: () => fixedNow,
    });
    expect(removalIds).toHaveLength(1);
    expect(await rowFor(pending?.id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "source_removed",
    });
    const removalRequests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("", "event_removal_deleted", fixedNow.toISOString()),
      ),
      deliveryIds: removalIds,
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          removalRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });
    const removalPayload = (await removalRequests[0]?.json()) as Record<
      string,
      unknown
    >;
    expect(removalPayload).toMatchObject({
      type: "message.deleted",
      source_message_id: "message_revision_one",
      text: "",
      removal_reason: "requested",
    });
    expect(removalPayload).not.toHaveProperty("body");
    expect(removalPayload).not.toHaveProperty("download_grant");
    expect(removalPayload).not.toHaveProperty("provider_token");
  });

  it("does not create revisions after chat disable or destination cutover", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_revision_policy",
        eventTypes: ["message.created", "message.edited"],
        chatEnabled: true,
      }),
    );
    const [createdId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent("event_policy_created")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("before edit", "event_policy_created"),
      ),
      deliveryIds: [createdId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_subscription_chat_rules SET enabled = 0 WHERE subscription_id = ?",
    )
      .bind("webhook_revision_policy")
      .run();
    await expect(
      fanOutIncomingWebhookDeliveries({
        database: workerEnv.CONTROL_DB,
        tenantId: "tenant_pilot",
        events: [editedEvent("event_policy_disabled")],
        now: () => fixedNow,
      }),
    ).resolves.toEqual([]);
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_subscriptions SET destination_version = 2 WHERE id = ?",
    )
      .bind("webhook_revision_policy")
      .run();
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_subscription_chat_rules SET enabled = 1 WHERE subscription_id = ?",
    )
      .bind("webhook_revision_policy")
      .run();
    await expect(
      fanOutIncomingWebhookDeliveries({
        database: workerEnv.CONTROL_DB,
        tenantId: "tenant_pilot",
        events: [editedEvent("event_policy_cutover")],
        now: () => fixedNow,
      }),
    ).resolves.toEqual([]);
  });

  it("rechecks the grant during edit hydration and suppresses an in-flight delete", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_edit_race",
        eventTypes: ["message.created", "message.edited"],
      }),
    );
    const [createdId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent("event_race_created")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("before edit", "event_race_created"),
      ),
      deliveryIds: [createdId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    const [editId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [editedEvent("event_race_edit")],
      now: () => fixedNow,
    });
    let removalRecorded = false;
    let fetchCount = 0;
    const projection: WebhookProjection = {
      getWebhookMessage: async () => {
        if (!removalRecorded) {
          removalRecorded = true;
          await recordRemovalWithSuppression(workerEnv.CONTROL_DB, {
            tenant_id: "tenant_pilot",
            resource_type: "message",
            resource_id: "message_revision_one",
            content_generation: "message_revision_one",
            account_id: "account_human",
            conversation_id: "conversation_one",
            source_event_id: "event_race_delete",
            source_object_key: null,
            reason: "requested",
            removed_at: fixedNow.toISOString(),
          });
        }
        return message("after edit", "event_race_edit");
      },
    };
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection,
      deliveryIds: [editId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });
    expect(fetchCount).toBe(0);
    expect(await rowFor(editId ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "source_removed",
    });

    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
    await seedAccountAccess(workerEnv.CONTROL_DB);
    await insertSubscription(
      subscription({
        id: "webhook_grant_race",
        eventTypes: ["message.created", "message.edited"],
        creatorPrincipalId: "principal_agent",
        creatorMembershipId: "membership_agent",
      }),
    );
    const [grantCreatedId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent("event_grant_created")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("before edit", "event_grant_created"),
      ),
      deliveryIds: [grantCreatedId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    const [grantEditId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [editedEvent("event_grant_edit")],
      now: () => fixedNow,
    });
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', updated_at = ?, revoked_at = ? WHERE id = ?",
    )
      .bind(
        fixedNow.toISOString(),
        fixedNow.toISOString(),
        "webhook_grant_race_grant",
      )
      .run();
    fetchCount = 0;
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("after edit", "event_grant_edit"),
      ),
      deliveryIds: [grantEditId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });
    expect(fetchCount).toBe(0);
    expect(await rowFor(grantEditId ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "authorization_revoked",
    });
  });

  it("reconciles an expiry authority for a previously notified conversation", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_expiry",
        eventTypes: ["message.created", "message.deleted"],
      }),
    );
    const [createdId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent("event_expiry_created")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("before expiry", "event_expiry_created"),
      ),
      deliveryIds: [createdId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    await recordRemovalWithSuppression(workerEnv.CONTROL_DB, {
      tenant_id: "tenant_pilot",
      resource_type: "conversation",
      resource_id: "conversation_one",
      content_generation: "conversation_one",
      account_id: "account_human",
      conversation_id: "conversation_one",
      source_event_id: "event_expiry_authority",
      source_object_key: null,
      reason: "expired",
      removed_at: fixedNow.toISOString(),
    });
    const removalIds = await reconcileWebhookRemovalDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      now: () => fixedNow,
    });
    expect(removalIds).toHaveLength(1);
    const removalRequests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("", "event_expiry_authority", fixedNow.toISOString()),
      ),
      deliveryIds: removalIds,
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          removalRequests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });
    const payload = (await removalRequests[0]?.json()) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      type: "message.deleted",
      text: "",
      removal_reason: "expired",
      content_generation: "conversation_one",
    });
  });

  it("strips download grants when an attachment authority is reconciled", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_attachment_removal",
        eventTypes: ["message.created", "message.deleted"],
      }),
    );
    const [createdId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [createdEvent("event_attachment_created")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("with attachment", "event_attachment_created", null, [
          attachment(),
        ]),
      ),
      deliveryIds: [createdId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 202 }),
      },
    });
    await recordRemovalWithSuppression(workerEnv.CONTROL_DB, {
      tenant_id: "tenant_pilot",
      resource_type: "attachment",
      resource_id: "attachment_revision_one",
      content_generation: "attachment_revision_one",
      account_id: "account_human",
      conversation_id: "conversation_one",
      source_event_id: "event_attachment_removed",
      source_object_key: "attachment_revision_one",
      reason: "retention",
      removed_at: fixedNow.toISOString(),
    });
    const removalIds = await reconcileWebhookRemovalDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      now: () => fixedNow,
    });
    expect(removalIds).toHaveLength(1);
    const requests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() =>
        message("", "event_attachment_removed", fixedNow.toISOString()),
      ),
      deliveryIds: removalIds,
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });
    const payload = (await requests[0]?.json()) as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        attachment_id: "attachment_revision_one",
        file_name: "proof.txt",
        size_bytes: 12,
      }),
    ]);
    expect(payload.attachments[0]).not.toHaveProperty("download_grant");
    expect(payload.attachments[0]).not.toHaveProperty("download_path");
  });
});
