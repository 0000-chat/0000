import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import { archiveCanonicalEventBatch } from "../../archive/writer";
import { readRestoreReplayPage } from "../../archive/replay";
import { purgeRecordedRemoval } from "../../archive/lifecycle";
import { recordRemoval } from "../../removals/ledger";
import { cleanupArchiveTenant } from "../archive/support";
import { restoreProjectionFromArchive } from "../../restore/activation";
import type { TenantProjectionDO } from "../../projection/tenant-projection";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";

const workerEnv = env as Cloudflare.Env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const bucket = (env as Cloudflare.Env).EVENT_ARCHIVE;
const projection = () => workerEnv.TENANT_PROJECTION.getByName(tenantId);

const createTestApp = () =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        }
        throw new Error("invalid local test token");
      },
    }),
  });

const resetProjection = async (): Promise<
  DurableObjectStub<TenantProjectionDO>
> => {
  const stub = projection();
  await runInDurableObject(stub, async (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_sql_schema_migrations'",
      )
      .toArray();
    for (const table of tables) {
      if (!/^[A-Za-z0-9_]+$/u.test(table.name)) {
        throw new Error("unexpected projection table name");
      }
      state.storage.sql.exec(`DELETE FROM "${table.name}"`);
    }
  });
  await stub.initialize({
    schema_version: 1,
    tenant_id: tenantId,
    initialized_at: "2026-09-14T00:00:00.000Z",
    authorization: {
      schema_version: 1,
      tenant_id: tenantId,
      principal_id: "principal_restore_activation",
      allowed_identity_ids: [],
      scopes: ["projection.initialize"],
    },
  });
  return stub;
};

const restoreEvent = () => ({
  schema_version: 1 as const,
  event_id: "$restore-activation:example.test",
  event_type: "message.created" as const,
  event_source: "live" as const,
  tenant_id: tenantId,
  identity_id: "identity_human",
  platform: "whatsapp" as const,
  account_id: "account_human",
  conversation_id: "conversation_restore_activation",
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: null,
  occurred_at: "2026-09-13T23:59:00.000Z",
  observed_at: "2026-09-13T23:59:01.000Z",
  payload: {
    message_id: "message_restore_activation",
    direction: "inbound" as const,
    sender_participant_id: null,
    sender_label: "Retained sender",
    body: "retained after real restore activation",
    reply_to_message_id: null,
    delivery_status: "delivered" as const,
    unread: true,
  },
});

const removedEvent = (messageId = "message_restore_activation_removed") => ({
  ...restoreEvent(),
  event_id: `$restore-activation-${messageId}:example.test`,
  payload: {
    ...restoreEvent().payload,
    message_id: messageId,
    body: "removed during restore",
  },
});

const retainedEvent = () => ({
  ...restoreEvent(),
  event_id: "$restore-activation-retained:example.test",
  payload: {
    ...restoreEvent().payload,
    message_id: "message_restore_activation_retained",
    body: "unrelated retained message",
  },
});

const removalInput = (resourceId: string) => ({
  tenant_id: tenantId,
  resource_type: "message" as const,
  resource_id: resourceId,
  content_generation: resourceId,
  account_id: "account_human",
  conversation_id: "conversation_restore_activation",
  source_event_id: null,
  source_object_key: null,
  reason: "requested" as const,
  removed_at: "2026-09-14T00:00:00.000Z",
});

