import { env, runInDurableObject } from "cloudflare:test";
import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readAuthorizedMessageRemoval,
  readAuthorizedResourceRemoval,
} from "../../removals/service";
import {
  markRemovalSuppressionComplete,
  readRemovalAuthority,
  readRemovalExpiry,
  recordRemoval,
  runRemovalExpiryTick,
  scheduleRemovalExpiry,
} from "../../removals/ledger";
import {
  removalStatusForTenant,
  recordRemovalWithSuppression,
  runRemovalExpiryAndSuppress,
} from "../../removals/service";
import type { TenantProjectionDO } from "../../projection/tenant-projection";
import {
  auth,
  bindingFor,
  event,
  initialize,
  input,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const identityId = "identity_human";
const accountId = "account_human";
const conversationId = "conversation_removal_wiring";
const messageId = "message_removal_wiring";
const fixedNow = new Date("2026-09-14T00:00:00.000Z");

const messageCreated = (
  eventId = "event_removal_wiring_created",
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      message_id: messageId,
      direction: "inbound",
      sender_participant_id: null,
      sender_label: "Original sender",
      body: "secret body",
      reply_to_message_id: null,
      delivery_status: "delivered",
      unread: true,
    },
    "message.created",
    {
      tenant_id: tenantId,
      identity_id: identityId,
      account_id: accountId,
      conversation_id: conversationId,
      occurred_at: "2026-09-13T23:59:00.000Z",
      observed_at: "2026-09-13T23:59:01.000Z",
    },
  );

const lateEdit = (): ProjectionEventEnvelope =>
  event(
    "event_removal_wiring_late_edit",
    {
      message_id: messageId,
      body: "late resurrected body",
      editor_participant_id: null,
    },
    "message.edited",
    {
      tenant_id: tenantId,
      identity_id: identityId,
      account_id: accountId,
      conversation_id: conversationId,
      occurred_at: "2026-09-14T00:01:00.000Z",
      observed_at: "2026-09-14T00:01:01.000Z",
    },
  );

const resetProjection = async (): Promise<
  DurableObjectStub<TenantProjectionDO>
> => {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
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
  await initialize(tenantId);
  return stub;
};

const apply = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  events: ProjectionEventEnvelope[],
): Promise<void> => {
  await stub.applyBatch(
    input(events, {
      tenant_id: tenantId,
      authorization: auth(["projection.write"], [identityId], tenantId),
      connections: [
        bindingFor(accountId, "connection_removal_wiring", identityId),
      ],
    }),
  );
};

const readProjectedMessage = async (
  stub: DurableObjectStub<TenantProjectionDO>,
) =>
  stub.getWebhookMessage({
    schema_version: 1,
    tenant_id: tenantId,
    identity_id: identityId,
    account_id: accountId,
    conversation_id: conversationId,
    message_id: messageId,
    authorization: auth(["projection.read"], [identityId], tenantId),
  });

const insertPendingDelivery = async (
  deliveryId: string,
  sourceMessageId: string,
): Promise<void> => {
  const createdAt = fixedNow.toISOString();
  const retryDeadline = new Date(
    fixedNow.getTime() + 24 * 60 * 60 * 1_000,
  ).toISOString();
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      `INSERT INTO webhook_subscriptions
       (id, tenant_id, creation_idempotency_key, owner_installation_id,
        owner_principal_id, creator_principal_id, creator_membership_id,
        creator_identity_id, logical_agent_id, ownership_mode,
        destination_url, destination_credential_ref, destination_version,
        event_filter_json, global_enabled, status, created_at, updated_at,
        revoked_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'human_owner', ?, NULL, 1,
               ?, 1, 'active', ?, ?, NULL)`,
    ).bind(
      "removal_wiring_subscription",
      tenantId,
      "removal_wiring_subscription_creation",
      "principal_human",
      "principal_human",
      "membership_human",
      identityId,
      "https://hooks.example.test/removal-wiring",
      JSON.stringify({ event_types: ["message.created"] }),
      createdAt,
      createdAt,
    ),
    workerEnv.CONTROL_DB.prepare(
      `INSERT INTO webhook_deliveries
       (id, tenant_id, subscription_id, source_event_id, source_message_id,
        source_identity_id, source_account_id, source_conversation_id,
        source_revision, destination_version, status, first_pending_at,
        retry_deadline, attempt_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, 0)`,
    ).bind(
      deliveryId,
      tenantId,
      "removal_wiring_subscription",
      `event_${deliveryId}`,
      sourceMessageId,
      identityId,
      accountId,
      conversationId,
      "event_removal_wiring_created",
      createdAt,
      retryDeadline,
    ),
  ]);
};

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
});

