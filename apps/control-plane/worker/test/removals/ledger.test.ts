import type { D1Migration } from "@cloudflare/vitest-plugin";
import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  listRemovalAuthorities,
  markRemovalSuppressionComplete,
  readRemovalAuthority,
  readRemovalExpiry,
  readTenantDeletionEpoch,
  recordRemoval,
  removalMatchesGeneration,
  runRemovalExpiryTick,
  scheduleRemovalExpiry,
} from "../../removals/ledger";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const removalInput = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: "tenant_pilot",
  resource_type: "message",
  resource_id: "message_removed",
  content_generation: "generation_1",
  account_id: "account_pilot",
  conversation_id: "conversation_pilot",
  source_event_id: "event_removed",
  source_object_key: "archive/tenant_pilot/event_removed",
  reason: "requested" as const,
  removed_at: "2026-09-14T00:00:00.000Z",
  ...overrides,
});

beforeEach(async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("DELETE FROM removal_expiry_schedule"),
    env.CONTROL_DB.prepare("DELETE FROM removal_authority"),
  ]);
});

describe("durable removal authority", () => {
  it("converges duplicate deletion requests and advances the tenant epoch once", async () => {
    const first = await recordRemoval(
      env.CONTROL_DB,
      removalInput(),
      new Date("2026-09-14T00:00:00.000Z"),
    );
    const duplicate = await recordRemoval(
      env.CONTROL_DB,
      removalInput({ removed_at: "2026-09-14T00:01:00.000Z" }),
      new Date("2026-09-14T00:01:00.000Z"),
    );

    expect(duplicate).toEqual(first);
    expect(first.deletion_epoch).toBe(1);
    expect(await readTenantDeletionEpoch(env.CONTROL_DB, "tenant_pilot")).toBe(
      1,
    );
    expect(
      await readRemovalAuthority(env.CONTROL_DB, {
        tenantId: "tenant_pilot",
        resourceType: "message",
        resourceId: "message_removed",
        contentGeneration: "generation_1",
        accountId: "account_pilot",
        conversationId: "conversation_pilot",
      }),
    ).toEqual(first);
  });

  it("fails closed for another account and a different content generation", async () => {
    const authority = await recordRemoval(env.CONTROL_DB, removalInput());

    expect(
      await readRemovalAuthority(env.CONTROL_DB, {
        tenantId: "tenant_pilot",
        resourceType: "message",
        resourceId: "message_removed",
        contentGeneration: "generation_1",
        accountId: "account_other",
        conversationId: "conversation_pilot",
      }),
    ).toBeNull();
    expect(
      await readRemovalAuthority(env.CONTROL_DB, {
        tenantId: "tenant_pilot",
        resourceType: "message",
        resourceId: "message_removed",
        contentGeneration: "generation_2",
        accountId: "account_pilot",
        conversationId: "conversation_pilot",
      }),
    ).toBeNull();
    expect(removalMatchesGeneration(authority, "generation_1")).toBe(true);
    expect(removalMatchesGeneration(authority, "generation_2")).toBe(false);
  });

  it("records expiry through the same authority and recovers duplicate wakeups", async () => {
    const expiresAt = "2026-09-14T00:05:00.000Z";
    const scheduleInput = {
      tenant_id: "tenant_pilot",
      resource_type: "message",
      resource_id: "message_expiring",
      content_generation: 3,
      account_id: "account_pilot",
      conversation_id: "conversation_pilot",
      source_event_id: "event_expiring",
      source_object_key: null,
      expires_at: expiresAt,
    } as const;
    const first = await scheduleRemovalExpiry(
      env.CONTROL_DB,
      scheduleInput,
      new Date("2026-09-14T00:00:00.000Z"),
    );
    const duplicate = await scheduleRemovalExpiry(
      env.CONTROL_DB,
      scheduleInput,
      new Date("2026-09-14T00:01:00.000Z"),
    );
    expect(duplicate).toEqual(first);
    await env.CONTROL_DB.prepare(
      `UPDATE removal_expiry_schedule
         SET status = 'processing', lease_token = 'removal_lease_stale',
             lease_expires_at = ?
         WHERE id = ?`,
    )
      .bind("2026-09-14T00:04:00.000Z", first.id)
      .run();

    const tick = await runRemovalExpiryTick(
      env.CONTROL_DB,
      new Date("2026-09-14T00:06:00.000Z"),
    );
    expect(tick.claimed).toBe(1);
    expect(tick.failed).toEqual([]);
    expect(tick.completed).toHaveLength(1);
    expect(tick.completed[0]).toMatchObject({
      reason: "expired",
      content_generation: "3",
      removed_at: expiresAt,
      deletion_epoch: 1,
    });

    const completedSchedule = await readRemovalExpiry(env.CONTROL_DB, {
      tenantId: "tenant_pilot",
      resourceType: "message",
      resourceId: "message_expiring",
      contentGeneration: 3,
    });
    expect(completedSchedule).toMatchObject({
      id: first.id,
      status: "completed",
      removal_id: tick.completed[0]?.id,
    });
    expect(
      await runRemovalExpiryTick(
        env.CONTROL_DB,
        new Date("2026-09-14T00:07:00.000Z"),
      ),
    ).toMatchObject({ claimed: 0, completed: [], failed: [] });
  });

  it("remains authoritative across migration re-entry and separates suppression from purge", async () => {
    const authority = await recordRemoval(env.CONTROL_DB, removalInput());
    await applyD1Migrations(env.CONTROL_DB, env.TEST_MIGRATIONS);

    const afterRebuild = await readRemovalAuthority(env.CONTROL_DB, {
      tenantId: "tenant_pilot",
      resourceType: "message",
      resourceId: "message_removed",
      contentGeneration: "generation_1",
    });
    expect(afterRebuild).toEqual(authority);
    expect(removalMatchesGeneration(afterRebuild, "generation_1")).toBe(true);

    const completed = await markRemovalSuppressionComplete(
      env.CONTROL_DB,
      "tenant_pilot",
      authority.id,
      new Date("2026-09-14T00:02:00.000Z"),
    );
    expect(completed).toMatchObject({
      status: "completed",
      purge_status: "not_started",
      completed_at: "2026-09-14T00:02:00.000Z",
    });
    expect(
      await listRemovalAuthorities(env.CONTROL_DB, "tenant_pilot"),
    ).toEqual([completed]);
  });
});