const seedCompleteControlledCopies = async (
  authorityId: string,
  resourceId: string,
  resourceType: "message" | "conversation" = "message",
  deletionEpoch = 1,
) => {
  const copyCreatedAt = "2026-09-13T00:00:00.000Z";
  const cleanupDeadline = "2026-09-15T00:00:00.000Z";
  const retentionDeadline = "2026-09-16T00:00:00.000Z";
  const stores = [
    ["projection_backup", "message"],
    ["synapse", "message"],
    ["bridge_database", "bridge_mapping"],
    ["media_store", "attachment"],
    ["queue", "queue_item"],
    ["restic_snapshot", "message"],
  ] as const;
  const statements = stores.flatMap(([store, contentClass], index) => {
    const operationId = `restore_activation_${authorityId}_copy_${index}`;
    const reference = `${store}:${resourceId}`;
    const operation = workerEnv.CONTROL_DB.prepare(
      `INSERT INTO controlled_copy_operations (
         id, tenant_id, removal_id, resource_type, resource_id,
         content_generation, deletion_epoch, store, owner, content_class,
         reference, deletion_method, required, copy_created_at,
         cleanup_margin_ms, cleanup_deadline, retention_deadline, status,
         lease_token, lease_expires_at, last_error, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'restore-activation-test', ?, ?, 'delete', 1, ?, ?, ?, ?, 'complete', NULL, NULL, NULL, ?, ?, ?)`,
    ).bind(
      operationId,
      tenantId,
      authorityId,
      resourceType,
      resourceId,
      resourceId,
      deletionEpoch,
      store,
      contentClass,
      reference,
      copyCreatedAt,
      86_400_000,
      cleanupDeadline,
      retentionDeadline,
      "2026-09-14T00:00:00.000Z",
      "2026-09-14T00:00:00.000Z",
      "2026-09-14T00:00:00.000Z",
    );
    const evidence = workerEnv.CONTROL_DB.prepare(
      `INSERT INTO controlled_copy_evidence (
         id, operation_id, tenant_id, removal_id, store, resource_id,
         content_generation, deletion_epoch, status, content_present,
         evidence_source, object_reference, detail, worker_token, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deleted', 0, 'restore-activation-test', ?, NULL, 'restore-activation-worker', ?)` ,
    ).bind(
      `restore_activation_${authorityId}_evidence_${index}`,
      operationId,
      tenantId,
      authorityId,
      store,
      resourceId,
      resourceId,
      deletionEpoch,
      reference,
      "2026-09-14T00:00:00.000Z",
    );
    return [operation, evidence];
  });
  await workerEnv.CONTROL_DB.batch(statements);
};