describe("active removal wiring", () => {
  it("records authority before cancellation and prevents a late revision from resurrecting content", async () => {
    const stub = await resetProjection();
    await apply(stub, [messageCreated()]);
    await insertPendingDelivery("delivery_removal_wiring", messageId);

    const authority = await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB,
      {
        tenant_id: tenantId,
        resource_type: "message",
        resource_id: messageId,
        content_generation: messageId,
        account_id: accountId,
        conversation_id: conversationId,
        source_event_id: "event_removal_wiring_delete",
        source_object_key: null,
        reason: "requested",
        removed_at: fixedNow.toISOString(),
      },
      fixedNow,
    );
    expect(authority.deletion_epoch).toBe(1);
    expect(
      await workerEnv.CONTROL_DB.prepare(
        "SELECT status, cancellation_reason FROM webhook_deliveries WHERE id = ?",
      )
        .bind("delivery_removal_wiring")
        .first(),
    ).toEqual({ status: "cancelled", cancellation_reason: "source_removed" });

    await apply(stub, [lateEdit()]);
    await expect(readProjectedMessage(stub)).resolves.toMatchObject({
      message_id: messageId,
      body: "",
      sender_label: "Deleted sender",
      deleted_at: fixedNow.toISOString(),
      revision: "event_removal_wiring_late_edit",
    });

    await expect(
      readAuthorizedResourceRemoval(workerEnv.CONTROL_DB, {
        tenantId,
        resourceType: "message",
        resourceId: messageId,
        accountId: "account_other",
        conversationId,
      }),
    ).resolves.toBeNull();

    await expect(
      removalStatusForTenant(workerEnv.CONTROL_DB, tenantId),
    ).resolves.toMatchObject({
      tenant_id: tenantId,
      active_suppression: "enforced",
      physical_purge: "not_implemented",
      incomplete: [
        expect.objectContaining({ id: authority.id, status: "active" }),
      ],
    });
  });

  it("turns an expiry wakeup into the same authority and cancellation path", async () => {
    await insertPendingDelivery(
      "delivery_removal_expiry",
      "message_removal_expiry",
    );
    const expiresAt = "2026-09-14T00:05:00.000Z";
    const schedule = await scheduleRemovalExpiry(
      workerEnv.CONTROL_DB,
      {
        tenant_id: tenantId,
        resource_type: "message",
        resource_id: "message_removal_expiry",
        content_generation: "message_removal_expiry",
        account_id: accountId,
        conversation_id: conversationId,
        source_event_id: "event_removal_expiry",
        source_object_key: null,
        expires_at: expiresAt,
      },
      fixedNow,
    );

    const result = await runRemovalExpiryAndSuppress(
      workerEnv.CONTROL_DB,
      new Date("2026-09-14T00:06:00.000Z"),
    );
    expect(result.claimed).toBe(1);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      resource_id: "message_removal_expiry",
      reason: "expired",
      removed_at: expiresAt,
    });
    await expect(
      readRemovalExpiry(workerEnv.CONTROL_DB, {
        tenantId,
        resourceType: "message",
        resourceId: "message_removal_expiry",
        contentGeneration: "message_removal_expiry",
      }),
    ).resolves.toMatchObject({ id: schedule.id, status: "completed" });
    await expect(
      workerEnv.CONTROL_DB.prepare(
        "SELECT status, cancellation_reason FROM webhook_deliveries WHERE id = ?",
      )
        .bind("delivery_removal_expiry")
        .first(),
    ).resolves.toEqual({
      status: "cancelled",
      cancellation_reason: "source_removed",
    });
    await expect(
      runRemovalExpiryTick(
        workerEnv.CONTROL_DB,
        new Date("2026-09-14T00:07:00.000Z"),
      ),
    ).resolves.toMatchObject({ claimed: 0, completed: [] });
  });

  it("inherits conversation suppression for descendant reads and deliveries", async () => {
    await insertPendingDelivery("delivery_conversation_removal", messageId);
    const authority = await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB,
      {
        tenant_id: tenantId,
        resource_type: "conversation",
        resource_id: conversationId,
        content_generation: conversationId,
        account_id: accountId,
        conversation_id: conversationId,
        source_event_id: "event_conversation_removal",
        source_object_key: null,
        reason: "requested",
        removed_at: fixedNow.toISOString(),
      },
      fixedNow,
    );
    expect(authority.resource_type).toBe("conversation");
    await expect(
      readAuthorizedMessageRemoval(workerEnv.CONTROL_DB, {
        tenantId,
        messageId,
        accountId,
        conversationId,
      }),
    ).resolves.toMatchObject({ resource_type: "conversation" });
    await expect(
      workerEnv.CONTROL_DB.prepare(
        "SELECT status, cancellation_reason FROM webhook_deliveries WHERE id = ?",
      )
        .bind("delivery_conversation_removal")
        .first(),
    ).resolves.toEqual({
      status: "cancelled",
      cancellation_reason: "source_removed",
    });
  });

  it("does not mutate authority when invalid removal input is rejected", async () => {
    let prepareCalls = 0;
    const database = {
      withSession: () => ({
        prepare: () => {
          prepareCalls += 1;
          throw new Error("write should not be attempted");
        },
      }),
    } as unknown as D1Database;
    await expect(
      recordRemovalWithSuppression(database, {
        tenant_id: tenantId,
        resource_type: "message",
        resource_id: messageId,
        content_generation: messageId,
        account_id: accountId,
        conversation_id: conversationId,
        source_event_id: null,
        source_object_key: null,
        reason: "invalid" as "requested",
      }),
    ).rejects.toThrow();
    expect(prepareCalls).toBe(0);
    await expect(
      readRemovalAuthority(workerEnv.CONTROL_DB, {
        tenantId,
        resourceType: "message",
        resourceId: messageId,
        contentGeneration: messageId,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed before applying a projection when the authority binding is absent", async () => {
    const stub = await resetProjection();
    await apply(stub, [messageCreated()]);
    const error = await runInDurableObject(stub, async (instance) => {
      const mutableEnv = (
        instance as unknown as {
          env: { CONTROL_DB: D1Database | undefined };
        }
      ).env;
      const database = mutableEnv.CONTROL_DB;
      mutableEnv.CONTROL_DB = undefined;
      try {
        await instance.applyBatch(
          input([lateEdit()], {
            tenant_id: tenantId,
            authorization: auth(["projection.write"], [identityId], tenantId),
            connections: [
              bindingFor(accountId, "connection_removal_wiring", identityId),
            ],
          }),
        );
        return undefined;
      } catch (failure) {
        return failure;
      } finally {
        mutableEnv.CONTROL_DB = database;
      }
    });
    expect(error).toMatchObject({ code: "projection_unavailable" });
    await expect(readProjectedMessage(stub)).resolves.toMatchObject({
      body: "secret body",
      revision: "event_removal_wiring_created",
    });
  });

  it("keeps completed suppression visible while reporting no physical purge", async () => {
    const authority = await recordRemoval(
      workerEnv.CONTROL_DB,
      {
        tenant_id: tenantId,
        resource_type: "message",
        resource_id: "message_completed_removal",
        content_generation: "message_completed_removal",
        account_id: accountId,
        conversation_id: conversationId,
        source_event_id: "event_completed_removal",
        source_object_key: null,
        reason: "retention",
      },
      fixedNow,
    );
    await markRemovalSuppressionComplete(
      workerEnv.CONTROL_DB,
      tenantId,
      authority.id,
      fixedNow,
    );
    await expect(
      removalStatusForTenant(workerEnv.CONTROL_DB, tenantId),
    ).resolves.toMatchObject({
      authorities: [
        expect.objectContaining({ id: authority.id, status: "completed" }),
      ],
      incomplete: [],
      active_suppression: "enforced",
      physical_purge: "not_implemented",
    });
  });
});