const seedOutboundRows = async (
  stub: DurableObjectStub<TenantProjectionDO>,
) => {
  await runInDurableObject(stub, async (_instance, state) => {
    const createdAt = "2026-09-14T00:00:00.000Z";
    const rows = [
      [
        "removed_pending",
        "message_restore_activation_removed_pending",
        "conversation_restore_activation",
        "pending",
      ],
      [
        "removed_dispatching",
        "message_restore_activation_removed_dispatching",
        "conversation_restore_activation",
        "dispatching",
      ],
      [
        "retained_pending",
        "message_restore_activation_outbound_retained",
        "conversation_restore_activation",
        "pending",
      ],
    ] as const;
    for (const [suffix, messageId, conversationId, status] of rows) {
      const commandId = `command_restore_activation_${suffix}`;
      const dispatchId = `dispatch_restore_activation_${suffix}`;
      state.storage.sql.exec(
        `INSERT INTO commands (
           id, identity_id, account_id, connection_id, conversation_id,
           platform, operation, delivery_mode, status, failure_code,
           created_at, updated_at, last_observed_ms, last_event_id
         ) VALUES (?, 'identity_human', 'account_human', 'connection_human_whatsapp',
           ?, 'whatsapp', 'message.send', 'direct',
           'accepted', NULL, ?, ?, 1789344000000, ?)`,
        commandId,
        conversationId,
        createdAt,
        createdAt,
        `event_restore_activation_${suffix}`,
      );
      const columns = [
        "id", "command_id", "message_id", "event_id", "tenant_id",
        "actor_principal_id", "actor_identity_id", "resource_identity_id",
        "account_id", "connection_id", "conversation_id", "platform",
        "idempotency_key", "body_digest", "body", "delivery_mode", "status",
        "transaction_id", "request_digest", "dispatch_lease_id",
        "dispatch_lease_expires_at", "uncertainty_reason", "uncertain_at",
        "projection_generation", "matrix_stage", "bridge_stage", "provider_stage",
        "last_evidence_at", "chat_paused", "duplicate_risk", "resend_of_command_id",
        "last_action", "last_action_actor_principal_id", "last_action_at",
        "confirmation_due_at", "confirmation_decision", "confirmation_actor_principal_id",
        "confirmation_actor_identity_id", "confirmation_decided_at", "created_at",
        "updated_at", "authority_reservation_id", "authority_membership_id",
        "authority_identity_id", "authority_capability_kind", "authority_capability_id",
        "authority_capability_epoch",
      ];
      state.storage.sql.exec(
        `INSERT INTO outbound_dispatches (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        dispatchId,
        commandId,
        messageId,
        `event_restore_activation_${suffix}`,
        tenantId,
        "principal_restore_activation",
        "identity_human",
        "identity_human",
        "account_human",
        "connection_human_whatsapp",
        conversationId,
        "whatsapp",
        `restore-activation-${suffix}`,
        "a".repeat(64),
        `restore body ${suffix}`,
        "direct",
        status,
        `transaction_restore_activation_${suffix}`,
        "b".repeat(64),
        status === "dispatching" ? `lease_restore_${suffix}` : null,
        status === "dispatching" ? "2026-09-14T00:10:00.000Z" : null,
        null,
        null,
        1,
        "unknown",
        "unknown",
        "unknown",
        null,
        0,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        createdAt,
        createdAt,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    }
  });
};

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM controlled_copy_evidence WHERE tenant_id = ?",
    ).bind(tenantId),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM controlled_copy_operations WHERE tenant_id = ?",
    ).bind(tenantId),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM restore_activation_leases WHERE tenant_id = ?",
    ).bind(tenantId),
  ]);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
  await cleanupArchiveTenant(bucket, tenantId);
});

afterEach(async () => {
  await cleanupArchiveTenant(bucket, tenantId);
});

describe("restore projection activation", () => {
  it("loads authority, sanitizes R2 replay, and publishes a ready projection", async () => {
    const stub = await resetProjection();
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore_activation",
      events: [restoreEvent()],
      archivedAt: "2026-09-14T00:00:00.000Z",
      producerVersion: "restore-activation-test/1",
      sourceCheckpoint: null,
    });

    const result = await restoreProjectionFromArchive({
      database: workerEnv.CONTROL_DB,
      bucket,
      projection: stub,
      tenantId,
      principalId: "principal_restore_activation",
      rebuildId: "rebuild_restore_activation",
      expectedGeneration: 1,
      startedAt: "2026-09-14T00:01:00.000Z",
      completedAt: "2026-09-14T00:02:00.000Z",
      connections: [
        {
          account_id: "account_human",
          connection_id: "connection_human_whatsapp",
          identity_id: "identity_human",
          platform: "whatsapp",
        },
      ],
      now: new Date("2026-09-14T00:02:00.000Z"),
    });

    expect(result).toMatchObject({
      tenant_id: tenantId,
      rebuild_id: "rebuild_restore_activation",
      deletion_epoch: 0,
      page_count: 1,
      removed_event_ids: [],
      changed_event_ids: [],
      readiness: { state: "ready" },
      projection: {
        state: "ready",
        generation: 2,
        message_count: 1,
      },
    });
    await expect(
      stub.getWebhookMessage({
        schema_version: 1,
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_restore_activation",
        message_id: "message_restore_activation",
        authorization: {
          schema_version: 1,
          tenant_id: tenantId,
          principal_id: "principal_restore_activation",
          allowed_identity_ids: ["identity_human"],
          scopes: ["projection.read"],
        },
      }),
    ).resolves.toMatchObject({
      message_id: "message_restore_activation",
      body: "retained after real restore activation",
    });
  });

  it("resumes from the durable archive cursor after a replay interruption", async () => {
    const stub = await resetProjection();
    const firstEvent = restoreEvent();
    const secondEvent = {
      ...restoreEvent(),
      event_id: "$restore-activation-second:example.test",
      payload: {
        ...restoreEvent().payload,
        message_id: "message_restore_activation_second",
      },
    };
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore_activation_first",
      events: [firstEvent],
      archivedAt: "2026-09-14T00:00:00.000Z",
      producerVersion: "restore-activation-test/1",
      sourceCheckpoint: null,
    });
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore_activation_second",
      events: [secondEvent],
      archivedAt: "2026-09-14T00:00:02.000Z",
      producerVersion: "restore-activation-test/1",
      sourceCheckpoint: null,
    });

    const authorization = {
      schema_version: 1 as const,
      tenant_id: tenantId,
      principal_id: "principal_restore_activation",
      allowed_identity_ids: [] as string[],
      scopes: ["projection.rebuild" as const],
    };
    await stub.beginRebuild({
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: "rebuild_restore_activation_resume",
      expected_generation: 1,
      started_at: "2026-09-14T00:01:00.000Z",
      authorization,
    });
    const firstPage = await readRestoreReplayPage(
      bucket,
      workerEnv.CONTROL_DB,
      tenantId,
    );
    expect(firstPage.next_cursor).not.toBeNull();
    await stub.applyReplayPage({
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: "rebuild_restore_activation_resume",
      source_cursor: null,
      connections: [
        {
          account_id: "account_human",
          connection_id: "connection_human_whatsapp",
          identity_id: "identity_human",
          platform: "whatsapp",
        },
      ],
      page: {
        schema_version: 1,
        replay_mode: "projection_only",
        tenant_id: tenantId,
        manifests: firstPage.manifests,
        events: firstPage.events,
        next_cursor: firstPage.next_cursor,
      },
      authorization,
    });

    const result = await restoreProjectionFromArchive({
      database: workerEnv.CONTROL_DB,
      bucket,
      projection: stub,
      tenantId,
      principalId: "principal_restore_activation",
      rebuildId: "rebuild_restore_activation_resume",
      expectedGeneration: 1,
      startedAt: "2026-09-14T00:01:00.000Z",
      completedAt: "2026-09-14T00:03:00.000Z",
      connections: [
        {
          account_id: "account_human",
          connection_id: "connection_human_whatsapp",
          identity_id: "identity_human",
          platform: "whatsapp",
        },
      ],
      now: new Date("2026-09-14T00:03:00.000Z"),
    });

    expect(result).toMatchObject({
      rebuild_id: "rebuild_restore_activation_resume",
      page_count: 1,
      projection: { state: "ready", generation: 2, message_count: 2 },
    });
  });

  it("runs the restore through the registered administrator endpoint", async () => {
    await resetProjection();
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore_activation_route",
      events: [restoreEvent()],
      archivedAt: "2026-09-14T00:00:00.000Z",
      producerVersion: "restore-activation-test/1",
      sourceCheckpoint: null,
    });

    const response = await createTestApp().request(
      "https://example.test/api/v1/removals/restore-projection",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer human-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rebuild_id: "rebuild_restore_activation_route",
          expected_generation: 1,
          started_at: "2026-09-14T00:01:00.000Z",
        }),
      },
      workerEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenant_id: tenantId,
      rebuild_id: "rebuild_restore_activation_route",
      deletion_epoch: 0,
      page_count: 1,
      readiness: { state: "ready" },
      projection: { state: "ready", generation: 2, message_count: 1 },
    });
  });

  it("restores a nonempty authority through the route and fences outbound uncertainty", async () => {
    const stub = await resetProjection();
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore_activation_authority",
      events: [
        removedEvent("message_restore_activation_removed_pending"),
        removedEvent("message_restore_activation_removed_dispatching"),
        retainedEvent(),
      ],
      archivedAt: "2026-09-14T00:00:00.000Z",
      producerVersion: "restore-activation-test/1",
      sourceCheckpoint: null,
    });
    const pendingAuthority = await recordRemoval(
      workerEnv.CONTROL_DB,
      {
        ...removalInput("message_restore_activation_removed_pending"),
      },
      new Date("2026-09-14T00:00:00.000Z"),
    );
    await expect(
      purgeRecordedRemoval(
        { database: workerEnv.CONTROL_DB, bucket, safetyWindowMs: 0 },
        pendingAuthority,
        new Date("2026-09-14T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ operation: { status: "complete" } });
    const dispatchingAuthority = await recordRemoval(
      workerEnv.CONTROL_DB,
      {
        ...removalInput("message_restore_activation_removed_dispatching"),
      },
      new Date("2026-09-14T00:00:01.000Z"),
    );
    await expect(
      purgeRecordedRemoval(
        { database: workerEnv.CONTROL_DB, bucket, safetyWindowMs: 0 },
        dispatchingAuthority,
        new Date("2026-09-14T00:00:01.000Z"),
      ),
    ).resolves.toMatchObject({ operation: { status: "complete" } });
    await seedCompleteControlledCopies(
      pendingAuthority.id,
      "message_restore_activation_removed_pending",
      "message",
      1,
    );
    await seedCompleteControlledCopies(
      dispatchingAuthority.id,
      "message_restore_activation_removed_dispatching",
      "message",
      2,
    );
    await seedOutboundRows(stub);

    const response = await createTestApp().request(
      "https://example.test/api/v1/removals/restore-projection",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer human-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rebuild_id: "rebuild_restore_activation_authority",
          expected_generation: 1,
          started_at: "2026-09-14T00:01:00.000Z",
        }),
      },
      workerEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deletion_epoch: 2,
      readiness: {
        state: "ready",
        authority_count: 2,
      },
      projection: { state: "ready", generation: 2, message_count: 4 },
    });
    await expect(
      stub.getWebhookMessage({
        schema_version: 1,
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_restore_activation",
        message_id: "message_restore_activation_retained",
        authorization: {
          schema_version: 1,
          tenant_id: tenantId,
          principal_id: "principal_restore_activation",
          allowed_identity_ids: ["identity_human"],
          scopes: ["projection.read"],
        },
      }),
    ).resolves.toMatchObject({ body: "unrelated retained message" });
    await expect(
      stub.getWebhookMessage({
        schema_version: 1,
        tenant_id: tenantId,
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_restore_activation",
        message_id: "message_restore_activation_removed_pending",
        authorization: {
          schema_version: 1,
          tenant_id: tenantId,
          principal_id: "principal_restore_activation",
          allowed_identity_ids: ["identity_human"],
          scopes: ["projection.read"],
        },
      }),
    ).rejects.toThrow();
    const dispatches = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{
          message_id: string;
          status: string;
          chat_paused: number;
          uncertainty_reason: string | null;
        }>(
          "SELECT message_id, status, chat_paused, uncertainty_reason FROM outbound_dispatches ORDER BY id",
        )
        .toArray(),
    );
    expect(dispatches).toEqual([
      {
        message_id: "message_restore_activation_removed_dispatching",
        status: "delivery_uncertain",
        chat_paused: 1,
        uncertainty_reason: "removal_authority:" + dispatchingAuthority.id,
      },
      {
        message_id: "message_restore_activation_removed_pending",
        status: "cancelled",
        chat_paused: 0,
        uncertainty_reason: null,
      },
      {
        message_id: "message_restore_activation_outbound_retained",
        status: "pending",
        chat_paused: 0,
        uncertainty_reason: null,
      },
    ]);
  });

  it("holds the removal writer behind the activation lease during archive replay", async () => {
    const stub = await resetProjection();
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore_activation_race",
      events: [restoreEvent()],
      archivedAt: "2026-09-14T00:00:00.000Z",
      producerVersion: "restore-activation-test/1",
      sourceCheckpoint: null,
    });
    let attempted = false;
    const originalGet = bucket.get.bind(bucket);
    const racingBucket = new Proxy(bucket, {
      get(target, property, receiver) {
        if (property === "get") {
          return async (...args: Parameters<R2Bucket["get"]>) => {
            if (!attempted) {
              attempted = true;
              await expect(
                recordRemoval(
                  workerEnv.CONTROL_DB,
                  removalInput("message_restore_activation"),
                  new Date("2026-09-14T00:02:00.000Z"),
                ),
              ).rejects.toThrow("removal authority was not recorded");
            }
            return originalGet(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as R2Bucket;

    await expect(
      restoreProjectionFromArchive({
        database: workerEnv.CONTROL_DB,
        bucket: racingBucket,
        projection: stub,
        tenantId,
        principalId: "principal_restore_activation",
        rebuildId: "rebuild_restore_activation_race",
        expectedGeneration: 1,
        startedAt: "2026-09-14T00:01:00.000Z",
        completedAt: "2026-09-14T00:03:00.000Z",
        connections: [
          {
            account_id: "account_human",
            connection_id: "connection_human_whatsapp",
            identity_id: "identity_human",
            platform: "whatsapp",
          },
        ],
        now: new Date("2026-09-14T00:02:00.000Z"),
      }),
    ).rejects.toThrow();
    await expect(
      workerEnv.CONTROL_DB.prepare(
        "SELECT count(*) AS count FROM removal_authority WHERE tenant_id = ?",
      )
        .bind(tenantId)
        .first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 0 });
  });
});
